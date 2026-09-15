/**
 * User name provider — injects the user's display name into the system prompt
 * when chatting via the app (client_chat). Tells the agent the user's name if
 * known, or hints that it can ask.
 *
 * Only active for `source === "client_chat"` so it never leaks into Telegram,
 * Discord, or other connectors.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { fetchConfiguredOwnerName } from "../services/owner-name.ts";

export function createUserNameProvider(): Provider {
  return {
    name: "userName",
    description:
      "Injects the app user's display name into context (app chat only).",
    descriptionCompressed: "inject app user display name context (app chat)",
    position: 10,
    dynamic: true,
    contexts: ["general"],
    contextGate: { anyOf: ["general"] },
    cacheStable: false,
    cacheScope: "turn",
    // #12087 Item 14: was USER but the body enforced OWNER (hasOwnerAccess).
    // Declared roleGate is now enforced by applyPluginRoleGating.
    roleGate: { minRole: "OWNER" },

    async get(
      _runtime: IAgentRuntime,
      message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      const content = message.content as Record<string, unknown> | undefined;
      if (content?.source !== MESSAGE_SOURCE_CLIENT_CHAT) {
        return { text: "" };
      }

      const name = await fetchConfiguredOwnerName();

      if (name) {
        return {
          text: `Configured app display name: ${name}. Entity aliases may include earlier names; follow explicit conversational corrections.`,
          values: { userName: name },
        };
      }

      return {
        text: "App display name unset (fallback: admin). SETTINGS op=set_owner_name stores an explicitly requested display name.",
        values: { userName: "admin", userNameFallback: true },
      };
    },
  };
}
