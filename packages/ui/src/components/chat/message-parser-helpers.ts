/**
 * Canonical parser that turns a raw assistant/user message string into the
 * ordered `Segment[]` the chat surfaces render: prose, fenced/inline code,
 * `[CONFIG:…]` blocks, UiSpec JSON, JSONL patches, permission cards, hidden
 * reasoning/tool tags, and any registry-driven inline widget
 * (`[CHOICE]`/`[FOLLOWUPS]`/`[FORM]`/`[TASK]`/plugin markers). `parseSegments`
 * is the single entry point both `MessageContent` (ChatView) and
 * `InlineWidgetText` (ChatOverlay) delegate to, so the same agent
 * output renders identically on every surface.
 *
 * The message string is UNTRUSTED agent output, so the patch/UiSpec path is the
 * attack surface: `sanitizePatchValue` / `createSafeRecord` strip
 * prototype-pollution keys (`__proto__`/`constructor`/`prototype`) and return
 * null-prototype containers. See `message-parser-helpers.fuzz.test.ts` for the
 * hardening invariants.
 *
 * `parseSegments` is a pure full-text parse. `collectSegmentRegions` and
 * `interleaveSegments` are the two halves it is built from, exported so the
 * streaming wrapper in `message-parser-incremental.ts` can re-run the identical
 * passes over just the changed tail of a growing turn (O(delta) per frame
 * instead of O(len) — #15280) while producing byte-identical output.
 */
import { stripAssistantStageDirections } from "@elizaos/shared";
import type { ConversationMessage } from "../../api/client-types-chat";
import type { PluginInfo } from "../../api/client-types-config";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { PatchOp, UiSpec } from "../../config/ui-spec";
import type { ConfigUiHint } from "../../types";
import {
  type PermissionCardPayload,
  parsePermissionRequestFromText,
} from "../composites/chat/permission-card.helpers";
import { paramsToSchema } from "../pages/plugin-list-utils";
import { getInlineWidgets } from "./widgets/inline-registry";

/** Reject prototype-pollution keys that should never be traversed or rendered. */
export const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);
export const SAFE_PLUGIN_ID_RE = /^[\w-]+$/;

export function createSafeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

export function sanitizePatchValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePatchValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const safe = createSafeRecord();
  for (const [key, nestedValue] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (BLOCKED_IDS.has(key)) continue;
    safe[key] = sanitizePatchValue(nestedValue);
  }
  return safe;
}

export function isSafeNormalizedPluginId(id: string): boolean {
  return !BLOCKED_IDS.has(id) && SAFE_PLUGIN_ID_RE.test(id);
}

// ── Segment types ───────────────────────────────────────────────────

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "config"; pluginId: string }
  | { kind: "ui-spec"; spec: UiSpec; raw: string }
  // A fenced (```lang ... ```) or inline (`...`) code span lifted out of the
  // prose so it can render in the CodeBlock primitive with a copy button.
  | { kind: "code"; code: string; lang?: string; inline: boolean }
  // Any registry-driven inline widget (choice/followups/form/task/plugin).
  | { kind: "widget"; widgetKind: string; data: unknown }
  | { kind: "permission"; payload: PermissionCardPayload }
  | { kind: "analysis-xml"; tag: string; content: string };

// ── Detection ───────────────────────────────────────────────────────

export const CONFIG_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;
export const FENCED_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/g;

/**
 * Any fenced code block ```` ```lang\n…``` ````. Captures the (optional)
 * language tag and the body. Detected after the UiSpec/patch passes so a fenced
 * UiSpec JSON is rendered as an interactive widget, not raw code; overlapping
 * regions are dropped before this pass claims them.
 */
export const FENCED_CODE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * Inline `code` spans inside otherwise plain prose. Backticked runs that contain
 * a newline are excluded (those are fenced blocks, handled above), and the body
 * must be non-empty so a stray pair of backticks isn't lifted out.
 */
