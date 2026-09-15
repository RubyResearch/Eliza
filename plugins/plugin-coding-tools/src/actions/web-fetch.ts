/**
 * WEB_FETCH gives the headless coding agent a direct, hardened URL reader.
 * The action is intentionally plugin-local so coding-only examples do not need
 * the full agent runtime action bundle, while the network guard remains shared
 * through core.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { stripHtmlRawTextElements, toWellFormedUnicode } from "@elizaos/core";
import {
  failureToActionResult,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { guardedTextHttpRequest } from "../lib/web-http.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

/**
 * Capability kill switch, mirroring the agent-runtime WEB_FETCH action:
 * `ELIZA_WEB_FETCH=0|false|off` disables outbound fetches. Checked at
 * `validate` AND at handler entry so a disabled capability never runs even
 * when the action was registered or invoked through another path.
 */
export function isCodingWebFetchEnabled(): boolean {
  const raw = process.env.ELIZA_WEB_FETCH?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function decodeHtmlEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  if (entity.startsWith("#")) {
    const code = entity.startsWith("#x")
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    // Exclude the UTF-16 surrogate range as well as values outside Unicode.
    // Once this scalar-value guard passes, String.fromCodePoint cannot throw.
    const isUnicodeScalarValue =
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 0x10ffff &&
      (code < 0xd800 || code > 0xdfff);
    return isUnicodeScalarValue ? String.fromCodePoint(code) : `&${entity};`;
  }
  return named[entity] ?? `&${entity};`;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ +([.,;:!?])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToReadableText(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const withoutNoise = stripHtmlRawTextElements(html)
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ");
  const text = withoutNoise
    .replace(
      /<\/?(?:h[1-6]|p|div|section|article|main|header|footer|li|ul|ol|tr|br)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<[^>]+>/g, " ")
    .replace(
      /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g,
      (_m, entity: string) => decodeHtmlEntity(entity),
    );
  const body = normalizeWhitespace(text);
  const normalizedTitle = title
    ? normalizeWhitespace(
        title.replace(
          /&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g,
          (_m, entity: string) => decodeHtmlEntity(entity),
        ),
      )
    : "";
  if (normalizedTitle && !body.startsWith(normalizedTitle)) {
    return normalizeWhitespace(`${normalizedTitle}\n\n${body}`);
  }
  return body;
}

const MAX_JSON_EXTRACT_DEPTH = 16;
const MAX_JSON_EXTRACT_PATH_LENGTH = 1024;
const MAX_JSON_EXTRACT_SEGMENT_LENGTH = 256;

function resolveJsonPath(root: unknown, path: string): unknown {
  if (path.length === 0 || path.length > MAX_JSON_EXTRACT_PATH_LENGTH)
    return undefined;
  const segments = path.split(".");
  if (segments.length === 0 || segments.length > MAX_JSON_EXTRACT_DEPTH)
    return undefined;
  let current = root;
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment.length > MAX_JSON_EXTRACT_SEGMENT_LENGTH
    )
      return undefined;
    if (current === null || typeof current !== "object") return undefined;
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current as object, segment);
    } catch {
      return undefined;
    }
    if (!descriptor || !("value" in descriptor)) return undefined;
    current = descriptor.value;
  }
  return current;
}

function extractBody(
  body: string,
  contentType: string,
  extract: string | undefined,
): { value: string; kind: "html" | "json" | "text" } {
  const type = contentType.toLowerCase();
  const trimmed = body.trim();
  if (type.includes("html")) {
    return { value: htmlToReadableText(body), kind: "html" };
  }
  if (
    type.includes("json") ||
    (!type && (trimmed.startsWith("{") || trimmed.startsWith("[")))
  ) {
    try {
      const parsed = JSON.parse(body) as unknown;
      const selected = extract ? resolveJsonPath(parsed, extract) : parsed;
      // A fuzzy or unresolved extract path must not hard-fail the fetch: fall back
      // to the full JSON so the model can still read it and pick out what it needs,
      // rather than surfacing an io_error for a best-effort path hint.
      const jsonValue = extract && selected === undefined ? parsed : selected;
      return { value: JSON.stringify(jsonValue), kind: "json" };
    } catch {
      // error-policy:J4 Malformed JSON falls back to raw text extraction rather than failing
      return { value: body.trim(), kind: "text" };
    }
  }
  return { value: body.trim(), kind: "text" };
}

