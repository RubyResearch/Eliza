/**
 * Single-source SSE contract for the chat turn: the phases the agent reports
 * mid-turn and the discriminator it returns when a turn fails. Both the agent
 * server (chat/conversation SSE emission) and the UI client (SSE parsing +
 * render) import these here so the wire format is declared exactly once and the
 * two sides cannot drift (#12409, parent #12093).
 */

/**
 * In-flight assistant-turn status, surfaced to the UI as an additive SSE
 * `{ type: "status", ... }` event so the chat can show what the agent is *doing*
 * rather than just breathing dots. The `token` / `done` / `error` SSE contract
 * is unchanged — a client that ignores `status` events behaves exactly as before.
 *
 * - `thinking`   — the model is being called; no user-visible tokens yet.
 * - `streaming`  — the model is emitting the user-visible reply token-by-token.
 * - `running_action` — a concrete action handler is executing (carry
 *                  `actionName`, e.g. "SEND_MESSAGE").
 * - `running_tool`   — a tool/MCP call is running (carry `toolName`).
 * - `evaluating` — post-response evaluators are running.
 * - `waking`     — a non-running cloud agent is auto-resuming (HTTP 202 +
 *                  Retry-After); the request is parked until it answers.
 * - `speaking`   — the reply is being spoken aloud (voice output); client-derived.
 */
export interface ChatTurnStatus {
  kind:
    | "thinking"
    | "streaming"
    | "running_action"
    | "running_tool"
    | "evaluating"
    | "waking"
    | "speaking";
  /** Optional short human-readable label override for the phase. */
  label?: string;
  /** Canonical action name when `kind === "running_action"`. */
  actionName?: string;
  /** Tool/MCP name when `kind === "running_tool"`. */
  toolName?: string;
}

/**
 * One tool/action-call lifecycle step, surfaced to the UI as an additive SSE
 * `{ type: "tool", ... }` event so the chat thread can render inline tool rows
 * (running → success/failure with arg/result previews) the way Claude Code /
 * Codex do (#13535, follow-up #8813). The runtime's native planner/tool loop
 * already produces these steps and streams them through the same channel as the
 * reply; the chat route forks them onto this event instead of dropping them.
 * Additive: a client that ignores `tool` events behaves exactly as before.
 *
 * - `call`   — the model invoked a tool; `args` carries the input.
 * - `result` — the tool returned; `result` carries the output.
 * - `error`  — the tool failed; `error` carries the message.
 *
 * `callId` correlates a `call` with its later `result`/`error` so the UI can
 * flip one row from running to settled rather than appending a second row.
 */
export interface ChatToolCallEvent {
  phase: "call" | "result" | "error";
  /** Stable id correlating a `call` with its `result`/`error`. */
  callId: string;
  /** Tool/action name being invoked (e.g. "WEB_SEARCH"). */
  toolName: string;
  /** Arguments the model passed to the tool; present on `call`. */
  args?: Record<string, unknown>;
  /** Tool output; present on `result`. */
  result?: unknown;
  /** Failure message; present on `error`. */
  error?: string;
}

/**
 * Exhaustive public turn-failure discriminators. Agent transport allowlists,
 * history reconstruction, durable outcome validation, and UI retry gates must
 * all derive from this single table so a new kind cannot ship half-wired.
 *
 * - `insufficient_credits` — billing/quota; do not retry as-is.
 * - `missing_capability` — tool/capability absent; retry cannot help.
 * - `no_provider` — no model configured; UX gate, not a chat retry.
 * - `planner_exhaustion` — budget/attempt limit with tools present; retry may help.
 * - `context_overflow` — model input exceeds its limit; do not retry as-is.
 * - `provider_issue` — provider/auth/infrastructure; often retryable.
 * - `generation_timeout` — turn wall-clock expired; retryable.
 * - `rate_limited` — throttle; retryable after a pause.
 * - `handler_error` — action handler failed; not a generic Retry affordance.
 * - `persistence_error` — save boundary failed; not a generic Retry affordance.
 * - `local_inference` — local model path issue; may recover after load/retry.
 * - `coding_mutation_unverified` — coding changes lack successful verification.
 * - `coding_verification_failed` — coding verification still fails after repair.
 * - `coding_tool_failure` — a coding tool failed without narrower provenance.
 */
export const CHAT_FAILURE_KINDS = [
  "insufficient_credits",
  "missing_capability",
  "no_provider",
  "planner_exhaustion",
  "context_overflow",
  "provider_issue",
  "generation_timeout",
  "rate_limited",
  "handler_error",
  "persistence_error",
  "local_inference",
  "coding_mutation_unverified",
  "coding_verification_failed",
  "coding_tool_failure",
] as const;

/**
 * Discriminator the conversation route includes in its 200 response so the
 * renderer can distinguish "provider configured but throwing" from "no
 * provider configured at all" — the latter is a UX gate ("Connect a
 * provider"), not a chat reply.
 */
export type ChatFailureKind = (typeof CHAT_FAILURE_KINDS)[number];

/** Authoritative terminal failure carried independently of assistant prose. */
export interface ChatTerminalFailure {
  kind: ChatFailureKind;
  message: string;
  transient: boolean;
  code?: string;
}

/**
 * Failure kinds for which a one-tap Retry (resend preceding user turn) is a
 * truthful affordance. Permanent configuration/billing/capability gaps and
 * specialized action/persistence failures stay off this list so the UI does
 * not invite a loop that cannot succeed.
 */
export const RETRYABLE_CHAT_FAILURE_KINDS = [
  "provider_issue",
  "rate_limited",
  "local_inference",
  "planner_exhaustion",
  "generation_timeout",
] as const satisfies readonly ChatFailureKind[];

const CHAT_FAILURE_KIND_SET: ReadonlySet<string> = new Set(CHAT_FAILURE_KINDS);
const RETRYABLE_CHAT_FAILURE_KIND_SET: ReadonlySet<string> = new Set(
  RETRYABLE_CHAT_FAILURE_KINDS,
);

/** Exhaustive runtime validator for wire/transport failure discriminators. */
export function isChatFailureKind(value: unknown): value is ChatFailureKind {
  return typeof value === "string" && CHAT_FAILURE_KIND_SET.has(value);
}

/** Narrow unknown transport payloads to a public `ChatFailureKind` or drop. */
export function parseChatFailureKind(
  value: unknown,
): ChatFailureKind | undefined {
  return isChatFailureKind(value) ? value : undefined;
}

/** Strictly validates a terminal failure received across a chat transport. */
export function parseChatTerminalFailure(
  value: unknown,
): ChatTerminalFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = parseChatFailureKind(record.kind);
  if (
    !kind ||
    typeof record.message !== "string" ||
    record.message.trim().length === 0 ||
    typeof record.transient !== "boolean" ||
    (record.code !== undefined && typeof record.code !== "string")
  ) {
    return undefined;
  }
  return {
    kind,
    message: record.message,
    transient: record.transient,
    ...(record.code ? { code: record.code } : {}),
  };
}

/** Whether UI surfaces should offer Retry for this structured failure. */
export function isRetryableChatFailureKind(kind: ChatFailureKind): boolean {
  return RETRYABLE_CHAT_FAILURE_KIND_SET.has(kind);
}
