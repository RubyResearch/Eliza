/**
 * GET_APP — "tell me about app X".
 *
 * Resolves an app by id or name from the user's text (or planner-supplied
 * options), then formats a detail block. Id-shaped references take the direct
 * `client.getApp(id)` path; names resolve via `client.listApps()` +
 * find-by-name. Read-only: no mutating calls.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  appReferenceLogView,
  describeAppReference,
  extractAppReference,
  findAppByReference,
  formatAppDetail,
  getCloudClient,
  looksLikeAppId,
  resolveCloudApiKey,
} from "../client.js";

const NO_KEY_MESSAGE =
  "I can't reach Eliza Cloud yet — no Cloud API key is configured. Add your ELIZAOS_CLOUD_API_KEY and I can look up your apps.";
const NO_REFERENCE_MESSAGE =
  "Which app would you like to know about? Tell me its name and I'll pull up the details.";
const ERROR_MESSAGE =
  "I couldn't fetch that app's details right now — the Cloud API returned an error. Try again in a moment.";

function notFoundMessage(reference: string, available: string[]): string {
  const base = `I couldn't find an app matching ${describeAppReference(reference)}.`;
  if (available.length === 0) {
    return `${base} You don't have any apps on Eliza Cloud yet.`;
  }
  return `${base} Your apps are: ${available.join(", ")}.`;
}

// Duck-typed view of the SDK CloudApiError `statusCode` (same shape as
// cloudApiStatusCode in deploy-gate.ts) so the guard below does not need to
// import the error class.
function cloudApiStatusCode(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const value = (err as Record<string, unknown>).statusCode;
  return typeof value === "number" ? value : null;
}

export const getAppAction: Action = {
  name: "GET_APP",
  similes: [
    "APP_DETAILS",
    "SHOW_APP",
    "TELL_ME_ABOUT_APP",
    "APP_INFO",
    "DESCRIBE_APP",
  ],
  description:
    "Show details about one specific Eliza Cloud app the user owns (URL, deployment status, credits used, earnings, users). Use when the user asks about a particular app by name or id.",
  descriptionCompressed: "Show details for one Eliza Cloud app by name/id.",
  contexts: ["settings", "finance", "apps"],
  contextGate: { anyOf: ["settings", "finance", "apps"] },

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    return resolveCloudApiKey(runtime) !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const client = getCloudClient(runtime);
    if (!client) {
      await callback?.({ text: NO_KEY_MESSAGE, actions: ["GET_APP"] });
      return {
        success: false,
        text: "No Eliza Cloud API key configured.",
        userFacingText: NO_KEY_MESSAGE,
        data: { reason: "no_key" },
      };
    }

    const reference = extractAppReference(message, options);
    if (!reference) {
      await callback?.({ text: NO_REFERENCE_MESSAGE, actions: ["GET_APP"] });
      return {
        success: false,
        text: "No app reference supplied.",
        userFacingText: NO_REFERENCE_MESSAGE,
        data: { reason: "no_reference" },
      };
    }

    try {
      // Id-shaped reference → direct single-app fetch.
      if (looksLikeAppId(reference)) {
        // A stale/foreign UUID makes getApp throw a 404/403; that must fall
        // through to list-based resolution and its helpful which-app reply,
        // not land in the outer catch as a generic error the user can never
        // retry past. Mirrors resolveApp (#29908) and resolveDomainTargetApp.
        // The try guards ONLY the fetch: formatting, delivery and the return
        // stay outside, so a failed callback on the happy path still reaches
        // the outer catch and reports failure (#29917).
        let app: Awaited<ReturnType<typeof client.getApp>>["app"] | undefined;
        try {
          ({ app } = await client.getApp(reference));
        } catch (err) {
          // error-policy:J4 degrade ONLY the benign not-found/forbidden
          // statuses to the list-based which-app reply. A 5xx from the id
          // endpoint is an outage, not evidence the app is gone: reporting
          // not_found there would tell the user their app does not exist
          // (#29917 review). Anything else is re-raised into the outer catch.
          const status = cloudApiStatusCode(err);
          if (status !== 404 && status !== 403) throw err;
          app = undefined;
        }
        if (app) {
          const detail = formatAppDetail(app);
          await callback?.({ text: detail, actions: ["GET_APP"] });
          return {
            success: true,
            text: `Fetched app ${app.name}.`,
            userFacingText: detail,
            verifiedUserFacing: true,
            data: { app: { id: app.id, name: app.name, slug: app.slug } },
          };
        }
      }

      // Name/slug reference → list + find.
      const { apps } = await client.listApps();
      const found = findAppByReference(apps ?? [], reference);
      if (!found) {
        const names = (apps ?? []).map((a) => a.name);
        const msg = notFoundMessage(reference, names);
        await callback?.({ text: msg, actions: ["GET_APP"] });
        return {
          success: false,
          text: `No app matched "${appReferenceLogView(reference)}".`,
          userFacingText: msg,
          data: {
            reason: "not_found",
            reference: appReferenceLogView(reference),
          },
        };
      }

      const detail = formatAppDetail(found);
      await callback?.({ text: detail, actions: ["GET_APP"] });
      return {
        success: true,
        text: `Fetched app ${found.name}.`,
        userFacingText: detail,
        verifiedUserFacing: true,
        data: { app: { id: found.id, name: found.name, slug: found.slug } },
      };
    } catch (err) {
      logger.warn(
        `[GET_APP] Failed to fetch app "${appReferenceLogView(reference)}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      await callback?.({ text: ERROR_MESSAGE, actions: ["GET_APP"] });
      return {
        success: false,
        text: "Failed to fetch Eliza Cloud app.",
        userFacingText: ERROR_MESSAGE,
        error: err instanceof Error ? err : new Error(String(err)),
        data: { reason: "error" },
      };
    }
  },

  examples: [
    [
      { name: "{{user}}", content: { text: "tell me about my Acme Bot app" } },
      {
        name: "{{agent}}",
        content: {
          text: "Acme Bot (acme-bot)\nURL: https://acme.apps.eliza.app\nStatus: deployed\nCredits used: $12.40",
          actions: ["GET_APP"],
        },
      },
    ],
  ],
};

export default getAppAction;