export const INLINE_CODE_RE = /`([^`\n]+)`/g;
export const FORM_SUBMIT_DISPLAY_RE = /^\[form:submit\s+([^\]\s]+)\]/;

export const HIDDEN_TAG_BLOCK_RE =
  /<(think|analysis|reasoning|tool_calls?|tools?)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/gi;

/**
 * Strip trailing partial hidden tags at the end of a streaming text chunk.
 * During streaming, the buffer may end mid-tag (e.g. `"Hello<thi"`,
 * `"Hello</respon"`, or just `"Hello<"`).  These fragments are not
 * user-facing content and must be hidden from both the display and voice
 * pipelines.
 */
export const TRAILING_PARTIAL_TAG_RE = /<\/?[a-zA-Z][^>]*$|<\/?$/s;

/**
 * Test-only accounting of how many characters the parse pipeline scans, so the
 * streaming-parse regression test can assert O(delta) work instead of O(N·L).
 * Plain integer adds — negligible in production, never read by render code.
 */
export const parserWork = {
  normalizedChars: 0,
  regionScanChars: 0,
  fullParses: 0,
  incrementalParses: 0,
};

export function resetParserWork(): void {
  parserWork.normalizedChars = 0;
  parserWork.regionScanChars = 0;
  parserWork.fullParses = 0;
  parserWork.incrementalParses = 0;
}

/**
 * The display normalization WITHOUT the final trim. Split out from
 * {@link normalizeDisplayText} so the incremental streaming wrapper
 * (`message-parser-incremental.ts`) can re-normalize only the changed tail and
 * concatenate it onto a stable prefix — trimming happens once on the joined
 * result, never on the stable prefix.
 */
export function normalizeDisplayCore(text: string): string {
  parserWork.normalizedChars += text.length;
  let normalized = text;

  // Hide hidden reasoning/tool blocks from chat bubbles.
  normalized = normalized.replace(HIDDEN_TAG_BLOCK_RE, " ");

  // During streaming, a chunk may end mid-tag (e.g. "<thi").
  // Strip any unterminated opening or closing tag at the very end so the
  // user never sees hidden-tag fragments while tokens arrive.
  normalized = normalized.replace(TRAILING_PARTIAL_TAG_RE, "");

  normalized = stripAssistantStageDirections(normalized);
  return normalized;
}

export function normalizeDisplayText(text: string): string {
  return normalizeDisplayCore(text).trim();
}

export interface FormSubmitDisplay {
  formId: string;
  label: string;
}

export function humanizeFormSubmitId(formId: string): string {
  return formId.replace(/[-_]+/g, " ").trim() || "form";
}

/**
 * User form submissions are transport commands stored in the transcript so the
 * agent can consume them. Display surfaces render a receipt instead of echoing
 * the protocol marker or submitted values back to the user.
 */
export function parseFormSubmitDisplay(text: string): FormSubmitDisplay | null {
  const match = FORM_SUBMIT_DISPLAY_RE.exec(text.trimStart());
  if (!match) return null;
  const formId = match[1];
  return { formId, label: humanizeFormSubmitId(formId) };
}

export function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // error-policy:J3 "is this JSON?" probe over untrusted message text —
    // null is the explicit "not a spec" signal
    return null;
  }
}

export function isUiSpec(obj: unknown): obj is UiSpec {
  if (!obj || typeof obj !== "object") return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.root === "string" &&
    typeof c.elements === "object" &&
    c.elements !== null
  );
}

// ── JSONL patch support (Chat Mode) ─────────────────────────────────

/**
 * Quick pre-check: does this line look like a JSON patch object?
 * Handles both compact `{"op":` and spaced `{ "op":` formats.
 */
export function looksLikePatch(trimmed: string): boolean {
  if (!trimmed.startsWith("{")) return false;
  return trimmed.includes('"op"') && trimmed.includes('"path"');
}

/** Try to parse a single line as an RFC 6902 JSON Patch operation. */
export function tryParsePatch(line: string): PatchOp | null {
  const t = line.trim();
  if (!looksLikePatch(t)) return null;
  // Recover only redundant closing braces AFTER a complete JSON object.
  // Live Qwen output sometimes adds one to an otherwise valid table patch.
  // Never fill missing values/brackets or alter quoted content. The source
  // message and trajectory retain the original bytes; this is render-only.
  let json = t;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < t.length; i++) {
    const char = t[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      if (/^\s*}(?:\s*})*\s*$/.test(t.slice(i + 1))) json = t.slice(0, i + 1);
      break;
    }
  }
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj.op === "string" && typeof obj.path === "string")
      return obj as PatchOp;
    return null;
  } catch {
    // error-policy:J3 untrusted stream line — null means "not a patch op"
    return null;
  }
}

/**
 * Apply a list of RFC 6902 patches to build a UiSpec.
 *
 * Only handles the paths the catalog emits:
 *   /root              → spec.root
 *   /elements/<id>     → spec.elements[id]
 *   /state/<key>       → spec.state[key]
 *   /state             → spec.state (whole object)
 */
export function compilePatches(patches: PatchOp[]): UiSpec | null {
  const spec: {
    root?: string;
    elements: Record<string, unknown>;
    state: Record<string, unknown>;
  } = { elements: {}, state: createSafeRecord() };

  for (const patch of patches) {
    if (patch.op !== "add" && patch.op !== "replace") continue;
    const { path, value } = patch as {
      op: string;
      path: string;
      value: unknown;
    };
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    if (parts[0] === "root" && parts.length === 1) {
      spec.root = value as string;
    } else if (parts[0] === "elements" && parts.length === 2) {
      spec.elements[parts[1]] = value;
    } else if (parts[0] === "state" && parts.length === 1) {
      const nextState = sanitizePatchValue(value);
      spec.state =
        nextState && typeof nextState === "object" && !Array.isArray(nextState)
          ? (nextState as Record<string, unknown>)
          : createSafeRecord();
    } else if (parts[0] === "state" && parts.length >= 2) {
      // Nested state path: /state/key or /state/key/subkey
      let cursor = spec.state;
      let blockedPath = false;
      for (let i = 1; i < parts.length - 1; i++) {
        const k = parts[i];
        if (BLOCKED_IDS.has(k)) {
          blockedPath = true;
          break;
        }
        if (
          !cursor[k] ||
          typeof cursor[k] !== "object" ||
          Array.isArray(cursor[k])
        ) {
          cursor[k] = createSafeRecord();
        }
        cursor = cursor[k] as Record<string, unknown>;
      }
      if (blockedPath) continue;
      const leaf = parts[parts.length - 1];
      if (BLOCKED_IDS.has(leaf)) continue;
      cursor[leaf] = sanitizePatchValue(value);
    }
  }

  return isUiSpec(spec) ? spec : null;
}

/**
 * Scan `text` for blocks of consecutive JSONL patch lines and return
 * their character regions plus the compiled UiSpec.
 *
 * A patch block is a run of lines where each non-empty line parses as a
 * valid PatchOp. A single empty line between patch lines is allowed.
 */
export function findPatchRegions(
  text: string,
): Array<{ start: number; end: number; spec: UiSpec; raw: string }> {
  const results: Array<{
    start: number;
    end: number;
    spec: UiSpec;
    raw: string;
  }> = [];
  const lines = text.split("\n");

  let blockStart = -1;
  let blockEnd = 0;
  let patches: PatchOp[] = [];
  let rawLines: string[] = [];
  let pos = 0;

  const flush = () => {
    if (patches.length >= 1) {
      const spec = compilePatches(patches);
      if (spec) {
        results.push({
          start: blockStart,
          end: blockEnd,
          spec,
          raw: rawLines.join("\n"),
        });
      }
    }
    blockStart = -1;
    patches = [];
    rawLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // +1 for the newline that split() consumed (except the very last line)
    const lineLen = line.length + (i < lines.length - 1 ? 1 : 0);
    const trimmed = line.trim();

    if (looksLikePatch(trimmed)) {
      const patch = tryParsePatch(trimmed);
      if (patch) {
        if (blockStart === -1) blockStart = pos;
        patches.push(patch);
        rawLines.push(line);
        blockEnd = pos + lineLen;
        pos += lineLen;
        continue;
      }
    }

    // Empty line: peek ahead to see if the next non-empty line is a patch
    if (trimmed.length === 0 && blockStart !== -1) {
      const nextPatch = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (nextPatch && tryParsePatch(nextPatch) !== null) {
        // Allow the gap and keep going
        pos += lineLen;
        continue;
      }
    }

    // Non-patch content — flush any open block
    if (blockStart !== -1) flush();
    pos += lineLen;
  }

  if (blockStart !== -1) flush();
  return results;
}

/** A run of message text split into plain prose and inline `code` spans. */
export type InlineTextPart =
  | { kind: "text"; text: string }
  | { kind: "code"; code: string };

/**
 * Split a plain-text run into alternating prose and inline `code` parts so the
 * renderer can wrap backticked spans in the code primitive while keeping them in
 * the flow of the sentence. Empty backtick pairs (` `` `) are treated as prose.
 * Pure + synchronous so it unit-tests without the DOM.
 */
export function splitInlineCode(text: string): InlineTextPart[] {
  const parts: InlineTextPart[] = [];
  let cursor = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let match: RegExpExecArray | null = INLINE_CODE_RE.exec(text);
  while (match !== null) {
    const code = match[1];
    if (code.trim().length > 0) {
      if (match.index > cursor) {
        parts.push({ kind: "text", text: text.slice(cursor, match.index) });
      }
      parts.push({ kind: "code", code });
      cursor = match.index + match[0].length;
    }
    match = INLINE_CODE_RE.exec(text);
  }
  if (cursor < text.length) {
    parts.push({ kind: "text", text: text.slice(cursor) });
  }
  if (parts.length === 0) parts.push({ kind: "text", text });
  return parts;
}

/**
 * Cheap pre-gate for {@link parseSegments}: every non-text region the parser
 * can produce REQUIRES at least one of these characters, so a message without
 * any of them is guaranteed plain prose and can skip the whole multi-pass scan
 * (permission parse, [CONFIG], widget parsers, fenced-JSON JSON.parse, JSONL
 * patches, fenced code). parseSegments runs on every streaming rAF flush over
 * the full accumulated text, so for typical streamed prose this single scan
 * replaces ~8 regex/JSON passes per frame.
 *
 * Region → required character:
 *   - fenced code / fenced-JSON UiSpec / permission fenced body → `` ` ``
 *   - [CONFIG:…] and every registry inline widget marker
 *     ([CHOICE]/[FOLLOWUPS]/[FORM]/[WORKFLOW]/[BACKGROUND]/[CHECKLIST]/[TASK])
 *     → `[` (plugin-registered widgets must also use a `[…]` marker — see
 *     inline-registry.tsx)
 *   - JSONL patch lines (`{"op":…` / `{ "op":…`) and the permission card's
 *     bare-JSON tail → `{`
 *   - analysis-mode XML blocks (<thought>/<action>/…) → `<`
 */
export const SEGMENT_TRIGGER_RE = /[`[{<]/;

/** A matched non-text region with its absolute char bounds in the target text. */
export interface SegmentRegion {
  start: number;
  end: number;
  segment: Segment;
}

/**
 * Run every region-producing pass over `targetText` and return the matched
 * regions UNSORTED, with the same cross-pass overlap-drop the full parser
 * applies (patch regions drop against fenced blocks; fenced code drops against
 * any already-claimed region). Extracted from {@link parseSegments} so the
 * streaming wrapper can run the identical passes over just the changed tail.
 *
 * `targetText` is the already-normalized display text (or raw text in analysis
 * mode); callers that scan a tail slice must shift the returned offsets by the
 * slice start themselves.
 */
export function collectSegmentRegions(
  targetText: string,
  analysisMode: boolean,
): SegmentRegion[] {
  parserWork.regionScanChars += targetText.length;
  const regions: SegmentRegion[] = [];

  if (analysisMode) {
    const XML_RE =
      /<(thought|analysis|reasoning|tool_calls?|tools?|action|providers?|response|text)\b[^>]*>([\s\S]*?)(?:<\/\1>|$)/gi;
    let m: RegExpExecArray | null = XML_RE.exec(targetText);
    while (m !== null) {
      regions.push({
        start: m.index,
        end: m.index + m[0].length,
        segment: {
          kind: "analysis-xml",
          tag: m[1].toLowerCase(),
          content: m[2],
        },
      });
      m = XML_RE.exec(targetText);
    }
  }

  // 1. Find [CONFIG:pluginId] markers
  CONFIG_RE.lastIndex = 0;
  let m: RegExpExecArray | null = CONFIG_RE.exec(targetText);
  while (m !== null) {
    regions.push({
      start: m.index,
      end: m.index + m[0].length,
      segment: { kind: "config", pluginId: m[1] },
    });
    m = CONFIG_RE.exec(targetText);
  }

  // 1b. Registry-driven inline widgets (choice/followups/form/task and any
  // plugin-registered marker). Each widget owns its parsing semantics; we only
  // collect the regions and tag them with the widget kind for render dispatch.
  for (const widget of getInlineWidgets()) {
    for (const match of widget.parse(targetText)) {
      regions.push({
        start: match.start,
        end: match.end,
        segment: {
          kind: "widget",
          widgetKind: widget.kind,
          data: match.data,
        },
      });
    }
  }

  // 2. Find fenced JSON that is a UiSpec (Generate Mode / legacy format)
  FENCED_JSON_RE.lastIndex = 0;
  m = FENCED_JSON_RE.exec(targetText);
  while (m !== null) {
    const json = m[1].trim();
    const parsed = tryParse(json);
    if (parsed && isUiSpec(parsed)) {
      regions.push({
        start: m.index,
        end: m.index + m[0].length,
        segment: { kind: "ui-spec", spec: parsed, raw: json },
      });
    }
    m = FENCED_JSON_RE.exec(targetText);
  }

  // 3. Find inline JSONL patch blocks (Chat Mode)
  for (const patch of findPatchRegions(targetText)) {
    // Skip if this region overlaps with an already-found fenced block
    const overlaps = regions.some(
      (r) => patch.start < r.end && patch.end > r.start,
    );
    if (!overlaps) {
      regions.push({
        start: patch.start,
        end: patch.end,
        segment: { kind: "ui-spec", spec: patch.spec, raw: patch.raw },
      });
    }
  }

  // 4. Find fenced code blocks. Runs after the UiSpec/patch passes so a fenced
  // UiSpec JSON renders as an interactive widget, not raw code; any fence that
  // overlaps an already-claimed region (UiSpec, config marker, …) is dropped.
  // Inline `code` is NOT lifted to a segment here — it stays in the text and is
  // rendered inline by `MessageTextBody` so it keeps its place in the sentence;
  // only block code gets the CodeBlock copy affordance.
  const overlapsExisting = (start: number, end: number): boolean =>
    regions.some((r) => start < r.end && end > r.start);
  FENCED_CODE_RE.lastIndex = 0;
  m = FENCED_CODE_RE.exec(targetText);
  while (m !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    const lang = m[1].trim();
    const code = m[2].replace(/\n$/, "");
    if (code.length > 0 && !overlapsExisting(start, end)) {
      regions.push({
        start,
        end,
        segment: {
          kind: "code",
          code,
          inline: false,
          ...(lang ? { lang } : {}),
        },
      });
    }
    m = FENCED_CODE_RE.exec(targetText);
  }

  return regions;
}

/**
 * Sort `regions` by start position and interleave them with the plain-text gaps
 * of `targetText`, dropping whitespace-only gaps. `startCursor` seeds the walk:
 * the streaming wrapper passes the stable-cut offset so the tail interleave
 * emits prose from the cut forward, exactly where the full parser's cursor would
 * be after consuming the stable prefix's regions. Regions starting before the
 * cursor are skipped (the same overlap guard the full parser uses).
 */
export function interleaveSegments(
  targetText: string,
  regions: SegmentRegion[],
  startCursor = 0,
): Segment[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  let cursor = startCursor;

  for (const r of sorted) {
    if (r.start < cursor) continue;
    if (r.start > cursor) {
      const t = targetText.slice(cursor, r.start);
      if (t.trim()) segments.push({ kind: "text", text: t });
    }
    segments.push(r.segment);
    cursor = r.end;
  }

  if (cursor < targetText.length) {
    const t = targetText.slice(cursor);
    if (t.trim()) segments.push({ kind: "text", text: t });
  }

  return segments;
}

export function parseSegments(text: string, analysisMode: boolean): Segment[] {
  parserWork.fullParses += 1;
  // If analysis mode is enabled, we parse the raw text to extract XML blocks,
  // otherwise we use the normalized text which strips them.
  const targetText = analysisMode ? text : normalizeDisplayText(text);
  if (!targetText) return [{ kind: "text", text: "" }];

  // Plain prose (no trigger character anywhere) → one text segment, no scans.
  if (!SEGMENT_TRIGGER_RE.test(targetText)) {
    return [{ kind: "text", text: targetText }];
  }

  const permissionRequest = analysisMode
    ? null
    : parsePermissionRequestFromText(targetText);
  if (permissionRequest) {
    const segments: Segment[] = [];
    if (permissionRequest.display.trim()) {
      segments.push({ kind: "text", text: permissionRequest.display });
    }
    segments.push({ kind: "permission", payload: permissionRequest.payload });
    return segments;
  }

  const regions = collectSegmentRegions(targetText, analysisMode);

  // No special content found — return plain text
  if (regions.length === 0) {
    return [{ kind: "text", text: targetText }];
  }

  return interleaveSegments(targetText, regions, 0);
}

// ── Conversation transcript ─────────────────────────────────────────

/** One message projected to its `Speaker: text` transcript line. */
export interface ConversationTranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

/**
 * Render a conversation as a plain-text transcript for "copy conversation".
 * Each turn becomes a `Speaker: text` block (blank line between turns), using
 * the display name for the speaker (the agent name for assistant turns, "You"
 * for the user). Empty/whitespace-only turns are skipped. Pure + DOM-free so it
 * unit-tests without React and both chat surfaces share one definition.
 */
export function conversationTranscriptText(
  messages: ReadonlyArray<ConversationTranscriptMessage>,
  options: { agentName?: string; userName?: string } = {},
): string {
  const agentName = options.agentName?.trim() || "Assistant";
  const userName = options.userName?.trim() || "You";
  return messages
    .map((message) => {
      const text = message.text.trim();
      if (!text) return "";
      const speaker = message.role === "assistant" ? agentName : userName;
      return `${speaker}: ${text}`;
    })
    .filter((line) => line.length > 0)
    .join("\n\n");
}

// ── InlinePluginConfig helpers ──────────────────────────────────────

/** Normalize plugin ID: strip @scope/plugin- prefix so both "discord" and "@elizaos/plugin-discord" resolve. */
export function normalizePluginId(id: string): string {
  return id.replace(/^@[^/]+\/plugin-/, "");
}

export function buildInlinePluginConfigModel(
  plugin: PluginInfo | null,
  values: Record<string, unknown>,
): {
  hasConfigurableParams: boolean;
  hints: Record<string, ConfigUiHint>;
  mergedValues: Record<string, unknown>;
  schema: JsonSchemaObject | null;
  setKeys: Set<string>;
} {
  const pluginParams = plugin?.parameters ?? [];
  const hasConfigurableParams = pluginParams.length > 0;
  if (!hasConfigurableParams || !plugin?.id) {
    return {
      hasConfigurableParams: false,
      hints: {},
      mergedValues: values,
      schema: null,
      setKeys: new Set<string>(),
    };
  }

  const auto = paramsToSchema(pluginParams, plugin.id);
  if (plugin.configUiHints) {
    for (const [key, serverHint] of Object.entries(plugin.configUiHints)) {
      auto.hints[key] = { ...auto.hints[key], ...serverHint };
    }
  }

  // Progressive disclosure for the in-chat setup card (#14412): when the
  // plugin declares required params, those are the minimal setup set — every
  // optional param moves behind ConfigRenderer's existing Advanced disclosure.
  // The schema's own `required` flag is the minimal-vs-advanced signal; a
  // server-provided `advanced: false` hint explicitly pins an optional field
  // in the minimal set. Plugins with no required params keep the heuristic
  // split from paramsToSchema (an all-Advanced card would render empty).
  if (pluginParams.some((p) => p.required)) {
    for (const param of pluginParams) {
      if (param.required) continue;
      if (plugin.configUiHints?.[param.key]?.advanced === false) continue;
      auto.hints[param.key] = { ...auto.hints[param.key], advanced: true };
    }
  }

  const initialValues: Record<string, unknown> = {};
  const setKeys = new Set<string>();
  for (const param of pluginParams) {
    if (param.isSet) {
      setKeys.add(param.key);
    }
    if (param.isSet && !param.sensitive && param.currentValue != null) {
      initialValues[param.key] = param.currentValue;
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (value != null && value !== "") {
      setKeys.add(key);
    }
  }

  return {
    hasConfigurableParams: true,
    hints: auto.hints,
    mergedValues: { ...initialValues, ...values },
    schema: auto.schema as JsonSchemaObject,
    setKeys,
  };
}

// ── SensitiveRequestBlock helpers ───────────────────────────────────

const SENSITIVE_REQUEST_LABEL_OVERRIDES = new Map<string, string>([
  ["API", "API"],
  ["ID", "ID"],
  ["OAUTH", "OAuth"],
  ["OPENAI", "OpenAI"],
  ["TOTP", "TOTP"],
  ["URI", "URI"],
  ["URL", "URL"],
]);

export function sensitiveRequestTitleLabel(key: string): string {
  const parts = key
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "Sensitive request";

  const words = parts.map((part, index) => {
    const upper = part.toUpperCase();
    const override = SENSITIVE_REQUEST_LABEL_OVERRIDES.get(upper);
    if (override) return override;
    if (upper === "KEY" && index === parts.length - 1) return "key";
    const lower = part.toLowerCase();
    if (index > 0) return lower;
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  });

  return words.join(" ").replace(/^Sub agent\b/i, "Sub-agent");
}

export function sensitiveRequestStatusLabel(
  status: NonNullable<ConversationMessage["secretRequest"]>["status"],
): string {
  switch (status) {
    case "saved":
    case "submitted":
    case "fulfilled":
      return "Saved";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return "Failed";
    default:
      return "Pending";
  }
}
