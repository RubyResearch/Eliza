/** Validates complete native page reads before exposing text or snapshots to the model. */
import { ElizaError } from "@elizaos/core";
import { BrowserDispatchFailure } from "./dispatch-types.js";
import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceCommandResult,
} from "./workspace/browser-workspace-types.js";

// The host supplies the existing authenticated, client-targeted view transport.
// This is not a browser fallback: an unavailable native page must fail closed.
export type NativeBrowserPageReader = (
  clientId: string,
  selector?: string,
) => Promise<unknown>;

export interface NativeBrowserClientTransport {
  readPage: NativeBrowserPageReader;
  navigate: (clientId: string, url?: string) => Promise<void>;
}

export async function readNativeBrowserPage(
  command: BrowserWorkspaceCommand,
  clientId: string,
  pageReader: NativeBrowserPageReader | null,
): Promise<BrowserWorkspaceCommandResult> {
  if (command.id) {
    throw new BrowserDispatchFailure(
      "UNSUPPORTED",
      "A server tab ID cannot identify the current native page. Omit id to read the requesting client's current page; CSS selectors are supported for text reads.",
      { targetId: "native-client" },
    );
  }
  if (
    !(
      command.subaction === "snapshot" ||
      (command.subaction === "get" &&
        (!command.getMode ||
          ["text", "title", "url"].includes(command.getMode)))
    )
  ) {
    throw new BrowserDispatchFailure(
      "UNSUPPORTED",
      "This native page supports current-page snapshot and text/title/URL reads. It will not execute this command against the Mac browser.",
      { targetId: "native-client" },
    );
  }
  if (!pageReader)
    throw new BrowserDispatchFailure(
      "UNAVAILABLE",
      "The requesting native Browser page reader is unavailable.",
      { targetId: "native-client" },
    );
  const result = await pageReader(clientId, command.selector);
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid native Browser page result.");
  const page = result as Record<string, unknown>;
  if (
    typeof page.url !== "string" ||
    typeof page.title !== "string" ||
    typeof page.text !== "string" ||
    typeof page.truncated !== "boolean"
  )
    throw new Error("Invalid native Browser page result.");
  if (page.truncated) {
    throw new ElizaError(
      "Native page read is incomplete. Update the native client or request a complete read with an explicit selector.",
      {
        code: "NATIVE_PAGE_READ_INCOMPLETE",
        context: { clientId, subaction: command.subaction },
      },
    );
  }
  return {
    targetId: "native-client",
    mode: "web",
    subaction: command.subaction,
    value:
      command.subaction === "snapshot"
        ? {
            bodyText: page.text,
            title: page.title,
            url: page.url,
            truncated: page.truncated,
          }
        : command.getMode === "url"
          ? page.url
          : command.getMode === "title"
            ? page.title
            : page.text,
  };
}
