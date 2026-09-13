/**
 * Mints a one-time browser pairing token for an owned dedicated agent.
 * Token-capable remote agents always use the Worker-bound canonical hostname;
 * only the explicit local Docker provider may return a loopback relay URL.
 */
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import {
  getConfiguredElizaAgentPublicWebUiUrl,
  getElizaAgentDirectWebUiUrl,
} from "@/lib/eliza-agent-web-ui";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { warmInferenceRateLimitGate } from "@/lib/services/inference-admission-gate";
import { getPairingTokenService } from "@/lib/services/pairing-token";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

// Statuses we'll auto-resume on. `error` is excluded — surfacing the error
// here lets the client show a real diagnostic instead of looping forever.
const RESUMABLE_STATUSES = new Set(["pending", "stopped", "disconnected"]);
const STARTING_STATUSES = new Set([
  "pending",
  "provisioning",
  "stopped",
  "disconnected",
]);
const RETRY_AFTER_SECONDS = 5;

function agentWebUiNotReadyResponse() {
  return applyCorsHeaders(
    Response.json(
      {
        success: false,
        code: "AGENT_WEB_UI_NOT_READY",
        error:
          "Agent Web UI is not configured through the managed HTTPS route yet. Retry in a moment.",
        retryable: true,
      },
      { status: 503 },
    ),
    CORS_METHODS,
  );
}

type PairingSandbox = NonNullable<
  Awaited<ReturnType<typeof agentSandboxesRepository.findByIdAndOrg>>
>;

/**
 * Return the browser-facing direct web UI origin for Docker-backed agents.
 * `bridge_url` is the API/control listener, while `web_ui_port` is the UI
 * listener on the same host for local Docker and current Hetzner shapes.
 */
