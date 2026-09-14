/**
 * GET/POST /api/v1/eliza/agents/[agentId]/upgrade-tier
 *
 * First-class Shared→Dedicated activation (#15355). GET returns the current
 * server-owned price/balance/runway quote without mutation. POST requires the
 * exact quote plus `activate_dedicated`, then mints and provisions the separate
 * Dedicated migration target. The rowless account-native personal Eliza and
 * older row-backed Shared agents use the same single-flight target service.
 * The Shared service keeps serving the user throughout; client handoff machinery
 * (readiness poll → idempotent transcript import → repoint, see
 * `packages/ui/src/cloud/handoff/`) performs the actual switch once the
 * container is running, and only a confirmed switch deletes the shared bridge.
 *
 * Distinct from `agent_upgrade`/`[agentId]/downgrade`, which are IMAGE
 * blue/green swap/rollback for an existing container — this route changes the
 * agent's execution tier by minting a new dedicated record.
 *
 * Contract:
 *  - 404 unknown agent OR another org's agent (org-scoped read; no oracle).
 *  - 409 when the agent is not shared-tier (nothing to upgrade).
 *  - 402 canonical insufficient-credits body when the org cannot fund
 *    {@link AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS} days of dedicated hosting —
 *    a dedicated agent burns credits continuously, so the gate demands runway,
 *    not the bare create minimum.
 *  - 202 `created:true` + jobId/polling on a fresh mint. Identity is copied
 *    SERVER-side (agent_name / character_id / agent_config / environment_vars):
 *    the compat create route never reads the source row, and clients must not
 *    reconstruct identity from DTOs (onboarding-created shared agents keep
 *    name/bio only in agent_config).
 *  - 2xx `alreadyInProgress:true` reattach when this shared agent already has a
 *    live migration target (the `__agentUpgradedFrom` marker): the single-flight
 *    service (per-source database lock spanning target creation through the
 *    provision enqueue, #15943) makes retries and concurrent tabs resume the
 *    SAME upgrade, with target and job committed atomically — so a reattach
 *    never prepares credentials or environment state; it only reads (or
 *    re-arms, for stopped/sleeping/dead-job targets) durable state.
 */

