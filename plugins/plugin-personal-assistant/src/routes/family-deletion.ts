/**
 * Exposes reviewed family deletion through the existing owner-authorized HTTP boundary.
 * Status and retry require the runtime, not an active family workflow service,
 * so interrupted cleanup remains observable after workspace revocation.
 */
import { ElizaError } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { z } from "zod";
import { previewFamilyDeletionDatabase } from "../lifeops/family-workflows/deletion-database-snapshot.js";
import {
  admitFamilyBackupCleanup,
  beginFamilyWorkspaceDeletion,
  previewFamilyBackupCleanup,
  purgeFamilyBackupCleanup,
  purgeFamilyWorkspaceFiles,
  readFamilyDeletionJob,
} from "../lifeops/family-workflows/workspace-deletion.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const prefix = "/api/lifeops/family-workflows/deletion";
const confirmation = z.strictObject({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  backupRetention: z.enum(["immediate", "7-days", "30-days"]),
});
const backupConfirmation = z.strictObject({
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  acknowledgeWholeArchiveHistory: z.literal(true),
});

export async function handleFamilyDeletionRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { method, pathname, req, res, json, readJsonBody } = ctx;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  res.setHeader("Cache-Control", "no-store");
  const runtime = ctx.state.runtime;
  if (!runtime) {
    ctx.error(res, "Agent runtime is not available", 503);
    return true;
  }
  try {
    if (method === "GET" && pathname === `${prefix}/backups/preview`) {
      json(res, await previewFamilyBackupCleanup(runtime, SELF_ENTITY_ID));
      return true;
    }
    if (method === "POST" && pathname === `${prefix}/backups`) {
      const body = await readJsonBody<z.infer<typeof backupConfirmation>>(
        req,
        res,
      );
      if (!body) return true;
      const parsed = backupConfirmation.safeParse(body);
      if (!parsed.success) {
        json(
          res,
          {
            code: "FAMILY_DELETION_INVALID_CONFIRMATION",
            error:
              "Review every eligible backup and acknowledge removal of its whole archived history",
          },
          400,
        );
        return true;
      }
      const admitted = await admitFamilyBackupCleanup(runtime, {
        ...parsed.data,
        ownerEntityId: SELF_ENTITY_ID,
      });
      if (
        admitted.backupCleanup &&
        Date.now() < Date.parse(admitted.backupCleanup.notBefore)
      ) {
        json(res, { job: admitted }, 202);
        return true;
      }
      json(res, {
        job: await purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID),
      });
      return true;
    }
    if (method === "POST" && pathname === `${prefix}/backups/resume`) {
      json(res, {
        job: await purgeFamilyBackupCleanup(runtime, SELF_ENTITY_ID),
      });
      return true;
    }
    if (method === "GET" && pathname === `${prefix}/preview`) {
      json(res, await previewFamilyDeletionDatabase(runtime, SELF_ENTITY_ID));
      return true;
    }
    if (method === "GET" && pathname === prefix) {
      json(res, { job: await readFamilyDeletionJob(runtime, SELF_ENTITY_ID) });
      return true;
    }
    if (method === "POST" && pathname === prefix) {
      const body = await readJsonBody<z.infer<typeof confirmation>>(req, res);
      if (!body) return true;
      const parsed = confirmation.safeParse(body);
      if (!parsed.success) {
        json(
          res,
          {
            error: "Review the workspace and choose a backup retention policy",
            code: "FAMILY_DELETION_INVALID_CONFIRMATION",
          },
          400,
        );
        return true;
      }
      await beginFamilyWorkspaceDeletion(runtime, {
        ...parsed.data,
        ownerEntityId: SELF_ENTITY_ID,
      });
      json(
        res,
        { job: await purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID) },
        202,
      );
      return true;
    }
    if (method === "POST" && pathname === `${prefix}/resume`) {
      json(
        res,
        { job: await purgeFamilyWorkspaceFiles(runtime, SELF_ENTITY_ID) },
        202,
      );
      return true;
    }
    ctx.error(res, "Family deletion route not found", 404);
    return true;
  } catch (cause) {
    // error-policy:J1 Keep partial cleanup visible without exposing SQL payloads or private source content.
    const code =
      cause instanceof ElizaError ? cause.code : "FAMILY_DELETION_FAILED";
    const status =
      code === "FAMILY_DELETION_ACCESS_DENIED"
        ? 403
        : code === "FAMILY_DELETION_NOT_FOUND"
          ? 404
          : [
                "FAMILY_DELETION_PREVIEW_STALE",
                "FAMILY_DELETION_WORK_UNSETTLED",
                "FAMILY_DELETION_SHARED_SOURCE",
                "AGENT_BACKUP_AUTHORITY_UNAVAILABLE",
                "AGENT_BACKUP_RETIREMENT_PENDING",
                "AGENT_BACKUP_CLEANUP_STALE",
                "AGENT_BACKUP_RETENTION_PENDING",
                "FAMILY_DELETION_BACKUP_REVIEW_REQUIRED",
              ].includes(code)
            ? 409
            : 500;
    json(
      res,
      {
        code,
        error:
          cause instanceof ElizaError
            ? cause.message
            : "Deletion did not complete. Check its status before retrying.",
      },
      status,
    );
    return true;
  }
}