export const webFetchAction: Action = {
  name: "WEB_FETCH",
  // "web" belongs alongside the coding contexts: stage-1's routing vocabulary
  // names `web` for live-lookup turns, and an action literally named
  // WEB_SEARCH/WEB_FETCH being unreachable from the `web` context left
  // candidate-less web turns with no web tool on the planner surface
  // (observed live: a weather+note composite surfaced only the CONTACT
  // family).
  contexts: [...CODING_TOOLS_CONTEXTS, "web"],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS, "web"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["LOOKUP_WEB", "WEB_LOOKUP", "FETCH_URL", "HTTP_GET", "GET_URL"],
  routingHint:
    "fetch ONE specific URL, JSON API, or data file whose address you have or can construct exactly -> WEB_FETCH; this is the exact-and-fresh path for live NOW-values: spot crypto price -> https://api.coingecko.com/api/v3/simple/price?ids=<coin>&vs_currencies=usd, current weather -> https://wttr.in/<city>?format=j1; to discover pages with no constructable URL -> WEB_SEARCH",
  description:
    "Fetch one specific public HTTPS URL and return readable text. Supports HTML extraction, JSON, and plain text. Prefer this over WEB_SEARCH for live NOW-values (spot prices, exchange rates, current weather) by constructing the live API URL yourself. Blocks private/internal hosts, redirects to private/internal hosts, non-HTTPS URLs, binary content, oversized reads, and timeouts.",
  parameters: [
    {
      name: "url",
      description: "Absolute public https URL to fetch.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "extract",
      description: "Optional dotted JSON path when the response is JSON.",
      required: false,
      schema: { type: "string" },
    },
  ],
  validate: async () => isCodingWebFetchEnabled(),
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!isCodingWebFetchEnabled()) {
      return failureToActionResult({
        reason: "disabled",
        message: "WEB_FETCH is disabled via ELIZA_WEB_FETCH",
      });
    }
    const url = readStringParam(options, "url")?.trim();
    const extract = readStringParam(options, "extract")?.trim();
    if (!url) {
      return failureToActionResult({
        reason: "missing_param",
        message: "url is required",
      });
    }

    try {
      const response = await guardedTextHttpRequest(url);
      if (!response.ok) {
        const result = failureToActionResult(
          {
            reason: "io_error",
            message: withUpstreamFallbackHint(
              `HTTP ${response.status}`,
              url,
              response.status,
            ),
          },
          {
            action: "WEB_FETCH",
            url,
            final_url: response.url,
            status: response.status,
          },
        );
        return result;
      }

      const extracted = extractBody(
        response.text,
        response.contentType,
        extract,
      );
      const wellFormed = toWellFormedUnicode(extracted.value);
      return successActionResult(wellFormed, {
        action: "WEB_FETCH",
        url,
        final_url: response.url,
        status: response.status,
        content_type: response.contentType,
        kind: extracted.kind,
        truncated: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = failureToActionResult(
        { reason: "io_error", message: withUpstreamFallbackHint(message, url) },
        { action: "WEB_FETCH", url },
      );
      return result;
    }
  },
};

/**
 * A 5xx, a 429 or a transport error is the endpoint's failure, not the
 * request's: "what's the weather in Austin right now?" ended as "my weather
 * lookup just failed on my end" after one wttr.in HTTP 500 (live sweep
 * 2026-09-14) although WEB_SEARCH could have answered. The failure text names
 * the fallback so the planner tries it before reporting; a 4xx other than 429
 * (bad URL, blocked, gone) and a request rejected before it was sent (policy,
 * malformed URL) carry no hint because retrying elsewhere with the same idea
 * rarely helps.
 */
const TRANSPORT_FAILURE_PATTERN =
  /timeout|timed out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|reset|refused|unreachable/i;

function withUpstreamFallbackHint(
  message: string,
  url: string,
  status?: number,
): string {
  const upstream =
    status === undefined
      ? TRANSPORT_FAILURE_PATTERN.test(message)
      : status >= 500 || status === 429;
  if (!upstream) return message;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the raw url
  }
  return `${message} — ${host} failed upstream; try another endpoint or WEB_SEARCH for the same value before telling the user it failed`;
}
