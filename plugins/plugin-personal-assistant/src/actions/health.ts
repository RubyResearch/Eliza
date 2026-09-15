/**
 * OWNER_HEALTH action wiring — binds the `@elizaos/plugin-health` action
 * factories to LifeOps owner-access control. Health domain logic lives in
 * plugin-health; this module only constructs the owner-facing wrapper and
 * re-exports the shared parameters and similes for `owner-surfaces.ts`.
 */
import { recentConversationTexts } from "@elizaos/core";
import {
  createHealthActionRunner,
  createOwnerHealthAction,
  HEALTH_PARAMETERS,
  HEALTH_SIMILES,
} from "@elizaos/plugin-health";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  type LifeOpsModelType,
  runLifeOpsJsonModel,
} from "../lifeops/google/format-helpers.js";
import { resolveOwnerTimeZone } from "../lifeops/owner/fact-store.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  messageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";

export { createOwnerHealthAction, HEALTH_PARAMETERS, HEALTH_SIMILES };

export const runHealthHandler = createHealthActionRunner({
  hasAccess: hasLifeOpsAccess,
  createService: (runtime) => new LifeOpsService(runtime),
  messageText,
  resolveTimeZone: (runtime) => resolveOwnerTimeZone(runtime, new Date()),
  renderReply: renderLifeOpsActionReply,
  recentConversationTexts,
  // The runner types modelType as the broad ModelTypeName; LifeOps's call args
  // want the model-enum subset. The runner only ever passes a standard ModelType
  // value, so narrow at the boundary.
  runJsonModel: (args) =>
    runLifeOpsJsonModel({
      ...args,
      modelType: args.modelType as LifeOpsModelType,
    }),
});
