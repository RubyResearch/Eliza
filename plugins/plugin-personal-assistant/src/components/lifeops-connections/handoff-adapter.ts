/** Owner account-switch client boundary, shared by the review and recovery UI. */
import { client } from "@elizaos/ui/api";
import type { LifeOpsElizaClientMethods } from "../../api/client-lifeops.js";

export type AccountHandoffAdapter = Pick<
  LifeOpsElizaClientMethods,
  | "getLifeOpsFamilyEmailOptions"
  | "getLifeOpsHandoffRetirementCandidates"
  | "getLifeOpsHandoffCalendarEntries"
  | "createLifeOpsAccountHandoff"
  | "getActiveLifeOpsAccountHandoff"
  | "getLifeOpsAccountHandoff"
  | "cancelLifeOpsAccountHandoff"
  | "advanceLifeOpsAccountHandoff"
>;

// Renderer boot registers the extensions; type-only imports keep server code out.
export const defaultAccountHandoffAdapter = client as typeof client &
  AccountHandoffAdapter;