function resolveDirectWebUiUrlFromBridgeHost(
  sandbox: PairingSandbox,
): string | null {
  if (!sandbox.web_ui_port) {
    return null;
  }

  const raw = sandbox.bridge_url?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.port = String(sandbox.web_ui_port);
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

function resolveDirectWebUiUrlFromHealthUrl(
  sandbox: PairingSandbox,
): string | null {
  const raw = sandbox.health_url?.trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Hosts a user's BROWSER can never reach: RFC1918, CGNAT (100.64/10 — the
 * tailnet our containers live on), and link-local. The direct-URL rungs below
 * derive origins from bridge_url / health_url / headscale_ip, which on
 * production are tailnet addresses — handing one to the browser produced the
 * dead "http://100.64.x.x:port/pair" redirect. Loopback stays allowed: local
 * Docker dev really is browser-reachable on the same machine.
 */
function isBrowserUnreachableHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHost(h)) return false;
  if (
    [".corp", ".home", ".internal", ".lan", ".local", ".private"].some(
      (suffix) => h.endsWith(suffix),
    )
  ) {
    return true;
  }
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  return /^f[cd]/.test(h) || h.startsWith("fe80");
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipv4 = normalized.split(".");
  return (
    ipv4.length === 4 &&
    ipv4[0] === "127" &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function browserReachableOrigin(origin: string | null): string | null {
  if (!origin) return null;
  try {
    return isBrowserUnreachableHost(new URL(origin).hostname) ? null : origin;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    // error-policy:J3 persisted sandbox URLs are untrusted input.
    return false;
  }
}

function resolveManagedWebUiUrl(
  sandbox: PairingSandbox,
  supportsUiTokenPairing: boolean,
  canonicalAgentBaseDomain: string | undefined,
): string | null {
  if (sandbox.execution_tier === "shared") return null;

  const directOrigins = [
    browserReachableOrigin(resolveDirectWebUiUrlFromBridgeHost(sandbox)),
    browserReachableOrigin(resolveDirectWebUiUrlFromHealthUrl(sandbox)),
    browserReachableOrigin(getElizaAgentDirectWebUiUrl(sandbox)),
  ];
  const canonicalOrigin = getConfiguredElizaAgentPublicWebUiUrl(
    sandbox,
    canonicalAgentBaseDomain,
  );

  if (supportsUiTokenPairing) {
    // Managed token exchange belongs to the Worker-owned hostname. A remote
    // direct host would bypass that boundary; loopback is reserved for the
    // local Docker provider whose ports bind only to 127.0.0.1.
    return directOrigins.find(isLoopbackOrigin) ?? canonicalOrigin;
  }

  return (
    canonicalOrigin ??
    directOrigins.find((origin): origin is string => origin !== null) ??
    null
  );
}

/**
 * POST /api/v1/eliza/agents/[agentId]/pairing-token
 *
 * Generates a one-time pairing token for the agent web UI.
 * The caller must be authenticated and own the agent.
 *
 * Responses:
 *   200 { success: true, data: { token, redirectUrl, expiresIn } }
 *     — agent is running; token issued.
 *   202 { success: true, data: { status: "starting", jobId?, retryAfterMs } }
 *     — agent is not running. We've kicked off (or detected) provisioning.
 *       `retryAfterMs` in the body is the client contract (the Cloud UI reads
 *       only the parsed payload); the `Retry-After` header mirrors it in
 *       seconds for generic HTTP clients.
 *   404 — agent not owned by caller.
 *   503 — running agent has no managed HTTPS Web UI URL configured.
 *
 * The 202 path replaces the previous hard-fail 400 ("Agent must be running
 * to generate pairing token"). The old behavior shifted the responsibility
 * for waking the agent onto every caller; now the server kicks off the
 * resume so any client gets the same self-healing flow.
 */
async function __hono_POST(
  request: Request,
  {
    params,
    canonicalAgentBaseDomain,
    executionCtx,
  }: {
    params: Promise<{ agentId: string }>;
    canonicalAgentBaseDomain: string | undefined;
    executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const sandbox = await agentSandboxesRepository.findByIdAndOrg(
      agentId,
      user.organization_id,
    );

    if (!sandbox) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    if (sandbox.status === "error") {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error:
              "Agent is in an error state. Resolve the failure before pairing.",
            data: { status: sandbox.status },
          },
          { status: 500 },
        ),
        CORS_METHODS,
      );
    }

    if (sandbox.execution_tier === "shared") {
      return agentWebUiNotReadyResponse();
    }

    if (sandbox.status !== "running") {
      if (
        sandbox.status === "stopped" &&
        (await agentSandboxesRepository.wasStoppedByUser(
          agentId,
          user.organization_id,
        ))
      ) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              code: "agent_stopped",
              error:
                "This agent is shut down. Start it from Cloud settings when you are ready.",
              data: { status: "stopped" },
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      // Agent is pending/provisioning/stopped/disconnected — kick off (or
      // detect in-flight) provisioning and tell the client to retry.
      let jobId: string | undefined;
      let alreadyInProgress = false;
      if (RESUMABLE_STATUSES.has(sandbox.status)) {
        const workerHealth = await checkProvisioningWorkerHealth();
        if (!workerHealth.ok) {
          logger.warn(
            "[pairing-token] auto-resume blocked: provisioning worker unavailable",
            {
              agentId,
              orgId: user.organization_id,
              status: sandbox.status,
              code: workerHealth.code,
            },
          );
          return applyCorsHeaders(
            Response.json(provisioningWorkerFailureBody(workerHealth), {
              status: workerHealth.status,
            }),
            CORS_METHODS,
          );
        }

        // Credit gate before re-provisioning a DEDICATED container (#11224):
        // pairing a stopped/reaped agent re-provisions its container, the same
        // paid-compute wake the resume/restart/wake routes gate. Shared agents
        // already returned early (execution_tier === "shared" above), so this
        // only fences the dedicated case — a suspended/zero-balance org can't
        // use pairing to get free compute the resume gate would have blocked.
        const creditCheck = await checkAgentCreditGate(user.organization_id);
        if (!creditCheck.allowed) {
          const body = insufficientCredits402(
            creditCheck,
            "[pairing-token] auto-resume blocked: insufficient credits",
            { agentId, orgId: user.organization_id },
          );
          return applyCorsHeaders(
            Response.json(body, { status: 402 }),
            CORS_METHODS,
          );
        }

        try {
          const { job, created } =
            await provisioningJobService.enqueueAgentProvisionOnce({
              agentId,
              organizationId: user.organization_id,
              userId: user.id,
              agentName: sandbox.agent_name ?? agentId,
              expectedLifecycleRevision: sandbox.lifecycle_revision,
            });
          jobId = job.id;
          alreadyInProgress = !created;
        } catch (error) {
          logger.warn("[pairing-token] auto-resume enqueue failed", {
            agentId,
            orgId: user.organization_id,
            status: sandbox.status,
            error: error instanceof Error ? error.message : String(error),
          });
          return applyCorsHeaders(
            Response.json(
              {
                success: false,
                code: "PROVISIONING_ENQUEUE_FAILED",
                error: "Failed to start agent resume. Retry in a moment.",
                retryable: true,
              },
              { status: 503 },
            ),
            CORS_METHODS,
          );
        }
      }
      const response = applyCorsHeaders(
        Response.json(
          {
            success: true,
            data: {
              agentId,
              status: STARTING_STATUSES.has(sandbox.status)
                ? "starting"
                : sandbox.status,
              jobId,
              alreadyInProgress,
              retryAfterMs: RETRY_AFTER_SECONDS * 1000,
              message:
                "Agent is not running yet. Resume has been requested; retry after the suggested interval.",
            },
          },
          { status: 202 },
        ),
        CORS_METHODS,
      );
      response.headers.set("Retry-After", String(RETRY_AFTER_SECONDS));
      return response;
    }

    const envVars = (sandbox.environment_vars ?? {}) as Record<string, string>;
    const supportsUiTokenPairing = Boolean(envVars.ELIZA_API_TOKEN?.trim());
    const webUiUrl = resolveManagedWebUiUrl(
      sandbox,
      supportsUiTokenPairing,
      canonicalAgentBaseDomain,
    );
    if (!webUiUrl) {
      return agentWebUiNotReadyResponse();
    }

    const tokenService = getPairingTokenService();
    const pairingToken = await tokenService.generateToken(
      user.id,
      user.organization_id,
      agentId,
      webUiUrl,
    );

    // Prepare the existing quota gate during browser handoff; warming neither
    // consumes quota nor replaces the first inference request's admission checks.
    if (executionCtx) {
      executionCtx.waitUntil(
        warmInferenceRateLimitGate(user.organization_id).catch((error) => {
          // error-policy:J1 Optional background preparation reports its failure;
          // foreground inference still performs the authoritative gate check.
          logger.warn("[pairing-token] Inference gate prewarm failed", {
            error,
          });
        }),
      );
    }

    const response = applyCorsHeaders(
      Response.json({
        success: true,
        data: {
          token: pairingToken,
          redirectUrl: supportsUiTokenPairing
            ? `${webUiUrl}/pair?token=${pairingToken}`
            : webUiUrl,
          expiresIn: 60,
        },
      }),
      CORS_METHODS,
    );

    response.headers.set(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    response.headers.set("Pragma", "no-cache");
    response.headers.set("Expires", "0");

    return response;
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) => {
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // error-policy:J1 Hono has no execution context outside Workers. Those
    // hosts perform the normal foreground gate check without preparation.
    executionCtx = undefined;
  }
  return __hono_POST(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
    canonicalAgentBaseDomain: c.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
    executionCtx,
  });
});
export default __hono_app;