import { type Context, Hono } from "hono";
import { z } from "zod";
import { errorToResponse } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { AGENT_PRICING } from "@/lib/constants/agent-pricing";
import { getMaxNonTerminalAgentsForOrg } from "@/lib/constants/agent-sandbox-quota";
import { checkAgentTierUpgradeCreditGate } from "@/lib/services/agent-billing-gate";
import { insufficientCredits402 } from "@/lib/services/agent-billing-gate-402";
import {
  createTierUpgradeTargetWithProvision,
  findLiveTierUpgradeTarget,
  PersonalDedicatedAuthorityRetainedError,
  PersonalDedicatedSelectionRequiredError,
} from "@/lib/services/agent-tier-upgrade-target";
import { buildDefaultAgentCharacterConfig } from "@/lib/services/default-agent-character";
import {
  AgentQuotaExceededError,
  elizaSandboxService,
} from "@/lib/services/eliza-sandbox";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import {
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody,
} from "@/lib/services/provisioning-worker-health";
import { applyCorsHeaders, handleCorsOptions } from "@/lib/services/proxy/cors";
import { stripReservedEnvKeys } from "@/lib/services/reserved-env-keys";
import {
  isPersonalSharedAgentId,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const CORS_METHODS = "GET, POST, OPTIONS";
const DEDICATED_QUOTE_VERSION = "personal-dedicated-v2";

const ActivationBody = z.object({
  action: z.literal("activate_dedicated"),
  quoteId: z.string().regex(/^[a-f0-9]{64}$/),
  minimumActivationChargeUsd: z.literal(
    AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
  ),
});

type AgentRow = NonNullable<
  Awaited<ReturnType<typeof elizaSandboxService.getAgentForWrite>>
>;

type AuthedUser = Awaited<
  ReturnType<typeof requireAuthOrApiKeyWithOrg>
>["user"];

type ProvisioningExecutionContext = Pick<
  Context<AppEnv>["executionCtx"],
  "waitUntil"
>;

async function retainProvisioningNudge(
  env: AppEnv["Bindings"],
  executionCtx: ProvisioningExecutionContext | undefined,
  context: {
    sharedAgentId: string;
    dedicatedAgentId: string;
    orgId: string;
    jobId: string;
  },
): Promise<void> {
  const trigger = provisioningJobService
    .triggerImmediate(env)
    .catch((error) => {
      // error-policy:J7 the committed job remains owned by the daemon; retain
      // the failed latency nudge as an operational diagnostic at this boundary.
      logger.warn("[agent-upgrade-tier] Immediate provisioning nudge failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  if (executionCtx) executionCtx.waitUntil(trigger);
  else await trigger;
}

interface UpgradeSource {
  id: string;
  agentName: string;
  executionTier: "shared" | "dedicated-lazy" | "dedicated-always" | "custom";
  status: AgentRow["status"];
  agentConfig: Record<string, unknown>;
  environmentVars: Record<string, string>;
  characterId?: string;
}

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

function asConfigRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asEnvRecord(value: unknown): Record<string, string> {
  const record = asConfigRecord(value);
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

async function resolveUpgradeSource(
  agentId: string,
  user: AuthedUser,
): Promise<UpgradeSource | null> {
  if (isPersonalSharedAgentId(agentId)) {
    const expected = personalSharedAgentId({
      userId: user.id,
      organizationId: user.organization_id,
    });
    if (agentId !== expected) return null;
    return {
      id: expected,
      agentName: "Eliza",
      executionTier: "shared",
      status: "running",
      agentConfig: buildDefaultAgentCharacterConfig(),
      environmentVars: {},
    };
  }

  const row = await elizaSandboxService.getAgentForWrite(
    agentId,
    user.organization_id,
  );
  if (!row) return null;
  return {
    id: row.id,
    agentName: row.agent_name ?? row.id,
    executionTier: row.execution_tier,
    status: row.status,
    agentConfig: asConfigRecord(row.agent_config),
    environmentVars: stripReservedEnvKeys(asEnvRecord(row.environment_vars)),
    ...(row.character_id ? { characterId: row.character_id } : {}),
  };
}

async function quoteIdFor(
  organizationId: string,
  sourceAgentId: string,
  balance: number,
): Promise<string> {
  const input = [
    DEDICATED_QUOTE_VERSION,
    organizationId,
    sourceAgentId,
    balance.toFixed(6),
    AGENT_PRICING.RUNNING_HOURLY_RATE.toFixed(6),
    AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE.toFixed(6),
    AGENT_PRICING.UPGRADE_MINIMUM_BALANCE.toFixed(6),
  ].join(":");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function dedicatedQuote(
  source: UpgradeSource,
  user: AuthedUser,
  existingTarget: AgentRow | null,
) {
  const credit = await checkAgentTierUpgradeCreditGate(user.organization_id);
  const minimumBalanceUsd = AGENT_PRICING.UPGRADE_MINIMUM_BALANCE;
  const balanceUsd = credit.balance;
  const reattachWithoutStartingCompute = Boolean(
    existingTarget &&
      existingTarget.status !== "error" &&
      existingTarget.status !== "stopped" &&
      existingTarget.status !== "sleeping",
  );
  const deficitUsd = Math.max(
    0,
    Math.round((minimumBalanceUsd - balanceUsd) * 100) / 100,
  );
  return {
    quoteId: await quoteIdFor(user.organization_id, source.id, balanceUsd),
    quoteVersion: DEDICATED_QUOTE_VERSION,
    sourceAgentId: source.id,
    currentMode: "shared" as const,
    targetMode: "dedicated" as const,
    hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
    minimumActivationChargeUsd: AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
    dailyRateUsd: AGENT_PRICING.DAILY_RUNNING_COST,
    minimumBalanceUsd,
    minimumRunwayDays: AGENT_PRICING.UPGRADE_MIN_HOSTING_DAYS,
    balanceUsd,
    deficitUsd,
    canActivate: credit.allowed || reattachWithoutStartingCompute,
    requiresConfirmation: true,
    action: "activate_dedicated" as const,
    activation: existingTarget
      ? {
          state: "in_progress" as const,
          dedicatedAgentId: existingTarget.id,
          status: existingTarget.status,
        }
      : { state: "available" as const },
    ...(!credit.allowed && !reattachWithoutStartingCompute && credit.error
      ? { unavailableReason: credit.error }
      : {}),
  };
}

function invalidUpgradeSource(source: UpgradeSource): Response | null {
  if (source.executionTier !== "shared") {
    return json(
      {
        success: false,
        code: "not_shared_tier",
        error:
          "Only Shared Eliza can be activated as Dedicated. This Eliza already runs on dedicated compute.",
      },
      409,
    );
  }
  if (source.status !== "running") {
    return json(
      {
        success: false,
        code: "agent_not_running",
        error:
          "Shared Eliza is not available for Dedicated activation right now.",
      },
      409,
    );
  }
  return null;
}

/**
 * Respond for a live migration target that already owns this upgrade — both
 * the pre-checked reattach and the race loser whose single-flight call
 * returned another request's committed target. Running and
 * already-provisioning targets reattach without a second credit gate: nothing
 * new starts billing. Resuming a stopped/sleeping target does start compute
 * again, so stopped/sleeping/error paths must prove the same dedicated runway as a fresh upgrade
 * before it may enqueue work. The enqueue is safe from any state because a
 * committed target's environment was fully prepared at creation — re-arming a
 * dead job never re-mints credentials.
 */
async function respondToLiveTarget(
  target: AgentRow,
  sharedAgentId: string,
  user: AuthedUser,
  env: AppEnv["Bindings"],
  confirmedQuoteId: string,
  executionCtx: ProvisioningExecutionContext | undefined,
): Promise<Response> {
  logger.info("[agent-upgrade-tier] Reattaching to in-flight upgrade", {
    sharedAgentId,
    dedicatedAgentId: target.id,
    orgId: user.organization_id,
    status: target.status,
  });
  if (target.status === "running") {
    return json({
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: target.status,
        executionTier: target.execution_tier,
      },
    });
  }
  if (
    target.status === "error" ||
    target.status === "stopped" ||
    target.status === "sleeping"
  ) {
    const resumeCreditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!resumeCreditCheck.allowed) {
      return json(
        insufficientCredits402(
          resumeCreditCheck,
          "[agent-upgrade-tier] Resume blocked: insufficient hosting runway",
          {
            sharedAgentId,
            dedicatedAgentId: target.id,
            orgId: user.organization_id,
          },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }
    const currentQuoteId = await quoteIdFor(
      user.organization_id,
      sharedAgentId,
      resumeCreditCheck.balance,
    );
    if (confirmedQuoteId !== currentQuoteId) {
      return json(
        {
          success: false,
          code: "dedicated_quote_changed",
          error:
            "Your Dedicated quote changed before reactivation. Review the latest balance and pricing, then confirm again.",
        },
        409,
      );
    }
  }
  // pending/provisioning (or error/stopped/sleeping after an interrupted boot):
  // hand back the active provision job — enqueue reuses an in-flight job
  // and only mints a new one when the previous attempt died.
  const reattach = await provisioningJobService.enqueueAgentProvisionOnce({
    agentId: target.id,
    organizationId: user.organization_id,
    userId: user.id,
    agentName: target.agent_name ?? target.id,
  });
  if (reattach.created) {
    await retainProvisioningNudge(env, executionCtx, {
      sharedAgentId,
      dedicatedAgentId: target.id,
      orgId: user.organization_id,
      jobId: reattach.job.id,
    });
  }
  return json(
    {
      success: true,
      created: false,
      alreadyInProgress: true,
      data: {
        id: target.id,
        agentId: target.id,
        dedicatedAgentId: target.id,
        sharedAgentId,
        agentName: target.agent_name,
        status: reattach.job.status,
        jobId: reattach.job.id,
        estimatedCompletionAt: reattach.job.estimated_completion_at,
        executionTier: target.execution_tier,
      },
      polling: pollingBody(reattach.job.id),
    },
    202,
  );
}

async function __hono_GET(
  request: Request,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;
    const source = await resolveUpgradeSource(agentId, user);
    if (!source) {
      return json({ success: false, error: "Agent not found" }, 404);
    }
    const sourceError = invalidUpgradeSource(source);
    if (sourceError) return sourceError;
    const existingTarget = await findLiveTierUpgradeTarget(
      user.organization_id,
      source.id,
    );
    return json({
      success: true,
      data: await dedicatedQuote(source, user, existingTarget),
    });
  } catch (error) {
    // error-policy:J1 translate authentication and quote failures at HTTP.
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
  executionCtx: ProvisioningExecutionContext | undefined,
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    const source = await resolveUpgradeSource(agentId, user);
    if (!source) {
      return json({ success: false, error: "Agent not found" }, 404);
    }
    const sourceError = invalidUpgradeSource(source);
    if (sourceError) return sourceError;

    // error-policy:J3 malformed JSON is an explicitly invalid confirmation.
    const confirmation = ActivationBody.safeParse(
      await request.json().catch(() => null),
    );
    if (!confirmation.success) {
      return json(
        {
          success: false,
          code: "dedicated_confirmation_required",
          error:
            "Review the current Dedicated quote and explicitly confirm activation before compute starts.",
        },
        400,
      );
    }

    // ── Reattach: an upgrade for this shared agent is already under way. ──
    const existingTarget = await findLiveTierUpgradeTarget(
      user.organization_id,
      source.id,
    );
    if (existingTarget) {
      return await respondToLiveTarget(
        existingTarget,
        source.id,
        user,
        env,
        confirmation.data.quoteId,
        executionCtx,
      );
    }

    // ── Credit gate: N days of dedicated hosting runway, not the bare create
    // minimum. Same canonical 402 body every other gate emits, carrying the
    // stricter threshold so clients render the real number.
    const creditCheck = await checkAgentTierUpgradeCreditGate(
      user.organization_id,
    );
    if (!creditCheck.allowed) {
      return json(
        insufficientCredits402(
          creditCheck,
          "[agent-upgrade-tier] Upgrade blocked: insufficient hosting runway",
          { sharedAgentId: source.id, orgId: user.organization_id },
          { requiredBalance: AGENT_PRICING.UPGRADE_MINIMUM_BALANCE },
        ),
        402,
      );
    }
    const currentQuoteId = await quoteIdFor(
      user.organization_id,
      source.id,
      creditCheck.balance,
    );
    if (confirmation.data.quoteId !== currentQuoteId) {
      return json(
        {
          success: false,
          code: "dedicated_quote_changed",
          error:
            "Your Dedicated quote changed before activation. Review the latest balance and pricing, then confirm again.",
          data: await dedicatedQuote(source, user, null),
        },
        409,
      );
    }

    // ── Worker health, BEFORE anything durable is minted. The single-flight
    // service commits the target together with its provision job, so a dead
    // worker checked here means nothing gets created at all — no fresh row to
    // roll back, no compensation window. (A worker dying between this check
    // and the commit leaves a valid job the recovering worker picks up.)
    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn(
        "[agent-upgrade-tier] Upgrade blocked: provisioning worker unavailable",
        {
          sharedAgentId: source.id,
          orgId: user.organization_id,
          code: workerHealth.code,
        },
      );
      return json(
        provisioningWorkerFailureBody(workerHealth),
        workerHealth.status,
      );
    }

    // ── Mint the dedicated migration target, copying identity server-side. ──
    // Reserved platform env keys are stripped from the copy so the new agent
    // gets ITS OWN minted tokens/identity (ELIZA_API_TOKEN, ELIZA_CLOUD_AGENT_ID,
    // PUBLIC_BASE_URL, …) while the user's BYO env — including `enc:v1:`
    // ciphertext, which the storage encryptor passes through untouched and the
    // same-org materialization path decrypts — survives verbatim. Environment
    // preparation, target insert, and provision enqueue all happen inside the
    // service's single-flight boundary.
    let result: Awaited<
      ReturnType<typeof createTierUpgradeTargetWithProvision>
    >;
    try {
      result = await createTierUpgradeTargetWithProvision({
        quotaAdmission: "organization",
        sourceAgentId: source.id,
        organizationId: user.organization_id,
        userId: user.id,
        agentName: source.agentName,
        ...(source.characterId ? { characterId: source.characterId } : {}),
        agentConfig: source.agentConfig,
        environmentVars: source.environmentVars,
        maxNonTerminalAgents: getMaxNonTerminalAgentsForOrg(
          creditCheck.balance,
        ),
      });
    } catch (error) {
      // error-policy:J1 translate known activation refusals; propagate others
      // to the outer HTTP error boundary.
      if (error instanceof AgentQuotaExceededError) {
        logger.warn("[agent-upgrade-tier] Upgrade blocked: org quota", {
          sharedAgentId: source.id,
          orgId: user.organization_id,
          count: error.count,
          max: error.max,
        });
        return json(
          {
            success: false,
            code: "agent_quota_exceeded",
            error: error.message,
            currentAgents: error.count,
            maxAgents: error.max,
          },
          429,
        );
      }
      if (error instanceof PersonalDedicatedSelectionRequiredError) {
        return json(
          {
            success: false,
            code: "dedicated_adoption_selection_required",
            error:
              "An existing Dedicated agent is selected for this account. Continue with same-row adoption instead of creating another agent.",
          },
          409,
        );
      }
      if (error instanceof PersonalDedicatedAuthorityRetainedError) {
        return json(
          {
            success: false,
            code: "dedicated_activation_reset_required",
            error:
              "This Personal Eliza has retained Dedicated activation history. Reconcile or reset the retired target before starting another Dedicated activation.",
            retryable: false,
          },
          409,
        );
      }
      throw error;
    }

    // Race loser: another request committed the target (and its job) while
    // this one was in flight — reattach to that durable state.
    if (!result.created) {
      return await respondToLiveTarget(
        result.agent,
        source.id,
        user,
        env,
        confirmation.data.quoteId,
        executionCtx,
      );
    }
    const dedicated = result.agent;
    const job = result.job;

    await retainProvisioningNudge(env, executionCtx, {
      sharedAgentId: source.id,
      dedicatedAgentId: dedicated.id,
      orgId: user.organization_id,
      jobId: job.id,
    });

    logger.info("[agent-upgrade-tier] Upgrade started", {
      sharedAgentId: source.id,
      dedicatedAgentId: dedicated.id,
      orgId: user.organization_id,
      jobId: job.id,
      balance: creditCheck.balance,
    });

    return json(
      {
        success: true,
        created: true,
        message:
          "Dedicated agent created. Provisioning job started — poll the job endpoint, then run the conversation handoff.",
        data: {
          id: dedicated.id,
          agentId: dedicated.id,
          dedicatedAgentId: dedicated.id,
          sharedAgentId: source.id,
          agentName: dedicated.agent_name,
          status: job.status,
          jobId: job.id,
          estimatedCompletionAt: job.estimated_completion_at,
          executionTier: dedicated.execution_tier,
        },
        polling: pollingBody(job.id),
      },
      202,
    );
  } catch (error) {
    // error-policy:J1 preserve the structured HTTP failure contract.
    return applyCorsHeaders(errorToResponse(error), CORS_METHODS);
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.options("/", () => handleCorsOptions(CORS_METHODS));
__hono_app.get("/", async (c) =>
  __hono_GET(c.req.raw, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
__hono_app.post("/", async (c) => {
  let executionCtx: ProvisioningExecutionContext | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // error-policy:J4 non-Worker Hono adapters lack this context; the route
    // awaits the nudge before returning instead of leaving work unobserved.
    executionCtx = undefined;
  }
  return __hono_POST(
    c.req.raw,
    c.env,
    {
      params: Promise.resolve({ agentId: c.req.param("agentId")! }),
    },
    executionCtx,
  );
});
export default __hono_app;
