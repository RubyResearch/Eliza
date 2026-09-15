/**
 * The single stateful engine behind the shell's chat + voice surface, exposed as
 * the `ShellController` returned by `useShellController`. It drives the shell
 * phase (booting → needs-auth → idle → summoned → listening → responding), the rendered message
 * list, send + vision-capture, and the whole voice stack: mic capture (via the
 * voice-capture factory), wake-word listening, end-of-turn aggregation,
 * hands-free conversation looping, transcription-mode long-form recording, and
 * spoken assistant output (through useShellVoiceOutput). Conversation switching
 * and horizontal swipe navigation resolve through conversation-nav.
 *
 * ChatSurface / AssistantOverlay / ChatOverlay and the home surfaces
 * are the consumers; they read the controller and render, holding no chat/voice
 * state of their own. ShellControllerContext provides one instance so the pill
 * and the overlay stay in lock-step without double-mounting this hook.
 */
import {
  VOICE_SETTINGS_APPLY_EVENT,
  type VoiceSettingsApplyPayload,
} from "@elizaos/shared/events";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import * as React from "react";
import type {
  ChatTurnStatus,
  ImageAttachment,
} from "../../api/client-types-chat";
import type { AsrProvider } from "../../api/client-types-config";
import { isElectrobunRuntime } from "../../bridge/electrobun-runtime";
import {
  APP_PAUSE_EVENT,
  APP_RESUME_EVENT,
  dispatchNavigateViewEvent,
  VOICE_CONTROL_EVENT,
  type VoiceControlEventDetail,
} from "../../events";
import { revalidateAuthStatus } from "../../hooks/useAuthStatus";
import { useRealtimeVoiceMint } from "../../hooks/useRealtimeVoiceMint";
import {
  isRealtimeVoiceFlagEnabled,
  type RealtimeVoiceStartOutcome,
  useRealtimeVoiceSession,
} from "../../hooks/useRealtimeVoiceSession";
import { useViewEvent } from "../../hooks/useViewEvent";
import {
  PENDANT_VOICE_TRANSCRIPT_EVENT,
  type PendantVoiceTranscriptDetail,
} from "../../pendant/pendant-connection";
import type { HomeModelStatus } from "../../services/local-inference/home-model-status";
import {
  useChatComposer,
  useChatTurnStatus,
  useConversationMessages,
} from "../../state";
import { dispatchConversationResync } from "../../state/AppContext.hooks";
import { useAppSelectorShallow } from "../../state/app-store";
import { claimCloudLoginWindow } from "../../state/cloud-login-launch";
import type { AppContextValue } from "../../state/internal";
import {
  loadContinuousChatMode,
  loadVadAutoStop,
  loadWakeWordEnabled,
  saveContinuousChatMode,
} from "../../state/persistence";
import { goHome } from "../../state/shell-surface-store";
import { deriveAgentReady } from "../../state/types";
import { openDesktopSettingsWindow } from "../../utils/desktop-workspace";
import { voiceCaptureDebug } from "../../utils/voice-capture-debug";
import { TurnAggregator } from "../../voice/end-of-turn";
import {
  type MicrophonePermissionState,
  queryMicrophonePermission,
} from "../../voice/local-asr-capture";
import { shouldRespondToVoiceTurn } from "../../voice/should-respond";
import { TranscriptSessionAccumulator } from "../../voice/transcript-session";
import {
  isTranscriptionExitPhrase,
  isTranscriptionStartPhrase,
  stripExitPhrase,
} from "../../voice/transcription-exit";
import { useWakeListenWindow } from "../../voice/useWakeListenWindow";
import {
  createVoiceCapture,
  type VoiceCaptureBackend,
  type VoiceCaptureHandle,
  type VoiceCaptureState,
} from "../../voice/voice-capture-factory";
import {
  VOICE_CONTINUOUS_MODES,
  type VoiceContinuousMode,
  type VoiceContinuousStatus,
  type VoiceTtsError,
} from "../../voice/voice-chat-types";
import { isCloudVoiceRunnable } from "../../voice/voice-provider-defaults";
import type { ServerControlFrame } from "../../voice/voice-session-protocol";
import { buildVoiceTurnSignal } from "../../voice/voice-turn-signal";
import { matchWakeName } from "../../voice/wake-name-match";
import { useHomeModelStatus } from "../local-inference/useHomeModelStatus";
import {
  buildConversationNav,
  type ConversationNav,
  type ConversationNavDirection,
  resolveAdjacentConversationId,
} from "./conversation-nav";
import type { ShellAuthGate } from "./shell-auth-gate";
import { deriveShellPhase } from "./shell-auth-gate";
import type { ShellMessage, ShellPhase } from "./shell-state";
import { useShellAuthGate } from "./useShellAuthGate";
import { useShellVoiceOutput } from "./useShellVoiceOutput";

export type {
  ConversationNav,
  ConversationNavDirection,
} from "./conversation-nav";
export {
  buildConversationNav,
  resolveAdjacentConversationId,
} from "./conversation-nav";

/** Upper bound (ms) the conversation-switch / clear loading spinner may show
 *  before it is force-cleared — see `runWithConversationLoading`. */
const CONVERSATION_LOADING_MAX_MS = 12_000;

/**
 * Grace window (ms) after a capture starts during which an APP_PAUSE is treated
 * as the iOS getUserMedia permission-dialog focus-steal (a transient
 * visibilitychange) rather than a real background-suspend, so the just-started
 * capture is NOT discarded out from under the grant (#voice-crickets). Matches
 * the composer-side CAPTURE_PAUSE_GRACE_MS in useVoiceChat. Transcription mode
 * never re-arms on resume, so without this a permission-prompt pause on the
 * transcribe surface is unrecoverable crickets.
 */
const SHELL_CAPTURE_PAUSE_GRACE_MS = 1500;

/** How a voice capture turn is consumed when it produces a final transcript.
 *  `"transcription"` records long-form: finals accumulate into ONE recording
 *  session (not per-utterance chat bubbles) and the agent stays quiet until an
 *  exit phrase, at which point the session becomes a Transcript record + a chat
 *  link-widget. */
export type CaptureIntent = "converse" | "dictate" | "transcription" | "ptt";

