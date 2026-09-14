// Handles v1 cloud API v1 eliza agents agentid provision route traffic with route-local auth expectations.
import { Hono } from "hono";
import { agentSandboxesRepository } from "@/db/repositories/agent-sandboxes";
import { CONTAINER_BACKED_EXECUTION_TIERS } from "@/db/schemas/agent-sandboxes";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { containersEnv } from "@/lib/config/containers-env";
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
import type { AppContext, AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "POST, OPTIONS";

function sanitizeEnqueueFailureMessage(
  error: string,
  status: 404 | 409 | 500,
): string {
  if (status !== 500) {
    return error;
  }

  return "Failed to start provisioning";
}

function createFailureId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `provision-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * POST /api/v1/eliza/agents/[agentId]/provision
 *
 * Provision (or re-provision) the sandbox for an Agent cloud agent.
 *
 * **Warm pool fast path:** When `WARM_POOL_ENABLED=true`, attempts to claim
 * a pre-warmed container atomically and returns 200 with running info.
 *
 * **Default (async):** Creates a provisioning job and returns 202 with a
 * jobId. Poll GET /api/v1/jobs/{jobId} for status. The endpoint also
 * fires a fire-and-forget kick at the worker so we don't wait up to 60s
 * for the next cron tick.
 *
 * `sync=true` remains a strict compatibility token, but every provider-mutating
 * request uses the durable admitted queue so deletion fencing cannot be bypassed.
 *
 * Idempotent: if the sandbox is already running, returns 200 with
 * existing connection info (no job created).
 */
async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
  ctx?: AppContext,
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    // Agent-provision wait identity, leftover tax after agent-resume
    // sync (#21099). sync=TRUE used to silently stay async (202 job)
    // instead of the blocking fallback.
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

    logger.info("[agent-api] Provision requested", {
      agentId,
      orgId: user.organization_id,
      async: true,
      syncRequested,
    });

    // Fast path: check if already running (no job needed)
    const existing = await elizaSandboxService.getAgentForWrite(
      agentId,
      user.organization_id!,
    );
    if (!existing) {
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
          (tier) => tier === existing.execution_tier,
        )
      ) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error:
                "Agent provision requires a container-backed execution tier",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (existing.pool_status !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Agent provision cannot target pool-owned capacity",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (existing.deleted_at !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error: "Agent provision cannot target deleted capacity",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
      if (existing.deletion_attempt_id !== null) {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error:
                "Agent provision cannot target capacity with deletion in progress",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
    }

    if (existing.execution_tier === "shared") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          source: "shared_runtime",
          data: {
            id: existing.id,
            agentName: existing.agent_name,
            status: existing.status,
            executionTier: existing.execution_tier,
            message: "Agent is already available on the shared runtime",
            // Shared agents have no agent server; their REST base is the
            // cloud-api adapter root (chat client appends `/api/...`).
            webUiUrl: `${new URL(request.url).origin}/api/v1/eliza/agents/${existing.id}`,
          },
        }),
        CORS_METHODS,
      );
    }

    if (
      existing.status === "running" &&
      existing.bridge_url &&
      existing.health_url
    ) {
      return applyCorsHeaders(
        Response.json({
          success: true,
          data: {
            id: existing.id,
            agentName: existing.agent_name,
            status: existing.status,
            webUiUrl: getConfiguredElizaAgentPublicWebUiUrl(
              existing,
              ctx?.env?.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
            ),
          },
        }),
        CORS_METHODS,
      );
    }

    // ── Credit gate: require minimum deposit before provisioning ──────
    const priceError = requireDedicatedComputePriceAcceptance(request);
    if (priceError) return applyCorsHeaders(priceError, CORS_METHODS);
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      const body = insufficientCredits402(
        creditCheck,
        "[agent-api] Provision blocked: insufficient credits",
        { agentId, orgId: user.organization_id },
      );
      return applyCorsHeaders(
        Response.json(body, { status: 402 }),
        CORS_METHODS,
      );
    }

    // ── Warm pool fast path ───────────────────────────────────────────
    // Attempt to atomically claim a pre-warmed container. Falls through
    // (returns null) when the pool is empty, disabled, or the user's row
    // already has a database (re-provision).
    if (containersEnv.warmPoolEnabled() && !syncRequested) {
      let committedWarmClaim = false;
      try {
        const claimed = await agentSandboxesRepository.claimWarmContainer({
          userAgentId: agentId,
          organizationId: user.organization_id!,
          image: containersEnv.defaultAgentImage(),
          agentName: existing.agent_name ?? agentId,
          agentConfig:
            (existing.agent_config as Record<string, unknown> | undefined) ??
            undefined,
          characterId: existing.character_id,
          expectedLifecycleRevision: existing.lifecycle_revision,
        });
        if (claimed) {
          committedWarmClaim = true;
          logger.info("[agent-api] Warm pool claim succeeded", {
            agentId,
            orgId: user.organization_id,
            poolNodeId: claimed.node_id,
          });
          // Post-claim character apply: the pool container booted GENERIC (no
          // ELIZA_AGENT_CHARACTER_JSON), so push the user's character onto the
          // live runtime via the container's PUT /api/character. Bounded (10s)
          // and NON-FATAL: on failure the claim still succeeds (the row's
          // agent_config applies on the next container restart) and
          // `warm_pool.character_push_failed` keeps the miss observable.
          try {
            const push =
              await elizaSandboxService.pushClaimedWarmContainerCharacter(
                claimed,
              );
            if (push.pushed) {
              logger.info("[agent-api] Warm pool character push applied", {
                agentId,
                orgId: user.organization_id,
                agentName: push.agentName,
              });
            }
          } catch (pushErr) {
            logger.warn(
              "[agent-api] Warm pool character push failed; claim kept (character applies on next restart)",
              {
                event: "warm_pool.character_push_failed",
                agentId,
                orgId: user.organization_id,
                error:
                  pushErr instanceof Error ? pushErr.message : String(pushErr),
              },
            );
          }
          // Post-claim inference re-key (F0): mint a user-org-scoped inference
          // key and push it onto the live container so it can infer against the
          // claiming org (the pool container booted with a pool-org key).
          // The live runtime must attest the replacement. Failure enters
          // restart recovery from row env instead of reporting a ready agent.
          try {
            const keyPush =
              await elizaSandboxService.pushClaimedWarmContainerInferenceKey(
                claimed,
              );
            if (keyPush.pushed) {
              logger.info("[agent-api] Warm pool inference key push applied", {
                agentId,
                orgId: user.organization_id,
                keyPrefix: keyPush.keyPrefix,
              });
            }
          } catch (keyErr) {
            const recovery =
              await provisioningJobService.enqueueAgentRestartOnce({
                agentId,
                organizationId: user.organization_id,
                userId: user.id,
              });
            if (recovery.created) {
              void provisioningJobService
                .triggerImmediate(ctx?.env)
                .catch(() => {
                  // error-policy:J5 the persisted restart job is observed by
                  // the provisioning worker poll after a failed nudge.
                });
            }
            logger.warn(
              "[agent-api] Warm pool inference key push failed; restart recovery enqueued",
              {
                event: "warm_pool.key_push_failed",
                agentId,
                orgId: user.organization_id,
                recoveryJobId: recovery.job.id,
                recoveryJobCreated: recovery.created,
                error:
                  keyErr instanceof Error ? keyErr.message : String(keyErr),
              },
            );
            return applyCorsHeaders(
              Response.json(
                {
                  success: true,
                  source: "warm_pool_recovery",
                  data: {
                    id: claimed.id,
                    agentName: claimed.agent_name,
                    status: "provisioning",
                  },
                },
                { status: 202 },
              ),
              CORS_METHODS,
            );
          }
          return applyCorsHeaders(
            Response.json({
              success: true,
              data: {
                id: claimed.id,
                agentName: claimed.agent_name,
                status: "running",
                webUiUrl: getConfiguredElizaAgentPublicWebUiUrl(
                  claimed,
                  ctx?.env?.ELIZA_CLOUD_AGENT_BASE_DOMAIN,
                ),
              },
              source: "warm_pool",
            }),
            CORS_METHODS,
          );
        }
        // Claim returned null: distinguish an EMPTY pool (starvation — the
        // steady state when replenish is broken, this provision now degrades to
        // the cold path) from an ineligible user row (re-provision that already
        // has a DB). `warm_pool.empty_on_claim` makes the starvation visible;
        // `warm_pool.claim_failed` below only covers THROWs.
        try {
          const ready =
            await agentSandboxesRepository.countReadyPoolEntriesForImage(
              containersEnv.defaultAgentImage(),
            );
          if (ready === 0) {
            logger.warn(
              "[agent-api] Warm pool empty on provision; degrading to cold path",
              {
                event: "warm_pool.empty_on_claim",
                agentId,
                orgId: user.organization_id,
              },
            );
          }
        } catch {
          // Observability probe is best-effort; never block the provision path.
        }
      } catch (err) {
        if (committedWarmClaim) {
          logger.error(
            "[agent-api] Warm pool claim committed but recovery enqueue failed",
            {
              event: "warm_pool.recovery_enqueue_failed",
              agentId,
              orgId: user.organization_id,
              error: err instanceof Error ? err.message : String(err),
            },
          );
          return applyCorsHeaders(
            Response.json(
              {
                success: false,
                code: "service_unavailable",
                error:
                  "Warm-pool credential recovery is pending but could not be scheduled",
              },
              { status: 503 },
            ),
            CORS_METHODS,
          );
        }
        // Don't block on claim errors — fall through to the normal path.
        logger.warn("[agent-api] Warm pool claim threw; falling back", {
          agentId,
          orgId: user.organization_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn(
        "[agent-api] Provision blocked: provisioning worker unavailable",
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

    // ── Async path (default) ──────────────────────────────────────────
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

    let enqueueResult: Awaited<
      ReturnType<typeof provisioningJobService.enqueueAgentProvisionOnce>
    >;
    try {
      enqueueResult = await provisioningJobService.enqueueAgentProvisionOnce({
        agentId,
        organizationId: user.organization_id!,
        userId: user.id,
        agentName: existing.agent_name ?? agentId,
        webhookUrl,
        expectedLifecycleRevision: existing.lifecycle_revision,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        message === "Agent not found"
          ? 404
          : message === "Agent state changed while starting"
            ? 409
            : 500;
      const failureId = status === 500 ? createFailureId() : undefined;

      if (status === 500) {
        logger.error("[agent-api] Failed to enqueue provisioning job", {
          failureId,
          agentId,
          orgId: user.organization_id,
          error: message,
        });
      }

      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            code:
              status === 500
                ? "provision_enqueue_failed"
                : "provision_enqueue_rejected",
            error: sanitizeEnqueueFailureMessage(message, status),
            ...(failureId ? { failureId } : {}),
            retryable: status === 500 || status === 409,
          },
          { status },
        ),
        CORS_METHODS,
      );
    }

    const { job, created } = enqueueResult;

    // Inline trigger: kick the worker now instead of waiting up to a minute
    // for the next cron tick. Fire-and-forget; the cron is the safety net.
    if (created) {
      const triggerEnv = ctx?.env;
      const triggerPromise = provisioningJobService
        .triggerImmediate(triggerEnv)
        .catch((err) => {
          // error-policy:J7 the durable job remains observable by the daemon;
          // retain a failed best-effort nudge as an operational diagnostic.
          logger.warn(
            "[provision] provisioning triggerImmediate nudge failed",
            {
              agentId,
              jobId: job.id,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        });
      let executionCtx: AppContext["executionCtx"] | undefined;
      try {
        executionCtx = ctx?.executionCtx;
      } catch {
        executionCtx = undefined;
      }
      if (typeof executionCtx?.waitUntil === "function") {
        executionCtx.waitUntil(triggerPromise);
      } else {
        // No Worker execution context to hand the promise to (non-Worker runtime):
        // the provisioning job is already persisted, so a failed immediate nudge only
        // defers execution to the next poll. Log it rather than swallow so a stuck
        // orchestrator surfaces.
        void triggerPromise;
      }
    }

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created,
          alreadyInProgress: !created,
          message: created
            ? "Provisioning job created. Poll the job endpoint for status."
            : "Provisioning is already in progress. Poll the existing job for status.",
          data: {
            jobId: job.id,
            agentId,
            status: job.status,
            estimatedCompletionAt: job.estimated_completion_at,
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
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.post("/", async (c) =>
  __hono_POST(
    c.req.raw,
    { params: Promise.resolve({ agentId: c.req.param("agentId")! }) },
    c,
  ),
);
export default __hono_app;
