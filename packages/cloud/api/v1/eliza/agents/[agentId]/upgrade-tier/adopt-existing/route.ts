/**
 * Quotes and explicitly confirms adoption of one existing owned Dedicated row
 * as the personal Eliza migration target. The server selects and binds the
 * target; clients cannot name a row, write markers, or start compute without a
 * target-bound current quote. Shared remains authoritative until the existing
 * cutover route confirms a healthy running target and imports personal state.
 */

import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { resolveElizaTraceId } from "@/lib/observability/http-telemetry";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  adoptPersonalDedicatedTargetWithProvision,
  PersonalDedicatedAdoptionError,
  type PersonalDedicatedAdoptionResolution,
  resolvePersonalDedicatedAdoption,
} from "@/lib/services/agent-tier-upgrade-target";
import { personalDedicatedActivationAuthorityKey } from "@/lib/services/personal-dedicated-adoption-provenance";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerCapability,
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
  REVIEWED_BACKUP_RESTORE_CAPABILITY,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import {
  isPersonalSharedAgentId,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, OPTIONS";
const ADOPTION_QUOTE_VERSION = "personal-dedicated-adoption-v3";

const AdoptionConfirmation = z
  .object({
    action: z.literal("adopt_existing_dedicated"),
    quoteId: z.string().regex(/^[a-f0-9]{64}$/),
    minimumActivationChargeUsd: z.number().finite().nonnegative(),
  })
  .strict();

type AuthedUser = Awaited<
  ReturnType<typeof requireAuthOrApiKeyWithOrg>
>["user"];

type ResolvedAdoption = Extract<
  PersonalDedicatedAdoptionResolution,
  { state: "available" | "adopted" }
>;

function json(body: unknown, status = 200): Response {
  return applyCorsHeaders(Response.json(body, { status }), CORS_METHODS);
}

function pollingBody(jobId: string) {
  return {
    endpoint: `/api/v1/jobs/${jobId}`,
    intervalMs: 5000,
    expectedDurationMs: 90000,
  };
}

function resolvePersonalSourceId(
  agentId: string,
  user: AuthedUser,
): string | null {
  if (!isPersonalSharedAgentId(agentId)) return null;
  const expected = personalSharedAgentId({
    userId: user.id,
    organizationId: user.organization_id,
  });
  return agentId === expected ? expected : null;
}

function startsCompute(status: ResolvedAdoption["agent"]["status"]): boolean {
  return status === "error" || status === "stopped" || status === "sleeping";
}

async function quoteIdFor(params: {
  organizationId: string;
  userId: string;
  sourceAgentId: string;
  targetId: string;
  targetStatus: ResolvedAdoption["agent"]["status"];
  lifecycleRevision: number;
  balance: number;
  activationAuthorityKey: string;
}): Promise<string> {
  const input = [
    ADOPTION_QUOTE_VERSION,
    params.organizationId,
    params.userId,
    params.sourceAgentId,
    params.targetId,
    params.targetStatus,
    params.lifecycleRevision.toString(10),
    params.balance.toFixed(6),
    params.activationAuthorityKey,
    AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6),
    AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE.toFixed(6),
    AGENT_PRICING.DAILY_RUNNING_COST.toFixed(6),
    AGENT_PRICING.UPGRADE_MINIMUM_BALANCE.toFixed(6),
    AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS.toString(10),
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function adoptionQuote(
  sourceAgentId: string,
  user: AuthedUser,
  resolution: ResolvedAdoption,
) {
  const credit = await checkAgentTierUpgradeCreditGate(user.organization_id);
  const target = resolution.agent;
  const willStartCompute = startsCompute(target.status);
  const activationAuthority = resolution.selectionActivationAuthority;
  const activationAuthorityKey =
    personalDedicatedActivationAuthorityKey(activationAuthority);
  const requiresCatalogRestore =
    willStartCompute &&
    activationAuthority?.kind === "catalog-restore-required";
  const minimumBalanceUsd = AGENT_PRICING.UPGRADE_MINIMUM_BALANCE;
  const deficitUsd = Math.max(
    0,
    Math.round((minimumBalanceUsd - credit.balance) * 100) / 100,
  );
  return {
    quoteId: await quoteIdFor({
      organizationId: user.organization_id,
      userId: user.id,
      sourceAgentId,
      targetId: target.id,
      targetStatus: target.status,
      lifecycleRevision: target.lifecycle_revision,
      balance: credit.balance,
      activationAuthorityKey,
    }),
    quoteVersion: ADOPTION_QUOTE_VERSION,
    sourceAgentId,
    dedicatedAgentId: target.id,
    currentMode: "shared" as const,
    targetMode: "dedicated" as const,
    status: target.status,
    adoptionState: resolution.state,
    startsCompute: willStartCompute,
    hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
    minimumActivationChargeUsd: willStartCompute
      ? AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE
      : 0,
    dailyRateUsd: AGENT_PRICING.DAILY_RUNNING_COST,
    minimumBalanceUsd,
    minimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
    balanceUsd: credit.balance,
    deficitUsd,
    stateDisposition:
      activationAuthority?.kind === "fresh-boot"
        ? ("fresh_boot_no_verified_backup" as const)
        : activationAuthority
          ? ("verified_backup_present" as const)
          : ("unreviewed_existing_target" as const),
    canAdopt: (!willStartCompute || credit.allowed) && !requiresCatalogRestore,
    requiresCatalogRestore,
    requiresConfirmation: true,
    action: "adopt_existing_dedicated" as const,
    ...(requiresCatalogRestore
      ? {
          unavailableReason:
            "The reviewed target has catalogue state that must use the catalogue restore workflow before activation.",
        }
      : !credit.allowed && willStartCompute && credit.error
        ? { unavailableReason: credit.error }
        : {}),
  };
}

function resolutionError(
  resolution: PersonalDedicatedAdoptionResolution,
): Response | null {
  if (resolution.state === "unavailable") {
    return json(
      {
        success: false,
        code: "dedicated_adoption_unavailable",
        error: "Agent not found",
      },
      404,
    );
  }
  if (resolution.state === "ambiguous") {
    return json(
      {
        success: false,
        code: "dedicated_adoption_ambiguous",
        error:
          "More than one existing Dedicated agent is eligible. Resolve the inventory before adopting; no agent was changed.",
      },
      409,
    );
  }
  return null;
}

function adoptionServiceError(error: PersonalDedicatedAdoptionError): Response {
  const code =
    error.code === "PERSONAL_DEDICATED_ADOPTION_AMBIGUOUS"
      ? "dedicated_adoption_ambiguous"
      : error.code === "PERSONAL_DEDICATED_ADOPTION_UNAVAILABLE"
        ? "dedicated_adoption_unavailable"
        : error.code === "PERSONAL_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED"
          ? "dedicated_adoption_catalog_restore_required"
          : "dedicated_adoption_quote_changed";
  return json(
    {
      success: false,
      code,
      error:
        code === "dedicated_adoption_quote_changed"
          ? "The existing Dedicated agent changed after quoting. Review the current quote and confirm again."
          : error.message,
    },
    409,
  );
}

async function resolveForOwner(sourceAgentId: string, user: AuthedUser) {
  return resolvePersonalDedicatedAdoption({
    organizationId: user.organization_id,
    userId: user.id,
    sourceAgentId,
  });
}

async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const sourceAgentId = resolvePersonalSourceId(agentId, user);
    if (!sourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }

    const resolution = await resolveForOwner(sourceAgentId, user);
    const invalid = resolutionError(resolution);
    if (invalid) return invalid;
    return json({
      success: true,
      data: await adoptionQuote(
        sourceAgentId,
        user,
        resolution as ResolvedAdoption,
      ),
    });
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates auth, lookup, and quote
    // failures into the route's structured response contract.
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
  executionCtx?: { waitUntil(promise: Promise<unknown>): void },
  resolvedTraceId?: string,
) {
  const startedAt = performance.now();
  const traceId = resolvedTraceId ?? resolveElizaTraceId(request.headers);
  let phase = "auth";
  let sourceAgentId = "unavailable";
  let orgId = "unavailable";
  let userId = "unavailable";
  const phaseTimingsMs: Record<string, number> = {};
  const timed = async <T>(name: string, operation: () => Promise<T>) => {
    phase = name;
    const phaseStartedAt = performance.now();
    try {
      return await operation();
    } finally {
      phaseTimingsMs[name] = Math.round(performance.now() - phaseStartedAt);
    }
  };
  try {
    const { user } = await timed("auth", () =>
      requireAuthOrApiKeyWithOrg(request),
    );
    orgId = user.organization_id;
    userId = user.id;
    const { agentId } = await params;
    const resolvedSourceAgentId = resolvePersonalSourceId(agentId, user);
    if (!resolvedSourceAgentId) {
      return json({ success: false, error: "Agent not found" }, 404);
    }
    sourceAgentId = resolvedSourceAgentId;

    let rawConfirmation: unknown;
    try {
      rawConfirmation = await timed("confirmation_parse", () => request.json());
    } catch {
      // error-policy:J3 malformed JSON is explicitly invalid confirmation.
      rawConfirmation = null;
    }
    const confirmation = AdoptionConfirmation.safeParse(rawConfirmation);
    if (!confirmation.success) {
      return json(
        {
          success: false,
          code: "dedicated_adoption_confirmation_required",
          error:
            "Review the current same-agent Dedicated quote and explicitly confirm adoption before any compute starts.",
        },
        400,
      );
    }

    const resolution = await timed("owner_resolution", () =>
      resolveForOwner(sourceAgentId, user),
    );
    const invalid = resolutionError(resolution);
    if (invalid) return invalid;
    const resolved = resolution as ResolvedAdoption;
    const quote = await timed("quote", () =>
      adoptionQuote(sourceAgentId, user, resolved),
    );
    if (
      confirmation.data.quoteId !== quote.quoteId ||
      confirmation.data.minimumActivationChargeUsd !==
        quote.minimumActivationChargeUsd
    ) {
      return json(
        {
          success: false,
          code: "dedicated_adoption_quote_changed",
          error:
            "The existing Dedicated agent or billing quote changed. Review the current quote and confirm again.",
          data: quote,
        },
        409,
      );
    }

    if (quote.startsCompute && !quote.canAdopt) {
      if (quote.requiresCatalogRestore) {
        return json(
          {
            success: false,
            code: "dedicated_adoption_catalog_restore_required",
            error: quote.unavailableReason,
            data: quote,
          },
          409,
        );
      }
      const credit = await timed("credit_recheck", () =>
        checkAgentTierUpgradeCreditGate(user.organization_id),
      );
      return json(
        insufficientCredits402(
          credit,
          "[agent-tier-adoption] Adoption blocked: insufficient hosting runway",
          {
            sourceAgentId,
            dedicatedAgentId: resolved.agent.id,
            orgId: user.organization_id,
          },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }

    if (quote.startsCompute) {
      const workerHealth = await timed("worker_health", () =>
        resolved.selectionActivationAuthority
          ? checkProvisioningWorkerCapability(
              REVIEWED_BACKUP_RESTORE_CAPABILITY,
            )
          : checkProvisioningWorkerHealth(),
      );
      if (!workerHealth.ok) {
        logger.warn(
          "[agent-tier-adoption] Adoption blocked: provisioning worker unavailable",
          {
            sourceAgentId,
            dedicatedAgentId: resolved.agent.id,
            orgId: user.organization_id,
            code: workerHealth.code,
          },
        );
        return json(
          provisioningWorkerFailureBody(workerHealth),
          workerHealth.status,
        );
      }
    }

    let result: Awaited<
      ReturnType<typeof adoptPersonalDedicatedTargetWithProvision>
    >;
    try {
      result = await timed("adoption_transaction", () =>
        adoptPersonalDedicatedTargetWithProvision({
          organizationId: user.organization_id,
          userId: user.id,
          sourceAgentId,
          expectedTargetId: resolved.agent.id,
          expectedLifecycleRevision: resolved.agent.lifecycle_revision,
          expectedStatus: resolved.agent.status,
          expectedBalance: quote.balanceUsd,
          expectedHourlyRate: quote.hourlyRateUsd,
          expectedDailyRate: quote.dailyRateUsd,
          expectedMinimumBalance: quote.minimumBalanceUsd,
          expectedMinimumRunwayDays: quote.minimumRunwayDays,
          expectedActivationAuthorityKey:
            personalDedicatedActivationAuthorityKey(
              resolved.selectionActivationAuthority,
            ),
        }),
      );
    } catch (error) {
      // error-policy:J1 the route maps typed adoption conflicts while every
      // other failure continues to the outer HTTP boundary.
      if (error instanceof PersonalDedicatedAdoptionError) {
        logger.warn("[agent-tier-adoption] Adoption transaction rejected", {
          sourceAgentId,
          dedicatedAgentId: resolved.agent.id,
          orgId: user.organization_id,
          userId: user.id,
          phase,
          durationMs: Math.round(performance.now() - startedAt),
          phaseTimingsMs,
          traceId,
          code: error.code,
          error: error.message,
        });
        return adoptionServiceError(error);
      }
      throw error;
    }

    if (result.jobCreated) {
      if (typeof executionCtx?.waitUntil === "function") {
        const trigger = provisioningJobService
          .triggerImmediate(env)
          .catch((error) => {
            // error-policy:J7 the durable job remains observable by the daemon;
            // retain the failed nudge as a structured operational diagnostic.
            logger.warn(
              "[agent-tier-adoption] Immediate provisioning nudge failed",
              {
                sourceAgentId,
                dedicatedAgentId: result.agent.id,
                orgId: user.organization_id,
                jobId: result.job?.id ?? null,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          });
        executionCtx.waitUntil(trigger);
      } else {
        logger.warn(
          "[agent-tier-adoption] Immediate provisioning nudge unavailable; daemon polling retained",
          {
            sourceAgentId,
            dedicatedAgentId: result.agent.id,
            orgId: user.organization_id,
            jobId: result.job?.id ?? null,
          },
        );
      }
    }

    logger.info("[agent-tier-adoption] Existing Dedicated target adopted", {
      sourceAgentId,
      dedicatedAgentId: result.agent.id,
      orgId: user.organization_id,
      alreadyAdopted: result.alreadyAdopted,
      jobId: result.job?.id ?? null,
      startsCompute: quote.startsCompute,
      durationMs: Math.round(performance.now() - startedAt),
      phaseTimingsMs,
      traceId,
    });

    const response = {
      success: true,
      created: false,
      alreadyAdopted: result.alreadyAdopted,
      message: result.job
        ? "Existing Dedicated agent adopted. Poll the same-id provisioning job, then run personal cutover."
        : "Existing running Dedicated agent adopted. Run personal cutover to make it authoritative.",
      data: {
        dedicatedAgentId: result.agent.id,
        sharedAgentId: sourceAgentId,
        status: result.job?.status ?? result.agent.status,
        executionTier: result.agent.execution_tier,
        runtime: "dedicated_pending_cutover" as const,
        ...(result.job
          ? {
              jobId: result.job.id,
              estimatedCompletionAt: result.job.estimated_completion_at,
            }
          : {}),
      },
      ...(result.job ? { polling: pollingBody(result.job.id) } : {}),
    };
    return json(response, result.job ? 202 : 200);
  } catch (error) {
    // error-policy:J1 the HTTP boundary translates request and service
    // failures without fabricating a successful adoption.
    logger.error("[agent-tier-adoption] Adoption request failed", {
      sourceAgentId,
      orgId,
      userId,
      phase,
      durationMs: Math.round(performance.now() - startedAt),
      phaseTimingsMs,
      traceId,
      errorName: error instanceof Error ? error.name : "NonErrorThrown",
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? (error.stack ?? null) : null,
      cause:
        error instanceof Error && error.cause instanceof Error
          ? {
              name: error.cause.name,
              message: error.cause.message,
              stack: error.cause.stack ?? null,
            }
          : null,
    });
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const app = new Hono<AppEnv>();
app.options("/", () => handleCorsOptions(CORS_METHODS));
app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
app.post("/", async (c) => {
  let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // Hono test and non-Worker adapters may not expose an execution context.
    // The durable daemon poll remains authoritative in that case.
    executionCtx = undefined;
  }
  const traceId = c.get("traceId") ?? resolveElizaTraceId(c.req.raw.headers);
  const response = await __hono_POST(
    c.req.raw,
    c.env,
    {
      params: Promise.resolve({ agentId: c.req.param("agentId")! }),
    },
    executionCtx,
    traceId,
  );
  response.headers.set("x-eliza-trace-id", traceId);
  return response;
});

export default app;
