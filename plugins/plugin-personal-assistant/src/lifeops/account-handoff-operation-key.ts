/** Keeps handoff pause and release operation identities stable across retries and process restarts. */
import { createHash } from "node:crypto";
export function accountHandoffOperationKey(
  agentId: string,
  ownerEntityId: string,
  operationId: string,
  step: "pause" | "resume_calendar",
): string {
  return `account-handoff:${createHash("sha256")
    .update(JSON.stringify([agentId, ownerEntityId, operationId, step]))
    .digest("hex")}`;
}
