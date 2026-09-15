/**
 * Production-parity seeds for the settings-in-chat live scenarios (#14325,
 * #16939). The scenario runtime factory boots a lean plugin set that omits the
 * @elizaos/agent eliza plugin, which in production registers two pieces these
 * scenarios depend on:
 *
 *  - the `uiWidgets` marker guide provider — without it a live model has never
 *    seen the `[CONFIG:pluginId]` vocabulary and reaches for VIEWS("open the
 *    settings page") instead of emitting the marker;
 *  - the agent-level SETTINGS action (`update_ai_provider` /
 *    `toggle_capability` / … ops). The app-control SETTINGS action that the
 *    lean runtime registers instead explicitly disclaims provider switching
 *    ("switching the model is MODEL_SWITCH"), so a live model — correctly —
 *    refuses to route "switch my provider" through it.
 *
 * In production the eliza plugin registers at runtime construction while
 * app-control lands in the deferred boot wave, so the agent-level SETTINGS is
 * first and wins the name collision (runtime.registerAction keeps the first).
 * These seeds register the REAL production objects (imported from
 * @elizaos/agent, not copies); `override: true` on SETTINGS reproduces the
 * production precedence on a runtime where app-control registered first.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsAction } from "@elizaos/agent/actions/settings-actions";
import { uiWidgetCapabilitiesProvider, uiWidgetsProvider } from "@elizaos/agent/providers/ui-catalog";
import type { Action, Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";

const SEED_PLUGIN_NAME = "scenario-production-agent-settings";

let isolatedConfigPath: string | null = null;

/**
 * Path of the per-run isolated eliza.json the seed pointed the config store
 * at — the domain artifact a finalCheck reads to prove the SETTINGS write
 * actually persisted. Null until the seed has run.
 */
export function seededElizaConfigPath(): string | null {
  return isolatedConfigPath;
}

type PluginRegisteringRuntime = {
  plugins?: Array<{ name?: string }>;
  registerPlugin?: (plugin: Plugin) => Promise<void>;
  registerAction?: (action: Action) => void;
};

/**
 * Registers the production uiWidgets guide provider and the production
 * agent-level SETTINGS action on the scenario runtime. Idempotent so a
 * shared-runtime CLI invocation running several settings scenarios back to
 * back does not double-register.
 */
export function productionAgentSettingsSeed(): ScenarioSeedStep {
  return {
    type: "custom",
    name: "register the production uiWidgets guide + agent-level SETTINGS action",
    apply: async (ctx: ScenarioContext) => {
      const runtime = ctx.runtime as PluginRegisteringRuntime | null;
      if (!runtime?.registerPlugin || !runtime.registerAction) {
        return "runtime.registerPlugin/registerAction unavailable";
      }
      // The agent-level SETTINGS handler persists through the real config
      // store (loadElizaConfig/saveElizaConfig). Point BOTH the read resolver
      // (ELIZA_CONFIG_PATH) and the write resolver (ELIZA_PERSIST_CONFIG_PATH)
      // at a per-run temp file — same isolation as
      // settings-chat-config-ops.test.ts — so a live scenario run can never
      // touch the host's real ~/.local/state/eliza/eliza.json, and the
      // persisted write is inspectable as a domain artifact afterwards.
      if (!isolatedConfigPath) {
        const dir = mkdtempSync(join(tmpdir(), "scenario-settings-config-"));
        isolatedConfigPath = join(dir, "eliza.json");
        writeFileSync(isolatedConfigPath, JSON.stringify({}));
        process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
        process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
      }
      const alreadyRegistered = (runtime.plugins ?? []).some(
        (plugin) => plugin.name === SEED_PLUGIN_NAME,
      );
      if (alreadyRegistered) {
        return undefined;
      }
      await runtime.registerPlugin({
        name: SEED_PLUGIN_NAME,
        description:
          "Scenario fixture: registers the production uiWidgets marker guide " +
          "and the production agent-level SETTINGS action (both normally " +
          "carried by the @elizaos/agent eliza plugin) so settings-in-chat " +
          "live scenarios run against the runtime shape production ships.",
        providers: [uiWidgetCapabilitiesProvider, uiWidgetsProvider],
      });
      // Direct host-path registration: `override` is honored here (the
      // registerPlugin path downgrades it to first-wins), and app-control's
      // SETTINGS is already registered by the time seeds run.
      runtime.registerAction({ ...settingsAction, override: true });
      return undefined;
    },
  };
}
