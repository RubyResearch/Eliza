/**
 * OWNER_SCREENTIME action wiring — binds the `@elizaos/plugin-health`
 * screen-time factories to LifeOps. Screen-time planning lives in plugin-health
 * (macOS only, platform-gated in `plugin.ts`); this module only constructs the
 * owner-facing wrapper and re-exports the shared parameters and similes.
 */
import { resolveActionArgs } from "@elizaos/core";
import {
  createOwnerScreenTimeAction,
  createScreenTimeActionRunner,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
} from "@elizaos/plugin-health";
import {
  getActivityReport,
  getTimeOnApp,
} from "../activity-profile/activity-tracker-reporting.js";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  getBrowserActivitySnapshot,
  getBrowserDomainActivity,
} from "../lifeops/browser-extension-store.js";
import { resolveOwnerTimeZone } from "../lifeops/owner/fact-store.js";
import { LifeOpsService } from "../lifeops/service.js";
import {
  messageText,
  renderLifeOpsActionReply,
} from "../lifeops/voice/grounded-reply.js";
import { isDarwin } from "../platform/host.js";

export {
  createOwnerScreenTimeAction,
  SCREEN_TIME_PARAMETERS,
  SCREEN_TIME_SIMILES,
};

export const runScreenTimeHandler = createScreenTimeActionRunner({
  hasAccess: hasLifeOpsAccess,
  createService: (runtime) => new LifeOpsService(runtime),
  messageText,
  resolveTimeZone: (runtime) => resolveOwnerTimeZone(runtime, new Date()),
  renderReply: renderLifeOpsActionReply,
  resolveActionArgs,
  isDarwin,
  getActivityReport,
  getTimeOnApp,
  getBrowserDomainActivity,
  // The runner's BrowserActivitySnapshot types domains as a mutable array; our
  // store returns it readonly. Return a shallow mutable copy at the boundary so
  // the (read-only) consumer's contract is satisfied without weakening ours.
  getBrowserActivitySnapshot: async (runtime, opts) => {
    const snapshot = await getBrowserActivitySnapshot(runtime, opts);
    return { ...snapshot, domains: [...snapshot.domains] };
  },
});
