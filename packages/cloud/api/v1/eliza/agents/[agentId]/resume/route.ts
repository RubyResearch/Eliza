// Handles v1 cloud API v1 eliza agents agentid resume route traffic with route-local auth expectations.
import { Hono } from "hono";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "@/db/schemas/agent-sandboxes";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { getConfiguredElizaAgentPublicWebUiUrl } from "@/lib/eliza-agent-web-ui";
import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";
import { checkAgentCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import { requireDedicatedComputePriceAcceptance } from "@/lib/services/dedicated-compute-price-acceptance";
import { elizaSandboxService } from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

/**
 * POST /api/v1/eliza/agents/[agentId]/resume
 *
 * Resume a suspended agent:
 * 1. Creates a new Docker container (possibly on a different node)
 * 2. Restores from the latest snapshot/backup
 * 3. Updates status to "running" in DB
 *
 * Every provider-mutating request uses the durable admitted job queue and
 * returns 202 with a jobId. `sync=true` remains a strict compatibility token,
 * but cannot bypass deletion fencing by restoring inline provider execution.
 *
 * Environment vars (JWT_SECRET, ELIZA_API_TOKEN, DATABASE_URL) are
 * preserved from the original container via the environment_vars column.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    // Agent-resume wait identity, not leftover tax on agent-create
    // autoProvision. sync=TRUE used to silently stay async (202 job)
    // instead of blocking provision.
    const syncValues = new URL(request.url).searchParams.getAll("sync");
    const requestedSync = syncValues[0];
    if (
      syncValues.length > 1 ||
      (requestedSync != null &&
        requestedSync !== "" &&
        requestedSync !== "true" &&
        requestedSync !== "false")
    ) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid sync",
            message:
              'sync must be specified at most once as "true" or "false".',
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }
    const syncRequested = requestedSync === "true";

    logger.info("[agent-api] Resume requested", {
      agentId,
      orgId: user.organization_id,
      async: true,
      syncRequested,
    });

    const agent = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id,
    );
    if (!agent) {
      return applyCorsHeaders(
        Response.json(
          { success: false, error: "Agent not found" },
          { status: 404 },
        ),
        CORS_METHODS,
      );
    }

    // Preserve the stricter compatibility-token eligibility checks before the
    // request enters the queue. The durable worker admission remains the
    // authoritative deletion/provider serialization boundary.
    if (syncRequested) {
      if (
        !CONTAINER_BACKED_EXECUTION_TIERS.some(
          (tier) => tier === agent.execution_tier,
        )
      ) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Agent resume requires a container-backed execution tier",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (agent.pool_status !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Agent resume cannot target pool-owned capacity",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (agent.deleted_at !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Agent resume cannot target deleted capacity",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (agent.deletion_attempt_id !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error:
                "Agent resume cannot target capacity with deletion in progress",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
    }

    if (agent.execution_tier === "shared") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          source: "shared_runtime",
          data: {
            agentId,
            action: "resume",
            message: "Agent is already available on the shared runtime",
            status: agent.status,
            executionTier: agent.execution_tier,
          },
        }),
        CORS_METHODS,
      );
    }

    if (agent.status === "running" && agent.bridge_url && agent.health_url) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            agentId,
            action: "resume",
            message: "Agent is already running",
            status: agent.status,
            webUiUrl: getConfiguredElizaAgentPublicWebUiUrl(
              agent,
              env.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
            ),
          },
        }),
        CORS_METHODS,
      );
    }

    // ── Credit gate: require minimum deposit before resuming ──────────
    const priceError = requireDedicatedComputePriceAcceptance(request);
    if (priceError) return applyCorsHeaders(priceError, CORS_METHODS);
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      const body = insufficientCredits402(
        creditCheck,
        "[agent-api] Resume blocked: insufficient credits",
        { agentId, orgId: user.organization_id },
      );
      return applyCorsHeaders(
        Response.json(body, { status: 402 }),
        CORS_METHODS,
      );
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn(
        "[agent-api] Resume blocked: provisioning worker unavailable",
        {
          agentId,
          orgId: user.organization_id,
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

    const webhookUrl = request.headers.get("x-webhook-url") ?? undefined;
    if (webhookUrl) {
      try {
        await assertSafeOutboundUrl(webhookUrl);
      } catch (error) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error:
                error instanceof Error ? error.message : "Invalid webhook URL",
            },
            { status: 400 },
          ),
          CORS_METHODS,
        );
      }
    }

    try {
      // Distinct job type from `agent_provision` so the daemon can
      // tell a user-initiated resume from a fresh provision in audit
      // logs.
      const { job, created } =
        await provisioningJobService.enqueueAgentResumeOnce({
          agentId,
          organizationId: user.organization_id,
          userId: user.id,
          webhookUrl,
        });

      // Best-effort wake of the orchestrator so the user does not wait for
      // the next cron tick. Same pattern as provision/delete/suspend.
      void provisioningJobService.triggerImmediate(env).catch((error) => {
        // error-policy:J7 the durable job remains visible to the polling worker.
        logger.warn("[agent-api] Resume worker nudge failed", {
          agentId,
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return applyCorsHeaders(
        Response.json(
          {
            success: true,
            created,
            alreadyInProgress: !created,
            data: {
              agentId,
              action: "resume",
              jobId: job.id,
              status: job.status,
              message: created
                ? "Resume job created. Poll the job endpoint for status."
                : "Resume is already in progress.",
            },
            polling: {
              endpoint: `/api/v1/jobs/${job.id}`,
              intervalMs: 5000,
              expectedDurationMs: 90000,
            },
          },
          { status: created ? 202 : 409 },
        ),
        CORS_METHODS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message === "Agent not found"
          ? 404
          : message === "Agent state changed while starting"
            ? 409
            : 500;
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: status === 500 ? "Failed to resume agent" : message,
          },
          { status },
        ),
        CORS_METHODS,
      );
    }
  } catch (error) {
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