export interface ShellController {
  phase: ShellPhase;
  /** Cloud-only auth gate. Local-runtime builds stay `{ gated: false }`. */
  authGate: ShellAuthGate;
  /** Launch Cloud sign-in. No-op unless `authGate.phase === "needs-auth"`. */
  requestSignIn: () => void;
  /** True while a pill-initiated Cloud sign-in is in flight. */
  signingIn: boolean;
  /** Raw "a reply is in flight" predicate — text streaming OR being spoken aloud.
   *  Unlike `phase === "responding"`, stays true after the mic opens (which flips
   *  phase to "listening"), so the composer reads one honest busy signal: send
   *  stays enabled (queue another turn) while voice input is gated. */
  responding: boolean;
  /** The rich, phase-aware status of the in-flight turn (#8813) — what the agent
   *  is *doing* right now (thinking / streaming / running an action / waking /
   *  speaking), or null when idle. Prefers the live server-reported phase, then
   *  falls back to client-derived signals. Use this for the status indicator;
   *  `responding` remains the coarse busy boolean for gating. */
  turnStatus: ChatTurnStatus | null;
  messages: readonly ShellMessage[];
  canSend: boolean;
  /** Local text-model readiness for the home surface. Gates send while not ready. */
  modelStatus: HomeModelStatus;
  recording: boolean;
  /** Visual mode for the waveform visualizer. */
  waveformMode: "idle" | "listening" | "responding";
  /** Live mic analyser while recording, for the voice avatar. `null` otherwise. */
  analyser: AnalyserNode | null;
  open: () => void;
  close: () => void;
  /** True while the one global chat/voice session is open. The hook other views
   *  (e.g. the homescreen apps + buttons) read to react to it. */
  isOpen: boolean;
  send: (
    text: string,
    options?: {
      channelType?: "DM" | "VOICE_DM";
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
      clientMessageId?: string;
    },
  ) => void;
  /** Route onboarding free text to the first-run conductor, never the agent. */
  sendFirstRunText?: (text: string) => void;
  /** Show the agent the screen: sends a vision-intent turn so the agent runs its
   *  plugin-vision screen-capture action. Backs the bottom-bar VISION button. */
  captureVision: () => void;
  /** True from a VISION tap until the resulting turn is in flight (pulses the
   *  VISION button). */
  visionCapturing: boolean;
  /** Toggle continuous ("open voice") capture. Used by a quick tap on the mic. */
  toggleRecording: () => void;
  /** Begin voice input unconditionally. `"converse"` (default) starts the
   *  configured realtime session; `"dictate"` routes the final transcript to
   *  the composer draft without sending; `"ptt"` (the pill's hold-to-talk
   *  quasimode, #20483) sends the final transcript as a voice turn directly,
   *  overlay open or not. */
  startRecording: (intent?: CaptureIntent) => void;
  /** End capture unconditionally. Used by push-to-talk release. */
  stopRecording: () => void;
  /** Abandon an in-flight capture WITHOUT transcribing or sending — the
   *  hold-to-talk cancel gestures (Esc mid-hold, slide-off release). Releases
   *  the mic immediately; a no-op when nothing is capturing. */
  cancelRecording: () => void;
  /** Live interim transcription of the current utterance ("" when none). */
  transcript: string;
  /** True while an assistant reply is being spoken aloud (voice output). */
  speaking: boolean;
  /** Speak a specific message aloud on demand — backs the per-message
   *  "Play audio" action row control (#10713). */
  speak: (text: string) => void;
  /** Stop any in-flight assistant speech — backs the Play control's toggle. */
  stopSpeaking: () => void;
  /** True while assistant voice output is muted by the user. */
  agentVoiceMuted: boolean;
  /** Mute/unmute assistant voice output. Muting stops any in-flight speech. */
  toggleAgentVoiceMute: () => void;
  /** True when autoplay policy blocked playback and a tap is needed to hear it. */
  needsAudioUnlock: boolean;
  /** The real controller always supplies this; optional for external legacy shell adapters. */
  ttsError?: VoiceTtsError | null;
  /** Resume audio output in response to a user gesture (enable sound). */
  unlockAudio: () => void;
  /** True while the hands-free voice conversation loop is active — the mic
   *  re-opens automatically after each spoken reply. Toggled by a tap on the mic. */
  handsFree: boolean;
  /** Realtime ownership and truthful provider phase for the persistent shell.
   *  Optional only so external fixture controllers remain source-compatible;
   *  the real shell controller always supplies it. */
  realtimeVoice?: {
    enabled: boolean;
    active: boolean;
    connecting: boolean;
    paused: boolean;
    /** True when realtime mic frames are replaced with silence. */
    microphoneMuted: boolean;
    status: VoiceContinuousStatus;
    error: string | null;
    /** Mute/unmute the realtime microphone without ending the conversation. */
    toggleMicrophoneMute: () => void;
  };
  /** Toggle the hands-free conversation loop (mic ↔ spoken reply ↔ mic). */
  toggleHandsFree: () => void;
  /** Proactive microphone-permission state, probed via
   *  `navigator.permissions.query({ name: "microphone" })` on boot and on every
   *  hands-free engage. `"denied"` means the OS revoked the grant to the
   *  installed PWA, so shell surfaces should render a "re-enable mic" affordance
   *  instead of a mic button that fails at capture time. `"unknown"` means the
   *  Permissions API or the `"microphone"` descriptor is unsupported
   *  (Safari-iOS); treat it like `"granted"`/`"prompt"` and let getUserMedia
   *  decide. */
  micPermission: MicrophonePermissionState;
  /** Re-probe the microphone permission without opening the mic, updating
   *  {@link micPermission} and surfacing a "re-enable mic" notice when denied.
   *  Backs a "re-enable mic" affordance's tap so the user can re-check after
   *  granting permission in browser/system settings. Resolves to the new state. */
  recheckMicPermission: () => Promise<MicrophonePermissionState>;
  /** True while transcription mode is active — the mic records continuously into
   *  one recording session (the agent does not reply) until the user says an exit
   *  phrase ("exit transcription mode"), then the session becomes a Transcript. */
  transcriptionMode: boolean;
  /** Toggle transcription mode on/off. Enabling opens a long-running capture
   *  that suppresses replies; disabling stops it and RESUMES the hands-free mic
   *  loop it paused (transcript off leaves the mic on — they are linked). */
  toggleTranscriptionMode: () => void | Promise<void>;
  /** End transcription AND turn the mic fully off (the mic button's action while
   *  transcribing — turning off the mic turns off transcript). */
  stopTranscriptionAndMic: () => void | Promise<void>;
  /** Register where push-to-talk dictation drops its final transcript (the
   *  overlay wires this to its composer draft). Pass null to clear. */
  setDictationSink: (sink: ((text: string) => void) | null) => void;
  /** Register where a completed transcription SESSION is delivered (its segments,
   *  the absolute session-start ms, and the concatenated session WAV when audio
   *  was retained). The overlay wires this to create the Transcript record (+
   *  audio) + drop a chat link-widget. Pass null to clear. */
  setTranscriptSessionSink: (
    sink:
      | ((
          segments: TranscriptSegment[],
          startedAtMs: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null,
  ) => void;
  /** Tell the controller whether the composer holds a pending typed/dictated
   *  draft. While a draft exists the hands-free ("always-on") loop is paused so
   *  the mic isn't listening over the keyboard; clearing the draft (on send)
   *  resumes it — restoring the prior voice state without a re-tap. */
  setComposerHasDraft: (hasDraft: boolean) => void;
  /** Clear the conversation and start a fresh, greeted one. */
  clearConversation: () => void;
  /** Jump to Settings (where ProviderSwitcher lives) — used by the chat's
   *  `no_provider` failure gate to let the user wire a provider in one tap. */
  openSettings: () => void;
  /** Return to the combined Home/Launcher surface and select Home. */
  navigateHome?: () => void;
  /** The active app tab. */
  currentTab?: string;
  /** Stop an in-flight reply stream (the composer's stop control). */
  stop: () => void;
  /** Horizontal-swipe navigation between conversations (sheet-open only). */
  conversationNav: ConversationNav;
  /** True while a conversation switch or clear is fetching messages. The overlay
   *  only renders the spinner when the visible thread is empty. */
  conversationLoading?: boolean;
  /** True once the server has told us (via a `no_provider` assistant turn) that
   *  no LLM/model provider is configured. Distinct from a transient warm-up: the
   *  agent's `canRespond` stays false forever, so the overlay uses this to stop
   *  showing the "Waking …" boot indicator and to explain the real cause instead.
   *  The controller also auto-navigates to Settings on its rising edge. */
  noProviderConfigured?: boolean;
  /**
   * A monotonically-changing token that advances whenever fresh boot progress
   * is observed while the agent is still waking (#14040 sub-defect 3) — e.g. a
   * cloud resume `202` reporting a live `jobId`. The boot banner keys its
   * "taking longer than usual" escalation off ABSENCE of progress: it restarts
   * its slow-boot timer on every change of this token, so a slow-but-
   * progressing boot never wrongly reads as stuck, while a truly stalled boot
   * (token never changes) still escalates. `undefined` when there is no boot
   * progress channel (older controllers / non-cloud), in which case the banner
   * falls back to raw-elapsed escalation.
   */
  bootProgressSignal?: string;
}

/**
 * Bridges the shell foundation (HomePill + AssistantOverlay + ChatSurface) to
 * the real agent message flow exposed by {@link useApp}. Replaces the v1
 * mocked echo: text submitted here goes through `sendChatText`, the same path
 * the main ChatView uses, so messages actually send and stream back.
 *
 * Voice capture uses the hook-free {@link createVoiceCapture} factory (the
 * standalone-surface path). A final transcript is submitted through the same
 * `send` handler. The phase drives the pill glow and waveform mode.
 */
/**
 * True when a mic-capture rejection is specifically a permission DENIAL
 * (`getUserMedia` rejects with a `NotAllowedError` / "permission denied" on a
 * revoked or refused grant) as opposed to a no-device or generic failure. Used
 * both to word the failure notice and to flip the proactive `micPermission`
 * state to "denied" so the "re-enable mic" affordance lights up.
 */
function isMicPermissionDenialError(err: unknown): boolean {
  const name =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (name === "SpeechRecognitionError") return false;
  const haystack = `${name} ${message}`.toLowerCase();
  return (
    haystack.includes("notallowed") ||
    haystack.includes("permissiondenied") ||
    haystack.includes("permission denied") ||
    haystack.includes("not-allowed")
  );
}

export function describeCaptureFailure(err: unknown): string {
  const name =
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    typeof (err as { name: unknown }).name === "string"
      ? (err as { name: string }).name
      : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (name === "SpeechRecognitionError") {
    return "Speech recognition failed. Check your transcription provider in Settings → Models & Providers.";
  }
  const haystack = `${name} ${message}`.toLowerCase();
  if (isMicPermissionDenialError(err)) {
    return "Microphone access was denied. Enable microphone permission in your browser or system settings to use voice.";
  }
  // A capture that opened successfully but contained no usable samples proves
  // the microphone path exists. Classify that as an empty utterance before the
  // broader "no microphone" device matcher sees the recorder's error text.
  if (haystack.includes("no microphone audio was captured")) {
    return "Didn't catch that — no voice audio was captured. Try again.";
  }
  if (
    haystack.includes("notfound") ||
    haystack.includes("devices not found") ||
    haystack.includes("no device") ||
    haystack.includes("no microphone")
  ) {
    return "No microphone was found. Connect a microphone to use voice.";
  }
  // Post-capture transcription failure (cloud/local STT): the mic worked and
  // the utterance was recorded, but the words could not be transcribed — the
  // honest message is "didn't catch that", not a microphone accusation.
  if (
    haystack.includes("cloudstterror") ||
    haystack.includes("cloud asr") ||
    haystack.includes("transcri") ||
    haystack.includes("empty transcript")
  ) {
    return "Voice transcription is unavailable. Try again in a moment.";
  }
  return "Could not start the microphone. Check your microphone permissions and try again.";
}

/**
 * Silence is a normal outcome for an open microphone, not an actionable
 * failure. Keep true permission, device, transport, and provider failures
 * visible, but let an empty recording/transcript return quietly to idle.
 */
export function isNoSpeechCaptureFailure(err: unknown): boolean {
  if (isMicPermissionDenialError(err)) return false;
  // An outage or rejected request is not evidence that the user was silent.
  if (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    typeof err.status === "number" &&
    (err.status >= 500 || [401, 403, 429].includes(err.status))
  )
    return false;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String(err.code).toLowerCase()
      : "";
  if (
    [
      "no-speech",
      "no_speech",
      "no_match",
      "speech_timeout",
      "empty_transcript",
    ].includes(code)
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("no microphone audio was captured") ||
    normalized.includes("empty transcript") ||
    normalized.includes("no-speech") ||
    normalized.includes("no_match") ||
    normalized.includes("speech_timeout") ||
    normalized.includes("speech timeout")
  );
}

function describeRealtimeVoiceFailure(
  outcome: Exclude<RealtimeVoiceStartOutcome, { kind: "live" }>,
  surfacedError: string | null,
): string {
  if (outcome.kind === "error") {
    return outcome.error.message;
  }
  if (surfacedError) return surfacedError;
  if (outcome.kind === "fallback-to-batch") {
    if (outcome.message) return outcome.message;
    if (outcome.reason === "consent") {
      return "Voice setup couldn't complete. Tap the mic to try again.";
    }
    if (outcome.reason === "mint") {
      return "Cartesia voice could not start a session. Tap Talk to retry.";
    }
    if (outcome.reason === "transport") {
      return "Cartesia voice could not connect. Check your connection and tap Talk to retry.";
    }
  }
  return "Cartesia voice is not ready yet. Tap Talk to retry.";
}

/** Shallow equality for two optional string lists (topic-change detection). */
function sameStringList(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function readAppliedContinuousMode(value: unknown): VoiceContinuousMode | null {
  return typeof value === "string" &&
    VOICE_CONTINUOUS_MODES.includes(value as VoiceContinuousMode)
    ? (value as VoiceContinuousMode)
    : null;
}

// Granular shallow selection instead of useApp() so the shell controller only
// re-renders when one of the exact fields it reads changes — not on every one of
// the ~300 AppContext fields. typecheck enforces completeness: any `s.x` used
// below but not selected here is a compile error, so this stays value-equivalent.
const selectShellController = (s: AppContextValue) => ({
  tab: s.tab,
  chatFirstTokenReceived: s.chatFirstTokenReceived,
  sendChatText: s.sendChatText,
  sendActionMessage: s.sendActionMessage,
  agentStatus: s.agentStatus,
  characterData: s.characterData,
  uiLanguage: s.uiLanguage,
  elizaCloudConnected: s.elizaCloudConnected,
  elizaCloudVoiceProxyAvailable: s.elizaCloudVoiceProxyAvailable,
  handleNewConversation: s.handleNewConversation,
  ensureActiveConversation: s.ensureActiveConversation,
  handleSelectConversation: s.handleSelectConversation,
  activeConversationId: s.activeConversationId,
  conversations: s.conversations,
  setTab: s.setTab,
  handleChatStop: s.handleChatStop,
  setActionNotice: s.setActionNotice,
  chatAgentVoiceMuted: s.chatAgentVoiceMuted,
  setState: s.setState,
  handleInteractiveCloudLogin: s.handleInteractiveCloudLogin,
});

export function useShellController(): ShellController {
  const {
    tab,
    chatFirstTokenReceived,
    sendChatText,
    sendActionMessage,
    agentStatus,
    characterData,
    uiLanguage,
    elizaCloudConnected,
    elizaCloudVoiceProxyAvailable,
    handleNewConversation,
    ensureActiveConversation,
    handleSelectConversation,
    activeConversationId,
    conversations,
    setTab,
    handleChatStop,
    setActionNotice,
    chatAgentVoiceMuted,
    setState,
    handleInteractiveCloudLogin,
  } = useAppSelectorShallow(selectShellController);
  const authGate = useShellAuthGate();
  // Async voice transitions must read the current auth boundary, not the render
  // that created their callback. Permission probes, recorder drains, and
  // conversation creation can all outlive a sign-out render.
  const authGateRef = React.useRef(authGate);
  authGateRef.current = authGate;
  const [signingIn, setSigningIn] = React.useState(false);
  const signInInFlightRef = React.useRef(false);
  const requestSignIn = React.useCallback(() => {
    if (authGate.phase !== "needs-auth") return;
    if (signInInFlightRef.current) return;
    signInInFlightRef.current = true;
    setSigningIn(true);
    // Keep the popup on the click/key gesture. Effects must not call this.
    claimCloudLoginWindow();
    void handleInteractiveCloudLogin()
      .catch((error: unknown) => {
        // error-policy:J4 sign-in failed; stay on the needs-auth chip
        setActionNotice(
          error instanceof Error
            ? error.message
            : "Could not start Cloud login.",
          "error",
          5000,
        );
      })
      .finally(() => {
        signInInFlightRef.current = false;
        setSigningIn(false);
      });
  }, [authGate.phase, handleInteractiveCloudLogin, setActionNotice]);
  const recoverGatedCapture = React.useCallback(() => {
    if (authGate.phase === "needs-auth") {
      requestSignIn();
      return;
    }
    void revalidateAuthStatus();
    setActionNotice(
      authGate.phase === "unavailable"
        ? "Unable to reach Eliza Cloud. Retrying the connection."
        : "Checking your Eliza Cloud session. Try push-to-talk again in a moment.",
      authGate.phase === "unavailable" ? "error" : "info",
      4000,
    );
  }, [authGate.phase, requestSignIn, setActionNotice]);
  // The wake phrase for transcript-mode inline replies follows the character
  // name (issue #9880); falls back to the running agent name, then "eliza".
  const wakeCharacterName =
    characterData?.name?.trim() || agentStatus?.agentName?.trim() || "eliza";
  const wakeCharacterNameRef = React.useRef(wakeCharacterName);
  wakeCharacterNameRef.current = wakeCharacterName;
  // Read per-token streaming messages from the isolated context so token updates
  // don't depend on the giant AppContext value identity.
  const { conversationMessages } = useConversationMessages();
  // chatSending lives in ChatComposerContext; the AppContext copy is intentionally
  // stale so send/typing churn does not fan out through the whole app.
  const { chatSending } = useChatComposer();
  // Live server-reported phase of the in-flight turn (from the chat-send SSE),
  // read from its dedicated context so status events re-render only chat surfaces.
  const { serverTurnStatus } = useChatTurnStatus();
  const conversationsRef = React.useRef(conversations);
  const activeConversationIdRef = React.useRef(activeConversationId);
  conversationsRef.current = conversations;
  activeConversationIdRef.current = activeConversationId;

  const handleRealtimeVoiceServerEvent = React.useCallback(
    (event: ServerControlFrame) => {
      if (event.t === "navigate_view") {
        dispatchNavigateViewEvent({
          viewId: event.viewId,
          ...(event.viewPath ? { viewPath: event.viewPath } : {}),
          source: "agent",
          ...(event.subview ? { subview: event.subview } : {}),
        });
        return;
      }
      // The voice gateway submits through the canonical conversation stream,
      // outside this renderer's useChatSend instance. Reconcile at the
      // authoritative STT final so the committed user turn leaves the composer
      // for its canonical bubble before model generation, then at terminal
      // usage so the persisted assistant reply replaces the in-flight state.
      // Never synthesize local bubbles: the normal conversation loader remains
      // the sole reader and deduper for saved history. Reconcile again when
      // playback actually starts so the saved assistant bubble appears with
      // its first audible frame instead of waiting for the terminal usage event.
      // Expiry/recovery may replace the socket before those terminal frames.
      // A newly authenticated ready boundary reloads saved history too; it must
      // never replay the prior utterance or its potentially committed actions.
      if (
        event.t !== "ready" &&
        event.t !== "stt_final" &&
        event.t !== "speaking_start" &&
        event.t !== "usage"
      )
        return;
      const conversationId = activeConversationIdRef.current?.trim() || null;
      if (!conversationId) return;
      dispatchConversationResync({
        conversationId,
        reason:
          event.t === "ready"
            ? "connection-recovered"
            : event.t === "stt_final" || event.t === "speaking_start"
              ? "voice-turn-progress"
              : "voice-turn-complete",
      });
    },
    [],
  );

  // The persistent shell is the mounted /chat surface, so it owns the one
  // realtime session. The build flag advertises the capability, but only a
  // resolved Dedicated identity plus a healthy conversation-bound probe may
  // select realtime. Otherwise the same Talk control deliberately remains
  // usable through the batch ASR/TTS path.
  const realtimeVoiceBuildEnabled = isRealtimeVoiceFlagEnabled();
  const { agentId: realtimeVoiceAgentId, getConsentNonce } =
    useRealtimeVoiceMint({ conversationId: activeConversationId });
  // Keep the capability eligible while the first conversation is being
  // created so a Talk gesture can queue against the UUID published by startup.
  // The session hook still requires both ids before it reports `available`.
  const realtimeVoiceCapabilityEnabled =
    realtimeVoiceBuildEnabled && Boolean(realtimeVoiceAgentId);
  const realtimeVoice = useRealtimeVoiceSession({
    agentId: realtimeVoiceAgentId,
    conversationId: activeConversationId,
    // Treat probe/identity loss as an operational flag-off edge. The session
    // hook's flag effect cancels any pending automatic identity restart before
    // a fast probe recovery can re-open the microphone without a new gesture.
    flagEnabled: realtimeVoiceCapabilityEnabled,
    getConsentNonce,
    clientOptions: { onServerEvent: handleRealtimeVoiceServerEvent },
  });
  const realtimeVoiceEnabled =
    realtimeVoiceCapabilityEnabled && realtimeVoice.available;
  // A resolved Dedicated identity may queue Talk while startup is still
  // publishing the first conversation. Once a conversation exists, the
  // conversation-bound availability probe is authoritative.
  const realtimeVoiceCanStart =
    realtimeVoiceEnabled ||
    (realtimeVoiceCapabilityEnabled && !activeConversationId?.trim());
  const [realtimeVoiceBatchFallback, setRealtimeVoiceBatchFallback] =
    React.useState(!realtimeVoiceEnabled);
  const realtimeVoiceSelected =
    realtimeVoiceEnabled && !realtimeVoiceBatchFallback;
  const realtimeVoiceWantedRef = React.useRef(false);
  // During an identity handoff the availability probe disarms before the old
  // client finishes teardown. Keep batch media out until that prior owner has
  // actually released the microphone/audio path.
  const realtimeVoiceOwnsMedia =
    realtimeVoiceBuildEnabled &&
    (realtimeVoiceSelected ||
      realtimeVoiceWantedRef.current ||
      realtimeVoice.active ||
      realtimeVoice.connecting ||
      realtimeVoice.agentSpeaking);
  const realtimeVoiceRef = React.useRef(realtimeVoice);
  realtimeVoiceRef.current = realtimeVoice;
  const realtimeVoiceWasEnabledRef = React.useRef(realtimeVoiceEnabled);
  // True once the CURRENT wanted session has reached live; distinguishes a
  // mid-session death (parked by the effect below startRealtimeVoice) from an
  // initial start failure (owned by startRealtimeVoice's outcome handling).
  const realtimeVoiceWasActiveRef = React.useRef(false);
  const startRealtimeVoiceRef = React.useRef<() => void>(() => {});
  const stopRealtimeVoiceRef = React.useRef<() => void>(() => {});
  const [realtimeVoiceBoundaryError, setRealtimeVoiceBoundaryError] =
    React.useState<string | null>(null);
  const conversationIdentityWaitersRef = React.useRef(
    new Set<{
      conversationId: string;
      resolve: (conversationId: string | null) => void;
    }>(),
  );

  const ensureActiveConversationForVoice = React.useCallback(async () => {
    // Startup can publish a provisional id before discovering the saved real
    // history. Text and voice must both wait for that selection to settle.
    const conversationId = await ensureActiveConversation();
    if (!conversationId || !realtimeVoiceWantedRef.current) return null;
    if (activeConversationIdRef.current?.trim() === conversationId) {
      return conversationId;
    }
    return new Promise<string | null>((resolve) => {
      conversationIdentityWaitersRef.current.add({
        conversationId,
        resolve,
      });
    });
  }, [ensureActiveConversation]);

  // A restored id must also reach the realtime hook's committed render before
  // mint/start reads it. A different committed selection cancels this gesture.
  React.useEffect(() => {
    const committedId = activeConversationId?.trim() || null;
    for (const waiter of conversationIdentityWaitersRef.current) {
      conversationIdentityWaitersRef.current.delete(waiter);
      waiter.resolve(
        committedId === waiter.conversationId ? committedId : null,
      );
    }
  }, [activeConversationId]);

  React.useEffect(
    () => () => {
      for (const waiter of conversationIdentityWaitersRef.current) {
        waiter.resolve(null);
      }
      conversationIdentityWaitersRef.current.clear();
    },
    [],
  );

  // Jump to Settings from the chat's no_provider gate. Stable identity.
  const openSettings = React.useCallback(() => {
    if (isElectrobunRuntime()) {
      void openDesktopSettingsWindow().catch((error: unknown) => {
        // error-policy:J4 surface native window failures so Settings can be retried
        setActionNotice(
          `Settings could not open. ${error instanceof Error ? error.message : String(error)}`,
          "error",
          6000,
        );
      });
      return;
    }
    setTab("settings");
  }, [setTab, setActionNotice]);
  // Commit the home half of the shared rail before the route changes so the
  // destination cannot paint one frame of the launcher with the wrong surface.
  const navigateHome = React.useCallback(() => {
    goHome();
    setTab("chat");
  }, [setTab]);

  // True while a clear or conversation switch is fetching the next thread, so
  // the overlay can show an in-thread spinner instead of an empty sheet. Cache
  // hits paint synchronously inside handleSelectConversation; the overlay only
  // renders the spinner when the visible thread is still empty.
  const [conversationLoading, setConversationLoading] = React.useState(false);
  const conversationLoadingSeqRef = React.useRef(0);
  const conversationTransitionBusyRef = React.useRef(false);

  // Stop any in-flight assistant speech across a conversation change. `voiceOutput`
  // is defined far below (after the conversation-switch handlers), so mirror its
  // `stopSpeaking` into a ref the clear/switch handlers can call at gesture time
  // without a definition-order/closure problem. Defaults to a no-op until wired.
  const stopSpeakingRef = React.useRef<() => void>(() => {});
  // The resolved ASR provider is loaded by `voiceOutput` (useShellVoiceOutput)
  // far below, but `startCapture` (which needs it to pick the STT backend) is
  // defined above it. Mirror it into a ref at render time — same closure/order
  // workaround as `stopSpeakingRef` — so capture reads the current provider at
  // gesture time. `undefined` until the voice config first loads, which the
  // capture factory treats as "local-inference-or-browser default".
  const asrProviderRef = React.useRef<AsrProvider | undefined>(undefined);
  // Guards the capture-failure notice so the hands-free re-listen loop's retries
  // (which re-call startCapture every ~250ms) don't spam the toast; cleared on
  // the next successful start so a later failure re-notifies.
  const captureFailureNoticedRef = React.useRef(false);

  const runWithConversationLoading = React.useCallback(
    (task: () => Promise<unknown>) => {
      const seq = conversationLoadingSeqRef.current + 1;
      conversationLoadingSeqRef.current = seq;
      conversationTransitionBusyRef.current = true;
      setConversationLoading(true);
      const clearLoadingForSeq = () => {
        if (conversationLoadingSeqRef.current === seq) {
          conversationTransitionBusyRef.current = false;
          setConversationLoading(false);
        }
      };
      // Watchdog: never let the empty-thread spinner outlive a stuck switch or
      // create. A cache-hit switch resolves in the same tick and a network load
      // in a few seconds, but the on-device agent can be model-bound (a warming
      // or loading 1.4 GB model, an in-flight generation), and a spinner that
      // hangs there reads as a permanently frozen new chat. Force-clear after a
      // bound so the (already-activated) conversation is usable while a slow
      // greeting backfills. Seq-guarded so a newer switch owns the flag.
      const watchdog = setTimeout(
        clearLoadingForSeq,
        CONVERSATION_LOADING_MAX_MS,
      );
      void Promise.resolve()
        .then(task)
        .finally(() => {
          clearTimeout(watchdog);
          clearLoadingForSeq();
        });
    },
    [],
  );

  // Clear the chat: drop the current conversation and start a fresh, greeted one
  // (handleNewConversation resets draft state + creates a new conversation with a
  // bootstrap greeting; an empty draft we just left is pruned, a non-empty
  // conversation is kept and remains swipe-reachable).
  const clearConversation = React.useCallback(() => {
    // A fresh conversation's bootstrap greeting is NOT a reply to a voice turn —
    // stop any reply still being spoken from the prior session and clear the
    // voice flag so the greeting isn't spoken aloud after it.
    stopSpeakingRef.current();
    setLastTurnVoice(false);
    runWithConversationLoading(handleNewConversation);
  }, [handleNewConversation, runWithConversationLoading]);

  // Switch conversations behind a loading flag so an uncached swipe shows the
  // spinner; a cached one resolves within the same tick (thread already painted).
  // A switch must not leave the previous thread's spoken reply playing into the
  // new one, nor inherit its "speak the next turn" latch: stop in-flight TTS and
  // reset lastTurnVoice so the target conversation starts silent.
  const selectConversation = React.useCallback(
    (id: string) => {
      stopSpeakingRef.current();
      setLastTurnVoice(false);
      runWithConversationLoading(() => handleSelectConversation(id));
    },
    [handleSelectConversation, runWithConversationLoading],
  );

  const selectAdjacentConversation = React.useCallback(
    (direction: ConversationNavDirection) => {
      if (conversationTransitionBusyRef.current) {
        return;
      }
      const targetId = resolveAdjacentConversationId(
        conversationsRef.current,
        activeConversationIdRef.current,
        direction,
      );
      if (targetId) {
        selectConversation(targetId);
      }
    },
    [selectConversation],
  );

  // Horizontal-swipe navigation between conversations (#8929). Computed by the
  // pure `buildConversationNav` helper (unit-tested) so the index-walk and
  // boundary logic stay verifiable independent of this AppContext-bound hook.
  // The callbacks re-resolve through refs at gesture time so a stale overlay
  // closure cannot navigate against an old active index after the list rerenders.
  const conversationNav = React.useMemo<ConversationNav>(() => {
    const nav = buildConversationNav(
      conversations,
      activeConversationId,
      selectConversation,
    );
    return {
      ...nav,
      goPrev: () => selectAdjacentConversation("prev"),
      goNext: () => selectAdjacentConversation("next"),
    };
  }, [
    conversations,
    activeConversationId,
    selectConversation,
    selectAdjacentConversation,
  ]);

  // "Ready" here means the agent's FIRST-TURN CAPABILITY is online (it can
  // answer) — NOT that the startup coordinator finished hydrating. The shell now
  // mounts early (isShellPaintable) while the agent warms up; the composer stays
  // interactive but queues sends until this flips, then flushes — so first-turn
  // capability fades in behind a live UI. Server-authoritative via
  // agentStatus.canRespond (falls back to running+model on older agents).
  const ready = deriveAgentReady(agentStatus);
  const modelStatus = useHomeModelStatus();
  const [isOpen, setIsOpen] = React.useState(false);
  const [recording, setRecording] = React.useState(false);
  // Post-release STT drain (#20483): the mic is closed but the utterance is
  // still transcribing. Drives the pill's "processing" phase so the gap
  // between hold-release and the send/turn never reads as a silent idle.
  const [sttPending, setSttPending] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [analyser, setAnalyser] = React.useState<AnalyserNode | null>(null);
  // True when the most recent user turn was voice-originated (VOICE_DM). Gates
  // whether the agent's reply is spoken back — typed turns stay silent.
  const [lastTurnVoice, setLastTurnVoice] = React.useState(false);
  const captureRef = React.useRef<VoiceCaptureHandle | null>(null);
  // Wall-clock (ms) the current capture handle was created. On the installed
  // iOS PWA the native getUserMedia permission dialog steals focus the instant
  // capture starts, firing visibilitychange → APP_PAUSE; discarding there kills
  // the mic the user is about to grant (tap → prompt → grant → crickets), and
  // transcription mode never re-arms on resume so it can't self-heal. A capture
  // younger than SHELL_CAPTURE_PAUSE_GRACE_MS is kept across such a pause
  // (#voice-crickets).
  const captureStartedAtRef = React.useRef<number>(0);
  // Semantic end-of-turn aggregator for the always-on/converse path: holds a
  // turn that trails off mid-clause (a trailing conjunction/preposition) and
  // appends the speaker's continuation, so a slow speaker is not cut off and
  // sent prematurely. One per converse capture; reset on stop/barge-in.
  const turnAggregatorRef = React.useRef<TurnAggregator | null>(null);
  // True while a stop is user-initiated (toggle-off / barge-in / typing-pause)
  // vs a clean VAD auto-stop. A one-shot backend (local-inference) ends the
  // capture on end-of-turn silence; if the turn was still held (unfinished) we
  // carry it into the NEXT capture so the continuation appends — but an explicit
  // stop discards it. Without this, a held mid-clause turn is silently dropped.
  const explicitStopRef = React.useRef(false);
  const turnCarryoverRef = React.useRef("");
  // Hands-free conversation loop (tap the mic): the mic re-opens after each
  // spoken reply. A ref mirrors the state so the debounced re-listen timer reads
  // the live value at fire time.
  const [handsFree, setHandsFree] = React.useState(false);
  const handsFreeRef = React.useRef(false);
  handsFreeRef.current = handsFree;
  // Proactive microphone-permission state. Populated by a
  // `navigator.permissions.query({ name: "microphone" })` probe on boot and on
  // every hands-free engage, without opening the mic. When the OS has revoked
  // the grant to the installed PWA, `getUserMedia` would otherwise reject with
  // a capture failure the moment the always-on loop re-opens the mic; instead
  // the shell can render a "re-enable mic" affordance the user can act on.
  // `"unknown"` (Permissions API absent / the
  // `"microphone"` descriptor unsupported on Safari-iOS) is treated exactly
  // like `"granted"`/`"prompt"`: proceed and let getUserMedia decide.
  const [micPermission, setMicPermission] =
    React.useState<MicrophonePermissionState>("unknown");
  const micPermissionRef = React.useRef<MicrophonePermissionState>("unknown");
  micPermissionRef.current = micPermission;
  // Transcription mode (long-form record-only): the mic stays open and every
  // utterance is sent silently (metadata.transcriptionMode) until an exit
  // phrase. A ref mirrors the state for the re-listen timer + capture closures.
  const [transcriptionMode, setTranscriptionMode] = React.useState(false);
  const transcriptionModeRef = React.useRef(false);
  transcriptionModeRef.current = transcriptionMode;
  // Whether the hands-free mic loop was running when transcription was entered.
  // The mic and transcript are LINKED but not identical: the transcript button
  // (and a spoken/server "stop") pauses the hands-free reply loop on enter and
  // RESUMES it on exit, so turning transcript off leaves the mic on. Only the
  // mic button turns the mic (and thus transcript) fully off.
  const resumeHandsFreeAfterTranscriptRef = React.useRef(false);
  // Set when a wake-triggered inline reply is sent during transcription, so the
  // assistant's answer is folded into the transcript once it arrives (#9880).
  const recordReplyIntoTranscriptRef = React.useRef(false);
  // Forward handle to `toggleTranscriptionMode` (defined far below) so the
  // converse capture loop can flip INTO transcription on a spoken "start
  // transcription" without a definition-order/closure problem.
  const toggleTranscriptionModeRef = React.useRef<() => void | Promise<void>>(
    () => {},
  );
  // The continuous-chat-mode persisted before hands-free engaged, restored when
  // the user taps the mic off so a deliberate ChatView "vad-gated" choice isn't
  // clobbered to "off". Defaults to "off" — tapping the mic off means voice off.
  const priorContinuousModeRef = React.useRef<"off" | "vad-gated">("off");
  // Auto-restore the persisted "always-on" loop at most once per mount (see the
  // boot effect below) so a later tap-off (which persists "off") is not
  // immediately re-engaged by the same effect re-running.
  const autoEngagedHandsFreeRef = React.useRef(false);
  // Composer-draft signal from the overlay. While the user has a pending typed
  // (or PTT-dictated) draft, the hands-free always-on loop pauses so the mic
  // doesn't transcribe the room over the keyboard; clearing it (on send) lets
  // the loop resume, returning to the prior voice state. State drives the loop
  // effect's re-arm; the ref gives its debounce timer a live re-check.
  const [composerHasDraft, setComposerHasDraftState] = React.useState(false);
  const composerHasDraftRef = React.useRef(false);
  composerHasDraftRef.current = composerHasDraft;
  const setComposerHasDraft = React.useCallback((hasDraft: boolean) => {
    setComposerHasDraftState(hasDraft);
  }, []);
  // Push-to-talk dictation routes its final transcript here (the overlay wires
  // this to its composer draft) instead of sending it.
  const onDictatedTextRef = React.useRef<((text: string) => void) | null>(null);
  const setDictationSink = React.useCallback(
    (sink: ((text: string) => void) | null) => {
      onDictatedTextRef.current = sink;
    },
    [],
  );

  // Transcription mode accumulates utterances into ONE recording session (not N
  // chat bubbles); on exit the segments become a Transcript record + a chat
  // link-widget, delivered through this sink.
  const transcriptSessionRef =
    React.useRef<TranscriptSessionAccumulator | null>(null);
  const transcriptSessionStartRef = React.useRef(0);
  const onTranscriptSessionRef = React.useRef<
    | ((
        segments: TranscriptSegment[],
        startedAtMs: number,
        audioWav: Uint8Array | null,
      ) => void)
    | null
  >(null);
  const setTranscriptSessionSink = React.useCallback(
    (
      sink:
        | ((
            segments: TranscriptSegment[],
            startedAtMs: number,
            audioWav: Uint8Array | null,
          ) => void)
        | null,
    ) => {
      onTranscriptSessionRef.current = sink;
    },
    [],
  );
  /** Begin a fresh recording session (every transcription-start path calls this). */
  const beginTranscriptSession = React.useCallback(() => {
    transcriptSessionStartRef.current = Date.now();
    transcriptSessionRef.current = new TranscriptSessionAccumulator(
      transcriptSessionStartRef.current,
    );
  }, []);
  /** Close the session and hand its segments to the sink (no-op if empty). */
  const finalizeTranscriptSession = React.useCallback(() => {
    const session = transcriptSessionRef.current;
    transcriptSessionRef.current = null;
    if (!session || session.count === 0) return;
    onTranscriptSessionRef.current?.(
      session.build(),
      transcriptSessionStartRef.current,
      session.buildAudioWav(),
    );
  }, []);

  // Identity-preserving projection: reuse the previously-mapped ShellMessage for
  // any turn whose content/failureKind/reasoning is unchanged, so the React.memo
  // on each ThreadLine short-circuits. Without this, every streamed token (which
  // hands `conversationMessages` a new array reference) re-wrapped EVERY message
  // into a fresh object, re-rendering all ~80 historical bubbles per token. The
  // reducer (useStreamingText) already preserves per-message identity one layer
  // down; this stops the projection from throwing it away. The Map is rebuilt
  // fresh each pass so dropped ids are evicted (no long-session leak), and the
  // returned array is still NEW whenever anything changes (latestAgentReply /
  // visibleMessages / scroll-follow still recompute). Cache key omits
  // role/createdAt — invariant per id.
  const shellMessageCacheRef = React.useRef<Map<string, ShellMessage>>(
    new Map(),
  );
  const messages = React.useMemo<ShellMessage[]>(() => {
    const source = Array.isArray(conversationMessages)
      ? conversationMessages
      : [];
    const prev = shellMessageCacheRef.current;
    const next = new Map<string, ShellMessage>();
    const out = source.map((message) => {
      const cached = prev.get(message.id);
      if (
        cached &&
        cached.content === message.text &&
        cached.interrupted === (message.interrupted || undefined) &&
        cached.failureKind === message.failureKind &&
        cached.terminalFailure === message.terminalFailure &&
        cached.replyRecoveryAvailable === message.replyRecoveryAvailable &&
        (cached.reasoning || undefined) === (message.reasoning || undefined) &&
        cached.secretRequest === message.secretRequest &&
        cached.capabilityHandoff === message.capabilityHandoff &&
        // Tool-event merges return a NEW array reference each step, so a
        // reference compare busts the cache exactly on a new/updated tool row.
        cached.toolEvents === message.toolEvents &&
        sameStringList(cached.topics, message.topics)
      ) {
        next.set(message.id, cached);
        return cached;
      }
      const mapped: ShellMessage = {
        id: message.id,
        role: message.role,
        content: message.text,
        createdAt: message.timestamp,
        ...(message.interrupted ? { interrupted: true } : {}),
        // Invariant per id (like role/createdAt), so the cache compare above
        // can omit it. Drives the suggestion affordance (#8792).
        ...(message.source ? { source: message.source } : {}),
        failureKind: message.failureKind,
        terminalFailure: message.terminalFailure,
        replyRecoveryAvailable: message.replyRecoveryAvailable,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
        ...(message.toolEvents?.length
          ? { toolEvents: message.toolEvents }
          : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments }
          : {}),
        ...(message.secretRequest
          ? { secretRequest: message.secretRequest }
          : {}),
        ...(message.capabilityHandoff
          ? { capabilityHandoff: message.capabilityHandoff }
          : {}),
        ...(message.topics?.length ? { topics: message.topics } : {}),
      };
      next.set(message.id, mapped);
      return mapped;
    });
    shellMessageCacheRef.current = next;
    return out;
  }, [conversationMessages]);

  // The agent's most recent reply, for the always-on shouldRespond echo guard
  // (suppress a voice turn that's just the agent's own TTS heard back). A ref so
  // the per-capture commit closure reads the live value.
  const latestAgentReply = React.useMemo<{ text: string; at: number }>(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === "assistant" && m.content.trim()) {
        return { text: m.content, at: m.createdAt };
      }
    }
    return { text: "", at: 0 };
  }, [messages]);
  const latestAgentReplyRef = React.useRef(latestAgentReply);
  latestAgentReplyRef.current = latestAgentReply;

  // When a wake-triggered inline reply was sent during transcription, fold the
  // agent's answer into the transcript record (speaker-labeled) so the parallel
  // chat is captured, then clear the one-shot flag (#9880).
  React.useEffect(() => {
    if (!recordReplyIntoTranscriptRef.current) return;
    if (!transcriptionModeRef.current) return;
    if (chatSending) return; // wait for the reply to finish streaming
    const reply = latestAgentReply.text.trim();
    if (!reply) return;
    recordReplyIntoTranscriptRef.current = false;
    transcriptSessionRef.current?.addFinal(reply, Date.now(), {
      speakerLabel: wakeCharacterNameRef.current,
    });
  }, [latestAgentReply, chatSending]);

  const send = React.useCallback(
    (
      text: string,
      options?: {
        channelType?: "DM" | "VOICE_DM";
        images?: ImageAttachment[];
        metadata?: Record<string, unknown>;
        clientMessageId?: string;
      },
    ) => {
      const trimmed = text.trim();
      // An image-only turn is valid: only bail when there's neither text nor an
      // attachment to send.
      if (!trimmed && !options?.images?.length) return;
      // Record voice-ness of this turn so the reply is (or is not) spoken back.
      setLastTurnVoice(options?.channelType === "VOICE_DM");
      // Send immediately even while the agent is still warming up: sendChatText
      // renders the optimistic user bubble + typing indicator right away, and the
      // server HOLDS the turn through the warming window (runtime-ready gate),
      // streaming the reply the instant first-turn capability comes online —
      // rather than queueing the message invisibly.
      if (options) {
        void sendChatText(trimmed, options);
        return;
      }
      void sendChatText(trimmed);
    },
    [sendChatText],
  );
  const sendFirstRunText = React.useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      void sendActionMessage(trimmed);
    },
    [sendActionMessage],
  );

  const stopCaptureAndDrain = React.useCallback(
    async (options?: { immediateUiReset?: boolean }) => {
      const handle = captureRef.current;
      captureRef.current = null;
      // Mark this as a user-initiated stop so the clean-auto-stop carryover does
      // NOT fire — a toggle-off / barge-in / typing-pause must discard a
      // half-finished utterance rather than carry or commit it.
      explicitStopRef.current = true;
      turnCarryoverRef.current = "";
      turnAggregatorRef.current?.reset();
      // Push-to-talk release (#20483): drop the listening UI state IMMEDIATELY.
      // For the cloud backend `handle.stop()` includes the whole STT round trip
      // (seconds), and the pill's hold release must visibly end the hot-mic
      // state the instant the finger lifts — the mic hardware is already done
      // capturing; only transcription remains. That remainder is surfaced as
      // the `processing` phase via sttPending so the drain never reads as a
      // silent idle. Opt-in only: the mode-handoff drains (hands-free →
      // transcription) key their replacement-capture effects off `recording`,
      // so flipping it early there would open the next recorder mid-drain.
      if (options?.immediateUiReset) {
        setAnalyser(null);
        setRecording(false);
        setTranscript("");
        if (handle) setSttPending(true);
      }
      if (handle) {
        try {
          await handle.stop();
        } catch {
          /* stop is best-effort from UI controls; transcribe failures surface
             through onStateChange("error") */
        } finally {
          handle.dispose();
          if (options?.immediateUiReset) setSttPending(false);
        }
      }
      setAnalyser(null);
      setRecording(false);
      setTranscript("");
    },
    [],
  );

  const stopCapture = React.useCallback(
    (options?: { immediateUiReset?: boolean }) => {
      void stopCaptureAndDrain(options);
    },
    [stopCaptureAndDrain],
  );

  // Hold-to-talk cancel (#20483): drop the capture WITHOUT the stop() drain, so
  // no STT round-trip runs and nothing is transcribed or sent. dispose() runs
  // the recorder's cancel() — it releases the MediaStream tracks and closes the
  // AudioContext. This is the Esc-mid-hold / slide-off-release path; a
  // cancelled hold must cost the user nothing.
  const cancelCapture = React.useCallback(() => {
    const handle = captureRef.current;
    captureRef.current = null;
    explicitStopRef.current = true;
    turnCarryoverRef.current = "";
    turnAggregatorRef.current?.reset();
    if (handle) {
      try {
        handle.dispose();
      } catch {
        /* dispose is best-effort — the recorder's cancel() is idempotent */
      }
    }
    setAnalyser(null);
    setRecording(false);
    setSttPending(false);
    setTranscript("");
  }, []);

  // Discard an in-flight capture on app suspend WITHOUT transcribing (#voice-V1).
  // When iOS backgrounds the PWA mid-capture the `ScriptProcessorNode` stalls,
  // so `handle.stop()` (the drain path) would trigger a doomed STT round-trip on
  // a truncated/empty WAV and throw "No microphone audio was captured". Instead
  // `dispose()` runs the recorder's `cancel()` — it releases the MediaStream
  // tracks (so iOS drops the mic indicator during suspension) and closes the
  // AudioContext without a transcribe. `explicitStopRef` is set so the clean-
  // auto-stop carryover does NOT fire (a suspended turn is discarded, not held),
  // and the state resets clear the stuck "recording" UI so a resume re-arms from
  // a clean idle. `handsFree` is deliberately left intact: the re-listen loop
  // (and the resume effect below) re-open the mic on foreground.
  const discardCaptureForSuspend = React.useCallback(() => {
    const handle = captureRef.current;
    if (!handle) return;
    // Permission-prompt grace (#voice-crickets): the iOS getUserMedia dialog
    // fires visibilitychange → APP_PAUSE the instant capture starts. Discarding
    // there kills the mic the user is about to grant, and transcription mode
    // never re-arms on resume, so keep a capture younger than the grace window.
    // A genuine background that stalls the WebAudio graph is still caught at
    // stop() by the empty-WAV guard, so keeping a young capture alive is safe.
    if (captureStartedAtRef.current > 0) {
      const captureAgeMs = Date.now() - captureStartedAtRef.current;
      if (captureAgeMs < SHELL_CAPTURE_PAUSE_GRACE_MS) {
        voiceCaptureDebug("pause:kept", {
          surface: "shell",
          captureAgeMs,
          graceMs: SHELL_CAPTURE_PAUSE_GRACE_MS,
        });
        return;
      }
    }
    voiceCaptureDebug("pause:cancel", { surface: "shell" });
    captureRef.current = null;
    explicitStopRef.current = true;
    turnCarryoverRef.current = "";
    turnAggregatorRef.current?.reset();
    try {
      handle.dispose();
    } catch {
      /* dispose is best-effort — the recorder's cancel() is idempotent */
    }
    setAnalyser(null);
    setRecording(false);
    setTranscript("");
  }, []);

  const startCapture = React.useCallback(
    (intent?: CaptureIntent) => {
      // Cloud-only, signed out: refuse capture. User-initiated paths call
      // requestSignIn themselves; auto-engage must not pop a login from an
      // effect (that would lose the gesture and fall into same-tab).
      if (authGateRef.current.gated) return;
      // Every legacy boot/re-listen/wake path converges here. Route a healthy,
      // conversation-bound realtime seam to Cartesia, but keep batch closed
      // while an old realtime owner is still releasing media after a probe or
      // identity change. A steady negative probe falls through to batch.
      if (
        realtimeVoiceOwnsMedia &&
        (intent === undefined || intent === "converse")
      ) {
        if (realtimeVoiceSelected) startRealtimeVoiceRef.current();
        return;
      }
      // Voice capture is independent of agent-respond readiness. A converse
      // transcript goes through the same warm-tolerant send() (the server holds
      // the turn until first-turn capability is online), and dictation only
      // fills the composer draft. Gating on `ready` here wrongly disabled voice
      // whenever the agent could not respond yet (e.g. no model loaded) even
      // though typing-and-sending worked. Only guard against a capture already
      // in flight.
      if (captureRef.current) return;
      // Converse (always-on) routes finals through the semantic end-of-turn
      // aggregator so a slow speaker who pauses mid-clause isn't cut off; a turn
      // only sends once it reads as complete. Dictation (push-to-talk) bypasses
      // it — the press-release is the turn boundary.
      let lastBackend: VoiceCaptureBackend = "talkmode";
      // Transcription mode wants a VERBATIM long-form transcript, so (like
      // dictation) it bypasses the echo/disfluency end-of-turn aggregator —
      // every final is sent as-is (after exit-phrase detection).
      const aggregator =
        intent === "dictate" || intent === "transcription" || intent === "ptt"
          ? null
          : new TurnAggregator({
              onCommit: (turn) => {
                // Always-on shouldRespond: don't reply to the agent's own TTS
                // echoed back through the mic, or to pure thinking-noise.
                const reply = latestAgentReplyRef.current;
                const replyAgeMs = reply.at
                  ? Math.max(0, Date.now() - reply.at)
                  : Number.POSITIVE_INFINITY;
                const respondContext = {
                  recentAgentReply: reply.text,
                  replyAgeMs,
                  agentSpeaking: speakingRef.current,
                };
                // Cheap client pre-filter: drop an obvious echo/disfluency turn
                // before it costs a server round-trip.
                if (!shouldRespondToVoiceTurn(turn, respondContext)) {
                  return;
                }
                // Attach the ambient signal so the server gate
                // (`core.voice_turn_signal`) is the single authority on whether
                // to reply, and so diarization/wake-word enrichment composes in
                // on platforms that have them. The transcript-only shell path
                // contributes semantic end-of-turn + the echo/disfluency gate.
                const voiceTurnSignal = buildVoiceTurnSignal(
                  turn,
                  respondContext,
                );
                send(turn, {
                  channelType: "VOICE_DM",
                  metadata: { voiceSource: lastBackend, voiceTurnSignal },
                });
              },
            });
      turnAggregatorRef.current?.dispose();
      turnAggregatorRef.current = aggregator;
      // Carry a held (unfinished) turn from the previous one-shot capture into
      // this one so the speaker's continuation appends instead of dropping.
      if (aggregator && turnCarryoverRef.current) {
        aggregator.seed(turnCarryoverRef.current);
      }
      turnCarryoverRef.current = "";
      // Read the user's VAD thresholds synchronously (local mirror of the
      // `messages.voice` setting) so end-of-turn silence detection honors the
      // configured sensitivity. Only consumed by the local-inference backend.
      const handle = createVoiceCapture({
        localAsrAutoStop: loadVadAutoStop(),
        cloudConnected: isCloudVoiceRunnable({
          connected: elizaCloudConnected,
          proxyAvailable: elizaCloudVoiceProxyAvailable,
        }),
        // Route to the configured STT backend. Without this the factory only
        // ever saw `undefined` and could never select the `eliza-cloud` /
        // `openai` cloud STT path — on a cloud box with no local ASR assets it
        // silently fell through to browser SpeechRecognition instead of
        // `/api/asr/cloud`. Passing the resolved provider makes the documented
        // cloud default reachable from the ambient/hands-free capture surface.
        ...(asrProviderRef.current
          ? { asrProvider: asrProviderRef.current }
          : {}),
        // Push-to-talk (dictation AND the pill's hold-to-talk quasimode) ends
        // on release, so the native recognizer must commit its running interim
        // as the final turn even if its silence window hasn't fired. Converse
        // stops only on toggle-off, where a partial must NOT be submitted.
        finalizeOnStop: intent === "dictate" || intent === "ptt",
        onTranscript: (segment) => {
          const text = segment.text.trim();
          if (!segment.final) {
            // Surface the interim best-guess as live transcription, prefixed by
            // any turn still held for continuation so the user sees the full
            // utterance build up.
            const held = aggregator?.pending;
            setTranscript(held ? `${held} ${text}` : text);
            return;
          }
          if (!text) {
            setTranscript("");
            return;
          }
          // A hands-free recorder can finish draining after the user has
          // switched modes. Once transcription owns the session, route that
          // final into the recording instead of letting the stale converse
          // intent send it as a chat turn.
          if (intent === "transcription" || transcriptionModeRef.current) {
            // Long-form record-only. Run exit detection on every final.
            if (isTranscriptionExitPhrase(text)) {
              // Fold any preceding non-exit content into the session, then close
              // it (→ Transcript record + chat link-widget) and leave the mode so
              // the NEXT turn is evaluated normally.
              const preceding = stripExitPhrase(text);
              if (preceding) {
                transcriptSessionRef.current?.addFinal(preceding, Date.now());
              }
              setTranscript("");
              setTranscriptionMode(false);
              transcriptionModeRef.current = false;
              finalizeTranscriptSession();
              stopCapture();
              // A spoken "stop transcription" turns transcript OFF but leaves
              // the mic ON — resume the hands-free loop it paused on enter.
              if (resumeHandsFreeAfterTranscriptRef.current) {
                resumeHandsFreeAfterTranscriptRef.current = false;
                if (realtimeVoiceSelected) {
                  startRealtimeVoiceRef.current();
                } else {
                  setHandsFree(true);
                  handsFreeRef.current = true;
                }
              }
              return;
            }
            // Wake word DURING transcription → one inline reply, parallel-chat
            // style: the agent answers (and speaks) while recording keeps
            // running (issue #9880). The user's wake utterance is still folded
            // into the transcript so the exchange is captured; the turn is sent
            // WITHOUT the transcriptionMode metadata so the server reply gate
            // does not suppress it, and we do NOT leave transcription mode.
            const wake = matchWakeName(text, wakeCharacterNameRef.current);
            if (wake.matched) {
              setTranscript("");
              transcriptSessionRef.current?.addFinal(text, Date.now(), {
                audioWav: segment.audioWav,
                words: segment.words,
              });
              const command = wake.command.trim() || text;
              const respondContext = {
                recentAgentReply: latestAgentReplyRef.current.text,
                replyAgeMs: latestAgentReplyRef.current.at
                  ? Math.max(0, Date.now() - latestAgentReplyRef.current.at)
                  : Number.POSITIVE_INFINITY,
                agentSpeaking: speakingRef.current,
              };
              // Capture the assistant's spoken reply into the transcript too, so
              // the parallel chat is part of the record.
              recordReplyIntoTranscriptRef.current = true;
              send(command, {
                channelType: "VOICE_DM",
                metadata: {
                  voiceSource: lastBackend,
                  voiceTurnSignal: buildVoiceTurnSignal(
                    command,
                    respondContext,
                  ),
                },
              });
              return;
            }
            // Accumulate this utterance into the recording session — it does NOT
            // post as its own chat bubble; the whole session becomes one record.
            // Carry the utterance WAV + per-word timings (fused ASR v12) so the
            // transcript retains audio + word-synced highlight.
            setTranscript("");
            transcriptSessionRef.current?.addFinal(text, Date.now(), {
              audioWav: segment.audioWav,
              words: segment.words,
            });
          } else if (intent === "dictate") {
            // Push-to-talk dictation: hand the text to the composer draft —
            // don't send, and leave lastTurnVoice false so no reply is spoken.
            setTranscript("");
            onDictatedTextRef.current?.(text);
          } else if (intent === "ptt") {
            // Hold-to-talk quasimode (#20483): the press-release IS the turn
            // boundary and the utterance IS the send. No aggregator, no
            // composer detour — the transcript goes straight out as a voice
            // turn, so the pill can serve a full exchange with the overlay
            // closed. An empty final never reaches here (guarded above), so a
            // ghost hold costs nothing.
            setTranscript("");
            send(text, {
              channelType: "VOICE_DM",
              metadata: { voiceSource: segment.backend },
            });
          } else if (aggregator) {
            // A spoken "start transcription" flips INTO long-form record-only
            // mode instead of being sent as a normal turn. (Exit is handled
            // above once already in transcription mode.)
            if (
              !transcriptionModeRef.current &&
              isTranscriptionStartPhrase(text)
            ) {
              setTranscript("");
              toggleTranscriptionModeRef.current();
              return;
            }
            lastBackend = segment.backend;
            const committed = aggregator.addFinal(text);
            // Keep the held turn visible while we wait for the speaker to
            // continue; clear once it commits (and sends).
            setTranscript(committed ? "" : aggregator.pending);
          }
        },
        onStateChange: (state: VoiceCaptureState, error?: Error) => {
          // A transcribe failure after a real utterance must be VISIBLE: the
          // hold-to-talk contract is that a ghost hold costs nothing but a
          // spoken turn never silently vanishes (#20483). Cloud STT throwing
          // at stop() lands here as the error state; surface one actionable
          // notice instead of letting the words evaporate.
          if (state === "error") {
            if (captureRef.current !== handle) return;
            if (handsFreeRef.current) {
              saveContinuousChatMode(priorContinuousModeRef.current);
              setHandsFree(false);
              handsFreeRef.current = false;
            }
            if (error && isMicPermissionDenialError(error)) {
              setMicPermission("denied");
              micPermissionRef.current = "denied";
            }
            if (
              error &&
              !isNoSpeechCaptureFailure(error) &&
              !captureFailureNoticedRef.current
            ) {
              captureFailureNoticedRef.current = true;
              setActionNotice(describeCaptureFailure(error), "error", 6000);
            }
          }
          if (state === "error" || state === "stopped" || state === "idle") {
            // Capture ended (clean stop, dispose, or error). Drop the handle and
            // analyser so the shell phase returns to idle/summoned and a later
            // startCapture is not blocked by a stale ref.
            if (captureRef.current === handle) captureRef.current = null;
            // A CLEAN end-of-turn auto-stop (one-shot backend like
            // local-inference) on a still-held turn: carry it to the next
            // capture so the continuation appends. An explicit stop (toggle-off /
            // barge-in / error) discards it.
            if (
              state === "stopped" &&
              !explicitStopRef.current &&
              aggregator?.pending
            ) {
              turnCarryoverRef.current = aggregator.pending;
            }
            explicitStopRef.current = false;
            aggregator?.reset();
            setAnalyser(null);
            setRecording(false);
            setTranscript("");
          }
        },
      });
      captureRef.current = handle;
      captureStartedAtRef.current = Date.now();
      setRecording(true);
      handle
        .start()
        .then(() => {
          // A clean start clears the failure latch so a later denial re-notifies.
          captureFailureNoticedRef.current = false;
          // A successful getUserMedia call proves the grant is live. Clear a
          // stale `micPermission: "denied"` so the "re-enable mic" affordance
          // does not linger after push-to-talk, transcription, or conversation
          // capture has already opened.
          if (micPermissionRef.current === "denied") {
            setMicPermission("granted");
            micPermissionRef.current = "granted";
          }
          if (captureRef.current === handle) setAnalyser(handle.getAnalyser());
        })
        .catch((err: unknown) => {
          captureRef.current = null;
          setAnalyser(null);
          setRecording(false);
          // A hands-free tap optimistically lit the mic ("end conversation")
          // before the device opened; a denial must roll that back so the button
          // returns to its resting "talk" state instead of showing a lit,
          // phantom-capturing conversation the mic never actually started. Mirror
          // the deliberate tap-off (restore the prior non-always-on mode) so a
          // reload doesn't re-engage a mic the user can't grant.
          if (handsFreeRef.current) {
            saveContinuousChatMode(priorContinuousModeRef.current);
            setHandsFree(false);
            handsFreeRef.current = false;
          }
          // Reconcile the proactive permission state with the getUserMedia
          // result. A `NotAllowedError`/permission-denied rejection is the
          // ground truth that the grant is revoked, even when an earlier
          // permissions query reported "prompt"/"unknown".
          if (isMicPermissionDenialError(err)) {
            setMicPermission("denied");
            micPermissionRef.current = "denied";
          }
          // Surface one actionable notice per grant epoch; the hands-free
          // re-listen loop may retry capture, but repeated toasts make recovery
          // harder rather than clearer.
          if (
            !captureFailureNoticedRef.current &&
            !isNoSpeechCaptureFailure(err)
          ) {
            captureFailureNoticedRef.current = true;
            setActionNotice(describeCaptureFailure(err), "error", 6000);
          }
        });
    },
    [
      realtimeVoiceSelected,
      realtimeVoiceOwnsMedia,
      elizaCloudConnected,
      elizaCloudVoiceProxyAvailable,
      send,
      stopCapture,
      finalizeTranscriptSession,
      setActionNotice,
    ],
  );

  // Proactive microphone-permission recheck. Reads the OS grant via
  // `navigator.permissions.query({ name: "microphone" })` without opening the
  // mic, mirrors it into `micPermission`, and — when the grant has been revoked
  // (`"denied"`) — surfaces an actionable "re-enable mic" notice instead of
  // letting the subsequent `getUserMedia` fail at capture time. Returns the resolved
  // state so callers (boot auto-engage, hands-free tap) can decide whether to
  // proceed. `"unknown"` (Permissions API / descriptor unsupported — Safari-iOS)
  // and `"prompt"`/`"granted"` all mean "proceed normally": we never block
  // capture on a probe that can't answer; only a known denial short-circuits.
  const recheckMicPermission =
    React.useCallback(async (): Promise<MicrophonePermissionState> => {
      const state = await queryMicrophonePermission();
      setMicPermission(state);
      micPermissionRef.current = state;
      if (state === "denied") {
        // Guard against spamming the toast on the hands-free re-listen loop's
        // repeated engages — reuse the same latch startCapture's failure path
        // uses so a single denial notice shows once per resolved-grant epoch.
        if (!captureFailureNoticedRef.current) {
          captureFailureNoticedRef.current = true;
          setActionNotice(
            "Microphone access is off. Re-enable microphone permission in your browser or system settings to use voice.",
            "error",
            6000,
          );
        }
        // A background refresh that discovers the grant is revoked must not
        // leave the shell in a phantom always-on state: if
        // hands-free is engaged but no capture is actually in flight (e.g. the
        // user engaged while a reply was responding, so the mic hasn't opened
        // yet), roll it back to rest and restore the prior mode. If a capture
        // is in flight, leave it because its own getUserMedia lifecycle handles
        // a mid-session revocation.
        if (handsFreeRef.current && !captureRef.current) {
          saveContinuousChatMode(priorContinuousModeRef.current);
          setHandsFree(false);
          handsFreeRef.current = false;
        }
      } else {
        // A recovered/unknown grant clears the latch so a later denial notifies.
        captureFailureNoticedRef.current = false;
      }
      return state;
    }, [setActionNotice]);

  // Engage-time surfacing of a known-denied grant: rolls hands-free back to
  // rest and shows the actionable "re-enable mic" notice (once per grant epoch)
  // instead of opening a mic getUserMedia would reject.
  const surfaceMicDeniedAtEngage = React.useCallback(() => {
    if (!captureFailureNoticedRef.current) {
      captureFailureNoticedRef.current = true;
      setActionNotice(
        "Microphone access is off. Re-enable microphone permission in your browser or system settings to use voice.",
        "error",
        6000,
      );
    }
  }, [setActionNotice]);

  // Engage-time mic-permission gate for the user-tap path. Returns a
  // decision the caller acts on: whether to proceed to open the mic.
  //
  // FAST PATH (last-known state is not "denied"): decide synchronously against
  // the ref the boot/prior probes seeded — keeps "tap → mic opens" raceless and
  // synchronous. "unknown"/"prompt"/"granted" proceed; a background refresh
  // keeps the ref fresh, and if the grant was revoked since the last probe,
  // startCapture's getUserMedia-denial catch is the authoritative backstop.
  //
  // RECOVERY PATH (last-known state is "denied"): await a fresh probe before
  // blocking, because a denied→retry tap is exactly when the user has just
  // re-enabled permission in settings — treating the stale "denied" as
  // authoritative would make that first retry a dead no-op. If the fresh probe
  // still reports "denied" we surface the affordance; otherwise (recovered /
  // now-unknown) we proceed to open the mic.
  //
  // `onProceed` is invoked (sync on the fast path, post-await on the recovery
  // path) only when the mic should open.
  const gateEngageOnMicPermission = React.useCallback(
    (onProceed: () => void): void => {
      if (micPermissionRef.current !== "denied") {
        // Fast path: proceed now, refresh the ref for next time in the
        // background.
        void recheckMicPermission();
        onProceed();
        return;
      }
      // Recovery path: the last-known grant is denied, so re-probe before
      // deciding. A just-re-enabled grant should engage on this tap.
      void recheckMicPermission().then((state) => {
        if (state === "denied") {
          surfaceMicDeniedAtEngage();
          return;
        }
        // Recovered (or now-unknown): guard against a capture that opened via
        // another path during the await, then open the mic.
        if (authGateRef.current.gated || captureRef.current) return;
        onProceed();
      });
    },
    [recheckMicPermission, surfaceMicDeniedAtEngage],
  );

  const toggleRecording = React.useCallback(() => {
    if (authGate.gated) {
      recoverGatedCapture();
      return;
    }
    if (realtimeVoiceCanStart) {
      if (recording || handsFreeRef.current || realtimeVoiceWantedRef.current) {
        stopRealtimeVoiceRef.current();
      } else {
        startRealtimeVoiceRef.current();
      }
      return;
    }
    if (recording) stopCapture();
    else startCapture();
  }, [
    authGate.gated,
    realtimeVoiceCanStart,
    recording,
    recoverGatedCapture,
    startCapture,
    stopCapture,
  ]);

  React.useEffect(() => () => stopCapture(), [stopCapture]);

  // Restore a persisted "always-on" continuous-chat mode on boot: engage the
  // hands-free re-listen LOOP (not a one-shot capture) so always-on survives a
  // reload as a real setting — the same state a mic tap produces. Audio output
  // stays locked until the first user gesture (no unlockAudio here), but the mic
  // (capture) opens from the already-granted permission. Guarded to auto-engage
  // at most once per mount so a later tap-off (which persists "off") isn't
  // re-engaged by this effect re-running.
  React.useEffect(() => {
    // Batch restore stays inert only while realtime is eligible or still owns
    // media. A negative conversation probe intentionally restores batch.
    if (realtimeVoiceOwnsMedia) return;
    if (autoEngagedHandsFreeRef.current) return;
    // Cloud-only signed out: leave the ref unset so a later sign-in retries
    // this restore; auto-engage must not light hands-free against the gate.
    if (authGate.gated) return;
    // Defer while a reply is mid-flight (voice is gated while responding); the
    // ref stays unset so this retries the instant `chatSending` clears.
    if (!ready || recording || captureRef.current || handsFree || chatSending)
      return;
    if (loadContinuousChatMode() !== "always-on") return;
    autoEngagedHandsFreeRef.current = true;
    priorContinuousModeRef.current = "off";
    // Proactive mic-permission recheck on boot: before re-opening the mic for a
    // persisted always-on session, await the fresh grant. Unlike the
    // user-tap path (which reads the already-seeded ref synchronously so
    // tap->mic stays raceless), boot fires on the same tick as the initial
    // probe, so the ref would still be the default "unknown". If the grant is
    // known-revoked, surface the "re-enable mic"
    // affordance and stay disengaged (roll back to the prior non-always-on
    // mode) instead of letting startCapture's getUserMedia reject.
    // Unknown/prompt/granted proceed (getUserMedia re-prompts on "prompt").
    void recheckMicPermission().then((state) => {
      if (state === "denied") {
        // Don't light a phantom always-on loop against a revoked grant.
        saveContinuousChatMode(priorContinuousModeRef.current);
        return;
      }
      // The probe is async: re-check the gating state so a capture that opened
      // via another path (or a hands-free toggle) during the await isn't
      // double-opened / overridden. The auth gate is re-read through the ref —
      // sign-out during the await must not light hands-free or summon the
      // overlay against a startCapture that will refuse.
      if (
        authGateRef.current.gated ||
        captureRef.current ||
        handsFreeRef.current
      ) {
        return;
      }
      setHandsFree(true);
      handsFreeRef.current = true;
      setIsOpen(true);
      startCapture("converse");
    });
  }, [
    ready,
    recording,
    handsFree,
    chatSending,
    startCapture,
    recheckMicPermission,
    realtimeVoiceOwnsMedia,
    authGate.gated,
  ]);

  // Populate the mic-permission state once on mount so a shell surface can
  // render the correct mic affordance immediately — independent of always-on.
  // This does not toast on denial (no notice on a passive boot probe): it only
  // seeds `micPermission` for the UI. The always-on boot effect above and the
  // hands-free tap below are the paths that surface the actionable notice.
  const bootPermissionProbedRef = React.useRef(false);
  React.useEffect(() => {
    if (bootPermissionProbedRef.current) return;
    bootPermissionProbedRef.current = true;
    void queryMicrophonePermission().then((state) => {
      setMicPermission(state);
      micPermissionRef.current = state;
    });
  }, []);

  const open = React.useCallback(() => {
    if (authGate.phase === "needs-auth") {
      requestSignIn();
      return;
    }
    setIsOpen(true);
  }, [authGate.phase, requestSignIn]);
  const close = React.useCallback(() => {
    setIsOpen(false);
    setHandsFree(false);
    handsFreeRef.current = false;
    realtimeVoiceWantedRef.current = false;
    stopRealtimeVoiceRef.current();
    if (captureRef.current) stopCapture();
  }, [stopCapture]);

  const toggleAgentVoiceMute = React.useCallback(() => {
    setState("chatAgentVoiceMuted", !chatAgentVoiceMuted);
  }, [chatAgentVoiceMuted, setState]);

  const voiceOutput = useShellVoiceOutput({
    conversationMessages: Array.isArray(conversationMessages)
      ? conversationMessages
      : [],
    chatSending,
    recording,
    lastTurnVoice,
    agentVoiceMuted: chatAgentVoiceMuted,
    toggleAgentVoiceMute,
    uiLanguage,
    cloudConnected: isCloudVoiceRunnable({
      connected: elizaCloudConnected && !authGate.gated,
      proxyAvailable: elizaCloudVoiceProxyAvailable,
    }),
    realtimeVoiceEnabled: realtimeVoiceOwnsMedia,
  });
  // Wire the forward ref so the conversation-switch / clear handlers (defined
  // above `voiceOutput`) can stop in-flight assistant speech at gesture time.
  stopSpeakingRef.current = voiceOutput.stopSpeaking;
  asrProviderRef.current = voiceOutput.asrProvider;

  // `recording` (push-to-talk press or continuous capture) wins over an
  // in-flight response so the pill shows the red "listening" pulse the instant
  // the mic opens, even while the previous turn is still streaming (barge-in).
  // "responding" covers BOTH the text streaming in (chatSending) AND the reply
  // being spoken aloud (voiceOutput.speaking), so the UI reads as busy for the
  // whole turn — not just the text phase, leaving a dead gap while TTS plays.
  // Stop/error clears `recording` (see startCapture/stopCapture), dropping the
  // phase back to responding → summoned → idle.
  // The RAW in-flight predicate — text streaming (chatSending) OR the reply being
  // spoken (speaking). Unlike `phase === "responding"`, this stays true even
  // after the mic opens (which flips phase to "listening"), so the composer-send
  // and voice-gating logic both read one honest "a reply is in flight" signal.
  const realtimeVoiceResponding =
    realtimeVoiceOwnsMedia &&
    (realtimeVoice.status === "thinking" ||
      realtimeVoice.status === "speaking" ||
      realtimeVoice.status === "interrupting");
  const realtimeVoiceListening =
    realtimeVoiceOwnsMedia &&
    (realtimeVoice.connecting ||
      realtimeVoice.status === "listening" ||
      realtimeVoice.status === "transcribing");
  const realtimeVoiceRecording =
    realtimeVoiceOwnsMedia &&
    (realtimeVoice.active || realtimeVoice.connecting);
  const responding =
    chatSending || voiceOutput.speaking || realtimeVoiceResponding;

  // The rich status (#8813): what the agent is *doing*, distinct from the coarse
  // `responding` boolean. Voice playback wins (the server can't see local TTS).
  // Otherwise prefer the live server phase while a text turn is in flight; if no
  // server status has arrived yet, fall back to thinking (sent, no first token)
  // → streaming (first token seen). The server's `waking` status (cloud 202) is
  // surfaced even before chatSending settles, so it shows while the agent boots.
  const turnStatus = React.useMemo<ChatTurnStatus | null>(() => {
    if (voiceOutput.speaking || realtimeVoice.agentSpeaking) {
      return { kind: "speaking" };
    }
    if (realtimeVoiceOwnsMedia && realtimeVoice.status === "thinking") {
      return { kind: "thinking" };
    }
    if (
      serverTurnStatus &&
      (chatSending || serverTurnStatus.kind === "waking")
    ) {
      return serverTurnStatus;
    }
    if (chatSending) {
      return { kind: chatFirstTokenReceived ? "streaming" : "thinking" };
    }
    return null;
  }, [
    voiceOutput.speaking,
    realtimeVoice.agentSpeaking,
    realtimeVoice.status,
    realtimeVoiceOwnsMedia,
    serverTurnStatus,
    chatSending,
    chatFirstTokenReceived,
  ]);

  // Opening the popup is independent of runtime readiness. The composer can
  // already queue/send while the server warms, so keeping an opened shell in
  // `booting` would make AssistantOverlay discard it even though `isOpen` is
  // true. Reserve `booting` for the closed launcher state and for the
  // cloud-only auth probe (`checking`).
  const phase: ShellPhase = deriveShellPhase({
    ready,
    recording,
    realtimeVoiceListening,
    sttPending,
    responding,
    isOpen,
    authGate: authGate.phase,
  });

  // Boot-progress token for the slow-boot escalation (#14040 sub-defect 3). It
  // advances whenever the readiness poll observes fresh progress while still
  // waking: the agent process advancing its lifecycle (`state`) / opening its
  // `port`, OR a cloud resume `202` observation (each stamped with a fresh
  // `observedAt`, so a single long-running resume that keeps the same
  // status/jobId STILL advances the token on every successful probe). The
  // banner restarts its slow-boot timer on each change, so a slow-but-
  // progressing boot never trips "taking longer than usual"; a genuinely
  // stalled boot (no fresh observation → token stable) still escalates.
  // `undefined` while ready so the banner (unmounted anyway) never keys off a
  // stale token.
  const bootProgressSignal: string | undefined = ready
    ? undefined
    : `${agentStatus?.state ?? ""}|${agentStatus?.port ?? ""}|` +
      `${agentStatus?.resumeProgress?.status ?? ""}:` +
      `${agentStatus?.resumeProgress?.jobId ?? ""}:` +
      `${agentStatus?.resumeProgress?.observedAt ?? ""}`;

  // History half of the "no LLM/model provider configured" signal. The server
  // stamps an assistant turn with `failureKind: "no_provider"` when it tried to
  // answer but no provider plugin is wired. Derived from the LATEST assistant
  // turn so a later successful reply (provider added in Settings) clears it
  // automatically.
  const latestAssistantNoProvider = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "assistant") {
        return message.failureKind === "no_provider";
      }
    }
    return false;
  }, [messages]);

  // AUTHORITATIVE "no provider configured" signal = history stamp AND live
  // server truth. The stamp is persisted in conversation history, so on its own
  // a stale no_provider turn would hijack every later app launch / conversation
  // switch into Settings even after a provider IS configured. Require the
  // current status to agree: `canRespond === false` exactly — the server's
  // `computeCanRespond` requires a registered TEXT handler, so with no provider
  // it stays false FOREVER (not a transient warm-up), while a null/undefined
  // early status is "unknown yet" and must NOT trigger. This matters because
  // `ready` (`deriveAgentReady`) keys off `canRespond`: without this signal the
  // shell would sit in the `booting` phase indefinitely — the "Waking …" banner
  // + "waking up…" composer placeholder never clear, reading as an infinite
  // spinner even though the send already came back with the actionable
  // no-provider gate.
  const noProviderConfigured =
    latestAssistantNoProvider && agentStatus?.canRespond === false;

  // On the false→true edge, route the user straight to Settings — where the
  // model provider is configured — instead of leaving them staring at a chat
  // that can never answer. The in-transcript no-provider gate remains the error
  // surface (with its own "Open Settings" CTA); this just makes the hop
  // automatic. Ref-guarded so it fires once per occurrence, not on every render,
  // and re-arms once the condition clears (provider wired → a later miss routes
  // again).
  const noProviderNavigatedRef = React.useRef(false);
  React.useEffect(() => {
    if (!noProviderConfigured) {
      noProviderNavigatedRef.current = false;
      return;
    }
    if (noProviderNavigatedRef.current) return;
    noProviderNavigatedRef.current = true;
    openSettings();
  }, [noProviderConfigured, openSettings]);

  // Live mirror of whether the agent is speaking, for the converse commit
  // closure's echo guard (it reads at send time, after this render).
  const speakingRef = React.useRef(false);
  speakingRef.current = voiceOutput.speaking || realtimeVoice.agentSpeaking;

  // The composer's stop control halts the turn — the spoken reply always, and
  // text generation ONLY while it's actually streaming. During pure TTS playback
  // `handleChatStop` must not fire: it's the broad chat-stop that also tears down
  // unrelated coding-agent PTY sessions; here we just want to stop the speech.
  const stopTurn = React.useCallback(() => {
    if (chatSending) handleChatStop();
    if (realtimeVoiceRef.current.agentSpeaking) {
      realtimeVoiceRef.current.bargeIn();
    }
    voiceOutput.stopSpeaking();
  }, [chatSending, handleChatStop, voiceOutput.stopSpeaking]);

  const stopRealtimeVoice = React.useCallback(() => {
    realtimeVoiceWantedRef.current = false;
    realtimeVoiceWasActiveRef.current = false;
    saveContinuousChatMode(priorContinuousModeRef.current);
    setHandsFree(false);
    handsFreeRef.current = false;
    if (captureRef.current) stopCapture();
    void realtimeVoiceRef.current.stop();
    voiceOutput.stopSpeaking();
  }, [stopCapture, voiceOutput.stopSpeaking]);

  const startRealtimeVoice = React.useCallback(async () => {
    if (authGateRef.current.gated) return;
    if (!realtimeVoiceCanStart) return;
    if (captureRef.current || recording || sttPending) return;
    if (
      realtimeVoiceWantedRef.current ||
      realtimeVoiceRef.current.active ||
      realtimeVoiceRef.current.connecting
    ) {
      return;
    }
    setRealtimeVoiceBatchFallback(false);

    const prior = loadContinuousChatMode();
    if (prior !== "always-on") priorContinuousModeRef.current = prior;
    saveContinuousChatMode("always-on");
    realtimeVoiceWantedRef.current = true;
    realtimeVoiceWasActiveRef.current = false;
    setRealtimeVoiceBoundaryError(null);
    setHandsFree(true);
    handsFreeRef.current = true;
    setIsOpen(true);
    if (captureRef.current) stopCapture();

    const conversationId = await ensureActiveConversationForVoice();
    if (authGateRef.current.gated || !realtimeVoiceWantedRef.current) return;
    if (!conversationId) {
      const message =
        "Cartesia voice needs an active conversation. Tap Talk to retry.";
      realtimeVoiceWantedRef.current = false;
      saveContinuousChatMode(priorContinuousModeRef.current);
      setHandsFree(false);
      handsFreeRef.current = false;
      setRealtimeVoiceBoundaryError(message);
      setActionNotice(message, "error", 6000);
      return;
    }

    if (authGateRef.current.gated) return;
    const outcome = await realtimeVoiceRef.current.start();
    if (!realtimeVoiceWantedRef.current) {
      if (outcome.kind === "live") void realtimeVoiceRef.current.stop();
      return;
    }
    if (outcome.kind === "live") return;

    const message = describeRealtimeVoiceFailure(
      outcome,
      realtimeVoiceRef.current.error?.message || null,
    );
    realtimeVoiceWantedRef.current = false;
    saveContinuousChatMode(priorContinuousModeRef.current);
    setHandsFree(false);
    handsFreeRef.current = false;
    setRealtimeVoiceBoundaryError(message);
    if (outcome.kind === "error" && outcome.error.kind === "permission") {
      setMicPermission("denied");
      micPermissionRef.current = "denied";
    }
    setActionNotice(message, "error", 6000);
  }, [
    ensureActiveConversationForVoice,
    realtimeVoiceCanStart,
    recording,
    setActionNotice,
    sttPending,
    stopCapture,
  ]);
  startRealtimeVoiceRef.current = () => {
    void startRealtimeVoice();
  };
  stopRealtimeVoiceRef.current = stopRealtimeVoice;

  // Identity loss ends the current realtime intent; it must not silently
  // reopen the microphone through a different transcription provider. A
  // recovered identity becomes selectable only when all media owners are idle.
  React.useEffect(() => {
    const wasEnabled = realtimeVoiceWasEnabledRef.current;
    realtimeVoiceWasEnabledRef.current = realtimeVoiceEnabled;

    if (wasEnabled && !realtimeVoiceEnabled) {
      const shouldContinue =
        realtimeVoiceWantedRef.current ||
        realtimeVoice.active ||
        realtimeVoice.connecting;
      realtimeVoiceWantedRef.current = false;
      realtimeVoiceWasActiveRef.current = false;
      setRealtimeVoiceBatchFallback(true);
      if (shouldContinue) {
        stopRealtimeVoice();
        const message =
          "Cartesia voice connection changed. Tap Talk to reconnect.";
        setRealtimeVoiceBoundaryError(message);
        setActionNotice(message, "error", 6000);
      }
    }

    if (!realtimeVoiceEnabled || !realtimeVoiceBatchFallback) return;
    if (
      authGate.gated ||
      handsFree ||
      realtimeVoice.active ||
      realtimeVoice.connecting ||
      captureRef.current ||
      recording ||
      sttPending ||
      chatSending ||
      voiceOutput.speaking
    ) {
      return;
    }

    setRealtimeVoiceBatchFallback(false);
  }, [
    authGate.gated,
    chatSending,
    handsFree,
    realtimeVoice.active,
    realtimeVoiceBatchFallback,
    realtimeVoice.connecting,
    realtimeVoiceEnabled,
    recording,
    sttPending,
    stopRealtimeVoice,
    setActionNotice,
    voiceOutput.speaking,
  ]);

  const stopRecording = React.useCallback(() => {
    if (
      realtimeVoiceWantedRef.current ||
      realtimeVoiceRef.current.active ||
      realtimeVoiceRef.current.connecting
    ) {
      stopRealtimeVoice();
      return;
    }
    // Push-to-talk release: end the visible hot-mic state the instant the
    // finger lifts — the STT drain continues in the background (#20483).
    stopCapture({ immediateUiReset: true });
  }, [stopCapture, stopRealtimeVoice]);

  // A LIVE Talk session that dies past the client's reconnect budget (network
  // outage longer than the recovery window, terminal server error) must park
  // Talk visibly OFF: restore the persisted mode, clear hands-free, and
  // surface the actionable error. Leaving `wanted` latched would make the
  // advertised "tap the mic to try again" first toggle the dead session off
  // and appear to do nothing. Gated on a previously-ACTIVE session so initial
  // start failures keep their existing outcome-driven handling in
  // startRealtimeVoice (which also owns the pre-live notice copy).
  React.useEffect(() => {
    if (realtimeVoice.active) realtimeVoiceWasActiveRef.current = true;
  }, [realtimeVoice.active]);
  React.useEffect(() => {
    if (!realtimeVoiceSelected) return;
    if (!realtimeVoice.error) return;
    if (realtimeVoice.active || realtimeVoice.connecting) return;
    if (!realtimeVoiceWasActiveRef.current) return;
    if (!realtimeVoiceWantedRef.current) return;
    realtimeVoiceWasActiveRef.current = false;
    realtimeVoiceWantedRef.current = false;
    saveContinuousChatMode(priorContinuousModeRef.current);
    setHandsFree(false);
    handsFreeRef.current = false;
    setActionNotice(realtimeVoice.error.message, "error", 6000);
  }, [
    realtimeVoiceSelected,
    realtimeVoice.error,
    realtimeVoice.active,
    realtimeVoice.connecting,
    setActionNotice,
  ]);

  // Persisted always-on remains one setting across providers. Once the
  // conversation-bound probe is eligible, Cartesia reclaims an idle Talk loop;
  // a negative probe leaves the batch restoration path authoritative.
  React.useEffect(() => {
    if (!realtimeVoiceSelected || autoEngagedHandsFreeRef.current) return;
    if (!ready || chatSending || realtimeVoice.connecting) return;
    if (loadContinuousChatMode() !== "always-on") return;
    autoEngagedHandsFreeRef.current = true;
    priorContinuousModeRef.current = "off";
    startRealtimeVoiceRef.current();
  }, [chatSending, ready, realtimeVoice.connecting, realtimeVoiceSelected]);

  // Tap-to-talk: toggle a hands-free conversation. Enabling unlocks audio (the
  // tap is the gesture) and opens the mic in "converse" mode; disabling stops
  // both the mic and any in-flight reply.
  const toggleHandsFree = React.useCallback(() => {
    // Stopping is always allowed. In particular, an auth transition must not
    // turn the visible stop control into a sign-in/retry action while a mic,
    // recorder, or realtime session is still owned by this shell.
    if (
      handsFreeRef.current ||
      realtimeVoiceWantedRef.current ||
      realtimeVoiceRef.current.active ||
      realtimeVoiceRef.current.connecting
    ) {
      stopRealtimeVoice();
      return;
    }
    if (authGate.gated) {
      recoverGatedCapture();
      return;
    }
    if (realtimeVoiceCanStart) {
      void startRealtimeVoice();
      return;
    }
    // Tap on → persist "always-on" so the loop is restored across reloads,
    // remembering what to fall back to when it is turned off.
    const prior = loadContinuousChatMode();
    if (prior !== "always-on") priorContinuousModeRef.current = prior;
    saveContinuousChatMode("always-on");
    // Proactive mic-permission gate on hands-free engage. The tap is the
    // audio-unlock gesture, so unlock regardless of the mic decision. The
    // gate opens the mic via the onProceed callback only when the grant is
    // not freshly denied; a known-denied grant surfaces the
    // "re-enable mic" notice and rolls the persisted mode back so a reload
    // doesn't re-engage a mic the user can't grant. (A denied→retry tap
    // re-probes authoritatively, so re-enabling permission engages on the
    // very next tap.)
    voiceOutput.unlockAudio();
    // We optimistically persisted "always-on" above. On the denied recovery
    // path the gate is async and may block, so roll the persisted mode back
    // to the prior value up front; onProceed re-persists "always-on" if the
    // fresh probe clears the denial and we actually engage. On the fast
    // (non-denied) path onProceed runs synchronously and re-persists
    // immediately, so the rollback+re-save is a no-op net change.
    const wasDeniedBeforeGate = micPermissionRef.current === "denied";
    if (wasDeniedBeforeGate) {
      saveContinuousChatMode(priorContinuousModeRef.current);
    }
    gateEngageOnMicPermission(() => {
      // Committing to engage: (re-)persist always-on so a reload restores it.
      saveContinuousChatMode("always-on");
      setHandsFree(true);
      handsFreeRef.current = true;
      setIsOpen(true);
      // Voice is gated while a reply is in flight: open the mic now only if
      // nothing is responding; otherwise the hands-free loop opens it the
      // instant the reply finishes.
      if (!responding) startCapture("converse");
    });
  }, [
    authGate.gated,
    recoverGatedCapture,
    responding,
    startCapture,
    voiceOutput,
    gateEngageOnMicPermission,
    realtimeVoiceCanStart,
    startRealtimeVoice,
    stopRealtimeVoice,
  ]);

  useViewEvent(
    VOICE_SETTINGS_APPLY_EVENT,
    React.useCallback(
      (event) => {
        const payload = event.payload as VoiceSettingsApplyPayload;
        const continuous = readAppliedContinuousMode(payload.continuous);
        if (!continuous) return;
        if (authGateRef.current.gated) return;
        saveContinuousChatMode(continuous);

        if (continuous === "always-on") {
          if (handsFreeRef.current) return;
          priorContinuousModeRef.current = "off";
          if (realtimeVoiceSelected) {
            startRealtimeVoiceRef.current();
            return;
          }
          setHandsFree(true);
          handsFreeRef.current = true;
          setIsOpen(true);
          if (!responding) startCapture("converse");
          return;
        }

        priorContinuousModeRef.current = continuous;
        if (!handsFreeRef.current) return;
        if (realtimeVoiceSelected) {
          stopRealtimeVoiceRef.current();
          return;
        }
        setHandsFree(false);
        handsFreeRef.current = false;
        if (captureRef.current) stopCapture();
        voiceOutput.stopSpeaking();
      },
      [
        realtimeVoiceSelected,
        responding,
        startCapture,
        stopCapture,
        voiceOutput,
      ],
    ),
  );

  // "Hey eliza" wake word: a native detection arms a bounded listening window
  // that opens the mic and closes once the agent has responded (or after an idle
  // timeout if nothing is said). Implemented as a temporary hands-free engage —
  // it never persists "always-on", and it stays inert when the user already
  // chose always-on (wake is only an entry ramp, never an exit). See
  // ../../voice/VOICE_UX.md.
  const wakeAlreadyAlwaysOn =
    handsFree && loadContinuousChatMode() === "always-on";
  // The Settings → Voice "Wake word" toggle gates this listening loop. Read the
  // persisted pref synchronously each render (same direct-read pattern as
  // loadContinuousChatMode above); it defaults ON so wake stays available unless
  // the user turns it off. A disabled pref makes useWakeListenWindow inert (no
  // native subscription, no mic effect).
  const wakeWordEnabled = loadWakeWordEnabled();
  useWakeListenWindow({
    enabled: wakeWordEnabled && !authGate.gated,
    alwaysOn: wakeAlreadyAlwaysOn,
    agentBusy: responding,
    characterName: wakeCharacterName,
    onOpen: React.useCallback(() => {
      // A native wake notification may already be queued when sign-out disables
      // the subscription. The callback itself is the final boundary.
      if (authGateRef.current.gated) return;
      setIsOpen(true);
      if (realtimeVoiceSelected) {
        startRealtimeVoiceRef.current();
        return;
      }
      setHandsFree(true);
      handsFreeRef.current = true;
      voiceOutput.unlockAudio();
      if (!responding && !captureRef.current) startCapture("converse");
    }, [realtimeVoiceSelected, responding, startCapture, voiceOutput]),
    onClose: React.useCallback(() => {
      // Close the temporary window without disturbing a persisted mode.
      if (realtimeVoiceSelected) {
        stopRealtimeVoiceRef.current();
        return;
      }
      setHandsFree(false);
      handsFreeRef.current = false;
      if (captureRef.current) stopCapture();
    }, [realtimeVoiceSelected, stopCapture]),
  });

  // Toggle transcription mode (long-form, record-only — the agent never replies
  // to a transcribed turn). It is an ADDITIVE voice layer: the mic stays on and
  // the composer keeps working; enabling it just pauses the hands-free REPLY
  // loop and opens a long-running capture that accumulates every utterance
  // silently. Turning it off (this toggle, the mic button, or a spoken exit
  // phrase) finalizes the session, which drops the transcript into the composer
  // as an attachment the user sends with their next message.
  const toggleTranscriptionMode = React.useCallback(async () => {
    if (authGateRef.current.gated) {
      recoverGatedCapture();
      return;
    }
    if (transcriptionModeRef.current) {
      setTranscriptionMode(false);
      transcriptionModeRef.current = false;
      if (captureRef.current) await stopCaptureAndDrain();
      // Close the recording session → Transcript record + chat link-widget.
      finalizeTranscriptSession();
      // Turning transcript OFF must leave the mic ON: resume the hands-free
      // listen loop the transcription layer paused on enter. (Only the mic
      // button — handleMicClick → stopTranscriptionAndMic — turns the mic off.)
      if (resumeHandsFreeAfterTranscriptRef.current) {
        resumeHandsFreeAfterTranscriptRef.current = false;
        if (realtimeVoiceSelected) {
          startRealtimeVoiceRef.current();
        } else {
          setHandsFree(true);
          handsFreeRef.current = true;
        }
      }
    } else {
      // Remember the mic state so we can restore it on exit, then pause the
      // hands-free REPLY loop while transcription records silently. The mic
      // itself stays on (transcription capture) — pressing transcript never
      // disables the mic.
      resumeHandsFreeAfterTranscriptRef.current = handsFreeRef.current;
      if (handsFreeRef.current) {
        if (realtimeVoiceSelected) {
          stopRealtimeVoiceRef.current();
        } else {
          setHandsFree(false);
          handsFreeRef.current = false;
        }
      }
      setTranscriptionMode(true);
      transcriptionModeRef.current = true;
      setIsOpen(true);
      voiceOutput.unlockAudio();
      beginTranscriptSession();
      // The outgoing hands-free recorder owns the WAV chunks captured before
      // this mode switch. Drain it before opening the transcription recorder so
      // both captures reach ASR in order and the old handle cannot dispose the
      // new capture's state.
      if (captureRef.current) await stopCaptureAndDrain();
      if (authGateRef.current.gated || !transcriptionModeRef.current) return;
      startCapture("transcription");
    }
  }, [
    startCapture,
    stopCaptureAndDrain,
    voiceOutput,
    beginTranscriptSession,
    finalizeTranscriptSession,
    realtimeVoiceSelected,
    recoverGatedCapture,
  ]);

  // The mic button while transcribing: turn the mic (and thus transcript) fully
  // OFF. Distinct from `toggleTranscriptionMode`'s off-path, which leaves the
  // mic listening — "turning off the mic turns off transcript" (mic = parent).
  const stopTranscriptionAndMic = React.useCallback(async () => {
    setTranscriptionMode(false);
    transcriptionModeRef.current = false;
    if (captureRef.current) await stopCaptureAndDrain();
    finalizeTranscriptSession();
    resumeHandsFreeAfterTranscriptRef.current = false;
    // Turn the mic fully off like a hands-free tap-off: persist the prior
    // non-always-on mode so the auto-engage loop does NOT re-open the mic.
    saveContinuousChatMode(priorContinuousModeRef.current);
    setHandsFree(false);
    handsFreeRef.current = false;
  }, [stopCaptureAndDrain, finalizeTranscriptSession]);
  // Keep the forward ref current so the converse capture loop (defined above)
  // can flip into transcription on a spoken start phrase.
  toggleTranscriptionModeRef.current = toggleTranscriptionMode;

  // A server-side agent action (START/STOP_TRANSCRIPTION) reaches the shell as a
  // window `voice-control` event (the agent-event bus → client bridge); flip
  // transcription to match. Idempotent — "start" while already transcribing (or
  // "stop" while idle) is a no-op.
  React.useEffect(() => {
    const onVoiceControl = (e: Event) => {
      if (authGateRef.current.gated) return;
      const detail = (e as CustomEvent<VoiceControlEventDetail>).detail;
      if (!detail) return;
      if (detail.command === "start" && !transcriptionModeRef.current) {
        toggleTranscriptionModeRef.current();
      } else if (detail.command === "stop" && transcriptionModeRef.current) {
        toggleTranscriptionModeRef.current();
      }
    };
    window.addEventListener(VOICE_CONTROL_EVENT, onVoiceControl);
    return () =>
      window.removeEventListener(VOICE_CONTROL_EVENT, onVoiceControl);
  }, []);

  // omi pendant → chat. The pendant module (packages/ui/src/pendant) runs its
  // own Web Bluetooth capture + VAD + ASR loop and dispatches each finalized
  // transcript as PENDANT_VOICE_TRANSCRIPT_EVENT. Route it through the same
  // VOICE_DM send the mic surfaces use so the reply is spoken back — the pendant
  // gets the full voice loop for free without touching the capture state machine.
  React.useEffect(() => {
    const onPendantTranscript = (e: Event) => {
      const detail = (e as CustomEvent<PendantVoiceTranscriptDetail>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      send(text, {
        channelType: "VOICE_DM",
        ...(detail.segmentId
          ? { clientMessageId: `pendant:${detail.segmentId}` }
          : {}),
        metadata: {
          voiceSource: "pendant",
          ...(detail.ownerId ? { pendantOwnerId: detail.ownerId } : {}),
          ...(detail.agentId ? { pendantAgentId: detail.agentId } : {}),
          ...(detail.sessionId ? { pendantSessionId: detail.sessionId } : {}),
          ...(detail.segmentId ? { pendantSegmentId: detail.segmentId } : {}),
          ...(detail.segmentRevision !== undefined
            ? { pendantSegmentRevision: detail.segmentRevision }
            : {}),
          voiceTurnSignal: buildVoiceTurnSignal(text, {
            recentAgentReply: latestAgentReplyRef.current.text,
            replyAgeMs: latestAgentReplyRef.current.at
              ? Math.max(0, Date.now() - latestAgentReplyRef.current.at)
              : Number.POSITIVE_INFINITY,
            agentSpeaking: speakingRef.current,
          }),
        },
      });
    };
    window.addEventListener(
      PENDANT_VOICE_TRANSCRIPT_EVENT,
      onPendantTranscript,
    );
    return () =>
      window.removeEventListener(
        PENDANT_VOICE_TRANSCRIPT_EVENT,
        onPendantTranscript,
      );
  }, [send]);

  // Transcription re-listen loop: a one-shot capture backend (local-inference
  // auto-stop on silence) ends after each utterance — re-open it so long-form
  // recording continues. Mirrors the hands-free loop but re-opens in
  // "transcription" intent and needs no spoken-reply gate (mode never replies).
  // Unlike hands-free, a composer draft does NOT pause it: transcription is an
  // additive layer — the composer keeps working and the mic stays on the whole
  // time. Gating on the draft silently dropped meeting audio while the badge
  // still said "Transcribing".
  React.useEffect(() => {
    if (!transcriptionMode || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    const timer = window.setTimeout(() => {
      if (
        transcriptionModeRef.current &&
        !authGateRef.current.gated &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking
      ) {
        startCapture("transcription");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    transcriptionMode,
    ready,
    recording,
    chatSending,
    voiceOutput.speaking,
    startCapture,
  ]);

  // Typing pauses always-on: when a draft appears while the hands-free mic is
  // live, stop the capture so it doesn't transcribe the room over the keyboard.
  // handsFree stays true, so the re-listen loop resumes once the draft clears.
  React.useEffect(() => {
    if (composerHasDraft && handsFree && captureRef.current) {
      stopCapture();
    }
  }, [composerHasDraft, handsFree, stopCapture]);

  // Hands-free loop: once a spoken reply finishes (and nothing is recording or
  // mid-send), re-open the mic so the conversation continues without a tap. The
  // 250ms debounce + live re-check via handsFreeRef guard against double-start.
  // Paused while the composer holds a draft (typing → always-on off), so a send
  // that clears the draft re-arms it and returns to the prior voice state.
  React.useEffect(() => {
    if (realtimeVoiceOwnsMedia) return;
    if (!handsFree || !ready) return;
    if (recording || captureRef.current) return;
    if (chatSending || voiceOutput.speaking) return;
    if (composerHasDraft) return;
    const timer = window.setTimeout(() => {
      if (
        handsFreeRef.current &&
        !authGateRef.current.gated &&
        !captureRef.current &&
        !chatSending &&
        !voiceOutput.speaking &&
        !composerHasDraftRef.current
      ) {
        startCapture("converse");
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    handsFree,
    ready,
    recording,
    chatSending,
    voiceOutput.speaking,
    composerHasDraft,
    startCapture,
    realtimeVoiceOwnsMedia,
  ]);

  // ── App suspend / resume: keep voice capture from getting stuck (#voice-V1) ──
  //
  // On the installed iOS PWA, backgrounding the app suspends the WebAudio graph:
  // the WAV recorder's `ScriptProcessorNode` stops firing, but nothing tears the
  // capture down, so on resume the UI is stuck in a phantom "recording" state
  // with an orphaned getUserMedia MediaStream (iOS keeps the mic indicator lit)
  // and the next tap early-returns against the stale `captureRef`.
  //
  // This extends #15179's lifecycle bridge (which already dispatches
  // APP_PAUSE/APP_RESUME on the web PWA and handles chat resync) rather than
  // duplicating it:
  //   - APP_PAUSE: discard any in-flight capture (release the mic, reset UI) so
  //     nothing stalls across suspension. Remember whether the mic was live so
  //     resume can re-arm it.
  //   - APP_RESUME: if the mic was hands-free-live at suspend (or always-on
  //     hands-free is engaged), re-open capture the instant we foreground
  //     instead of waiting for a user tap. The existing re-listen loop also
  //     covers this via state deps, but a direct nudge avoids a dead mic when
  //     the loop's deps didn't change across the suspend.
  const wasCapturingAtSuspendRef = React.useRef(false);
  React.useEffect(() => {
    const onPause = (): void => {
      wasCapturingAtSuspendRef.current = !!captureRef.current;
      discardCaptureForSuspend();
    };
    const onResume = (): void => {
      // The realtime client owns visibility suspend/resume for its socket,
      // AudioContext, and microphone. Never overlay a batch recorder on it.
      if (realtimeVoiceOwnsMedia) return;
      const shouldReArm =
        (wasCapturingAtSuspendRef.current || handsFreeRef.current) &&
        !transcriptionModeRef.current;
      wasCapturingAtSuspendRef.current = false;
      if (!shouldReArm) return;
      // Re-open only from a clean idle: never stack a second capture over one
      // that survived (or was re-armed by the re-listen loop first), and stay
      // out of the way while a reply is still streaming/speaking (voice is gated
      // while responding — the loop re-opens once it clears).
      if (
        !ready ||
        recording ||
        captureRef.current ||
        chatSending ||
        voiceOutput.speaking
      ) {
        return;
      }
      startCapture("converse");
    };
    document.addEventListener(APP_PAUSE_EVENT, onPause);
    document.addEventListener(APP_RESUME_EVENT, onResume);
    return () => {
      document.removeEventListener(APP_PAUSE_EVENT, onPause);
      document.removeEventListener(APP_RESUME_EVENT, onResume);
    };
  }, [
    discardCaptureForSuspend,
    startCapture,
    ready,
    recording,
    chatSending,
    voiceOutput.speaking,
    realtimeVoiceOwnsMedia,
  ]);

  const waveformMode =
    phase === "listening"
      ? "listening"
      : phase === "responding"
        ? "responding"
        : "idle";

  let realtimeVoiceErrorMessage = realtimeVoiceBoundaryError;
  if (
    !realtimeVoiceErrorMessage &&
    realtimeVoiceOwnsMedia &&
    realtimeVoice.error
  ) {
    realtimeVoiceErrorMessage = realtimeVoice.error.message;
  }
  const unlockVoiceAudio = React.useCallback(() => {
    if (
      realtimeVoiceOwnsMedia &&
      (realtimeVoiceWantedRef.current ||
        realtimeVoiceRef.current.active ||
        realtimeVoiceRef.current.connecting)
    ) {
      void realtimeVoiceRef.current.unlock();
      return;
    }
    voiceOutput.unlockAudio();
  }, [realtimeVoiceOwnsMedia, voiceOutput.unlockAudio]);

  // Accept input while the agent is still booting; pre-ready sends queue (see
  // `send`) and flush on ready. Send stays enabled mid-response: typing + sending
  // again queues another message into the room (Option A — serialized turns), so
  // a stopped agent is the only thing that disables it. Voice, by contrast, IS
  // gated while responding (the mic/PTT below read `responding`). This mirrors the
  // canonical ChatView composer, which does NOT gate on local text-model
  // readiness: the overlay is the single chat input on the /chat tab, so a
  // missing/loading local model must still submit the send. The server returns a
  // failureKind gate ("Connect a provider") that the transcript renders.
  const canSend = agentStatus?.state !== "stopped";

  // VISION button: a tap sends a screen-vision turn so the agent runs its
  // plugin-vision screen-capture action (server-side capture + analysis). The
  // transient `visionCapturing` flag pulses the button until the turn is in
  // flight (responding rises), then clears.
  const [visionCapturing, setVisionCapturing] = React.useState(false);
  const captureVision = React.useCallback(() => {
    if (!canSend) return;
    setVisionCapturing(true);
    send("Take a look at my screen and tell me what you see.", {
      metadata: { vision: { surface: "screen" } },
    });
  }, [canSend, send]);
  React.useEffect(() => {
    if (visionCapturing && responding) setVisionCapturing(false);
  }, [visionCapturing, responding]);

  // The auth boundary is terminal for the whole voice loop, not just the
  // in-flight capture: hands-free and transcription state must fall too, or the
  // re-listen loop / transcript-resume path silently reopens the mic the moment
  // a later sign-in clears the gate — without a fresh voice gesture.
  React.useEffect(() => {
    if (!authGate.gated) return;
    // Authentication is a terminal boundary for every voice loop. Discard the
    // partial transcription session instead of finalizing it into a healthy
    // attachment after its authenticated owner has disappeared.
    setTranscriptionMode(false);
    transcriptionModeRef.current = false;
    transcriptSessionRef.current = null;
    transcriptSessionStartRef.current = 0;
    resumeHandsFreeAfterTranscriptRef.current = false;
    recordReplyIntoTranscriptRef.current = false;
    wasCapturingAtSuspendRef.current = false;
    autoEngagedHandsFreeRef.current = true;
    if (captureRef.current) cancelCapture();
    if (authGate.phase === "needs-auth" && isOpen) setIsOpen(false);
    stopRealtimeVoiceRef.current();
  }, [authGate.gated, authGate.phase, cancelCapture, isOpen]);

  const startRecording = React.useCallback(
    (intent?: CaptureIntent) => {
      if (authGate.gated) {
        recoverGatedCapture();
        return;
      }
      startCapture(intent);
    },
    [authGate.gated, recoverGatedCapture, startCapture],
  );

  return {
    phase,
    authGate,
    requestSignIn,
    signingIn,
    bootProgressSignal,
    responding,
    turnStatus,
    messages,
    canSend,
    modelStatus,
    recording: recording || realtimeVoiceRecording,
    waveformMode,
    analyser,
    open,
    close,
    isOpen,
    send,
    sendFirstRunText,
    captureVision,
    visionCapturing,
    toggleRecording,
    startRecording,
    stopRecording,
    cancelRecording: cancelCapture,
    handsFree,
    realtimeVoice: {
      enabled: realtimeVoiceSelected,
      active: realtimeVoice.active,
      connecting: realtimeVoice.connecting,
      paused: realtimeVoice.paused,
      microphoneMuted: realtimeVoice.microphoneMuted,
      status: realtimeVoice.status,
      error: realtimeVoiceErrorMessage,
      toggleMicrophoneMute: realtimeVoice.toggleMicrophoneMute,
    },
    toggleHandsFree,
    micPermission,
    recheckMicPermission,
    transcriptionMode,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft,
    transcript:
      realtimeVoice.active || realtimeVoice.connecting
        ? realtimeVoice.status === "listening" ||
          realtimeVoice.status === "transcribing"
          ? realtimeVoice.transcriptPartial
          : ""
        : transcript,
    speaking: voiceOutput.speaking || realtimeVoice.agentSpeaking,
    ttsError: voiceOutput.ttsError,
    speak: voiceOutput.speak,
    stopSpeaking: voiceOutput.stopSpeaking,
    agentVoiceMuted: voiceOutput.agentVoiceMuted,
    toggleAgentVoiceMute: voiceOutput.toggleAgentVoiceMute,
    needsAudioUnlock:
      (realtimeVoiceOwnsMedia &&
        (realtimeVoice.active || realtimeVoice.connecting) &&
        realtimeVoice.needsUnlock) ||
      voiceOutput.needsAudioUnlock,
    unlockAudio: unlockVoiceAudio,
    clearConversation,
    openSettings,
    navigateHome,
    currentTab: tab,
    stop: stopTurn,
    conversationNav,
    // Revealability is driven by the EXPLICIT, sequence-guarded loading flag
    // (set by runWithConversationLoading on clear/select/new and cleared in its
    // finally) — never by `messages.length === 0`. A bare message-count heuristic
    // is a STEADY-STATE condition, not a transient one: it latches true forever
    // for a genuinely-empty active conversation (greeting generation failed
    // silently, or an existing zero-message conversation was selected), which
    // pinned a perpetual loading spinner and let the grabber/pill open the sheet
    // into a never-resolving loader.
    conversationLoading,
    noProviderConfigured,
  };
}
