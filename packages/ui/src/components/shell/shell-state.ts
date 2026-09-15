/**
 * Defines shell reducer state for overlays, launcher mode, notifications, and
 * surface coordination.
 */

import type { CapabilityHandoffRequest } from "@elizaos/shared";
import type {
  ChatFailureKind,
  ChatTerminalFailure,
  ConversationSecretRequest,
  MessageAttachment,
  NativeToolCallEvent,
} from "../../api";

/**
 * Shell phase for the device-shell foundation (HomePill + AssistantOverlay +
 * ChatSurface). Drives the pill's visual treatment.
 *
 *   booting    — startup not ready and popup closed; pill dim, no halo.
 *                Also the cloud-only auth-probe rest (`checking`) so a slow
 *                `/api/auth/me` never flashes the sign-in chip.
 *   needs-auth — cloud-only, proxy up, no Cloud session; labeled sign-in chip.
 *   idle       — ready, no overlay; pill solid.
 *   summoned   — overlay open, no active mic/response; faint halo.
 *   listening  — push-to-talk capture in flight; dark chip + live bars.
 *   processing — the mic is closed but the utterance is still being
 *                transcribed (STT drain after a hold-to-talk release); dark
 *                chip with pulsing dots — "I heard you, working on it"
 *                (#20483). Distinct from responding: no agent turn exists yet.
 *   responding — agent stream in flight; ambient glow (the pill further
 *                differentiates speaking via its `speaking` prop).
 */
export const SHELL_PHASES = [
  "booting",
  "needs-auth",
  "idle",
  "summoned",
  "listening",
  "processing",
  "responding",
] as const;

export type ShellPhase = (typeof SHELL_PHASES)[number];

export function isShellPhase(value: unknown): value is ShellPhase {
  return (
    typeof value === "string" &&
    (SHELL_PHASES as readonly string[]).includes(value)
  );
}

export interface ShellMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** True when the assistant stream ended before a completed turn. */
  interrupted?: boolean;
  /**
   * Message origin (e.g. "client_chat", "proactive-interaction"). Assistant
   * turns with source "proactive-interaction" render as dismissible/acceptable
   * suggestion bubbles (#8792).
   */
  source?: string;
  /** Set on assistant turns the server flagged as failed (e.g. no provider). */
  failureKind?: ChatFailureKind;
  /** Complete typed terminal failure used for truthful transient retry state. */
  terminalFailure?: ChatTerminalFailure;
  /** Server confirms durable evidence supports regenerating only this reply. */
  replyRecoveryAvailable?: boolean;
  /** Agent reasoning/thought for this turn, rendered as a collapsed block. */
  reasoning?: string;
  /** Inline tool-call rows for this turn, streamed live from the chat SSE `tool`
   *  events and rendered via ToolCallEventLog (#13535). */
  toolEvents?: NativeToolCallEvent[];
  /** Media attached to this turn — user uploads and agent-generated media. */
  attachments?: MessageAttachment[];
  /** Pending secret / OAuth request (rendered as an actionable block). */
  secretRequest?: ConversationSecretRequest;
  /** Validated personal-workspace setup receipt for this assistant turn. */
  capabilityHandoff?: CapabilityHandoffRequest;
  /** Short topic labels retained for search and memory semantics. */
  topics?: string[];
}

/**
 * Initial size of the shell transcript's render window — the newest N turns
 * rendered when a conversation first opens. Older turns stay in state (the
 * agent's context is untouched); the window GROWS a page at a time as the reader
 * scrolls up ({@link planScrollTopLoadOlder}), bounded by
 * {@link MAX_LOADED_SHELL_WINDOW}, so the idle/drag DOM stays lean while history
 * browsing still reaches back. Gap 4 of #9141 (transcript windowing) built this
 * seam; #13532/#14329 (infinite upward scroll) made it a sliding window.
 */
export const MAX_RENDERED_SHELL_MESSAGES = 80;

