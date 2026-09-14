// Handles v1 cloud API v1 eliza agents agentid wake route traffic with route-local auth expectations.
import { Hono } from "hono";
import { z } from "zod";
import { errorToResponse, ValidationError } from "@/lib/api/errors";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
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

// Strict: this body selects between integrity-relevant wake modes, so an
// unrecognized key (e.g. a typo'd `restoreBackupID`) must be a 400, not a
// silently-ignored field that turns an explicit restore-point/fresh-boot
// choice into the default latest-backup wake.
const wakeSchema = z.strictObject({
  restoreBackupId: z.string().uuid().optional(),
  forceFreshBoot: z.boolean().optional(),
});

/** Backups inspected when validating an explicit restoreBackupId (retention keeps ~10 restore points + chain ancestors). */
const RESTORE_BACKUP_LOOKUP_LIMIT = 100;

/**
 * POST /api/v1/eliza/agents/[agentId]/wake
 *
 * Enqueues an `agent_wake` job — the inverse of `/sleep`. The daemon runs the
 * restore-integrity gate (#15603 B6) before touching compute: the backup the
 * wake would restore must decrypt + hash-verify, otherwise the job fails with
 * a typed error and the sandbox stays `sleeping`. Two explicit opt-ins in the
 * JSON body (both default OFF, mutually exclusive):
 *   - `restoreBackupId` — wake from a specific (typically older, validated)
 *     backup after the latest failed the gate.
 *   - `forceFreshBoot` — boot the agent empty, explicitly accepting data loss.
 *
 * Because waking spins up paid compute, the org must clear the same credit
 * gate as resume/provision.
 *
 * Returns 202 with the job id; clients poll `/api/v1/jobs/<id>`. Idempotent.
 */
async function __hono_POST(
  request: Request,
  env: AppEnv["Bindings"],
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(request);
    const { agentId } = await params;

    // Every field is optional, so a bodyless POST is the canonical "wake with
    // the latest validated backup" call — treat an empty body as `{}`.
    // Malformed non-empty JSON is the caller's fault: a typed 400, not the
    // unguarded SyntaxError that errorToResponse maps to a 500.
    const rawBody = await request.text();
    let body: unknown = {};
    if (rawBody.trim().length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // error-policy:J3 untrusted request body — malformed JSON becomes a typed 400 "invalid" result
        throw new ValidationError("Invalid JSON body");
      }
    }
    const parsed = wakeSchema.safeParse(body);
    if (!parsed.success) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "Invalid request",
            details: parsed.error.issues,
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }
    const { restoreBackupId, forceFreshBoot } = parsed.data;
    if (restoreBackupId && forceFreshBoot) {
      return applyCorsHeaders(
        Response.json(
          {
            success: false,
            error: "restoreBackupId and forceFreshBoot are mutually exclusive",
          },
          { status: 400 },
        ),
        CORS_METHODS,
      );
    }

    logger.info("[agent-api] Wake requested", {
      agentId,
      orgId: user.organization_id,
      restoreBackupId,
      forceFreshBoot,
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

    if (agent.execution_tier === "shared") {
      return applyCorsHeaders(
        Response.json({
          success: true,
          source: "shared_runtime",
          data: {
            agentId,
            action: "wake",
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
            action: "wake",
            message: "Agent is already running",
            status: agent.status,
          },
        }),
        CORS_METHODS,
      );
    }

    if (restoreBackupId) {
      // Fail fast on a restore point the daemon gate would refuse anyway.
      // Ownership check uses backup METADATA only (no payload decrypt in the
      // Worker); a backup belonging to another agent is indistinguishable from
      // a missing one so backup ids are not a cross-agent existence oracle.
      const backups = await elizaSandboxService.listBackups(
        agentId,
        user.organization_id,
        RESTORE_BACKUP_LOOKUP_LIMIT,
      );
      const requested = backups.find((b) => b.id === restoreBackupId);
      if (!requested) {
        return applyCorsHeaders(
          Response.json(
            { success: false, error: "No backup found" },
            { status: 404 },
          ),
          CORS_METHODS,
        );
      }
      if (requested.verification_status === "failed") {
        return applyCorsHeaders(
          Response.json(
            {
              success: false,
              error:
                `Backup ${restoreBackupId} previously failed restore-integrity ` +
                `verification (${requested.verification_error ?? "unknown failure"}). ` +
                "Choose a different backup, or retry with forceFreshBoot to boot " +
                "empty and accept the data loss.",
            },
            { status: 409 },
          ),
          CORS_METHODS,
        );
      }
    }

    // Credit gate: waking provisions paid compute.
    const priceError = requireDedicatedComputePriceAcceptance(request);
    if (priceError) return applyCorsHeaders(priceError, CORS_METHODS);
    const creditCheck = await checkAgentCreditGate(user.organization_id);
    if (!creditCheck.allowed) {
      const body = insufficientCredits402(
        creditCheck,
        "[agent-api] Wake blocked: insufficient credits",
        { agentId, orgId: user.organization_id },
      );
      return applyCorsHeaders(
        Response.json(body, { status: 402 }),
        CORS_METHODS,
      );
    }

    const workerHealth = await checkProvisioningWorkerHealth();
    if (!workerHealth.ok) {
      logger.warn("[agent-api] Wake blocked: provisioning worker unavailable", {
        agentId,
        orgId: user.organization_id,
        code: workerHealth.code,
      });
      return applyCorsHeaders(
        Response.json(provisioningWorkerFailureBody(workerHealth), {
          status: workerHealth.status,
        }),
        CORS_METHODS,
      );
    }

    const enqueueResult = await provisioningJobService.enqueueAgentWakeOnce({
      agentId,
      organizationId: user.organization_id,
      userId: user.id,
      restoreBackupId,
      forceFreshBoot,
    });

    void provisioningJobService.triggerImmediate(env).catch(() => {
      // Logged inside the service; nothing actionable here.
    });

    logger.info("[agent-api] Agent wake enqueued", {
      agentId,
      orgId: user.organization_id,
      jobId: enqueueResult.job.id,
      created: enqueueResult.created,
    });

    return applyCorsHeaders(
      Response.json(
        {
          success: true,
          created: enqueueResult.created,
          alreadyInProgress: !enqueueResult.created,
          data: {
            agentId,
            action: "wake",
            jobId: enqueueResult.job.id,
            status: enqueueResult.job.status,
            previousStatus: agent.status,
            // The params the in-flight job will actually apply — a reused job
            // keeps its own params, and a conflicting request 409s in the
            // enqueue instead of silently echoing values that were dropped.
            restoreBackupId: enqueueResult.appliedRestoreBackupId,
            forceFreshBoot: enqueueResult.appliedForceFreshBoot,
            message: enqueueResult.created
              ? "Wake job created. Poll the job endpoint for status."
              : "Wake is already in progress.",
          },
          polling: {
            endpoint: `/api/v1/jobs/${enqueueResult.job.id}`,
            intervalMs: 5000,
            expectedDurationMs: 90000,
          },
        },
        { status: enqueueResult.created ? 202 : 409 },
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
  __hono_POST(c.req.raw, c.env, {
    params: Promise.resolve({ agentId: c.req.param("agentId")! }),
  }),
);
export default __hono_app;
