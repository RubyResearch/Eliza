/**
 * Browser workspace provider — surfaces the live browser-workspace tab list
 * and current dispatch mode (`desktop` / `web`) into agent context whenever
 * a `browser` or `web` context is selected.
 *
 * Does not include wallet state; an agent that needs wallet context gets it
 * from the wallet provider instead of coupling it to browser workspace state.
 */

import type { Provider } from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
import {
  BROWSER_SERVICE_TYPE,
  type BrowserService,
} from "../browser-service.js";
import {
  getBrowserWorkspaceMode,
  listBrowserWorkspaceTabs,
} from "../workspace/browser-workspace.js";

const PROVIDER_NAME = "browser_workspace";

export const browserWorkspaceProvider: Provider = {
  name: PROVIDER_NAME,
  description:
    "Live summary of the Eliza browser workspace — current dispatch mode and the complete open tab list.",
  descriptionCompressed: "Browser workspace mode + open tab list.",
  contexts: ["browser", "web"],
  contextGate: { anyOf: ["browser", "web"] },
  cacheStable: false,
  cacheScope: "turn",
  // Live browser workspace (dispatch mode + open tabs/URLs) is owner-operator
  // context (#12094 item 3: gate travels with the provider so a rename can't
  // silently drop it).
  roleGate: { minRole: "OWNER" },
  get: async (runtime, message) => {
    if (asRecord(message.content?.metadata)?.uiBrowserSurface === "native") {
      return {
        text: JSON.stringify({
          browser_workspace: {
            target: "native-client",
            description:
              "The requesting client's native Browser page. BROWSER open/navigate/show target this client's Browser view. For open-and-read, navigate to the requested URL then read the native page to verify it loaded. A read alone does not open a closed view; use VIEWS show Browser first when needed. Use BROWSER snapshot or get text/title/url to observe it. Do not use Mac workspace tab IDs or assume their page content matches this client.",
            supportedReads: ["snapshot", "get text", "get title", "get url"],
          },
        }),
        data: { nativeClient: true, availableTargetIds: ["native-client"] },
      };
    }
    try {
      const mode = getBrowserWorkspaceMode();
      const tabs = await listBrowserWorkspaceTabs();
      const service = runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE);
      const targets = service ? await service.resolveTargets() : [];
      const text = JSON.stringify(
        {
          [PROVIDER_NAME]: {
            target: "workspace",
            availableTargets: targets.map((target) => ({
              id: target.id,
              description: target.description,
            })),
            mode,
            tabCount: tabs.length,
            tabs: tabs.map((tab) => ({
              id: tab.id,
              visible: tab.visible,
              url: tab.url,
              title: tab.title,
            })),
          },
        },
        null,
        2,
      );
      return {
        text,
        data: {
          available: true,
          availableTargetIds: targets.map((target) => target.id),
          mode,
          tabs,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        text: JSON.stringify(
          {
            [PROVIDER_NAME]: {
              available: false,
              error: message,
            },
          },
          null,
          2,
        ),
        data: { available: false, error: message },
      };
    }
  },
};