/**
 * Hard upper bound on the render window: however far the reader scrolls up, the
 * transcript never renders more than this many turns at once, so a very long
 * thread can't unbound the DOM and jank the per-frame `flexBasis` sheet drag
 * (#14329 acceptance: bounded ~400, no virtualizer). State still holds every
 * loaded turn.
 */
export const MAX_LOADED_SHELL_WINDOW = 400;

/**
 * How many turns the render window grows per scroll-to-top — one older page, so
 * revealing already-loaded-but-windowed-out turns matches the size of a fetched
 * older page and the reader gets a full page of runway each time.
 */
export const SHELL_RENDER_WINDOW_STEP = 50;

/**
 * The renderable subset of a shell transcript: drops empty turns — EXCEPT turns
 * that carry non-text content (attachments or a pending secret request: an
 * image-only send is a valid user turn and an assistant reply can be a bare
 * generated image), a FAILED assistant turn (failureKind carries the retry /
 * no-provider / insufficient-credits UI, which is often content-less — a
 * rate-limit or provider stall fails before any token streams, so dropping it
 * would hide the failure AND its retry affordance entirely), and the in-flight
 * interrupted assistant receipt, and the in-flight assistant turn while a reply
 * is streaming (phase === "responding"), so its
 * bubble can show the breathing dots anchored where the text will fill in. Pure
 * + DOM-free so the render window can measure the loaded-renderable count
 * without a second filter definition.
 */
export function filterRenderableShellMessages(
  messages: readonly ShellMessage[],
  phase: ShellPhase,
): ShellMessage[] {
  return messages.filter(
    (m) =>
      m.content.trim() ||
      (m.attachments?.length ?? 0) > 0 ||
      m.secretRequest !== undefined ||
      m.capabilityHandoff !== undefined ||
      m.failureKind !== undefined ||
      (m.role === "assistant" && m.interrupted === true) ||
      (m.role === "assistant" && phase === "responding"),
  );
}

/**
 * Pure transcript-windowing decision (#9141 gap 4 seam): the renderable turns,
 * capped to the newest `max` to bound DOM nodes. Pure + DOM-free so the cap +
 * exceptions are unit-testable and any future virtualizer can reuse the same
 * predicate.
 */
export function selectVisibleShellMessages(
  messages: readonly ShellMessage[],
  phase: ShellPhase,
  max: number = MAX_RENDERED_SHELL_MESSAGES,
): ShellMessage[] {
  const kept = filterRenderableShellMessages(messages, phase);
  return max > 0 && kept.length > max ? kept.slice(-max) : [...kept];
}

/**
 * Decide the render window's response to a scroll-to-top for the infinite
 * upward scroll (#13532/#14329). Two moves, reveal-before-fetch:
 *
 *  1. If loaded-but-windowed-out older turns exist (`windowSize <
 *     loadedRenderableCount`), GROW the window one page to reveal them — no
 *     network. This is why the idle/drag DOM stays at the initial window while
 *     only history browsing grows it.
 *  2. Once the window has consumed every loaded turn, signal a FETCH of the next
 *     older server page (when the server reports more) so the caller can prepend
 *     and grow again.
 *
 * Never grows past {@link MAX_LOADED_SHELL_WINDOW}: at the bound it neither
 * grows nor fetches, so the caller's observer latches off instead of spinning.
 * Pure so the reveal-before-fetch policy is unit-tested independent of the
 * overlay.
 */
export function planScrollTopLoadOlder(
  windowSize: number,
  loadedRenderableCount: number,
  serverHasMore: boolean,
): { nextWindowSize: number; shouldFetch: boolean } {
  if (windowSize >= MAX_LOADED_SHELL_WINDOW) {
    return { nextWindowSize: MAX_LOADED_SHELL_WINDOW, shouldFetch: false };
  }
  if (windowSize < loadedRenderableCount) {
    return {
      nextWindowSize: Math.min(
        windowSize + SHELL_RENDER_WINDOW_STEP,
        MAX_LOADED_SHELL_WINDOW,
        loadedRenderableCount,
      ),
      shouldFetch: false,
    };
  }
  return { nextWindowSize: windowSize, shouldFetch: serverHasMore };
}
