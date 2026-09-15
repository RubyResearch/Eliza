/**
 * Renders the chat overlay that keeps the composer and transcript
 * available across views.
 */

import { logger } from "@elizaos/logger";
import { MAX_CHAT_MEDIA_RAW_BYTES } from "@elizaos/shared";
import { transcriptPlainText } from "@elizaos/shared/transcripts";
import {
  AudioLines,
  FileText,
  Film,
  House,
  Loader2,
  Mic,
  MicOff,
  Music,
  Paperclip,
  Search,
  SendHorizontal,
} from "lucide-react";
import {
  AnimatePresence,
  animate,
  type MotionStyle,
  type MotionValue,
  motion,
  useIsPresent,
  useMotionTemplate,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
  useTransform,
} from "motion/react";
import * as React from "react";
import { type OrbState, ThinkingOrb } from "thinking-orbs";
import { registerPendingFirstRunTextConsumer } from "../../first-run/first-run-pending-text";
import { ChatVoiceStatusBar } from "../composites/chat/ChatVoiceStatusBar";
import {
  highlightSearchMatches,
  highlightSearchMessage,
} from "./search-match-highlight";

type ChatSheetMotionStyle = MotionStyle & {
  "--chat-composer-background"?: string | MotionValue<string>;
  "--chat-composer-border"?: string | MotionValue<string>;
  "--chat-composer-shadow"?: string | MotionValue<string>;
  "--chat-sheet-background"?: string | MotionValue<string>;
  "--chat-sheet-backdrop-filter"?: string | MotionValue<string>;
  "--chat-sheet-image"?: string;
  "--chat-sheet-radius"?: string | MotionValue<string>;
  "--chat-sheet-shadow"?: string | MotionValue<string>;
};

import { client } from "../../api/client";
import type {
  ConversationMessageSearchResult,
  ImageAttachment,
} from "../../api/client-types-chat";
import { useComposerKeydown, useComposerPaste } from "../../chat/composer-core";
import { reportComposerActivity } from "../../chat/report-composer-activity";
import {
  parseSlashDraft,
  resolveClientShortcutExecution,
  runSlashExecution,
  type SlashExecution,
} from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import {
  type BackIntentEventDetail,
  CHAT_CLOSE_EVENT,
  CHAT_OPEN_EVENT,
  CHAT_PREFILL_EVENT,
  type ChatPrefillEventDetail,
  ELIZA_BACK_INTENT_EVENT,
  NAVIGATE_VIEW_EVENT,
  type NavigateViewDetail,
} from "../../events";
import {
  TOUCH_TAP_MOVE_SLOP as OUTSIDE_SHEET_TAP_SLOP,
  useRafCoalescer,
} from "../../gestures";
import { useNativeGlassAnchor } from "../../glass/GlassSurface";
import { useNativeGlassDiag } from "../../glass/native-backdrop";
import {
  GLASS_SHEET_BACKDROP_FILTER,
  GLASS_SHEET_FILL,
} from "../../glass/tokens";
import { useConversationRenderWindow } from "../../hooks/useConversationRenderWindow";
import { useDesktopBridgeEvent } from "../../hooks/useDesktopBridgeEvent";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import { useLoadOlderOnScroll } from "../../hooks/useLoadOlderOnScroll";
import {
  CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
  Z_SHELL_OVERLAY,
} from "../../lib/floating-layers";
import { cn } from "../../lib/utils";
import {
  OS_INTENT_COMPOSER_PREFILL_EVENT,
  type OsIntentComposerPrefillDetail,
} from "../../os-intent/host";
import {
  isAndroid,
  isIOS,
  isNative,
  isStandalonePwa,
} from "../../platform/init";
import {
  getPhysicalScreenVerticalExtent,
  KEYBOARD_INTRUSION_THRESHOLD_PX,
  STANDALONE_BOTTOM_RECLAIM_OFFSET,
  shouldInstallStandaloneBottomReclaim,
} from "../../platform/standalone-bottom-reclaim";
import { useAppSelectorShallow } from "../../state";
import {
  clearChatDraft,
  useChatComposerOrLocal,
} from "../../state/ChatComposerContext.hooks";
import { useConversationMessages } from "../../state/ConversationMessagesContext.hooks";
import { loadOlderConversationMessages } from "../../state/load-older-conversation-messages";
import { goHome } from "../../state/shell-surface-store";
import { useViewChatBinding } from "../../state/view-chat-binding";
import { NATIVE_GLASS_DARK_TINT } from "../../themes/native-glass.js";
import { tryHandleTutorialText } from "../../tutorial/tutorial-action-channel";
import { copyTextToClipboard } from "../../utils/clipboard";
import {
  bytesToMb,
  CHAT_UPLOAD_ACCEPT,
  chatUploadKind,
  intakeAttachmentFiles,
  MAX_CHAT_IMAGES,
  summarizeDroppedAttachments,
} from "../../utils/image-attachment";
import { isInteractiveGestureTarget } from "../../utils/interactive-gesture-target";
import { voiceCaptureDebug } from "../../utils/voice-capture-debug";
import { findChoiceRegions } from "../chat/message-choice-parser";
import { MessageSearchPanel } from "../chat/message-search/MessageSearchPanel";
import { AgentProvisioningWidget } from "../chat/widgets/agent-provisioning";
import {
  buildReplyTargetFromMessage,
  ChatMessage,
  getChatMessageAnchorId,
} from "../composites/chat/chat-message";
import { ChatReplyPill } from "../composites/chat/chat-reply-pill";
import type {
  ChatMessageData,
  ChatMessageRenderContext,
} from "../composites/chat/chat-types";
import { TurnStatus } from "../composites/chat/chat-typing-indicator";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Input } from "../ui/input";
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "../ui/message-scroller";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";
import {
  clamp01,
  grabberBarOpacity,
  pillHandleCounterScale,
  pillMorphScale,
  sheetBlackoutProgress,
} from "./chat-overlay-motion";
import {
  FIRST_RUN_SIGN_IN_FALLBACK_DELAY_MS,
  isFirstRunShellMessage,
  renderOverlayMessageBody,
  SpeakingStatusAccessory,
  selectFirstRunDisplayMessages,
  selectSemanticNewestFirstRunMessage,
  shellToChatMessageData,
} from "./chat-overlay-transcript";
import {
  CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
  CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
} from "./chat-overlay-window-bounds";
import {
  isShortLandscapeViewport,
  measureSafeAreaInsetTop,
  resolveChatKeyboardHiddenViewportBaseline,
  resolveChatNativeKeyboardLift,
  resolveChatPanelHalfDetentHeight,
  resolveChatPanelLayout,
} from "./chat-panel-layout";
import { setChatComposerAccessoryBarHidden } from "./ios-chat-accessory-bar";
import { liquidGlassEdgeShadow } from "./liquid-glass";
import { withPressLatch } from "./press-latch";
import { SlashCommandMenu, useSlashMenu } from "./SlashCommandMenu";
import {
  filterRenderableShellMessages,
  type ShellMessage,
} from "./shell-state";
import { type PullGestureBinding, usePullGesture } from "./use-pull-gesture";
import type { ConversationNav, ShellController } from "./useShellController";
import { WALLPAPER_FLOAT_SHADOW, WALLPAPER_TEXT } from "./wallpaper-idiom";

export { __renderThreadLineForParity } from "./chat-overlay-transcript";

/** No-op slash controller so the overlay renders without a provider (stories). */
const EMPTY_SLASH_CONTROLLER: SlashCommandController = {
  commands: [],
  loading: false,
  error: false,
  naturalShortcutsEnabled: false,
  isAuthorized: false,
  isElevated: false,
  resolveChoices: () => [],
  describeChoice: () => "",
  resolveSection: () => undefined,
  navigateTab: () => {},
  navigateSettings: () => {},
  navigateView: () => {},
  clearChat: () => {},
  openCommandPalette: () => {},
};

/**
 * The chat overlay: one always-present, ambient glass conversation
 * that floats over EVERY view. There are no separate chats and no switcher — it
 * is a single endless thread (the app's one active conversation, via
 * useShellController).
 *
 * Layout is a fixed composer at the bottom with a pull-up history SHEET above
 * it. At rest the sheet is only the composer + grabber; pull the grabber UP, or
 * just start typing, to spring it open into the full transcript. Pull the
 * grabber back DOWN, or press Escape, to close.
 * Nothing else dismisses it — clicking or scrolling the view behind does
 * nothing. The composer never moves; the history slides up over it.
 *
 * The container is pointer-events-none (the view behind stays live); only the
 * composer + sheet capture input, so it is non-blocking — unlike the
 * focus-trapping AssistantOverlay it supersedes in the main shell.
 *
 * Two design rules keep it intimate rather than app-like:
 *  1. SELF-CONTAINED CONTRAST — every surface carries its own dark-glass scrim
 *     (or, for floating text, a soft shadow) plus fixed light text, never the
 *     theme's `--txt`, so it stays legible over any substrate: a bright view, a
 *     dark view, or the warm "good evening" backdrop.
 *  2. NO CHROME/SIGNAGE — the thread speaks for itself: no message counter, no
 *     "new chat", no tab strip; controls dissolve into the glass, and status is
 *     a soft breath of light, not a brand-colored alert ring.
 *
 * Pure/presentational: it takes the controller as a prop so it can be rendered
 * in isolation (stories / harness) with a mock. The app wraps it in a small
 * context-reading mount (see App.tsx) that supplies the shared controller.
 */

// The chat floats over arbitrary app surfaces, including theme-app where
// `--card` is brand orange. Keep the sheet's local tokens dark, neutral, and
// self-owned so open/maximized chat never turns into a transparent-looking
// orange overlay.
const CHAT_PANEL_THEME = {
  "--bg": "#101114",
  "--bg-hover": "rgba(255, 255, 255, 0.08)",
  "--bg-muted": "rgba(255, 255, 255, 0.06)",
  "--card": "#181a20",
  "--card-foreground": "#f4f5f7",
  "--surface": "rgba(255, 255, 255, 0.07)",
  "--txt": "#f4f5f7",
  "--text": "#f4f5f7",
  "--text-strong": "#ffffff",
  "--foreground": "#f4f5f7",
  "--muted": "rgba(244, 245, 247, 0.68)",
  "--muted-strong": "rgba(244, 245, 247, 0.86)",
  "--muted-foreground": "rgba(244, 245, 247, 0.68)",
  "--border": "rgba(255, 255, 255, 0.18)",
  "--border-strong": "rgba(255, 255, 255, 0.34)",
  "--ring": "rgba(244, 245, 247, 0.8)",
  "--accent": "#ff7a3d",
  "--accent-foreground": "#101114",
} as React.CSSProperties;

// The drag-handle bar color. Set EXPLICITLY (not `bg-muted-strong`) because the
// SheetGrabber renders OUTSIDE the fieldset that scopes CHAT_PANEL_THEME, so a
// token-based color there resolves to the ambient app theme — which is dark on a
// light surface, making the handle render BLACK (the "handle is black sometimes"
// bug: the open-sheet grabber was black while the in-panel pill bar was white).
// Fixed white matches the panel's `--muted-strong` in every context; Card owns
// that paint through its typed visualStyle boundary.
/** Keeps the rounded desktop sheet and handle inside the native host clip. */
const DESKTOP_HOST_TOP_BREATHING_ROOM_PX = 12;

// Shared easing for the overlay's cheap motion path. Open/close must stay
// opacity/translate only: animating blur/filter or scaling a scrollable
// transcript repaints too much of the viewport and visibly janks on laptops.
const OVERLAY_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

// `screen.height` is a useful keyboard-down reference only on the iOS
// standalone/native surfaces that own the collapsed-viewport reclaim. On
// desktop and Android it describes the monitor or physical device rather than
// the layout viewport, so using it there would create false keyboard lifts.
const SCREEN_KEYBOARD_SIGNAL_ACTIVE =
  typeof window !== "undefined" &&
  shouldInstallStandaloneBottomReclaim({
    standalonePwa: isStandalonePwa(),
    isNative,
    isIOS,
  });

// Pull-sheet detents. The chat-history window is bottom-anchored just above the
// fixed composer; its height animates between the closed composer/grabber and
// OPEN (most of the viewport above the input). The live drag tracks the finger
// 1:1; release snaps with an
// Apple-style spring. HALF is a comfortable mid-stop; FULL fills all the way to
// panelMaxH (the sheet rises to just under the status bar) — you pull it back
// DOWN to dismiss.
/** The five explicit states of the floating chat surface. Derived from the
 * resting height + flags so it always matches what's rendered (see the
 * `chatState` derivation in the component). */
export type ChatState =
  | "CLOSED"
  | "INPUT"
  | "OPEN_UNDER_HALF"
  | "OPEN_HALF_OR_OVER"
  | "MAXIMIZED";

export type ChatSurfaceState = ChatState | "INPUT_MENU";

/**
 * The chat's openness as a SINGLE source of truth — one ordered state machine
 * instead of separate `pilled` boolean + `detent` enum that had to be hand-kept
 * in sync. `pill` (collapsed to the bottom capsule) sits below `input` (bare
 * composer bar), then `half`/`full` open the thread. `pilled`, `sheetOpen`,
 * `expanded`, and the `detent` height read are all derived from this; `freeH`
 * (a transient free-drag height) and `maximized` (the full-bleed variant of
 * `full`) remain orthogonal overrides.
 */
export type ChatMode = "pill" | "input" | "half" | "full";

type MotionControls = { stop: () => void };

// Keep the synchronous resize anchor aligned with MessageScroller's own
// definition of an end-pinned reader.
const MESSAGE_SCROLLER_END_THRESHOLD_PX = 8;
// A landscape phone still needs room for the attach, mic, voice, and text
// controls. The compact composer must remain a useful input surface rather
// than forcing the editable field into a narrow utility strip.
const SHORT_LANDSCAPE_CHAT_MAX_WIDTH_PX = 360;
// Ceiling (px) for the composer-footprint clearance the chat reserves in the
// home/launcher layout. The panel can momentarily measure its OPEN/animating
// height on the drag-down→collapse edge; publishing that as the reserved space
// would push the launcher's top row off-screen (it lays out against this
// padding). A tall composer — 3-line draft + a couple of attachment chips — is
// well under this, so the cap only ever clips the bogus open-height reading.
const CHAT_CLEARANCE_MAX_PX = 220;
// The resting overlay seats the panel half a rem above the shell's safe-area
// floor. That gap is part of the occluded footprint even though it is outside
// the measured fieldset.
const CHAT_CLEARANCE_REST_GAP_PX = 8;
// Single source of truth for the visible gap between the focused composer and
// the software keyboard. The layout solver consumes the same number it paints,
// so a native keyboard event cannot leave panel height using stale rest padding.
const KEYBOARD_COMPOSER_GAP_PX = 12;
// The pull-down-to-restore grab zone is scoped to the TOP BAR only (safe-area +
// this many px), NOT the whole panel. A full-height strip stole the transcript's
// scroll (every touch-drag/wheel over the messages read as a restore pull) and
// made an accidental tap twitch the sheet out of full-screen. Confining it to
// the top leaves the transcript freely scrollable and makes "exit full-screen"
// an explicit drag from the top edge.
const MAXIMIZE_RESTORE_ZONE_PX = 96;
// A tap or tiny pointer wobble remains inert, but a deliberate downward pull
// must take ownership almost immediately. The previous viewport-relative
// threshold consumed roughly 90–130px before moving anything, which made a
// maximized sheet feel stuck and encouraged repeated, harder swipes.
const RESTORE_UNMAX_SLOP_PX = 8;
// The panel's top clearance + max height (which decide how the full-bleed header
// clears the notch) live in the pure, unit-tested `resolveChatPanelLayout` — see
// chat-panel-layout.ts.
// Detent magnetism: on a deliberate (non-flick) drag release, a height within
// this many px of a detent (collapsed/half/full) snaps to that detent instead
// of resting free — so near-detent releases are deterministic + clean, and only
// the clear gaps between detents keep the free-drag rest height.
const SHEET_DETENT_MAGNET = 64;
// Over-pull past the FULL detent morphs the inset sheet to edge-to-edge
// full-bleed across the REAL pixel gap between the two solved heights
// (`fullPanelMaxH - insetPanelMaxH`, see maxOverPull) — 1:1 with the finger,
// no fixed range constant. The maximize tracks the finger over that gap
// instead of springing on release, so pulling past full reads as one continuous
// expand-to-maximize — and dragging back down within the same gesture reverses
// it. Release commits the maximize once the morph is at least half-complete.
const COMPOSER_TYPING_PAUSE_MS = 2_000;
const DESKTOP_INPUT_IDLE_COLLAPSE_MS = 10_000;
const COMPOSER_ACTIVITY_SURFACE = "chat_overlay";

// A light iOS-style impact on each detent cross. Self-contained + guarded so it
// is a no-op off-native (and in jsdom tests) without coupling the overlay to the
// Capacitor bridge module. Mirrors `bridge/capacitor-bridge.ts` `haptics.light()`.
function detentHaptic(): void {
  try {
    const cap = (
      globalThis as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          Plugins?: {
            Haptics?: { impact?: (o: { style: string }) => unknown };
          };
        };
      }
    ).Capacitor;
    if (cap?.isNativePlatform?.()) {
      void Promise.resolve(
        cap.Plugins?.Haptics?.impact?.({ style: "LIGHT" }),
      ).catch(() => {
        // Thin native clients intentionally omit optional haptics. Capacitor
        // exposes the proxy anyway, then rejects when the plugin is absent.
      });
    }
  } catch {
    // Haptics are a nicety — never let them throw into the gesture path.
  }
}
const SHEET_SPRING = {
  type: "spring" as const,
  stiffness: 320,
  damping: 34,
  mass: 0.9,
};
// Slightly springier preset for the pill→input "liquid glass" open: a touch
// less damping than the height spring so the input reads as springing IN on a
// flick, while the live drag-tracking gives a slow pull its "lerp" character.
const OPEN_SPRING = {
  type: "spring" as const,
  stiffness: 300,
  damping: 26,
  mass: 0.85,
};
// Finger travel (px) that fully opens the input from the pill. A live pill drag
// maps offset → openProgress ∈ [0,1] over this distance; past it, the excess
// flows into the thread height so pill → input → chat is one continuous motion.
const PILL_OPEN_DISTANCE = 120;
// Downward finger travel PAST the bottom (thread height 0) at which releasing an
// OPEN-sheet drag commits the pill. Deliberately smaller than the halfway mark
// of the input→pill morph (PILL_OPEN_DISTANCE / 2): a drag that consumed the
// whole thread height ends with the finger near the screen edge, so only
// ~50–80px of physical travel can exist past the bottom — requiring the full
// half-morph would make "drag from full screen down to the pill" physically
// unreachable on shorter panels. The short input→pill gesture (which has the
// whole screen of room) keeps the stricter halfway rule.
const PILL_COMMIT_OVERSHOOT = 40;
const PILL_COMMIT_PROGRESS = 1 - PILL_COMMIT_OVERSHOOT / PILL_OPEN_DISTANCE;

// The panel's resting corner radius. ONE constant for every height — the pill
// capsule, the collapsed input bar, and the open sheet all share it, so the
// corners never animate while the sheet grows (only the maximize morph squares
// them off toward edge-to-edge).
const PANEL_RADIUS_PX = 32;

// Full-screen is a DISCRETE snap at 90% of the viewport. Below this line the
// chat is the rounded, inset window; crossing it upward springs the panel all
// the way to edge-to-edge. A same-gesture reversal below the line springs back
// to the window shape. Keeping the decision in visible-height space avoids the
// old "near-full but still showing wallpaper above it" resting state.
const FULLSCREEN_SNAP_VH = 0.9;
// Keep a committed full-screen snap stable through a few pixels of pointer
// noise. The entry threshold is still the visible 90% line; reversing farther
// than this hands height authority back to the inset sheet.
const FULLSCREEN_RELEASE_HYSTERESIS_PX = 12;

export {
  grabberBarOpacity,
  PILL_MORPH_MIN_SCALE,
  pillHandleCounterScale,
  pillMorphScale,
  sheetBlackoutProgress,
} from "./chat-overlay-motion";

// Glyphs (viewBox 0 0 36 36), rendered in currentColor inside a soft chip. Send
// + voice/send use lucide icons (AudioLines / SendHorizontal); the rest stay
// hand-drawn.
// The plus fills nearly the whole 36-unit box (arms 3→33) so, rendered at the
// full button size, it carries the same optical weight as the lucide mic/send
// marks — a tighter path would read as a small, over-padded glyph beside them.
const PLUS_GLYPH = "M15 3H21V15H33V21H21V33H15V21H3V15H15Z";
// Stop generating: a centered square (the universal "stop" affordance), sized to
// sit between the plus arms and the mic in weight.
const STOP_GLYPH = "M8 8H28V28H8Z";

/** Base64-encode WAV bytes in chunks (avoids the apply() arg-count limit). */
function wavBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// Muted-speaker glyph for the autoplay-blocked "tap to enable sound" prompt.
const SPEAKER_MUTED_GLYPH =
  "M7 15H12L18 10V26L12 21H7Z M21 12.4L22.4 11L31 19.6L29.6 21Z";
function Glyph({
  d,
  className,
}: {
  d: string;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 36 36"
      className={cn("h-[26px] w-[26px]", className)}
      aria-hidden="true"
    >
      <path fill="currentColor" fillRule="evenodd" d={d} />
    </svg>
  );
}

/** A soft round glass control that dissolves into the bar; brightens only when active. */
export function SoftButton({
  glyph,
  icon: Icon,
  label,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  disabled,
  active,
  pressed,
  pulse,
  testId,
}: {
  /** A hand-drawn SVG path glyph (legacy), OR pass `icon` for a lucide icon. */
  glyph?: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick?: () => void;
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerUp?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  active?: boolean;
  /** Accessible toggle state when it is intentionally broader than the accent state. */
  pressed?: boolean;
  /** Breathe the glyph while a batch capture has no richer activity surface. */
  pulse?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <Button
      variant="transparent"
      size="icon"
      data-testid={testId}
      aria-label={label}
      aria-pressed={pressed ?? active}
      data-state={active ? "on" : "off"}
      // aria-disabled (not the native attr) so the button stays focusable and its
      // label/reason is announceable; the click is guarded instead.
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      onPointerDown={disabled ? undefined : onPointerDown}
      onPointerUp={disabled ? undefined : onPointerUp}
      onPointerCancel={disabled ? undefined : onPointerCancel}
      onPointerLeave={disabled ? undefined : onPointerLeave}
      className={cn(
        // Icon-only control: transparent, borderless, no capsule — just the
        // glyph. Hover and active express through icon color alone — neutral
        // resting → white active — never a background/border or status color.
        //
        // The icon size keeps the visible desktop box quiet at 40px and lets the
        // shared Button primitive raise the real element to 44px on coarse
        // pointers. Real target geometry avoids overlapping pseudo hit areas
        // when compact screens draw the two trailing controls closer together.
        "relative grid shrink-0 place-items-center [&_svg]:size-5",
        "text-muted-strong hover:text-txt data-[state=on]:text-inverse data-[state=on]:hover:text-inverse aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40",
        // Batch capture has no inline waveform, so its glyph breathes; realtime
        // voice keeps this control static because the composer owns the motion.
        pulse && "animate-pulse motion-reduce:animate-none",
        // Blocked controls (e.g. voice/transcript during conductor-only
        // onboarding) read as inert: dimmed AND non-interactive to the pointer
        // (no hover color shift, no cursor) — matching the attachment "+".
        // Keyboard focus is unaffected, so the aria-disabled label still
        // announces.
      )}
    >
      {Icon ? (
        <Icon aria-hidden={true} />
      ) : glyph ? (
        // Match the lucide marks: the parent [&_svg] rule governs the box, and
        // the widened glyph paths fill the same fraction of it.
        <Glyph d={glyph} className="size-5" />
      ) : null}
    </Button>
  );
}

function ComposerControlTransition({
  children,
  controlKey,
  reduceMotion,
}: {
  children: React.ReactNode;
  controlKey: string;
  reduceMotion: boolean;
}): React.JSX.Element {
  const present = useIsPresent();
  return (
    <motion.div
      data-composer-control={controlKey}
      aria-hidden={!present || undefined}
      inert={!present || undefined}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.16,
        ease: OVERLAY_EASE,
      }}
      className="absolute inset-0 grid place-items-center"
      style={{ pointerEvents: present ? "auto" : "none" }}
    >
      {children}
    </motion.div>
  );
}

function ComposerControlSlot({
  children,
  controlKey,
  reduceMotion,
  slot,
}: {
  children: React.ReactNode;
  controlKey: string | null;
  reduceMotion: boolean;
  slot: "left" | "right";
}): React.JSX.Element {
  return (
    <div
      data-testid={`chat-composer-control-slot-${slot}`}
      className="relative size-10 shrink-0 pointer-coarse:size-11"
    >
      <AnimatePresence initial={false}>
        {controlKey ? (
          <ComposerControlTransition
            key={controlKey}
            controlKey={controlKey}
            reduceMotion={reduceMotion}
          >
            {children}
          </ComposerControlTransition>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const COMPOSER_MIC_BARS = [
  { id: "outer-left", height: 10 },
  { id: "far-left", height: 13 },
  { id: "mid-far-left", height: 17 },
  { id: "mid-left", height: 16 },
  { id: "near-left", height: 21 },
  { id: "inner-left", height: 22 },
  { id: "center-left", height: 26 },
  { id: "center", height: 28 },
  { id: "center-right", height: 26 },
  { id: "inner-right", height: 22 },
  { id: "near-right", height: 21 },
  { id: "mid-right", height: 16 },
  { id: "mid-far-right", height: 17 },
  { id: "far-right", height: 13 },
  { id: "outer-right", height: 10 },
] as const;

// Audio-frame writes stay imperative so live microphone activity never
// rerenders the chat tree while transcription owns the composer's text lane.
function ComposerMicActivity({
  analyser,
  finishing,
  reduceMotion,
  transcript,
}: {
  analyser: AnalyserNode | null;
  finishing: boolean;
  reduceMotion: boolean;
  transcript: string;
}): React.JSX.Element {
  const barsRef = React.useRef<Array<HTMLSpanElement | null>>([]);

  React.useEffect(() => {
    if (!analyser || finishing || reduceMotion) return;
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const renderFrame = () => {
      analyser.getByteTimeDomainData(samples);
      barsRef.current.forEach((bar, index) => {
        if (!bar) return;
        const segmentStart = Math.floor(
          (index * samples.length) / COMPOSER_MIC_BARS.length,
        );
        const segmentEnd = Math.max(
          segmentStart + 1,
          Math.floor(((index + 1) * samples.length) / COMPOSER_MIC_BARS.length),
        );
        let energy = 0;
        for (
          let sampleIndex = segmentStart;
          sampleIndex < segmentEnd;
          sampleIndex += 1
        ) {
          const normalized = ((samples[sampleIndex] ?? 128) - 128) / 128;
          energy += normalized * normalized;
        }
        const rms = Math.sqrt(energy / (segmentEnd - segmentStart));
        const activity = Math.min(1, Math.max(0.16, rms * 5.5));
        const center = (COMPOSER_MIC_BARS.length - 1) / 2;
        const centerWeight = 1 - Math.abs(index - center) * 0.035;
        bar.style.transform = `scaleY(${Math.max(0.18, activity * centerWeight)})`;
      });
      frame = window.requestAnimationFrame(renderFrame);
    };
    frame = window.requestAnimationFrame(renderFrame);
    return () => window.cancelAnimationFrame(frame);
  }, [analyser, finishing, reduceMotion]);

  return (
    <div
      role="status"
      aria-label={
        finishing ? "Finishing transcription" : "Live microphone activity"
      }
      data-testid="chat-composer-mic-activity"
      className="relative flex min-h-10 min-w-0 flex-1 items-center justify-between gap-1 px-2 text-white/85"
    >
      <span className="sr-only" aria-live="polite">
        {finishing
          ? "Finishing transcription"
          : transcript.trim() || "Listening"}
      </span>
      <Separator
        aria-hidden="true"
        tone="subtle40"
        className="pointer-events-none absolute inset-x-2 top-1/2 -translate-y-1/2"
      />
      {COMPOSER_MIC_BARS.map(({ id, height }, index) => (
        <Card
          asChild
          surface="inverseForeground"
          border="none"
          radius="full"
          key={id}
        >
          <span
            // Stable bar ids keep imperative analyser writes independent of React.
            ref={(node) => {
              barsRef.current[index] = node;
            }}
            aria-hidden="true"
            className={cn(
              "relative z-10 w-0.5 origin-center transition-transform duration-75 sm:w-1",
              !finishing &&
                !analyser &&
                "animate-pulse motion-reduce:animate-none",
            )}
            style={{ height, transform: "scaleY(0.32)" }}
          />
        </Card>
      ))}
    </div>
  );
}

type RealtimeVoiceStatus = NonNullable<
  ShellController["realtimeVoice"]
>["status"];

const REALTIME_COMPOSER_LABEL: Record<RealtimeVoiceStatus, string> = {
  idle: "Voice is live",
  listening: "Listening…",
  transcribing: "Hearing you…",
  thinking: "Thinking…",
  speaking: "Speaking · mic paused",
  interrupting: "Stopping…",
};

type RealtimeVoiceVisualPhase =
  | RealtimeVoiceStatus
  | "connecting"
  | "paused"
  | "error";

const REALTIME_VOICE_ORB: Record<
  RealtimeVoiceVisualPhase,
  { state: OrbState; speed: number; paused?: boolean }
> = {
  idle: { state: "breathing", speed: 0.72 },
  connecting: { state: "connecting", speed: 1 },
  listening: { state: "listening", speed: 1 },
  transcribing: { state: "listening", speed: 0.82 },
  thinking: { state: "working", speed: 0.92 },
  speaking: { state: "composing", speed: 1.08 },
  interrupting: { state: "shaping", speed: 1.18 },
  paused: { state: "breathing", speed: 0, paused: true },
  error: { state: "breathing", speed: 0, paused: true },
};

/** A fixed-size orb gives every realtime phase distinct motion without moving the composer. */
function ComposerRealtimeVoiceWaveform({
  phase,
  reduceMotion,
}: {
  phase: RealtimeVoiceVisualPhase;
  reduceMotion: boolean;
}): React.JSX.Element {
  const visual = REALTIME_VOICE_ORB[phase];
  const paused = reduceMotion || visual.paused === true;

  return (
    <span
      aria-hidden="true"
      data-phase={phase}
      data-orb-state={visual.state}
      data-testid="chat-composer-realtime-waveform"
      className={cn(
        "flex h-5 w-6 shrink-0 items-center justify-center",
        phase === "error" ? "opacity-60" : "opacity-90",
      )}
    >
      <ThinkingOrb
        aria-hidden="true"
        data-testid="chat-composer-thinking-orb"
        state={visual.state}
        size={20}
        speed={paused ? 0 : visual.speed}
        paused={paused}
        theme="dark"
      />
    </span>
  );
}

/** Realtime voice occupies the composer's normal text lane, never a second card. */
function ComposerRealtimeVoiceActivity({
  connecting,
  error,
  needsAudioUnlock,
  onUnlockAudio,
  paused,
  microphoneMuted,
  reduceMotion,
  status,
  transcript,
}: {
  connecting: boolean;
  error: string | null;
  needsAudioUnlock: boolean;
  onUnlockAudio: () => void;
  paused: boolean;
  microphoneMuted: boolean;
  reduceMotion: boolean;
  status: RealtimeVoiceStatus;
  transcript: string;
}): React.JSX.Element {
  const phaseLabel = error
    ? error
    : paused
      ? "Voice paused"
      : connecting
        ? "Connecting…"
        : microphoneMuted &&
            (status === "listening" || status === "transcribing")
          ? "Microphone muted"
          : REALTIME_COMPOSER_LABEL[status];
  const liveTranscript =
    !error &&
    !paused &&
    !connecting &&
    !microphoneMuted &&
    (status === "listening" || status === "transcribing")
      ? transcript.trim()
      : "";
  const visualPhase: RealtimeVoiceVisualPhase = error
    ? "error"
    : paused ||
        (microphoneMuted &&
          (status === "listening" || status === "transcribing"))
      ? "paused"
      : connecting
        ? "connecting"
        : status;
  const shimmerPhase =
    !error &&
    !paused &&
    !liveTranscript &&
    (connecting ||
      status === "transcribing" ||
      status === "thinking" ||
      status === "speaking");
  const visibleCopy = liveTranscript || phaseLabel;
  const copyRef = React.useRef<HTMLSpanElement>(null);

  // Live partials grow from the end, so keep the newest words in view without
  // letting a long utterance resize the composer or cover its controls.
  React.useLayoutEffect(() => {
    const copy = copyRef.current;
    if (!copy) return;
    copy.scrollTop = liveTranscript ? copy.scrollHeight : 0;
  }, [liveTranscript]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={
        liveTranscript ? `${phaseLabel}: ${liveTranscript}` : phaseLabel
      }
      data-status={status}
      data-testid="chat-composer-realtime-voice"
      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-1.5"
    >
      <ComposerRealtimeVoiceWaveform
        phase={visualPhase}
        reduceMotion={reduceMotion}
      />
      <div className="flex h-10 min-w-0 flex-1 items-center overflow-hidden">
        <span
          ref={copyRef}
          data-testid="chat-composer-realtime-copy"
          className={cn(
            "block max-h-10 w-full min-w-0 overflow-hidden whitespace-pre-wrap text-start text-sm leading-5 [overflow-wrap:anywhere]",
            error
              ? "text-danger"
              : liveTranscript
                ? "text-txt"
                : "text-white/75",
            shimmerPhase &&
              "shimmer shimmer-duration-1200 motion-reduce:shimmer-none",
          )}
          title={visibleCopy}
        >
          {visibleCopy}
        </span>
      </div>
      {needsAudioUnlock ? (
        <Button
          variant="warningOutline"
          size="tiny"
          onClick={onUnlockAudio}
          data-testid="chat-composer-voice-audio-unlock"
          shape="circle"
          className="shrink-0"
        >
          Enable sound
        </Button>
      ) : null}
    </div>
  );
}

/** Inert conversation-nav fallback for minimal mock controllers. */
const EMPTY_CONVERSATION_NAV: ConversationNav = {
  hasPrev: false,
  hasNext: false,
  goPrev: () => {},
  goNext: () => {},
  activeId: null,
  index: -1,
};

/**
 * The drag handle at the top of the chat sheet — pull UP to open the history,
 * pull DOWN to close it. It is also keyboard-operable (Enter/Space toggles,
 * ArrowUp opens, ArrowDown/Escape closes) so the drag-only affordance stays
 * WCAG 2.1.1 operable. `touch-none` keeps the browser from scroll/refreshing
 * mid-drag. A subtle white breath marks live agent work.
 */
function SheetGrabber({
  open,
  onOpen,
  onClose,
  binding,
  breathing,
  opacity,
  pilled,
  locked = false,
}: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  binding: PullGestureBinding;
  breathing: boolean;
  // Crossfade opacity (driven by openProgress): 0 while the pill capsule owns the
  // handle, fading to 1 only AFTER the pill has fully faded out — so the grabber
  // bar and the (identical) pill bar are NEVER both visible (the "two pills" bug).
  opacity: MotionValue<number>;
  // Inert while pilled so the invisible grabber can't steal taps meant for the
  // pill capsule (or pass-through to the home screen) below it.
  pilled: boolean;
  /** Keeps the normal handle visible while onboarding owns the detent. */
  locked?: boolean;
}): React.JSX.Element {
  const disabled = pilled || locked;
  return (
    <Button asChild variant="chatGestureTarget" size="content">
      <motion.button
        style={{ opacity, pointerEvents: disabled ? "none" : "auto" }}
        // Invisible + inert while pilled: the pill capsule below owns the drag, so
        // keep this out of the tab order and the a11y tree until it's the handle.
        tabIndex={disabled ? -1 : undefined}
        aria-hidden={disabled || undefined}
        // A disclosure toggle for the chat history, not a value-bearing separator:
        // button + aria-expanded is the accurate semantic and stays keyboard-
        // operable (Enter/Space toggle, Arrow keys nudge) per WCAG 2.1.1.
        type="button"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        aria-label={open ? "drag down to close chat" : "drag up to open chat"}
        data-testid="chat-sheet-grabber"
        data-open={open ? "true" : "false"}
        onClick={(event) => {
          // Assistive activation has no pointer sequence. Pointer taps already
          // toggle through the gesture binding and must not be replayed here.
          if (disabled || event.detail !== 0) return;
          if (open) onClose();
          else onOpen();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) onClose();
            else onOpen();
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            onOpen();
          } else if (e.key === "ArrowDown" || e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        // Opening the sheet moves this handle before Chromium emits the touch
        // gesture's compatibility click. Without suppressing that native follow-
        // up, the click re-hit-tests onto the composer now underneath the release
        // coordinate and focuses it; the next handle tap then dismisses the
        // keyboard instead of closing the sheet. Pointer events remain the sole
        // touch authority, matching PillHandle's moving-target contract below.
        onTouchEnd={(e) => {
          if (e.cancelable) e.preventDefault();
        }}
        {...binding}
        onPointerDown={(event) => {
          // This handle is a complete gesture owner. In the shell it can sit over
          // a broad home/notification pull surface, whose native listener runs
          // independently of React; do not let this press seed both systems.
          event.stopPropagation();
          binding.onPointerDown(event);
        }}
        className={cn(
          "appearance-none text-left",
          // ABSOLUTELY positioned over the panel top (zero layout height — it
          // floats slightly on top of the input row, so collapsed height == the
          // input bar). The grab target is WIDE (a swipe-up from anywhere across
          // the composer's top edge opens the chat — the lock-screen "swipe up to
          // open" affordance) but STAYS ABOVE the input row so it never steals
          // taps meant for the textarea / +/mic controls below it.
          // z-20 keeps it above the input row (z-10) so it always wins the drag.
          "absolute top-0.5 z-20 flex cursor-grab touch-none select-none items-center justify-center py-2 active:cursor-grabbing",
          // In input mode, reserve a real gutter over BOTH edge controls. The
          // prior full-width band began inside the + button and immediately to
          // its right, so a tiny miss opened/flung the sheet instead of opening
          // chat actions. Once the sheet is open, those controls are far below
          // this top handle and the generous full-width drag lane is safe again.
          open ? "inset-x-6" : "inset-x-[4.5rem]",
          // The invisible hit target reaches a comfortable distance ABOVE the
          // panel (a swipe-up begun in the empty field just over the composer is
          // caught) and STOPS at the handle's own bottom, so it never overlaps the
          // interactive composer row beneath — taps fall through to the input.
          "before:absolute before:-inset-x-2 before:-top-6 before:bottom-0 before:content-['']",
        )}
      >
        <Card
          asChild
          surface="transparent"
          border="none"
          radius="full"
          overlayHandle
        >
          <span
            aria-hidden="true"
            className={cn(
              // The visible grabber line. Its show/hide is driven by the WRAPPER's
              // `grabberOpacity` crossfade (fades in over [0.55, 0.95] of the open),
              // strictly anti-phase with the pill bar so the two are never on screen
              // together. The bar paints at full opacity — a prior regression pinned
              // it to `opacity-0`, leaving the handle grabbable but invisible (#9142).
              "opacity-100 transition-all duration-300",
              // CLOSED (input mode): same h-1.5 w-12 bar as the pill capsule — the
              // two crossfade and must be pixel-identical. OPEN sheet: a quieter,
              // smaller bar (the full-size handle over the transcript read as
              // oversized chrome).
              open ? "h-1 w-9" : "h-1.5 w-12",
              // A dedicated opacity/scale breath marks live agent work without
              // repurposing shadcn's text-only shimmer utility.
              breathing && "eliza-chat-handle-breathe",
            )}
          />
        </Card>
      </motion.button>
    </Button>
  );
}

/**
 * The fully-collapsed PILL — the chat reduced to a small glass capsule at the
 * very bottom. Tap or flick/pull it up to bring the input back. Big invisible
 * hit area so it's easy to grab; the visible capsule stays small.
 */
export function PillHandle({
  binding,
  counterScale,
  onOpen,
  breathing,
  pilled,
  desktopOverlayHost = false,
}: {
  binding: PullGestureBinding;
  // Inverse of the panel's pill-morph scale (see pillHandleCounterScale),
  // applied to the visible BAR only — the button/hit geometry keeps riding the
  // panel scale (the touch-compat mousedown after a tap must keep landing where
  // it always did), while the painted bar stays pixel-identical to the
  // input-mode grabber bar across the whole morph.
  counterScale: MotionValue<number>;
  onOpen: () => void;
  breathing: boolean;
  // Interactive ONLY while pilled. The handle's hit zone (`px-16 pt-10`) is tall
  // and wide and sits directly over the composer textarea; if it kept
  // `pointer-events-auto` while NOT pilled it would intercept the tap meant for
  // the input (the parent's `pointer-events:none` can't override a child that
  // opts back in), so the keyboard would never open. Gate on `pilled` so taps
  // pass through to the textarea once the input has formed.
  pilled: boolean;
  desktopOverlayHost?: boolean;
}): React.JSX.Element {
  if (desktopOverlayHost) {
    return (
      <motion.div
        className="h-1.5 w-12 origin-bottom"
        style={{
          scale: counterScale,
          transformOrigin: desktopOverlayHost ? "center" : "bottom center",
          ...(desktopOverlayHost
            ? {
                width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
                height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
              }
            : {}),
        }}
      >
        <Button
          variant="transparent"
          size="content"
          shape="circle"
          data-testid="chat-pill"
          aria-label="open chat"
          style={{
            width: CHAT_OVERLAY_RESTING_WINDOW_WIDTH,
            height: CHAT_OVERLAY_RESTING_WINDOW_HEIGHT,
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" ||
              event.key === " " ||
              event.key === "ArrowUp"
            ) {
              event.preventDefault();
              onOpen();
            }
          }}
          onTouchEnd={(event) => {
            if (event.cancelable) event.preventDefault();
          }}
          {...binding}
          tabIndex={pilled ? 0 : -1}
          aria-hidden={pilled ? undefined : true}
          className={cn(
            "shrink-0 cursor-grab touch-none select-none active:scale-95 active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inverse/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
            pilled ? "pointer-events-auto" : "pointer-events-none",
          )}
        >
          <Card
            asChild
            surface="transparent"
            border="none"
            radius="full"
            overlayHandle
          >
            <span
              aria-hidden="true"
              data-testid="chat-pill-mark"
              className={cn(
                "pointer-events-none h-3 w-16 opacity-100",
                breathing && "eliza-chat-handle-breathe",
              )}
            />
          </Card>
        </Button>
      </motion.div>
    );
  }

  return (
    <Button
      variant="chatGestureTarget"
      size="content"
      data-testid="chat-pill"
      aria-label="open chat"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
          e.preventDefault();
          onOpen();
        }
      }}
      // A touch tap opens the INPUT bar in the pointerup that precedes this
      // touchend — by the time the browser dispatches its compat mouse events
      // (mousedown/click), the composer textarea has already formed under the
      // same coordinates, and the synthetic click would focus it and pop the
      // keyboard the pill tap deliberately leaves down. preventDefault() on
      // touchend suppresses the compat sequence; the gesture itself runs on
      // pointer events and is unaffected. Unconditional: a touchend only
      // reaches this handle when the touch STARTED on it (touch events retarget
      // to their touchstart element), i.e. while it was the pilled handle —
      // the render that formed the input has already flipped `pilled` false by
      // the time this fires, so the prop cannot gate it.
      onTouchEnd={(event) => {
        if (event.cancelable) event.preventDefault();
      }}
      {...binding}
      tabIndex={pilled ? undefined : -1}
      aria-hidden={pilled ? undefined : true}
      className={cn(
        "h-auto w-full px-8 pb-1.5 pt-10",
        // The bar hugs the BOTTOM (small pb) where the collapsed input sat — not
        // floating mid-air; the tall pt + full width keep a generous upward grab/
        // flick zone so a swipe-up from anywhere across the bottom opens the chat
        // (the lock-screen affordance). Flex-center keeps the capsule centred
        // while the invisible hit area spans wide.
        "flex cursor-grab touch-none select-none items-end justify-center active:cursor-grabbing",
        // Interactive only while pilled. When NOT pilled the (faded) handle must
        // let taps fall through to the composer textarea below it — otherwise its
        // tall hit zone steals the tap and the keyboard never opens.
        pilled ? "pointer-events-auto" : "pointer-events-none",
      )}
    >
      <Card
        asChild
        surface="transparent"
        border="none"
        radius="full"
        overlayHandle
        layoutStyle={{ transformOrigin: "bottom center" }}
      >
        <motion.span
          aria-hidden="true"
          className={cn(
            // Identical to the SheetGrabber's closed-state bar — same white shape
            // + color whether the chat is open or collapsed to the pill. Its
            // show/hide is driven by the WRAPPER's `pillOpacity` crossfade
            // (anti-phase with the grabber). The bar paints at full opacity — a
            // prior regression pinned it to `opacity-0`, leaving the pill handle
            // grabbable but invisible (#9142).
            "h-1.5 w-12 opacity-100 transition-colors duration-300",
            // Same compositor-only work-state breath as the SheetGrabber bar.
            breathing && "eliza-chat-handle-breathe",
          )}
          // The shared handle surface keeps both bars pixel-identical through the
          // crossfade. The counter-scale cancels
          // the panel's pill-morph shrink for the BAR alone, so the collapsed
          // handle renders the same size as the input-mode grabber bar.
          style={{
            scale: counterScale,
          }}
        />
      </Card>
    </Button>
  );
}

/** Forces the canonical shadcn scroller to the end after an explicit send. */
function MessageScrollerSendFollow({ request }: { request: number }) {
  const { scrollToEnd } = useMessageScroller();

  React.useLayoutEffect(() => {
    if (request === 0) return;
    scrollToEnd({ behavior: "auto" });
  }, [request, scrollToEnd]);

  return null;
}

type ScrollToTranscriptMessage = ReturnType<
  typeof useMessageScroller
>["scrollToMessage"];

/** Exposes the scroller's coordinated jump API to search result handling. */
function MessageScrollerSearchBridge({
  scrollToMessageRef,
}: {
  scrollToMessageRef: React.MutableRefObject<ScrollToTranscriptMessage | null>;
}) {
  const { scrollToMessage } = useMessageScroller();

  React.useLayoutEffect(() => {
    scrollToMessageRef.current = scrollToMessage;
    return () => {
      if (scrollToMessageRef.current === scrollToMessage) {
        scrollToMessageRef.current = null;
      }
    };
  }, [scrollToMessage, scrollToMessageRef]);

  return null;
}

export function ChatOverlay({
  controller,
  agentName = "Eliza",
  slash: slashProp,
  firstRunOpen = false,
  acceptPendingFirstRunText = false,
  initialMode = "input",
  releaseFirstRunToFull = false,
  fillHostAtHalf = false,
  onFirstRunReleaseHandled,
  onPilledChange,
  onDetentChange,
  onStateChange,
}: {
  controller: ShellController;
  /** Name shown in the composer placeholder ("Message {agentName}"). Defaults to Eliza. */
  agentName?: string;
  /** Universal slash-command catalog + app-level nav effects. */
  slash?: SlashCommandController;
  /**
   * True while in-chat first-run onboarding is active (`firstRunComplete ===
   * false` upstream). The overlay stays at the shared HALF chat detent while it
   * owns an onboarding choice. During external Cloud sign-in the transparent
   * desktop host minimizes so the browser is unobstructed; the regular app
   * keeps its sign-in actions visible. Successful authentication opens FULL.
   * There is never a separate desktop web chat.
   */
  firstRunOpen?: boolean;
  /** The host confirms setup completion before this composer may consume queued intent. */
  acceptPendingFirstRunText?: boolean;
  /** Initial resting detent when a host opens this shared chat surface. */
  initialMode?: "input" | "half";
  /**
   * One-shot completion intent retained by the parent shell when onboarding
   * completion and a runtime-target remount happen in the same transition.
   */
  releaseFirstRunToFull?: boolean;
  /** Desktop bottom-bar hosts have no page behind their transparent window. */
  fillHostAtHalf?: boolean;
  /** Acknowledges that the retained completion intent reached this overlay. */
  onFirstRunReleaseHandled?: () => void;
  /**
   * Reports entry to and exit from the component's own resting pill state.
   * Desktop uses the pilled edge to collapse its transparent native host back
   * to the small always-visible pill; web leaves this unset and keeps the
   * entire transition local to the shared chat surface.
   */
  onPilledChange?: (pilled: boolean) => void;
  /** Reports the settled visible footprint to transparent desktop hosts. */
  onDetentChange?: (detent: "pill" | "input" | "half" | "full") => void;
  /** Native hosts use this to grow the transparent pill window with the sheet. */
  onStateChange?: (state: ChatSurfaceState) => void;
}): React.JSX.Element {
  const [chatActionsOpen, setChatActionsOpen] = React.useState(false);
  const {
    messages,
    phase,
    responding,
    turnStatus,
    send,
    sendFirstRunText,
    canSend,
    recording,
    analyser,
    transcript,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    toggleTranscriptionMode,
    stopTranscriptionAndMic,
    setDictationSink,
    setTranscriptSessionSink,
    setComposerHasDraft,
    needsAudioUnlock,
    ttsError,
    unlockAudio,
    openSettings,
    navigateHome,
    currentTab,
    stop,
    speak,
    stopSpeaking,
    speaking,
  } = controller;
  const realtimeVoice = controller.realtimeVoice;
  const realtimeVoiceComposerVisible = Boolean(
    realtimeVoice?.enabled &&
      !realtimeVoice.error &&
      (handsFree ||
        realtimeVoice.active ||
        realtimeVoice.connecting ||
        realtimeVoice.status !== "idle"),
  );
  const realtimeVoiceControlsVisible = Boolean(
    realtimeVoice?.enabled &&
      handsFree &&
      (realtimeVoice.active || realtimeVoice.connecting),
  );
  // True once the server has reported no LLM/model provider is configured (a
  // `no_provider` assistant turn). Defaulted for minimal mock controllers.
  const noProviderConfigured = controller.noProviderConfigured ?? false;
  const firstRunComposerPlaceholder = React.useMemo(() => {
    const latestStatus = messages.at(-1)?.content ?? "";
    if (/waiting for sign-in/i.test(latestStatus)) {
      return "Waiting for sign-in…";
    }
    if (/couldn['’]t connect to eliza cloud/i.test(latestStatus)) {
      return "Hey Eliza…";
    }
    if (
      /opening your personal eliza|setting up your agent|connecting to eliza cloud/i.test(
        latestStatus,
      )
    ) {
      return "Connecting to Eliza Cloud…";
    }
    return "Hey Eliza…";
  }, [messages]);
  // Local text-model readiness (#12178 WI-4). While it `blocksSend`, the
  // composer stays usable and the in-chat model-status card carries progress +
  // cancel/switch controls; the placeholder tells the user they can keep typing.
  const modelStatus = controller.modelStatus;
  const modelBlocksSend = modelStatus?.blocksSend ?? false;
  // App-level chat handlers shared with the desktop chat surface. The first-run
  // transcript's CHOICE widgets still use the action funnel inside their own
  // renderer; this overlay-level selection only needs message-management
  // handlers.
  const {
    handleChatEdit,
    handleChatRetry,
    handleSelectConversation,
    loadConversationMessagesAround,
  } = useAppSelectorShallow((s) => ({
    // Editing a persisted turn must truncate and replace the original branch;
    // sending the corrected text as a fresh turn leaves the typo in history.
    handleChatEdit: s.handleChatEdit,
    handleChatRetry: s.handleChatRetry,
    // Search-jump (#14279): select the hit's conversation, then (if the hit is
    // older than the loaded recent window) load a window centered on it before
    // scrolling. Inert no-ops in stories/tests with no AppContext.
    handleSelectConversation: s.handleSelectConversation,
    loadConversationMessagesAround: s.loadConversationMessagesAround,
  }));
  // Defensive default so a minimal mock controller (stories/tests) that predates
  // the swipe-nav surface still renders without crashing.
  const conversationNav = controller.conversationNav ?? EMPTY_CONVERSATION_NAV;
  // True while a clear/swipe is fetching an uncached thread — gates the empty
  // thread's loading spinner. Defaulted for minimal mock controllers.
  const conversationLoading = controller.conversationLoading ?? false;

  // Copy a message (reveal-row Copy). Stable identity so the memoized row isn't
  // re-rendered every parent tick. Copy is fire-and-forget UX, but the promise
  // must still be OBSERVED: an unhandled writeText rejection (permission-denied
  // environments) surfaces as a pageerror, which the ui-smoke diagnostics gate
  // rightly fails.
  const handleCopyMessage = React.useCallback((text: string) => {
    copyTextToClipboard(text).catch((err: unknown) => {
      // error-policy:J7 best-effort copy — the failure is logged, never thrown
      // into the gesture handler.
      logger.warn({ err }, "[ChatOverlay] copy to clipboard failed");
    });
  }, []);
  // Press-and-hold copy adds a light haptic on top of the copy (the only
  // extraction affordance on touch, where there is no hover row).
  const handleLongPressCopy = React.useCallback((text: string) => {
    copyTextToClipboard(text).catch((err: unknown) => {
      // error-policy:J7 best-effort copy — logged, never thrown (see above).
      logger.warn({ err }, "[ChatOverlay] copy to clipboard failed");
    });
    detentHaptic();
  }, []);

  // Which message initiated the current voice playback, so ONLY that bubble
  // shows Stop. The global `speaking` flag alone lit EVERY assistant bubble to
  // "Stop" at once; scope the playing state to the actual source message.
  // Cleared when playback ends (speaking true→false) so a stale id never
  // re-lights an old bubble during the next, unrelated playback.
  const [playingMessageId, setPlayingMessageId] = React.useState<string | null>(
    null,
  );
  const wasSpeakingRef = React.useRef(false);
  React.useEffect(() => {
    if (wasSpeakingRef.current && !speaking) setPlayingMessageId(null);
    wasSpeakingRef.current = speaking;
  }, [speaking]);

  // Play an assistant message aloud from its reveal row (#10713). Toggling: a tap
  // on the message currently playing stops it; any other tap speaks that message
  // (and marks it as the one playing, so only its bubble shows Stop).
  const handleSpeakMessage = React.useCallback(
    (id: string, text: string) => {
      if (speaking && playingMessageId === id) {
        stopSpeaking?.();
        setPlayingMessageId(null);
        return;
      }
      speak?.(text);
      setPlayingMessageId(id);
    },
    [speaking, playingMessageId, speak, stopSpeaking],
  );

  // Editing rewinds the persisted branch at the selected user turn, replaces
  // its text, and resends through the canonical AppContext transaction. Stop
  // playback first so stale audio never continues over the corrected branch.
  const handleEditMessage = React.useCallback(
    async (id: string, text: string): Promise<boolean> => {
      stopSpeaking?.();
      setPlayingMessageId(null);
      return handleChatEdit(id, text);
    },
    [handleChatEdit, stopSpeaking],
  );

  // Durable reply recovery uses the same handler as the panel chat surface.
  // Other failure kinds retain their existing resend contract. Read the live
  // list through a ref to keep memoized transcript rows stable during streaming.
  const messagesRef = React.useRef(messages);
  messagesRef.current = messages;
  const handleRetry = React.useCallback(
    (assistantId: string) => {
      const list = messagesRef.current;
      const assistantIdx = list.findIndex(
        (m) => m.id === assistantId && m.role === "assistant",
      );
      if (assistantIdx < 0) return;
      if (list[assistantIdx].replyRecoveryAvailable === true) {
        return handleChatRetry(assistantId);
      }
      for (let i = assistantIdx - 1; i >= 0; i -= 1) {
        if (list[i].role === "user") {
          const retryText = list[i].content.trim();
          if (retryText) send(retryText);
          return;
        }
      }
    },
    [send, handleChatRetry],
  );

  // Proactive suggestions (#8792) — same semantics as the composite ChatView:
  // dismiss removes the bubble from the live transcript only (the server-side
  // per-surface cooldown keeps the same offer from immediately re-appearing);
  // accept ("Do it") sends the implied action as a real turn through the SAME
  // send() path an edit-resend uses, then clears the bubble.
  const {
    removeConversationMessage,
    conversationMessages,
    prependConversationMessages,
  } = useConversationMessages();
  const handleDismissSuggestion = React.useCallback(
    (messageId: string) => {
      removeConversationMessage(messageId);
    },
    [removeConversationMessage],
  );
  const handleAcceptSuggestion = React.useCallback(
    (m: ChatMessageData) => {
      send("Yes, let's do it.");
      removeConversationMessage(m.id);
    },
    [send, removeConversationMessage],
  );

  const slash = slashProp ?? EMPTY_SLASH_CONTROLLER;

  // Honor the OS "reduce motion" setting: every overlay animation collapses to
  // a near-instant cross-fade with no positional movement when this is true.
  const reduce = useReducedMotion() ?? false;

  // The composer draft + pending attachments are the SHARED ChatComposerContext
  // slot (one draft per active conversation, edited by every surface): under
  // the app provider, AppContext owns the debounced per-conversation
  // persistence and useChatCallbacks.handleSelectConversation owns the
  // switch-time flush/restore handoff — a swipe here routes through
  // conversationNav → selectConversation → that same handoff, which repaints
  // this composer because it reads the context. The overlay keeps NO private
  // draft copy (#12188 Phase 3); stories/e2e fixtures without a provider fall
  // back to live local state inside useChatComposerOrLocal. Prefill
  // (CHAT_PREFILL / assistant-launch) and dictation setDraft() writes are
  // persisted upstream like any keystroke; the successful-send path clears the
  // stored draft immediately (below).
  const {
    chatInput: draft,
    setChatInput: setDraft,
    chatPendingImages: pendingImages,
    setChatPendingImages: setPendingImages,
    chatReplyTarget,
    setChatReplyTarget,
  } = useChatComposerOrLocal();
  const activeConversationId = conversationNav.activeId;
  const sentMessageHistory = React.useMemo(
    () =>
      messages.flatMap((message) => {
        const content = message.content.trim();
        return message.role === "user" && content ? [content] : [];
      }),
    [messages],
  );
  const messageHistoryCursorRef = React.useRef<number | null>(null);
  const messageHistoryDraftRef = React.useRef("");
  const resetMessageHistory = React.useCallback(() => {
    messageHistoryCursorRef.current = null;
    messageHistoryDraftRef.current = "";
  }, []);
  const messageHistoryConversationRef = React.useRef(activeConversationId);
  React.useEffect(() => {
    if (messageHistoryConversationRef.current === activeConversationId) return;
    messageHistoryConversationRef.current = activeConversationId;
    resetMessageHistory();
  }, [activeConversationId, resetMessageHistory]);
  // Live handle to the draft for callbacks that must read the current text
  // without subscribing (dictation append), same pattern as messagesRef above.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;
  // Finalization drains the capture asynchronously. An immediate ref closes
  // the same-frame double-tap gap before React can paint the disabled controls.
  const transcriptionFinishingRef = React.useRef(false);
  const [transcriptionFinishing, setTranscriptionFinishing] =
    React.useState(false);
  const transcriptionComposerActive =
    transcriptionMode || transcriptionFinishing;
  const cloudLoginWaiting = React.useMemo(() => {
    if (!firstRunOpen) return false;
    // The conductor keeps earlier setup turns in transcript history and can
    // refresh one in place. Only the newest semantic first-run state may
    // minimize the sheet; a later tutorial/error/status must take ownership.
    const activeMessage = selectSemanticNewestFirstRunMessage(messages);
    return (
      activeMessage?.id === "first-run:cloud-login-waiting" &&
      (activeMessage.content.startsWith("Waiting for sign-in in the browser") ||
        activeMessage.content.startsWith("Finish signing in to continue here."))
    );
  }, [firstRunOpen, messages]);
  // Live handle to the active conversation id for the send path's draft clear,
  // so submitText keeps its stable identity.
  const activeConversationIdRef = React.useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const composerHadDraftRef = React.useRef(draft.trim().length > 0);
  const composerPauseTimerRef = React.useRef<number | null>(null);
  // The active view can take over the composer: override the placeholder and
  // receive the live draft (e.g. Help uses the chat as its search box).
  const viewChatBinding = useViewChatBinding();
  // Escape dismisses the slash menu without clearing the draft; typing reopens.
  const [slashDismissed, setSlashDismissed] = React.useState(false);
  // The chat-history sheet: closed (composer + grabber) ↔ open (full scrollable
  // history). The ONLY open/close driver — opened by a pull-up drag, by focusing
  // the composer, or by sending; closed by a pull-down drag or Escape. Never by
  // click-out, scroll, or blur.
  // The sheet's vertical position is ONE ordinal — the single source of truth for
  // how far the chat is open: `input` (composer-only) → `half` (reading
  // height) → `full` (near-fullscreen). `sheetOpen`/`expanded` are derived
  // read-only views so the two can never disagree (no impossible "open but not
  // open" combos). `pilled` sits BELOW input; `maximized` drops the inset at full.
  // Grabber pulls step through the detents (each cross haptics); programmatic
  // opens (send/focus) go full.
  // ONE openness state machine (see ChatMode). pilled / sheetOpen / expanded /
  // detent are all DERIVED from it — so the impossible "open but not open" or
  // pilled-and-full combos can't exist and no transition has to hand-sync two
  // separate states (which is what bred the old stuck states).
  // Onboarding owns HALF only while the user is acting inside Eliza. External
  // Cloud auth deliberately releases that pin and minimizes the native host to
  // the existing compact composer so Safari remains readable and clickable
  // during sign-in. Do not use the internal handle-only `pill` mode here: that
  // is a drag affordance, not a user-facing idle surface.
  const minimizeForCloudLogin = cloudLoginWaiting && fillHostAtHalf;
  const pinnedOpen = firstRunOpen && !minimizeForCloudLogin;
  const [mode, setMode] = React.useState<ChatMode>(
    pinnedOpen ? "half" : initialMode,
  );
  // The pin-at-half + stable edge effect lives below `goToDetent` (it
  // needs the detent animator); the mount state above still opens HALF first.
  //
  // During onboarding the sheet MUST stay open — the seeded greeting + choices
  // are the only way forward and the composer is frozen behind them. Deriving
  // openness from the effect alone proved raceable on a home-view boot (the
  // sheet could settle collapsed with the options hidden behind the grabber and
  // only a misleading "tap an option above" hint showing). Pin it structurally
  // at HALF, the same shared mobile composer detent used after a normal pull-up.
  const effectiveMode: ChatMode = pinnedOpen ? "half" : mode;
  const pilled = effectiveMode === "pill";
  const sheetOpen = effectiveMode === "half" || effectiveMode === "full";
  const expanded = effectiveMode === "full";
  React.useEffect(() => {
    onPilledChange?.(pilled);
  }, [onPilledChange, pilled]);
  const previousSheetOpenRef = React.useRef(sheetOpen);
  React.useLayoutEffect(() => {
    const wasOpen = previousSheetOpenRef.current;
    previousSheetOpenRef.current = sheetOpen;
    // A reply belongs to the visible thread it references. Clear it on the
    // shared open → closed edge so every dismissal path has identical behavior.
    if (wasOpen && !sheetOpen && chatReplyTarget) {
      setChatReplyTarget(null);
    }
  }, [chatReplyTarget, setChatReplyTarget, sheetOpen]);
  // LIVE mirror of `mode` for release/settle handlers. A mid-drag commit
  // (pill/maximize) sets React state, but the release often runs in the SAME
  // event — before React flushes — so closures still see the pre-commit mode
  // and settle the springs toward the wrong rest. The mid-drag commit branches
  // update this ref synchronously alongside setMode; render re-mirrors it.
  const modeRef = React.useRef(effectiveMode);
  modeRef.current = effectiveMode;
  // Free-drag rest height (px): when set, the sheet rests exactly where the user
  // released a deliberate drag instead of snapping to a detent. Cleared whenever
  // a detent is taken (tap/flick/focus/collapse) so the detents stay the
  // snap-to targets and free-positioning is purely the drag affordance.
  const [freeH, setFreeH] = React.useState<number | null>(null);
  // Live mirror of `freeH`, same contract as `modeRef` above.
  const freeHRef = React.useRef<number | null>(null);
  freeHRef.current = freeH;
  // FULL-SCREEN (maximized): at the FULL detent the user can drop the inset
  // (max-width, side padding, top margin, rounding) so the chat is edge-to-edge.
  // Invariant: only true while at FULL (sheetOpen && expanded && !pilled); every
  // leave-full transition resets it. First-run deliberately stays in the shared
  // half-height conversation rather than opening a maximized dashboard.
  const [maximized, setMaximized] = React.useState(false);
  // The desktop pill deliberately reuses this mobile/web composer, but it must
  // never inherit the phone's edge-to-edge detent. A MAXIMIZED renderer state
  // makes the transparent native host claim the complete work area, blocking
  // every app behind a mostly empty black window. Desktop still gets the same
  // input, half, and inset-full conversation states.
  const maximizeAllowed = !fillHostAtHalf;
  // Live mirror for threshold commits and reversals that can occur in one
  // pointer event before React has flushed the maximized state update.
  const maximizedRef = React.useRef(maximized);
  maximizedRef.current = maximized;
  // A restore drag is in flight (pull-down out of full-bleed). Declared up here
  // (not by the restore binding) because `fullBleedFrame` below reads it to keep
  // the panel MAX-HEIGHT full-screen-sized for the drag (so the height can track
  // the finger without clamping), and that feeds `panelMaxH` computed before the
  // binding. Keeping the strip mounted while true also preserves the pointer
  // capture across the un-maximize (the "can't collapse" bug). See the binding.
  const [restoreDragging, setRestoreDragging] = React.useState(false);
  // Whether the in-flight restore drag cleared its accidental-wobble slop and
  // gave the shared continuum to the finger. Keep the committed maximize state
  // stable for the whole hold; release converts the live geometry to the honest
  // inset detent. This ref lets that release observe engagement synchronously.
  const restoreDidEngageRef = React.useRef(false);
  // Reactive composer-focus flag. Only the short-landscape compact resting
  // affordance reads it (#14173): focusing the field lifts the compact treatment
  // so the composer widens to full BEFORE the first keystroke, and blurring an
  // empty composer settles it back to compact. Elsewhere focus is tracked via
  // refs (composerFocusedAtPressRef) that must not trigger a re-render.
  const [composerFocused, setComposerFocused] = React.useState(false);
  // Pointer/key activity restarts the desktop input bar's idle timer even when
  // it does not change the draft (for example, clicking an empty composer).
  const [inputIdleEpoch, noteInputActivity] = React.useReducer(
    (epoch: number) => epoch + 1,
    0,
  );
  React.useEffect(
    () => () => {
      // The setting is WebView-global. Always restore it when chat leaves the
      // tree so a later settings or onboarding field retains its accessory.
      setChatComposerAccessoryBarHidden(false);
    },
    [],
  );
  React.useLayoutEffect(() => {
    if (!transcriptionComposerActive && !realtimeVoiceComposerVisible) return;
    // Removing a focused textarea does not reliably emit blur in WebKit. Give
    // the WebView-global accessory back in the same commit that installs the
    // voice/transcription surface, otherwise every later form can inherit
    // chat's hidden state until the overlay itself unmounts.
    setChatComposerAccessoryBarHidden(false);
    setComposerFocused(false);
  }, [realtimeVoiceComposerVisible, transcriptionComposerActive]);
  // Whether the sheet was collapsed when the composer last gained focus — so
  // dismissing the keyboard (tap the handle, tap the scrim, tap outside) returns
  // to the prior resting state (collapsed → input) instead of leaving the sheet
  // hanging open, while a sheet that was ALREADY open before focus stays open.
  const preFocusCollapsedRef = React.useRef(true);
  // Snapshot of "was the composer focused (keyboard up) at the last pointerdown".
  // The browser can auto-blur the input between a scrim pointerdown and its
  // click, so the scrim's click handler can't read live focus — it reads this to
  // tell a FIRST tap (keyboard up → just dismiss + restore) from a SECOND tap
  // (keyboard already down → close the chat).
  const composerFocusedAtPressRef = React.useRef(false);
  const outsideSheetPointerRef = React.useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    composerFocusedAtPress: boolean;
    dragged: boolean;
  } | null>(null);
  const suppressNextOutsideClickRef = React.useRef(false);
  // The live thread (history) height in px, as a MOTION VALUE — driven directly
  // by the pointer during a drag and spring-animated to a detent on release.
  // Keeping it off React state means a drag updates the DOM height every frame
  // with NO component re-render, so the gesture stays buttery. `draggingRef`
  // gates the settle effect so it doesn't fight an in-flight finger drag.
  const threadHeight = useMotionValue(0);
  // Pill → input morph progress (0 = pill capsule, 1 = full input bar), OFF React
  // state like threadHeight so a pill drag morphs the glass at 60fps with no
  // re-render. Drives the glass/content crossfade + scale; `threadHeight` stays
  // 0 until the input is fully formed, then takes over for input → chat.
  const openProgress = useMotionValue(pilled ? 0 : 1);
  // Imperative animations triggered from gesture callbacks are outside React's
  // effect cleanup, so keep one owner per motion value and stop stale springs
  // before starting another.
  const threadAnimationRef = React.useRef<MotionControls | null>(null);
  const openProgressAnimationRef = React.useRef<MotionControls | null>(null);
  const prefillFocusFrameRef = React.useRef<number | null>(null);
  const prefillFocusTimerRef = React.useRef<number | null>(null);
  // Render-level motion state for the active drag and its release spring. The
  // native-glass handoff and safe-area morph use this boundary, while the live
  // height itself remains a MotionValue so pointer frames do not re-render.
  // Do not turn this signal into `will-change` on the text-bearing fieldset:
  // promoting and demoting that whole subtree re-rasterizes stationary glyphs
  // at the gesture edges. The pill's real transform is composited by the
  // browser when Framer Motion writes it; open-sheet drags change layout only.
  const [isDragging, setDragging] = React.useState(false);
  const isDraggingRef = React.useRef(false);
  // True only while the sheet is at TRUE rest: no finger down AND no height
  // spring running (drag releases, detent taps, and programmatic opens all
  // animate through `animateThreadHeight`, which owns the falling edge). The
  // native glass anchor keys on this — anchoring at pointer-up would chase the
  // settle spring with per-frame updateRect churn (measured ~68 calls/settle
  // in the #16200 investigation).
  const [sheetSettled, setSheetSettled] = React.useState(true);
  const setDraggingState = React.useCallback((dragging: boolean) => {
    if (dragging) setSheetSettled(false);
    if (isDraggingRef.current === dragging) return;
    isDraggingRef.current = dragging;
    setDragging(dragging);
  }, []);
  const stopThreadAnimation = React.useCallback(() => {
    threadAnimationRef.current?.stop();
    threadAnimationRef.current = null;
  }, []);
  const stopOpenProgressAnimation = React.useCallback(() => {
    openProgressAnimationRef.current?.stop();
    openProgressAnimationRef.current = null;
  }, []);
  const animateThreadHeight = React.useCallback(
    (target: number) => {
      stopThreadAnimation();
      setSheetSettled(false);
      const controls = animate(threadHeight, target, SHEET_SPRING);
      threadAnimationRef.current = controls;
      // Drop the drag-scoped GPU promotion only once the RELEASE spring has come
      // to rest — clearing it on release itself would strip `will-change` mid
      // settle-spring and repaint exactly when the panel is still moving. A stop
      // (a new gesture interrupting) rejects `.finished`, so keep the layer for
      // the incoming drag; only a clean finish drops it. The settled flag rides
      // the same edge: only a clean, uninterrupted finish is "at rest".
      controls.finished
        .then(() => {
          if (draggingRef.current) return; // a new drag started meanwhile
          setSheetSettled(true);
          if (!isDraggingRef.current) return;
          setDraggingState(false);
        })
        .catch(() => {
          // Interrupted by a fresh gesture (stop) — keep the promotion resident.
        });
      return controls;
    },
    [stopThreadAnimation, threadHeight, setDraggingState],
  );
  const animateOpenProgress = React.useCallback(
    (target: number) => {
      stopOpenProgressAnimation();
      openProgressAnimationRef.current = animate(
        openProgress,
        target,
        OPEN_SPRING,
      );
    },
    [openProgress, stopOpenProgressAnimation],
  );
  const clearPrefillFocusSchedule = React.useCallback(() => {
    if (
      prefillFocusFrameRef.current !== null &&
      typeof window !== "undefined" &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(prefillFocusFrameRef.current);
    }
    if (
      prefillFocusTimerRef.current !== null &&
      typeof window !== "undefined"
    ) {
      window.clearTimeout(prefillFocusTimerRef.current);
    }
    prefillFocusFrameRef.current = null;
    prefillFocusTimerRef.current = null;
  }, []);
  React.useEffect(
    () => () => {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      if (layoutShiftIntentTimerRef.current !== null) {
        window.clearTimeout(layoutShiftIntentTimerRef.current);
        layoutShiftIntentTimerRef.current = null;
      }
      overlayRef.current?.removeAttribute(LAYOUT_SHIFT_INTENT_ATTR);
      clearPrefillFocusSchedule();
    },
    [stopThreadAnimation, stopOpenProgressAnimation, clearPrefillFocusSchedule],
  );
  // Latest `settleDrag` (defined below) exposed to the viewport-resize effect
  // (which runs earlier). A rotation can orphan an in-flight drag — re-settling
  // the morph keeps the pill↔input crossfade from stranding both bars visible.
  const settleDragRef = React.useRef<(() => void) | null>(null);
  const draggingRef = React.useRef(false);
  // A pointer is pressed on the open-sheet grabber / the maximize-restore strip
  // RIGHT NOW. Each gates ITS element's mount (below) so the handle survives any
  // re-render between the pointerdown and the gesture's first integrated frame.
  // The mount gates otherwise keep an element alive only once `draggingRef` /
  // `restoreDragging` go live — which happens on that first frame, not the press
  // — leaving a window where a re-render (a late settle landing under a loaded
  // main thread) unmounts the element UNDER the captured pointer. Chromium then
  // fires pointercancel + lostpointercapture on the dead node and the gesture's
  // release never runs its settle: the grabber drag dies mid-morph, and worse,
  // the restore strip strands `restoreDragging`/`draggingRef` true (freezing the
  // sheet's settle springs — the desktop-held FULL→bottom drain then reads the
  // corrupted sheet and never engages, stuck at scale 1.00). Held deliberately
  // OUT of the settle-suppression guards (unlike `draggingRef`): they only keep
  // the element mounted. Each ref holds the ACCEPTED pointer's id (#15824), not
  // a boolean: only an eligible primary press latches (the browser guarantees a
  // terminal for a captured press — an ineligible one gets no capture and no
  // such guarantee), and only that pointer's own terminal clears it, so a
  // secondary finger's up can never unlatch a still-held primary drag.
  const grabberPressRef = React.useRef<number | null>(null);
  const restorePressRef = React.useRef<number | null>(null);
  // Peak visible panel height reached during the current upward drag. The
  // release path reads the same 90%-of-viewport threshold as the live crossing,
  // so releasing on either side of the line cannot disagree with what the user
  // saw while holding the sheet.
  const maxPullRawRef = React.useRef(0);
  // Once a held gesture crosses the full-screen line and then reverses below
  // it, release must honor the reversal instead of the earlier high-water mark.
  const maximizeReversedRef = React.useRef(false);
  // Thread height at the START of the current gesture. Release paths that land
  // at the bottom use it to tell a big yank (started at/above the half detent →
  // the user is putting the chat away → PILL) from a short close (started low →
  // INPUT). Distance-past-the-bottom alone can't make that call: a maximized
  // sheet fills the screen, so the finger physically runs out of room to
  // overshoot below it.
  const dragStartHRef = React.useRef(0);
  // THE drag integrator. The whole pill → input → chat → full-bleed continuum
  // is ONE coordinate: -PILL_OPEN_DISTANCE (pill capsule) through 0 (input bar)
  // up to the full-bleed ceiling. Each pointer frame integrates the frame's
  // delta into it and clamps at both ends, so the sheet follows the pointer's
  // POSITION exactly — travel past an edge is consumed (not banked), and a
  // reversal moves the sheet on its very first pixel. Because the value is a
  // per-frame integral (not baseH + total offset), an up-down-up mouse drag can
  // never drift out of sync with the cursor, and mode/maximize state flips
  // mid-gesture never re-base anything.
  const dragContRef = React.useRef(0);
  // The gesture's RESTING pose at pointerdown (mode + free-rest height +
  // whether it began at the inset FULL detent). Mid-drag commits mutate
  // mode/freeH under the held finger; a same-gesture REVERSAL restores this
  // snapshot so a cancel (rotation, OS takeover) settles at the detent the
  // gesture actually started from — not one it merely passed through — and so
  // the maximize thresholds keep reading the gesture's true origin.
  const dragStartModeRef = React.useRef<ChatMode>("input");
  const dragStartFreeHRef = React.useRef<number | null>(null);
  // Continuum coordinate at which this gesture crossed the 90% snap line. Once
  // full-screen, the height spring owns the panel while the finger remains above
  // this coordinate; reversing below it hands height back to the finger and
  // restores the window shape.
  const fullscreenCrossContRef = React.useRef<number | null>(null);
  // TRUE while the current gesture is a maximize-restore drag (the top strip).
  // The restore drag owns its own 90% crossing; the integrator must not also
  // un-maximize on frame 1 —
  // the two branches racing was the "restore drag snaps back to FULL on
  // release" bug (the strip's slop branch never saw `maximized` true, so
  // restoreDragging/restoreDidEngageRef were never set and the release
  // discarded the whole downward travel).
  const restoreGestureRef = React.useRef(false);
  // TRUE once the current gesture's mid-drag PILL commit fired. The release
  // handlers run in the SAME event as the last integrator frame, so they can
  // see the pre-commit `pilled/sheetOpen` closures (React flushes the commit's
  // setState after the event) — same race `restoreDidEngageRef` guards for
  // the restore drag. Reset at every gesture seed.
  const pillCommittedMidDragRef = React.useRef(false);
  // The last integrated gesture offset (px, up-positive, 0 at pointerdown);
  // per-frame delta = offset - this.
  const dragLastOffsetRef = React.useRef(0);
  // Continuum position at gesture start (< 0 when the gesture began on the
  // pill). The measured-top fallback uses it to distinguish a rising sheet from
  // a restore/downward drag.
  const dragStartContRef = React.useRef(0);
  // Maximize-morph tracking. Raw height is the deterministic source while the
  // sheet is already open; measured top-edge pinning supplements it for long
  // pill/input hauls where the visual panel reaches its inset ceiling before the
  // raw travel has consumed the whole morph budget. These latch that pin phase.
  const dragMinTopRef = React.useRef(Number.POSITIVE_INFINITY);
  const dragPinnedRef = React.useRef(false);
  const dragOffAtPinRef = React.useRef(0);
  const dragPinTopRef = React.useRef(0);

  const resetPullPeak = React.useCallback(() => {
    maxPullRawRef.current = 0;
    maximizeReversedRef.current = false;
    fullscreenCrossContRef.current = null;
  }, []);
  // At rest the collapsed composer should not carry hidden transcript/header
  // DOM. During an upward pull, though, the sheet needs a mounted body so the
  // MotionValue-driven height can follow the finger before the release commits
  // to an open detent. This boolean changes only at gesture boundaries; the
  // per-frame drag still stays outside React.
  const [dragPreviewVisible, setDragPreviewVisible] = React.useState(false);
  const dragPreviewVisibleRef = React.useRef(false);
  const setDragPreviewMounted = React.useCallback((visible: boolean) => {
    if (dragPreviewVisibleRef.current === visible) return;
    dragPreviewVisibleRef.current = visible;
    setDragPreviewVisible(visible);
  }, []);
  const [imageError, setImageError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  const preserveComposerFocusUntilRef = React.useRef(0);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLFieldSetElement>(null);
  // The SURFACE layer (not the transparent fieldset container): it carries the
  // live corner radius the native glass region must mirror.
  const glassSurfaceRef = React.useRef<HTMLDivElement | null>(null);
  const [panelElement, setPanelElement] =
    React.useState<HTMLFieldSetElement | null>(null);
  const bindPanelRef = React.useCallback((node: HTMLFieldSetElement | null) => {
    panelRef.current = node;
    setPanelElement(node);
  }, []);
  const getPanelElement = React.useCallback(() => {
    if (panelElement) return panelElement;
    if (panelRef.current) return panelRef.current;
    if (typeof document === "undefined") return null;
    return document.querySelector<HTMLFieldSetElement>(
      '[data-testid="chat-sheet"]',
    );
  }, [panelElement]);
  // The transcript's inner content wrapper — measured to size the onboarding
  // sheet to its content (grow-from-the-bottom) instead of a tall empty panel.
  const threadContentRef = React.useRef<HTMLDivElement>(null);
  const layoutShiftIntentTimerRef = React.useRef<number | null>(null);
  const layoutShiftIntentLastMotionRef = React.useRef(0);
  const markLayoutShiftIntent = React.useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay || typeof window === "undefined") return;
    // Arm ONCE per motion burst (#15257): this fires on EVERY threadHeight
    // tick (60+/s across a whole drag or settle spring). While armed, a tick
    // only refreshes the last-motion timestamp — no attribute write, no timer
    // churn. The single clear timer extends itself while motion continues and
    // removes the marker ~180ms after the last tick.
    layoutShiftIntentLastMotionRef.current = performance.now();
    if (layoutShiftIntentTimerRef.current !== null) return;
    overlay.setAttribute(
      LAYOUT_SHIFT_INTENT_ATTR,
      LAYOUT_SHIFT_INTENT_TRANSIENT,
    );
    const scheduleClear = (delay: number) => {
      layoutShiftIntentTimerRef.current = window.setTimeout(() => {
        const since =
          performance.now() - layoutShiftIntentLastMotionRef.current;
        if (since < 180) {
          scheduleClear(180 - since);
          return;
        }
        layoutShiftIntentTimerRef.current = null;
        overlayRef.current?.removeAttribute(LAYOUT_SHIFT_INTENT_ATTR);
      }, delay);
    };
    scheduleClear(180);
  }, []);
  // The composer content (textarea + thread). Held so we can imperatively clear
  // its `inert` (set while pilled) the instant the pill is tapped open, before
  // React re-renders — iOS only raises the keyboard for a focus() that lands on
  // a non-inert element synchronously inside the originating tap gesture.
  const contentRef = React.useRef<HTMLDivElement>(null);
  // Set for one focus() when we open the pill to the bare input bar: that focus
  // is only there to raise the iOS keyboard and must NOT trip the focus→expand
  // that the normal "tap the visible composer" path relies on (which would
  // fling a history thread open to half instead of resting on the input bar).
  const suppressExpandOnFocusRef = React.useRef(false);
  // A focus→expand that found nothing revealable yet (the boot race: composer
  // focused while the restored conversation's messages are still in flight)
  // parks its intent here. The reveal-edge effect below honors it — but only
  // while the composer is STILL focused — so focusing the composer opens the
  // chat even when the focus wins the race against the thread load. Consumed
  // on every reveal edge so a stale intent can never fling the sheet open long
  // after the user has moved on.
  const pendingExpandOnRevealRef = React.useRef(false);
  const focusThreadRef = React.useRef(false);
  // A microphone barge-in briefly changes phase while the response is still
  // live. Keep its assistant placeholder mounted until token one arrives.
  const renderableMessages = React.useMemo(
    () =>
      filterRenderableShellMessages(
        messages,
        responding ? "responding" : phase,
      ),
    [messages, phase, responding],
  );
  // Mirror the active id so an async older-page result is dropped after a
  // mid-flight conversation switch: a page fetched for the previous thread must
  // never prepend into the newly active one.
  const loadOlderConversationIdRef = React.useRef(activeConversationId);
  loadOlderConversationIdRef.current = activeConversationId;
  const loadOlderResumeRef = React.useRef<{
    conversationId: string | null;
    before?: number;
  }>({ conversationId: activeConversationId });
  const fetchOlder = React.useCallback(async () => {
    const conversationId = activeConversationId;
    if (!conversationId) return { hasMore: false, prependedCount: 0 };
    if (loadOlderResumeRef.current.conversationId !== conversationId) {
      loadOlderResumeRef.current = { conversationId };
    }
    const result = await loadOlderConversationMessages({
      client,
      conversationId,
      currentMessages: conversationMessages,
      before: loadOlderResumeRef.current.before,
      prependMessages: (older) => {
        if (loadOlderConversationIdRef.current === conversationId) {
          prependConversationMessages(older);
        }
      },
    });
    if (loadOlderConversationIdRef.current === conversationId) {
      loadOlderResumeRef.current = {
        conversationId,
        before: result.resumeBefore,
      };
    }
    return result;
  }, [activeConversationId, conversationMessages, prependConversationMessages]);
  // The render window slides UP as the reader scrolls into history (#14329,
  // #15281): it opens at MAX_RENDERED_SHELL_MESSAGES (lean idle/drag DOM) and
  // grows a page per scroll-to-top — first revealing already-loaded turns, then
  // paging older ones in — bounded by MAX_LOADED_SHELL_WINDOW so a long thread
  // never unbounds the DOM. The one shared engine (also drives ChatView),
  // reset when the active conversation changes.
  const renderWindow = useConversationRenderWindow({
    renderableCount: renderableMessages.length,
    conversationKey: activeConversationId,
    fetchOlder,
  });
  const hasFirstRunMessages = React.useMemo(
    () => renderableMessages.some(isFirstRunShellMessage),
    [renderableMessages],
  );
  const [firstRunFallbackReady, setFirstRunFallbackReady] =
    React.useState(false);
  React.useEffect(() => {
    if (!firstRunOpen || hasFirstRunMessages) {
      setFirstRunFallbackReady(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setFirstRunFallbackReady(true);
    }, FIRST_RUN_SIGN_IN_FALLBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [firstRunOpen, hasFirstRunMessages]);
  const visibleMessages = React.useMemo(() => {
    if (firstRunOpen)
      return selectFirstRunDisplayMessages(
        renderableMessages,
        firstRunFallbackReady,
      );
    return renderableMessages.length > renderWindow.windowSize
      ? renderableMessages.slice(-renderWindow.windowSize)
      : renderableMessages;
  }, [
    firstRunFallbackReady,
    firstRunOpen,
    renderableMessages,
    renderWindow.windowSize,
  ]);
  const cloudSignInRequired = React.useMemo(
    () =>
      firstRunOpen &&
      visibleMessages.some((message) =>
        message.content.includes(
          "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
        ),
      ),
    [firstRunOpen, visibleMessages],
  );
  // Automatic realtime speech belongs to the composer-wide voice state. Only
  // user-selected playback belongs to a message row; binding automatic TTS to
  // the newest row would reveal Reply/Copy/Play as each response starts.
  const speakingSourceMessageId = speaking ? playingMessageId : null;
  const lastId = visibleMessages.at(-1)?.id ?? null;
  const lastContent = visibleMessages.at(-1)?.content ?? "";
  // The thread body is mounted while the sheet is open OR during an upward
  // drag's inert preview; the auto-scroll engine runs exactly then.
  const threadPresented = sheetOpen || dragPreviewVisible;
  // The official shadcn MessageScroller owns bottom-follow, turn anchoring, and
  // streamed-content growth. The ref remains local because search, keyboard
  // focus, topic jumps, and infinite-history prefetch address the same viewport.
  const threadRef = React.useRef<HTMLDivElement>(null);
  // MessageScroller intentionally defers resize reconciliation to the next
  // animation frame. That is correct for ordinary content growth, but the chat
  // sheet changes this viewport's height on every drag frame: a bottom-pinned
  // transcript would otherwise paint once at the old scrollTop, then jump when
  // MessageScroller catches up. Preserve only an already-pinned reader in the
  // ResizeObserver delivery phase; readers in history retain their exact place.
  const threadPinnedToEndRef = React.useRef(!firstRunOpen);
  const handleThreadScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const viewport = event.currentTarget;
      const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      threadPinnedToEndRef.current =
        end - viewport.scrollTop <= MESSAGE_SCROLLER_END_THRESHOLD_PX;
    },
    [],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a conversation change resets the keyed MessageScroller to its declared start/end policy.
  React.useLayoutEffect(() => {
    threadPinnedToEndRef.current = !firstRunOpen;
  }, [activeConversationId, firstRunOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeConversationId remounts the keyed viewport even while presentation stays true.
  React.useLayoutEffect(() => {
    const viewport = threadRef.current;
    if (
      !threadPresented ||
      !viewport ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const preservePinnedEnd = () => {
      if (!threadPinnedToEndRef.current) return;
      const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(end - viewport.scrollTop) > 0.5) {
        viewport.scrollTop = end;
      }
    };
    preservePinnedEnd();
    const observer = new ResizeObserver(preservePinnedEnd);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [activeConversationId, threadPresented]);
  const [scrollToEndRequest, setScrollToEndRequest] = React.useState(0);
  // Focus the thread for keyboard scrolling when an opener requested it.
  // Deliberately NO dependency array: many requesters (drag settles, flick
  // landings, maximize) fire while the sheet is ALREADY open, so a
  // `[sheetOpen]`-keyed effect never re-ran for them — the intent stranded and
  // then stole composer focus on a LATER open (keyboard flashing closed). Every
  // request site also sets state, so the next render consumes the intent
  // immediately; off-request renders are a single ref check.
  React.useLayoutEffect(() => {
    if (sheetOpen && focusThreadRef.current) {
      threadRef.current?.focus();
      focusThreadRef.current = false;
    }
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: these values are the event keys for transient layout-motion intent.
  React.useEffect(() => {
    markLayoutShiftIntent();
  }, [
    visibleMessages.length,
    lastId,
    lastContent,
    responding,
    turnStatus?.kind,
    turnStatus?.label,
    turnStatus?.actionName,
    turnStatus?.toolName,
    markLayoutShiftIntent,
  ]);

  // ── Infinite upward scroll (#13532/#14329), wired into the overlay per #14279
  // The overlay is the primary mobile/PWA chat surface. The shadcn
  // MessageScroller owns bottom-follow and streamed growth on `threadRef`; the
  // top sentinel lets useLoadOlderOnScroll own the opposite direction and
  // preserve the viewport when an older page is prepended. Paging + windowing
  // state lives in the shared useConversationRenderWindow above.
  const topSentinelRef = React.useRef<HTMLDivElement>(null);
  useLoadOlderOnScroll<HTMLDivElement>({
    scrollRef: threadRef,
    sentinelRef: topSentinelRef,
    onLoadOlder: renderWindow.onLoadOlder,
    hasMore: renderWindow.canLoadOlder,
    topItemKey: visibleMessages[0]?.id ?? "",
    enabled: threadPresented,
  });

  // ── Message search across previous chats (#9955, wired into the overlay per
  //    #14279) ─────────────────────────────────────────────────────────
  // A quiet search entry point in the sheet header opens the shared
  // MessageSearchPanel. Search runs against the server keyword endpoint (ranked
  // by relevance then recency — already smarter than a naive substring scan);
  // a hit jumps to its conversation + message, loading a centered window if the
  // hit predates the loaded recent window, then scroll-flashes the anchor.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const openSearch = React.useCallback(() => {
    // Grow the sheet to FULL when search opens so the results region has the
    // most room above a raised keyboard (the panel bottom-anchors its input
    // right above the keyboard; the taller the sheet, the more results are
    // visible in the space above it). The header — hence the search control —
    // only exists at half+, so this only ever grows the sheet, never shrinks it.
    setFreeH(null);
    setMode("full");
    setSearchOpen(true);
  }, []);
  const closeSearch = React.useCallback(() => setSearchOpen(false), []);
  // Collapse search when the sheet closes so a re-open lands on the transcript.
  React.useEffect(() => {
    if (!sheetOpen) setSearchOpen(false);
  }, [sheetOpen]);
  const completedSearchQueryRef = React.useRef("");
  const runMessageSearch = React.useCallback(
    async (query: string, signal: AbortSignal) => {
      const { results } = await client.searchConversationMessages(query, {
        signal,
      });
      if (!signal.aborted) completedSearchQueryRef.current = query.trim();
      return results;
    },
    [],
  );
  // Poll a bounded number of frames for the anchor to mount (the thread
  // re-renders asynchronously after a selection / window load), then resolve it
  // or null once the frame budget is spent.
  const waitForSearchAnchor = React.useCallback(
    (anchorId: string, maxFrames: number): Promise<HTMLElement | null> =>
      new Promise((resolve) => {
        if (typeof requestAnimationFrame === "undefined") {
          resolve(document.getElementById(anchorId));
          return;
        }
        let frames = 0;
        const step = () => {
          const el = document.getElementById(anchorId);
          if (el) {
            resolve(el);
            return;
          }
          if (frames++ < maxFrames) {
            requestAnimationFrame(step);
            return;
          }
          resolve(null);
        };
        requestAnimationFrame(step);
      }),
    [],
  );
  const activeSearchHighlightRef = React.useRef<{
    element: HTMLElement;
    fadeTimer: number;
    cleanupTimer: number;
    clearMatches: () => void;
    backgroundColor: string;
    boxShadow: string;
    borderRadius: string;
    transition: string;
  } | null>(null);
  const clearSearchHighlight = React.useCallback(() => {
    const active = activeSearchHighlightRef.current;
    if (!active) return;
    window.clearTimeout(active.fadeTimer);
    window.clearTimeout(active.cleanupTimer);
    active.clearMatches();
    active.element.style.backgroundColor = active.backgroundColor;
    active.element.style.boxShadow = active.boxShadow;
    active.element.style.borderRadius = active.borderRadius;
    active.element.style.transition = active.transition;
    active.element.removeAttribute("data-chat-search-highlight");
    activeSearchHighlightRef.current = null;
  }, []);
  React.useEffect(() => clearSearchHighlight, [clearSearchHighlight]);
  const searchScrollToMessageRef =
    React.useRef<ScrollToTranscriptMessage | null>(null);
  const scrollAndFlashSearchAnchor = React.useCallback(
    (el: HTMLElement, messageId: string, query: string, isUser: boolean) => {
      clearSearchHighlight();
      const reducedMotion = reduce;
      const scrolled = searchScrollToMessageRef.current?.(messageId, {
        align: "center",
        behavior: "auto",
      });
      if (!scrolled) {
        el.scrollIntoView({
          block: "center",
          behavior: reducedMotion ? "auto" : "smooth",
        });
      }
      const bubble =
        el.querySelector<HTMLElement>('[data-chat-message-bubble="true"]') ??
        el;
      const paintTarget =
        bubble.querySelector<HTMLElement>('[data-chat-selectable="true"]') ??
        bubble;
      const clearTextMatches = highlightSearchMatches(paintTarget, query);
      const glow = highlightSearchMessage(bubble, paintTarget, isUser);
      const clearMatches = () => {
        clearTextMatches();
        glow.clear();
      };
      const previous = {
        backgroundColor: paintTarget.style.backgroundColor,
        boxShadow: paintTarget.style.boxShadow,
        borderRadius: paintTarget.style.borderRadius,
        transition: paintTarget.style.transition,
      };
      // Extend the white tint beyond the text without shifting the transcript.
      // A soft outer glow keeps the destination distinct from exact matches.
      paintTarget.setAttribute("data-chat-search-highlight", "true");
      const fadeTimer = window.setTimeout(() => {
        clearTextMatches();
        glow.fade();
      }, 1050);
      const cleanupTimer = window.setTimeout(
        clearSearchHighlight,
        reducedMotion ? 1050 : 1550,
      );
      activeSearchHighlightRef.current = {
        element: paintTarget,
        clearMatches,
        fadeTimer,
        cleanupTimer,
        ...previous,
      };
    },
    [clearSearchHighlight, reduce],
  );
  const handleSearchJump = React.useCallback(
    (result: ConversationMessageSearchResult) => {
      const anchorId = getChatMessageAnchorId(result.messageId);
      const query = completedSearchQueryRef.current;
      void (async () => {
        // Select the hit's conversation and let its recent window load first, so
        // the in-window case (the common one) scrolls without a second fetch.
        await handleSelectConversation(result.conversationId);
        let el = await waitForSearchAnchor(anchorId, 20);
        if (!el) {
          // The message may already be loaded but outside the deliberately
          // bounded render window. Reveal local history before fetching.
          renderWindow.revealFullWindow();
          el = await waitForSearchAnchor(anchorId, 2);
        }
        if (!el) {
          // A genuinely older hit needs a window centered on the message.
          const loaded = await loadConversationMessagesAround(
            result.conversationId,
            result.messageId,
          );
          if (loaded) {
            el = await waitForSearchAnchor(anchorId, 20);
          }
        }
        if (el)
          scrollAndFlashSearchAnchor(
            el,
            result.messageId,
            query,
            result.role === "user",
          );
      })();
    },
    [
      handleSelectConversation,
      loadConversationMessagesAround,
      waitForSearchAnchor,
      scrollAndFlashSearchAnchor,
      renderWindow.revealFullWindow,
    ],
  );

  // The stable body renderer keeps ChatMessage's memo intact while the sheet
  // moves; only the active assistant row receives volatile turn status.
  const renderRowBody = React.useCallback(
    (m: ChatMessageData, ctx: ChatMessageRenderContext | undefined) =>
      renderOverlayMessageBody(m, ctx, openSettings),
    [openSettings],
  );
  // Reply arms the shared composer reply target so the next send() stamps
  // replyToMessageId (attached at the sendChatText chokepoint → REPLY_CONTEXT)
  // and the pill renders above the input. Opens the sheet so the reply is typed
  // against the visible thread, not the bare collapsed bar.
  const handleReplyMessage = React.useCallback(
    (message: ChatMessageData) => {
      setChatReplyTarget(buildReplyTargetFromMessage(message, agentName));
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
      // Keep this synchronous with the trusted Reply click so mobile browsers
      // may open the software keyboard without a second tap.
      inputRef.current?.focus({ preventScroll: true });
    },
    [setChatReplyTarget, agentName],
  );
  // Render one transcript line as the canonical ChatMessage (glass chrome);
  // shared by the flat and topic-grouped paths so the in-flight-turn detection
  // stays identical.
  const renderThreadLine = React.useCallback(
    (m: ShellMessage, index: number) => {
      const messageData = shellToChatMessageData(m);
      const isLastAssistant =
        index === visibleMessages.length - 1 && m.role === "assistant";
      const isInFlight =
        isLastAssistant &&
        responding &&
        !m.content.trim() &&
        !m.attachments?.length &&
        !m.failureKind &&
        !m.secretRequest;
      // Only the last assistant turn reads volatile status; every settled row
      // gets no renderContext so its memo identity is unchanged.
      const renderContext: ChatMessageRenderContext | undefined =
        isLastAssistant
          ? {
              turnStatus: isInFlight ? turnStatus : null,
            }
          : undefined;
      return (
        <MessageScrollerItem
          key={m.id}
          messageId={m.id}
          className={cn("w-full", firstRunOpen && index > 0 && "mt-2")}
        >
          <ChatMessage
            actionAccessory={
              m.id === speakingSourceMessageId ? (
                <SpeakingStatusAccessory />
              ) : undefined
            }
            appearance="glass"
            // Fast actions can navigate in the same paint that appends their
            // optimistic turn. Overlay rows must therefore be visible on their
            // first frame so the handoff never exposes only the prior transcript.
            agentName={agentName}
            message={messageData}
            reduceMotion={reduce}
            onCopy={handleCopyMessage}
            onLongPressCopy={handleLongPressCopy}
            onSpeak={handleSpeakMessage}
            onEdit={handleEditMessage}
            onReply={isInFlight ? undefined : handleReplyMessage}
            onRetry={handleRetry}
            playing={speaking && playingMessageId === m.id}
            renderContent={renderRowBody}
            renderContext={renderContext}
            onAcceptSuggestion={handleAcceptSuggestion}
            onDismissSuggestion={handleDismissSuggestion}
          />
        </MessageScrollerItem>
      );
    },
    [
      visibleMessages.length,
      speakingSourceMessageId,
      firstRunOpen,
      agentName,
      reduce,
      handleCopyMessage,
      handleLongPressCopy,
      handleSpeakMessage,
      handleEditMessage,
      handleReplyMessage,
      handleRetry,
      speaking,
      playingMessageId,
      responding,
      turnStatus,
      renderRowBody,
      handleAcceptSuggestion,
      handleDismissSuggestion,
    ],
  );

  const booting = phase === "booting";
  const listening = phase === "listening";
  const hasDraft = draft.trim().length > 0;
  const hasImages = pendingImages.length > 0;
  const draftOwnsTrailingControl = (hasDraft || hasImages) && !recording;
  const generationOwnsTrailingControl =
    !recording && responding && Boolean(turnStatus) && !playingMessageId;
  React.useEffect(() => {
    const draftLength = draft.trim().length;
    if (composerPauseTimerRef.current !== null) {
      window.clearTimeout(composerPauseTimerRef.current);
      composerPauseTimerRef.current = null;
    }
    if (draftLength === 0) {
      composerHadDraftRef.current = false;
      return;
    }
    if (!composerHadDraftRef.current) {
      reportComposerActivity({
        activity: "typing_started",
        surface: COMPOSER_ACTIVITY_SURFACE,
        conversationId: activeConversationId,
        draftLength,
      });
      composerHadDraftRef.current = true;
    }
    composerPauseTimerRef.current = window.setTimeout(() => {
      reportComposerActivity({
        activity: "typing_paused",
        surface: COMPOSER_ACTIVITY_SURFACE,
        conversationId: activeConversationIdRef.current,
        draftLength: draftRef.current.trim().length,
        idleForMs: COMPOSER_TYPING_PAUSE_MS,
      });
      composerPauseTimerRef.current = null;
    }, COMPOSER_TYPING_PAUSE_MS);
    return () => {
      if (composerPauseTimerRef.current !== null) {
        window.clearTimeout(composerPauseTimerRef.current);
        composerPauseTimerRef.current = null;
      }
    };
  }, [activeConversationId, draft]);

  // Send `text` (and optional images) through the normal chat pipeline, clearing
  // the composer. Shared by the send button and the slash menu (agent commands).
  const submitText = React.useCallback(
    (text: string, images: ImageAttachment[] = []) => {
      const trimmed = text.trim();
      // An image-only turn is valid; only bail when there's nothing to send.
      if (!trimmed && images.length === 0) return;
      // During onboarding, free text belongs to the local conductor and must
      // never reach the runtime. Attachments remain unavailable until setup.
      if (firstRunOpen) {
        resetMessageHistory();
        if (trimmed && images.length === 0) sendFirstRunText?.(trimmed);
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        inputRef.current?.focus();
        return;
      }
      // Explicit tutorial commands ("start/stop/restart tutorial") drive the
      // chat-native tour locally — never an agent turn. Text-only: a turn
      // carrying images is a real message, not a command. Sits BEFORE the
      // canSend gate because the tour is fully client-side and must work with
      // the agent stopped.
      if (trimmed && images.length === 0 && tryHandleTutorialText(trimmed)) {
        resetMessageHistory();
        clearChatDraft(activeConversationIdRef.current);
        // The submitted text is no longer a live view filter.
        viewChatBinding?.onQuery?.("");
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        inputRef.current?.focus();
        return;
      }
      // Post-onboarding: a stopped agent can't take a turn.
      if (!canSend) return;
      resetMessageHistory();
      // Successful submit: drop the persisted draft for this conversation NOW
      // (not just via the debounced persist of the now-empty draft) so a reload
      // in the debounce window can't restore an already-sent draft.
      clearChatDraft(activeConversationIdRef.current);
      viewChatBinding?.onQuery?.("");
      // A bound view (e.g. the coding cockpit when a session is focused) can
      // claim the send to drive its OWN target instead of the host agent. If it
      // consumes the text, clear the composer and stop — do not fall through to
      // controller.send. Returns false/undefined → driver mode (host agent).
      // ONLY claim a text-only turn: the binding's onSubmit is text-only, so a
      // turn carrying images must fall through to the host agent (which can send
      // images) rather than have the images silently dropped.
      if (
        trimmed &&
        images.length === 0 &&
        viewChatBinding?.onSubmit?.(trimmed)
      ) {
        setDraft("");
        setSlashDismissed(false);
        setPendingImages([]);
        setImageError(null);
        return;
      }
      setDraft("");
      setSlashDismissed(false);
      setPendingImages([]);
      setImageError(null);
      if (images.length) {
        send(trimmed, { images });
      } else {
        send(trimmed);
      }
      // Sending is an explicit return to the live edge, even if the reader had
      // scrolled into history. Once there, MessageScroller's auto-follow keeps
      // streamed growth and the arriving reply pinned to the composer.
      setScrollToEndRequest((request) => request + 1);
      // Open the thread to show the conversation + the streaming reply, the same
      // HALF detent focusing/typing uses — NOT a full-screen takeover on every
      // send (that shoved the messages up too high). Keep a taller detent if the
      // user already opened one; clear any free-rest so the height matches.
      setFreeH(null);
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
      // Sending COMMITS to the open chat: a deliberate message means this is now
      // an active conversation, so dismissing the keyboard afterwards keeps the
      // thread open (preFocusCollapsedRef gates that) instead of collapsing the
      // whole conversation back to the bare input bar — even when the chat was
      // opened by tapping the collapsed input.
      preFocusCollapsedRef.current = false;
      detentHaptic();
      inputRef.current?.focus();
    },
    [
      canSend,
      firstRunOpen,
      resetMessageHistory,
      send,
      sendFirstRunText,
      setDraft,
      setPendingImages,
      viewChatBinding,
    ],
  );

  const finishTranscription = React.useCallback(async () => {
    if (transcriptionFinishingRef.current) return;
    transcriptionFinishingRef.current = true;
    setTranscriptionFinishing(true);
    try {
      await toggleTranscriptionMode();
    } finally {
      transcriptionFinishingRef.current = false;
      setTranscriptionFinishing(false);
    }
  }, [toggleTranscriptionMode]);

  const addImageFiles = React.useCallback(
    (files: FileList | File[]) => {
      void intakeAttachmentFiles(files)
        .then(({ attachments, droppedTooLarge }) => {
          // The overlay is a pure component without an i18n translator, so it
          // surfaces the "kept N, dropped M" notice inline in English (matching
          // its other hardcoded strings) via the existing imageError channel.
          const summary = summarizeDroppedAttachments({
            acceptedCount: attachments.length,
            droppedTooLarge,
            droppedOverCount: [],
          });
          setImageError(
            summary
              ? `Kept ${summary.kept}, dropped ${summary.dropped} (too large — max ${summary.maxMb}MB)`
              : null,
          );
          if (attachments.length) {
            setPendingImages((prev) =>
              [...prev, ...attachments].slice(0, MAX_CHAT_IMAGES),
            );
          }
        })
        .catch((err: unknown) => {
          // Surface the failure inline rather than silently dropping the image —
          // the overlay is pure, so it can't reach the global notice channel.
          setImageError(
            err instanceof Error ? err.message : "Couldn't read image",
          );
        });
    },
    [setPendingImages],
  );

  const removeImage = React.useCallback(
    (index: number) => {
      setPendingImages((prev) => prev.filter((_, i) => i !== index));
    },
    [setPendingImages],
  );

  const handleMicClick = React.useCallback(() => {
    // Trace the home-overlay mic tap BEFORE any branching so the on-screen HUD
    // captures the tap even when this handler early-returns short of capture.
    voiceCaptureDebug("mic:tap", {
      surface: "overlay",
      transcriptionMode,
      responding,
      handsFree,
    });
    // While transcribing, the mic is the master voice control: a tap turns the
    // mic OFF, which also ends transcription (mic = parent — turning off the mic
    // turns off transcript). This is distinct from the transcript button, which
    // turns transcript off but LEAVES THE MIC ON. The finished transcript still
    // drops into the composer as an attachment. This OFF path is checked FIRST
    // — never gated on `responding`: a wake-word inline reply (#9880) flips
    // `responding` true while `handsFree` stays false mid-transcription, and
    // gating it left a lit, dead "stop transcription" mic until the reply
    // finished.
    if (transcriptionMode) {
      voiceCaptureDebug("mic:branch", { action: "stop-transcription" });
      stopTranscriptionAndMic();
      return;
    }
    // Voice can't be turned ON while a reply is in flight (it's gated until the
    // turn finishes), but an active hands-free session can always be turned OFF.
    if (responding && !handsFree) {
      voiceCaptureDebug("mic:noop", { reason: "responding-not-handsfree" });
      return;
    }
    // Quick tap = hands-free conversation: the agent speaks its replies back and
    // the mic re-opens after each one. Tap again to end.
    voiceCaptureDebug("mic:branch", { action: "toggle-handsfree" });
    toggleHandsFree();
  }, [
    responding,
    handsFree,
    toggleHandsFree,
    transcriptionMode,
    stopTranscriptionAndMic,
  ]);

  const hasThread = visibleMessages.length > 0;
  const hasRevealableThread = hasThread || conversationLoading;

  // Track the VISUAL viewport so the chat sizes to — and sits above — whatever
  // the mobile keyboard leaves visible. `height` shrinks when the keyboard opens
  // (on iOS innerHeight does not, so read visualViewport); `keyboardInset` is how
  // far the keyboard intrudes from the layout bottom, used to lift the whole
  // overlay above it. `bottomPad` is the overlay's own safe-area/nav padding,
  // reserved when bounding the panel height.
  const readViewport = React.useCallback(() => {
    if (typeof window === "undefined")
      return {
        height: 800,
        keyboardInset: 0,
        innerHeight: 800,
        innerWidth: 1280,
      };
    const vv = window.visualViewport;
    const innerHeight = window.innerHeight;
    const height = vv?.height ?? innerHeight;
    // On iOS standalone/native, the soft keyboard can shrink innerHeight and
    // visualViewport.height together, making their delta read as zero. The
    // gated screen-height signal recovers that keyboard intrusion on the same
    // surfaces that install the bottom reclaim. The threshold filters the
    // smaller resting collapse band so it is never treated as a keyboard.
    let keyboardInset = 0;
    if (vv) {
      const insetFromInner = Math.max(
        0,
        innerHeight - vv.height - vv.offsetTop,
      );
      let screenKeyboard = 0;
      if (SCREEN_KEYBOARD_SIGNAL_ACTIVE) {
        const screenHeight = getPhysicalScreenVerticalExtent();
        const insetFromScreen =
          screenHeight > 0
            ? Math.max(0, screenHeight - vv.height - vv.offsetTop)
            : 0;
        // Only trust the screen-based signal once it clears the resting-collapse
        // band (so the ~59px fixed-body ICB collapse is never a keyboard).
        screenKeyboard =
          insetFromScreen >= KEYBOARD_INTRUSION_THRESHOLD_PX
            ? insetFromScreen
            : 0;
      }
      keyboardInset = Math.max(insetFromInner, screenKeyboard);
    }
    // innerHeight is the LAYOUT viewport: on Android it shrinks (adjustResize)
    // when the keyboard opens, on iOS (`resize: "body"`) it does not. The lift
    // math below uses that to avoid double-counting the keyboard. innerWidth +
    // innerHeight also drive the short-landscape compact treatment (#14173) —
    // the LAYOUT viewport so a raised keyboard never flips the orientation read.
    return {
      height,
      keyboardInset,
      innerHeight,
      innerWidth: window.innerWidth,
    };
  }, []);
  const [viewport, setViewport] = React.useState(readViewport);
  const [bottomPad, setBottomPad] = React.useState(0);
  // The resolved shared safe-area inset in px, so the full-bleed header reserves
  // the actual notch/Dynamic-Island inset instead of a fixed guess. Re-measured
  // on rotation (`resize`); it never changes between resizes, so it stays off the
  // high-rate vv `scroll`.
  const [safeAreaTop, setSafeAreaTop] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const measure = () =>
      setSafeAreaTop((prev) => {
        const next = measureSafeAreaInsetTop();
        return prev === next ? prev : next;
      });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // Coalesce the high-rate vv `scroll` to at most one commit per frame (shared
  // useRafCoalescer) so the keyboard-animation storm can't drive >60 forced
  // style reads + setStates/s.
  const viewportSync = useRafCoalescer<void>(() => {
    // Bail out of the re-render when the viewport values are unchanged — vv
    // `scroll` fires constantly while the keyboard animates but the height/
    // inset frequently don't actually move between events.
    setViewport((prev) => {
      const next = readViewport();
      return prev.height === next.height &&
        prev.keyboardInset === next.keyboardInset &&
        prev.innerHeight === next.innerHeight &&
        prev.innerWidth === next.innerWidth
        ? prev
        : next;
    });
    const el = overlayRef.current;
    if (el) {
      const pad = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
      setBottomPad((prev) => (prev === pad ? prev : pad));
    }
  });
  // Depend on the coalescer's stable methods, NOT the wrapper object (which is a
  // fresh literal each render) — otherwise this effect re-runs every render and
  // re-fires settleDragRef mid-drag, stranding an in-progress sheet gesture.
  const scheduleViewportSync = viewportSync.schedule;
  const cancelViewportSync = viewportSync.cancel;
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const sync = () => scheduleViewportSync(undefined);
    // A real WINDOW resize (rotation/desktop resize) must never strand the
    // pill↔input morph mid-crossfade — rotation often cancels the in-flight
    // pointer with no pointerup, leaving the drag orphaned. Re-settle to a clean
    // 0/1 end there. `visualViewport.resize`, however, fires continuously during
    // soft-keyboard animation; settling on those events fights typing, detent
    // drags, and keyboard open/close. For vv resize/scroll, update measurements
    // only and let the current sheet state remain authoritative.
    let settleFrame: number | null = null;
    const syncAndSettleWindow = () => {
      sync();
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      // orientationchange may arrive before innerWidth/innerHeight and the
      // visual viewport have reached their final values. Measure now, measure
      // once more on the next frame, then settle against the committed layout.
      settleFrame = window.requestAnimationFrame(() => {
        sync();
        settleFrame = window.requestAnimationFrame(() => {
          settleFrame = null;
          settleDragRef.current?.();
        });
      });
    };
    // Initial mount needs measurements only. Scheduling the deferred settle
    // here races the first user gesture: the second frame can land after a
    // pointerdown and cancel a valid drag preview. Real resize/orientation
    // events below retain the two-frame settle path.
    sync();
    const vv = window.visualViewport;
    window.addEventListener("resize", syncAndSettleWindow);
    window.addEventListener("orientationchange", syncAndSettleWindow);
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync, { passive: true });
    return () => {
      cancelViewportSync();
      if (settleFrame !== null) window.cancelAnimationFrame(settleFrame);
      window.removeEventListener("resize", syncAndSettleWindow);
      window.removeEventListener("orientationchange", syncAndSettleWindow);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, [scheduleViewportSync, cancelViewportSync]);
  const viewportH = viewport.height;
  const keyboardInset = viewport.keyboardInset;

  // iOS keyboard avoidance. With Capacitor `resize:"body"`, the software
  // keyboard shrinks the BODY but NOT the visual viewport's relationship to a
  // `position: fixed` element, and the visualViewport delta above frequently
  // reads 0 — so `keyboardInset` alone can't lift the fixed composer and it
  // ends up hidden BEHIND the keyboard (reported on device + simulator).
  // Subscribe to the Capacitor Keyboard plugin for the authoritative keyboard
  // height and lift by whichever inset is larger.
  const [nativeKeyboardHeight, setNativeKeyboardHeight] = React.useState(0);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    let cancelled = false;
    const handles: Array<{ remove: () => void }> = [];
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => {
        if (cancelled) return;
        void Keyboard.addListener("keyboardWillShow", (info) => {
          setNativeKeyboardHeight(info?.keyboardHeight ?? 0);
        })
          .then((handle) => {
            if (cancelled) handle.remove();
            else handles.push(handle);
          })
          // error-policy:J6 best-effort native listener registration; the
          // visualViewport path (outer catch) covers keyboard insets otherwise.
          .catch(() => {});
        void Keyboard.addListener("keyboardWillHide", () => {
          setNativeKeyboardHeight(0);
        })
          .then((handle) => {
            if (cancelled) handle.remove();
            else handles.push(handle);
          })
          // error-policy:J6 best-effort native listener registration; the
          // visualViewport path (outer catch) covers keyboard insets otherwise.
          .catch(() => {});
      })
      .catch(() => {
        // Web / non-native: no Keyboard plugin; visualViewport handles it.
      });
    return () => {
      cancelled = true;
      for (const handle of handles) handle.remove();
    };
  }, []);
  // Preserve the last trustworthy keyboard-hidden viewport. Some Android
  // windows resize before keyboardWillShow, while the Light Phone III keyboard
  // overlays the WebView without resizing it at all. A same-orientation height
  // drop is therefore provisional until the native event resolves; a width
  // change resets the baseline for rotation or a new window class.
  const keyboardHiddenViewportRef = React.useRef({
    innerHeight: viewport.innerHeight,
    innerWidth: viewport.innerWidth,
  });
  React.useEffect(() => {
    keyboardHiddenViewportRef.current =
      resolveChatKeyboardHiddenViewportBaseline({
        previous: keyboardHiddenViewportRef.current,
        currentInnerHeight: viewport.innerHeight,
        currentInnerWidth: viewport.innerWidth,
        nativeKeyboardVisible: nativeKeyboardHeight > 0,
      });
  }, [nativeKeyboardHeight, viewport.innerHeight, viewport.innerWidth]);

  // Lift the composer above the keyboard by ONLY the part the layout didn't
  // already absorb. On Android the window shrank by ~the keyboard height
  // (layoutShrink ≈ keyboardHeight), so the extra native lift is ~0 — without
  // this the chat double-counts and jumps a whole keyboard height too high. On
  // iOS the layout doesn't shrink (layoutShrink = 0), so the full native height
  // lifts the fixed composer above the keyboard. Web (no native plugin) keeps
  // the visualViewport-derived inset.
  // Pixel's adjustResize path consumes the bridge height and therefore returns
  // zero. The Light Phone III's keyboard leaves the WebView at full height, so
  // its unabsorbed bridge height becomes the fixed-overlay lift. iOS keeps the
  // same explicit bridge path for its resize:"body" window.
  const nativeLift = resolveChatNativeKeyboardLift({
    platformNeedsNativeLift: isIOS || isAndroid,
    nativeKeyboardHeight,
    keyboardHiddenInnerHeight: keyboardHiddenViewportRef.current.innerHeight,
    currentInnerHeight: viewport.innerHeight,
  });
  const effectiveKeyboardInset = Math.max(keyboardInset, nativeLift);
  const keyboardLiftActive = effectiveKeyboardInset > 0;
  // A REAL keyboard (not the few-px inset mobile emulation reports) blocks the
  // over-pull maximize: the edge-to-edge panel is sized against the LAYOUT
  // viewport, so with the keyboard up it would spill above the shrunk visual
  // viewport. Gating on the same intrusion threshold the keyboardInset math uses
  // keeps a genuine keyboard from over-maximizing while never tripping on the
  // sub-threshold inset a touch page carries at rest.
  const keyboardBlocksMaximize =
    effectiveKeyboardInset >= KEYBOARD_INTRUSION_THRESHOLD_PX;
  const layoutBottomPad = keyboardLiftActive
    ? KEYBOARD_COMPOSER_GAP_PX
    : bottomPad;

  // FULL-SCREEN derived gate: maximized only takes effect AT the full detent, so
  // a stale flag can never leak into half/collapsed/pill. Drives the edge-to-edge
  // panel styles + a zero top margin.
  const fullBleed =
    maximizeAllowed && maximized && expanded && sheetOpen && !pilled;
  // Only the panel MAX-HEIGHT stays full-screen-sized for the whole restore drag,
  // so the height can track the finger without the max-height clamping it shorter
  // on the first frame (a vertical pop). Every other property (side inset, bottom
  // padding, corner radius, bg) returns to its INSET value the moment the drag
  // drops `maximized`, so the panel becomes the real chat shape live and there is
  // nothing left to snap into place on release.
  const fullBleedFrame = fullBleed || restoreDragging;

  // #14173: on a wide-but-short landscape viewport the bottom-anchored composer
  // spans nearly the full width (max-w-3xl, centered) as a ~full-width band, and
  // in the short height that band sits on top of the view's own controls (the
  // audit's `overlayClearanceIssues`, e.g. builtin-browser). Shrink the RESTING
  // overlay to a compact bottom-corner affordance so it clears them; the moment
  // it is opened, focused, composing, or working, the normal centered composer
  // returns (so the reading/typing surface is never cramped). Portrait phones
  // and desktop/tablet never satisfy `shortLandscape`, so they are untouched.
  const shortLandscape =
    !fillHostAtHalf &&
    isShortLandscapeViewport(viewport.innerWidth, viewport.innerHeight);
  const compactLanding =
    shortLandscape &&
    !sheetOpen &&
    !fullBleed &&
    !composerFocused &&
    !hasDraft &&
    !hasImages &&
    !recording &&
    !responding &&
    !pinnedOpen;

  // Publish the RESTING composer footprint to --eliza-chat-clearance so routed
  // content reserves exactly the space the collapsed composer occupies. This
  // stays a block-axis reservation in short landscape: consuming the
  // composer's width as permanent inline padding turns every page into an
  // artificial half-width column.
  React.useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }
    const panel = getPanelElement();
    const root = document.documentElement;
    // The committed detent stays collapsed during a pull-up, and switches back
    // before the closing spring finishes. Neither is a resting measurement.
    if (sheetOpen || !sheetSettled) return;
    if (!panel) return;
    const publish = () => {
      // Motion and pointer refs update before React's effect cleanup. Ignore
      // resize deliveries from that interval instead of resizing routed views.
      if (draggingRef.current || threadHeight.get() > 0) return;
      const h =
        panel.getBoundingClientRect().height + CHAT_CLEARANCE_REST_GAP_PX;
      // Cap it: a mid-collapse frame can report the open panel height, and
      // reserving that in the home/launcher layout clips the top apps off-screen.
      if (h > 0)
        root.style.setProperty(
          "--eliza-chat-clearance",
          `${Math.min(Math.ceil(h), CHAT_CLEARANCE_MAX_PX)}px`,
        );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [sheetOpen, sheetSettled, getPanelElement, threadHeight]);

  // Inline clearance is deliberately zero. Routed pages retain their full
  // reading width while block-axis clearance keeps their final content above
  // the resting composer.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    root.style.setProperty("--eliza-chat-side-clearance", "0px");
    return () => {
      root.style.setProperty("--eliza-chat-side-clearance", "0px");
    };
  }, []);

  // Top clearance + max height come from the pure, unit-tested layout solver.
  // It reserves the real measured notch inset (`safeAreaTop`) above the panel,
  // and — critically — subtracts any keyboard lift the visual viewport did NOT
  // report (the iOS Capacitor `resize:"body"` case where `keyboardInset` reads 0
  // but the native Keyboard plugin still lifted the overlay): without that, the
  // panel is sized against the full height while ALSO being pushed up by the
  // keyboard, so its top edge shoots above the notch and off-screen. Full-bleed
  // drops the top margin + the overlay's bottom padding
  // so the maximized panel fills the screen edge-to-edge.
  // Solve BOTH shapes: the inset overlay height (detent target) and the
  // edge-to-edge full-bleed height. Their difference is the REAL pixel gap the
  // maximize morph travels — the over-pull past FULL grows the panel 1:1 with
  // the finger across exactly this gap (no arbitrary morph constant), so the
  // panel top tracks the pointer all the way to the screen edge.
  const layoutInput = {
    viewportH,
    bottomPad: layoutBottomPad,
    keyboardInset,
    effectiveKeyboardInset,
    safeAreaTopPx: safeAreaTop,
  };
  const { panelMaxH: insetPanelMaxH } = resolveChatPanelLayout({
    ...layoutInput,
    fullBleed: false,
  });
  const { panelMaxH: fullPanelMaxH } = resolveChatPanelLayout({
    ...layoutInput,
    fullBleed: true,
  });
  const fullscreenSnapH = viewportH * FULLSCREEN_SNAP_VH;
  // Use the frame (not just `maximized`) so the max-height stays full for the
  // whole restore drag — otherwise frame 1 clamps the panel to the inset height
  // and it pops shorter before the finger has moved.
  const desktopHostPanelMaxH = Math.max(
    0,
    fullPanelMaxH - DESKTOP_HOST_TOP_BREATHING_ROOM_PX,
  );
  const panelMaxH = fullBleedFrame
    ? fullPanelMaxH
    : fillHostAtHalf
      ? desktopHostPanelMaxH
      : insetPanelMaxH;
  const restingPanelMaxH = fillHostAtHalf
    ? desktopHostPanelMaxH
    : insetPanelMaxH;
  const maxOverPull = Math.max(0, fullPanelMaxH - restingPanelMaxH);

  // History-height detents: COLLAPSED (0) → HALF → FULL — the thread's ideal
  // flex-basis; flex-shrink clamps the real height to fit. FULL == panelMaxH so
  // the detent target matches the visible height (no dead slack at the top of a
  // pull-down) while the sheet rises all the way to the top.
  const openH = panelMaxH;
  // The nominal half detent can exceed the entire visible panel when a native
  // keyboard lifts the overlay without shrinking Chromium's layout viewport
  // (the LP3 WebView reports 414px while its keyboard consumes 223px). A resting
  // detent may never outrun its current panel ceiling: panelCapH intentionally
  // follows threadHeight during a live over-pull, so an oversized HALF target
  // otherwise re-expands the cap and clips the grabber above the screen.
  const halfH = fillHostAtHalf
    ? panelMaxH
    : resolveChatPanelHalfDetentHeight(viewportH, panelMaxH);
  const detentH = !sheetOpen ? 0 : expanded ? openH : halfH;
  // A free-drag rest height wins over the detent until a detent is re-taken.
  const baseH = freeH != null ? Math.min(freeH, panelMaxH) : detentH;

  // The single explicit state of the chat surface — the named machine the rest
  // of the component (header gate, data attribute, transitions) reads from. It
  // is DERIVED from the resting height so it always agrees with what's on
  // screen; the live drag stays on the `threadHeight` motion value (no
  // re-render per frame). The five states:
  //   CLOSED            — pill only (sheet pilled away)
  //   INPUT             — composer bar, no thread (the resting closed state)
  //   OPEN_UNDER_HALF   — opened but below the half detent (a deliberate slow
  //                       pull rested here); the status header stays hidden
  //   OPEN_HALF_OR_OVER — at the half detent or taller (status header shows)
  //   MAXIMIZED         — full-bleed edge-to-edge
  // Transitions: pill tap / flick-up → INPUT; focus·type·flick·send → an OPEN_*
  // state; pull-down → INPUT → CLOSED; maximize toggle ↔ MAXIMIZED.
  // MAXIMIZED is keyed off the SAME `fullBleed` predicate the styles use, so the
  // enum and the full-bleed layout can never disagree (no "maximized at half"
  // ghost state).
  const chatState: ChatState = pilled
    ? "CLOSED"
    : !sheetOpen
      ? "INPUT"
      : fullBleed
        ? "MAXIMIZED"
        : baseH >= halfH - 1
          ? "OPEN_HALF_OR_OVER"
          : "OPEN_UNDER_HALF";
  // The actions menu is portaled above the composer. INPUT's shallow 64px
  // native desktop host would clip that portal at the window boundary. The
  // dedicated INPUT_MENU host adds height only: it retains INPUT's exact width
  // and bottom anchor so opening the floating menu cannot resize the composer.
  const nativeSurfaceState: ChatSurfaceState =
    chatActionsOpen && chatState === "INPUT" ? "INPUT_MENU" : chatState;
  React.useEffect(() => {
    onStateChange?.(nativeSurfaceState);
  }, [nativeSurfaceState, onStateChange]);
  // The status header is gated on the LIVE rendered height, NOT the settled enum
  // — otherwise dragging the panel below half keeps the top strip mounted on a
  // too-short panel. It shows only when the panel actually renders at/over half
  // (or is full-bleed), tracking the finger frame-by-frame; the prev===next guard
  // keeps re-renders to the two threshold crossings.
  const evalHeaderVisible = React.useCallback(
    (h: number) => threadPresented && !pilled && (fullBleed || h >= halfH - 1),
    [threadPresented, pilled, fullBleed, halfH],
  );
  const [headerVisible, setHeaderVisible] = React.useState(false);
  useMotionValueEvent(threadHeight, "change", (h) => {
    markLayoutShiftIntent();
    const next = evalHeaderVisible(h);
    setHeaderVisible((prev) => (prev === next ? prev : next));
    // Unmount the collapse-preview transcript once the height has actually
    // sprung to rest at 0 — closeSheet keeps it mounted so the panel follows the
    // spring down instead of snapping. Gated so it never fires mid-drag (a
    // pill-drag sits at h=0 while dragging) or while the sheet is open.
    if (
      h <= 1 &&
      !draggingRef.current &&
      !sheetOpen &&
      dragPreviewVisibleRef.current
    ) {
      setDragPreviewMounted(false);
    }
  });
  // Re-evaluate on settled-state changes that don't tick the height (programmatic
  // pill/maximize/open with the spring already at rest).
  // biome-ignore lint/correctness/useExhaustiveDependencies: threadHeight is a stable motion ref
  React.useEffect(() => {
    setHeaderVisible(evalHeaderVisible(threadHeight.get()));
  }, [evalHeaderVisible]);
  // The thread's flex-basis is the live height as a px string. At rest
  // (threadHeight 0 = INPUT/CLOSED) the structural backdrop marker drops out of
  // compositing via `visibility` — compositor-only, no reflow, no re-render —
  // and flips back the instant the thread opens.
  const scrimVisibility = useTransform(threadHeight, (h) =>
    h > 0 ? "visible" : "hidden",
  );
  // Scroll geometry is integer CSS pixels (`clientHeight`, `scrollHeight`, and
  // the bottom-anchor `scrollTop`). Quantize the flex viewport to that same
  // coordinate system so fractional pointer frames cannot make transcript
  // glyphs drift subpixel-by-subpixel and then jump when the scroll anchor
  // crosses its next integer pixel.
  const threadFlexBasis = useTransform(
    threadHeight,
    (height) => `${Math.round(height)}px`,
  );
  // Full-screen SHAPE spring (0 = inset chat shape, 1 = edge-to-edge). It springs
  // between the two whenever `maximized` flips, so a maximize ANIMATES out to full
  // screen instead of jumping, and a restore drag ANIMATES back to the exact inset
  // shape instead of popping/snapping. Only the SHAPE eases (side inset, corner
  // radius, composer bottom-inset); the height is still the finger/detent spring,
  // so the two read as one motion. Reduced-motion sets it instantly.
  // Start at the committed shape so pinned first paint does not flash the inset
  // panel before the full-screen morph effect catches up.
  const fullBleedT = useMotionValue(fullBleed ? 1 : 0);
  // Live over-pull fraction the FINGER drives every drag frame (0 = at/below the
  // inset ceiling, 1 = full over-pull). It supplements the height cap through the
  // inset-ceiling DEAD ZONE: the FULL-detent thread flex-basis deliberately
  // OVERSHOOTS the visible thread by the composer/header chrome (~48px), so the
  // panel content reaches `insetPanelMaxH` — and the panel visually PINS at the
  // inset ceiling — while `cont` is still ~chrome px BELOW `insetPanelMaxH`.
  // `threadHeight` alone can't lift the cap there (it's < insetPanelMaxH), so the
  // panel froze under a still-rising finger. This value carries the measured pin
  // over-pull (`onDragOffset`'s `overpullT`), lifting the cap 1:1 through that gap
  // — and because the pin height ≈ `maxOverPull` (both are the dropped top
  // margin), `insetPanelMaxH + maxOverPull * overpullT == cont + chrome`, i.e. the
  // panel edge tracks the finger exactly. It is SET-only (never `animate()`d) so
  // it can never linger a spring that reflows the panel mid-pointer and cancels a
  // live drag; off-drag it stays 0 and `threadHeight`/`fullBleedT` own the cap.
  // Rests at 0 even when maximized (the maximized detent settles `threadHeight`
  // to `fullPanelMaxH`, which owns the cap) so a PROGRAMMATIC maximize animates
  // the height with `fullBleedT`/`threadHeight` instead of a `pin=1` forcing the
  // cap to full instantly.
  const overpullCapT = useMotionValue(0);
  // Mirror the settled full-bleed flag so release handlers can settle the morph
  // toward the committed shape without waiting for a re-render.
  const fullBleedRef = React.useRef(fullBleed);
  fullBleedRef.current = fullBleed;
  const fullBleedAnimRef = React.useRef<MotionControls | null>(null);
  const stopFullBleedAnimation = React.useCallback(() => {
    fullBleedAnimRef.current?.stop();
    fullBleedAnimRef.current = null;
  }, []);
  // Settle the shape morph to an explicit target. Used on release because a
  // finger-driven over-pull that is released WITHOUT changing `fullBleed` (an
  // over-pull-then-return, or a restore that lands back at full) never re-fires
  // the state effect below — the morph would otherwise strand mid-way.
  const animateFullBleedTo = React.useCallback(
    (target: number) => {
      stopFullBleedAnimation();
      if (reduce) {
        fullBleedT.set(target);
        return;
      }
      fullBleedAnimRef.current = animate(fullBleedT, target, SHEET_SPRING);
    },
    [fullBleedT, reduce, stopFullBleedAnimation],
  );
  const settleFullBleed = React.useCallback(
    () => animateFullBleedTo(fullBleedRef.current ? 1 : 0),
    [animateFullBleedTo],
  );
  // State-driven flips (programmatic maximize/restore, keyboard, onboarding)
  // spring the shape. Skipped while a finger owns the morph — the live drag
  // sets `fullBleedT` directly and the release path settles it explicitly.
  React.useEffect(() => {
    if (reduce) {
      fullBleedT.set(fullBleed ? 1 : 0);
      return;
    }
    if (draggingRef.current) return;
    stopFullBleedAnimation();
    const controls = animate(fullBleedT, fullBleed ? 1 : 0, SHEET_SPRING);
    fullBleedAnimRef.current = controls;
    return () => controls.stop();
  }, [fullBleed, reduce, fullBleedT, stopFullBleedAnimation]);
  // Side inset (12→0px), corner radius (inset radius→0), and the composer bottom
  // inset (full→0), each scaled by the spring so they collapse/return together.
  const overlayPadX = useTransform(fullBleedT, [0, 1], [12, 0]);
  // The panel WRAPPER's max-width rides the same morph: 48rem (max-w-3xl; the
  // compact landscape affordance is 13rem) widening to the full viewport as the
  // shape goes edge-to-edge. Discrete classes popped the width only when the
  // maximize COMMITTED — on desktop the background jumped 768px → viewport on
  // release instead of growing under the finger. The content columns inside
  // stay pinned at the reading width, so only the glass grows.
  const wrapperBaseMaxW = compactLanding
    ? SHORT_LANDSCAPE_CHAT_MAX_WIDTH_PX
    : 768;
  const wrapperMaxW = useTransform(
    fullBleedT,
    (t) =>
      `${wrapperBaseMaxW + Math.max(0, viewport.innerWidth - wrapperBaseMaxW) * t}px`,
  );
  // The panel's height CAP is the HIGHER of two ceilings: the over-pull ceiling
  // (inset at 0 growing to full-bleed) and the LIVE finger height (`threadHeight`).
  // Taking the max lets an upward over-pull grow past the inset ceiling 1:1 UNDER
  // THE FINGER: while the SHAPE (`fullBleedT`) still snaps discretely at the
  // commit threshold (`Maximize is a DISCRETE STATE`), the cap follows the finger
  // every frame with no freeze. Two finger-tracked inputs feed the over-pull
  // ceiling: `threadHeight` (== cont, so once `cont > insetPanelMaxH` the cap is
  // cont) and `overpullCapT` (the live pin fraction, which lifts the cap through
  // the inset-ceiling flex-overshoot dead zone BELOW `insetPanelMaxH` — see its
  // declaration). Both are SET each frame (no separate spring to desync, reflow,
  // or cancel a live pointer); off-drag they rest at the committed 0/1 and
  // `threadHeight`/the settle spring own the cap. Resting inset detents stay
  // clamped: at the FULL detent `overpullCapT` is 0 and `threadHeight` settles to
  // `insetPanelMaxH`, so the max is exactly `insetPanelMaxH` and the deliberately
  // overshooting flex-basis is still capped. Clamped to `fullPanelMaxH` so a
  // spring overshoot can never balloon the panel past the screen.
  const panelCapH = useTransform(
    [threadHeight, fullBleedT, overpullCapT] as MotionValue<number>[],
    ([h, t, pin]: number[]) =>
      Math.min(
        fullPanelMaxH,
        Math.max(restingPanelMaxH + maxOverPull * Math.max(t, pin), h),
      ),
  );
  // Corner radius is CONSTANT at every sheet height (no swim while the panel
  // grows); only the maximize shape morph squares it toward edge-to-edge.
  const morphRadius = useTransform(
    fullBleedT,
    (t: number) => `${PANEL_RADIUS_PX * (1 - t)}px`,
  );
  // Paint follows the drag itself: the resting composer keeps the translucent
  // glass fill, and pulling the sheet up blends the fill to the OPAQUE panel
  // `--bg` by the time the sheet reaches the HALF detent — so the open sheet
  // always reads BLACK, matching the app's dark view surfaces, instead of
  // frosting whatever sits behind it (a bright web page or the warm wallpaper
  // both washed the old translucent sheet). Composed with `fullBleedT` (the
  // maximize shape coordinate) so full-bleed keeps its existing opaque end
  // state, and both inputs are continuous — React's boolean `fullBleed` picks
  // the resting state, but the fill never pops mid-gesture.
  const surfaceBlackout = useTransform(
    [threadHeight, fullBleedT] as MotionValue<number>[],
    ([h, t]: number[]) => sheetBlackoutProgress(h, halfH, t),
  );
  const surfaceBackgroundColor = useTransform(surfaceBlackout, (t: number) => {
    const percent = (clamp01(t) * 100).toFixed(3);
    return `color-mix(in srgb, var(--bg) ${percent}%, ${GLASS_SHEET_FILL})`;
  });
  // Opaque sheets do not need to filter the hidden backdrop.
  const surfaceBackdropFilter = useTransform(
    surfaceBlackout,
    (t: number): string => (t >= 1 ? "none" : GLASS_SHEET_BACKDROP_FILTER),
  );
  // Keep transformed transcript children one physical border-width inside the
  // inset glass. The rim is translucent, so clipping at its outer edge lets
  // compositor-promoted text show through the antialiased top curve even when
  // the rim itself paints above it. The reserved pixel eases to zero with the
  // full-bleed morph, where there is no border or rounded edge to protect.
  const contentClipPath = useTransform(fullBleedT, (t: number) => {
    const inset = 1 - t;
    const innerRadius = Math.max(0, PANEL_RADIUS_PX * (1 - t) - inset);
    return `inset(${inset}px round ${innerRadius}px)`;
  });
  const bottomInsetFactor = useTransform(fullBleedT, [0, 1], [1, 0]);
  const overlayPadBottom = useMotionTemplate`calc(${bottomInsetFactor} * (var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem))`;
  // Full-bleed extends the glass UP under the status bar; riding the shape
  // spring (instead of a discrete swap at commit) keeps the top edge from
  // popping a safe-area-height on notch devices. 0px at rest (t=0).
  const glassTopExtension = useMotionTemplate`calc(${fullBleedT} * -1 * var(--safe-area-top, 0px))`;
  // At full-bleed the composer floats as its OWN glass capsule — the exact
  // chrome of the resting input bar (frosted fill, hairline border, capsule
  // radius) — instead of dissolving into the edge-to-edge panel. All of it
  // rides the shape morph so the chrome fades in/out with the maximize
  // gesture, never popping at commit:
  //  - the home-gesture clearance moves OUTSIDE the capsule (a bottom margin,
  //    0 at rest) so the capsule floats above the gesture bar;
  //  - a small side inset (width shrinks by 24px at t=1) keeps the capsule off
  //    the screen edges on narrow viewports;
  //  - border + frosted fill alphas scale with the morph.
  // A comfortable float above the bottom edge: the home-gesture inset PLUS a
  // base 0.75rem, so the capsule never sits flush against the screen bottom in
  // full-screen (the "margin goes away in fullscreen" complaint) even on a
  // device with no safe-area inset.
  const composerCapsuleMarginBottom = useMotionTemplate`calc(${fullBleedT} * (max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.75rem))`;
  const composerCapsuleWidth = useMotionTemplate`calc(100% - ${fullBleedT} * 24px)`;
  const composerCapsuleBorder = useMotionTemplate`color-mix(in srgb, var(--border-strong) calc(${fullBleedT} * 100%), transparent)`;
  const composerCapsuleBg = useMotionTemplate`color-mix(in srgb, var(--card) calc(${fullBleedT} * 86%), transparent)`;
  const composerCapsuleShadow = useTransform(fullBleedT, (t: number) =>
    liquidGlassEdgeShadow(t),
  );
  // --- Liquid-glass pill → input morph (driven by openProgress) ---------------
  // The panel is ONE persistent element; the pill capsule and the full
  // input crossfade by opacity (compositor-cheap) while the whole panel scales
  // up from a capsule. transform + opacity only. The scale runs the full
  // pillMorphScale lerp (down to PILL_MORPH_MIN_SCALE) so collapsing to the
  // pill reads as the chat HARD-shrinking into the capsule, not a 10% nudge.
  const panelScale = useTransform(openProgress, pillMorphScale);
  // Constant-size pill handle: cancel the panel's pill-morph scale on the
  // capsule wrapper (see pillHandleCounterScale).
  const pillCounterScale = useTransform(openProgress, pillHandleCounterScale);
  // Glass surface + its content crossfade IN as the input forms (one wrapper, so
  // sheen/glow/thread/composer resolve together with the glass).
  const glassOpacity = useTransform(openProgress, [0, 1], [0, 1]);
  const rimOpacity = useTransform(
    [glassOpacity, fullBleedT] as MotionValue<number>[],
    ([open, bleed]: number[]) => open * (1 - bleed),
  );
  // The pill capsule fades OUT over the first half of the open so it has cleared
  // before the input controls resolve (no double-image mid-morph).
  const pillOpacity = useTransform(openProgress, [0, 0.55], [1, 0], {
    clamp: true,
  });
  // The drag-handle (SheetGrabber) bar is IDENTICAL to the pill bar, so they must
  // never both be on screen. The pill fades OUT over [0, 0.55]; the grabber fades
  // IN only over [0.55, 0.95] — a strict crossfade with no overlap. (Before, the
  // grabber mounted at full opacity the instant `pilled` flipped false, while the
  // pill was still fading out → two bars = the "two pills" bug.) It ALSO fades
  // back OUT with the over-pull shape morph (`fullBleedT`), so dragging up
  // through the top ~10% dissolves the handle instead of popping it away when
  // the maximize commits — see grabberBarOpacity.
  const grabberOpacity = useTransform(
    [openProgress, fullBleedT] as MotionValue<number>[],
    ([p, t]: number[]) => grabberBarOpacity(p, t),
  );
  // Header reveal tracks the LIVE height: as the panel approaches the half
  // detent the top buttons FADE in and their space LERPS open; pulling back
  // below half fades them out and collapses the space — no pop. (Maximized sits
  // at openH ≫ half, so it's fully revealed.) overflow-hidden on the header clips
  // the buttons while the space is still opening.
  const headerOpacity = useTransform(
    threadHeight,
    [halfH - 64, halfH],
    [0, 1],
    {
      clamp: true,
    },
  );
  const headerMaxH = useTransform(threadHeight, [halfH - 64, halfH], [0, 100], {
    clamp: true,
  });
  // The header carries NO top padding of its own — the transcript runs to the
  // panel's top edge at every inset height. Only full-bleed pads the top, to
  // clear the status bar (safe-area top + 8px), EASED with the shape morph
  // instead of swapping discretely at commit — the discrete swap popped the
  // header down a status-bar height on notch devices the frame `fullBleed`
  // flipped. The safe-area term stays a CSS `var(--safe-area-top)` INSIDE the
  // calc (not a JS-measured number): the host seeds that var on native — and
  // the e2e harness drives it — so the padding must honor it even where the
  // env() probe reads 0.
  const headerPadTopMorph = useMotionTemplate`calc(${fullBleedT} * (var(--safe-area-top, 0px) + 0.5rem))`;
  const headerMaxHMorph = useTransform(
    [headerMaxH, fullBleedT] as MotionValue<number>[],
    // 400px stands in for "uncapped": the safe-area inset + badge row is well
    // under it, and a finite target lets the cap lerp instead of jumping to
    // `none`.
    ([mh, t]: number[]) => mh + (400 - mh) * clamp01(t),
  );
  // The glass should lead the gesture; transcript content fades in only after
  // there is enough vertical space to avoid clipped bubble slivers during the
  // first few pixels of a pull.
  const threadContentOpacity = useTransform(threadHeight, [72, 128], [0, 1], {
    clamp: true,
  });

  // Sub-threshold release: spring back to the current detent (no state change).
  // Also settles the pill→input morph to its resting end (0 while pilled, 1 once
  // open) so a half-finished pill drag springs cleanly back to the capsule.
  const settleDrag = React.useCallback(() => {
    draggingRef.current = false;
    // Keep a collapsed-state drag preview mounted until the return spring
    // actually reaches zero. Unmounting it at pointer-up removes the moving
    // body one frame before the glass settles, which reads as a flash/snap on a
    // short pull or a canceled pointer. The threadHeight listener owns the
    // eventual unmount; committed open destinations clear the preview below.
    // Settle toward the LIVE resting pose (modeRef/freeHRef), not the render
    // closure: a mid-drag commit flips mode in the same event as the release,
    // and the stale closure here sprang the sheet back toward the PRE-commit
    // rest (e.g. a drag-out-the-bottom re-opening the glass because `pilled`
    // still read false).
    const liveMode = modeRef.current;
    const livePilled = liveMode === "pill";
    const liveSheetOpen = liveMode === "half" || liveMode === "full";
    const liveFreeH = freeHRef.current;
    const liveDetentH = !liveSheetOpen
      ? 0
      : liveMode === "full"
        ? openH
        : halfH;
    const liveBaseH =
      liveFreeH != null ? Math.min(liveFreeH, panelMaxH) : liveDetentH;
    const open = livePilled ? 0 : 1;
    if (reduce) {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      threadHeight.set(liveBaseH);
      openProgress.set(open);
    } else {
      animateThreadHeight(liveBaseH);
      animateOpenProgress(open);
    }
    // Return the shape morph to its committed end (inset unless still maximized):
    // a released over-pull that did not commit maximize must un-morph the edges.
    settleFullBleed();
    // Hand the height cap back to `threadHeight`/`fullBleedT` (the settle springs):
    // the live pin fraction is finger-only and must rest at 0 off-drag.
    overpullCapT.set(0);
  }, [
    threadHeight,
    openProgress,
    openH,
    halfH,
    panelMaxH,
    reduce,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
    animateOpenProgress,
    settleFullBleed,
    overpullCapT,
  ]);
  // Keep the ref the (earlier-declared) viewport-resize effect calls pointing at
  // the latest settleDrag, so a rotation re-settles with current geometry.
  settleDragRef.current = settleDrag;

  // Drive openProgress from the pilled flag for NON-drag transitions (tap the
  // pill, programmatic open/close): a live finger drag owns openProgress itself
  // (draggingRef gates this so it never fights the gesture).
  React.useEffect(() => {
    if (draggingRef.current) return;
    const open = pilled ? 0 : 1;
    if (reduce) {
      stopOpenProgressAnimation();
      openProgress.set(open);
      return;
    }
    animateOpenProgress(open);
    return stopOpenProgressAnimation;
  }, [
    pilled,
    reduce,
    openProgress,
    animateOpenProgress,
    stopOpenProgressAnimation,
  ]);

  const closeSheet = React.useCallback(() => {
    draggingRef.current = false;
    setFreeH(null);
    setMaximized(false);
    setMode("input");
    // Every collapse to INPUT drops the keyboard (matrix invariant) — this is
    // reached without a blur via collapseFromRelease (drag-to-bottom release),
    // and a detent change fires exactly one haptic.
    inputRef.current?.blur();
    detentHaptic();
    if (reduce) {
      stopThreadAnimation();
      stopOpenProgressAnimation();
      threadHeight.set(0);
      openProgress.set(1);
      setDragPreviewMounted(false);
    } else {
      // Keep the transcript MOUNTED through the collapse spring. `setMode("input")`
      // above flips `sheetOpen` false, which alone would unmount the thread this
      // very frame — the panel would then snap to the composer height instantly
      // while the `threadHeight` spring animated a now-unmounted element's
      // flex-basis (the "jerky, too-fast collapse" — 415px in one frame). The
      // drag-preview mount keeps the thread laid out so the panel height actually
      // follows the spring down; the settle listener below unmounts it once the
      // height reaches 0 (robust to the [baseH] effect re-issuing the spring).
      setDragPreviewMounted(true);
      animateThreadHeight(0);
      // Settle the pill morph to the input's resting end explicitly: a drag
      // that dipped past the bottom left openProgress below 1, and the
      // `pilled`-driven effect won't re-fire when `pilled` stays false — the
      // glass would otherwise strand semi-transparent.
      animateOpenProgress(1);
    }
  }, [
    reduce,
    threadHeight,
    openProgress,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
    animateOpenProgress,
    setDragPreviewMounted,
  ]);

  // Collapse the whole chat to the bottom pill capsule — the shared landing for
  // every "put the chat away" release (flick down from the input, an input drag
  // whose pill morph crossed halfway, an open-sheet drag carried past the
  // bottom). Mode "pill" drives everything else: the pilled effect springs
  // openProgress → 0 and the detent effect springs the thread height → 0.
  const collapseToPill = React.useCallback(() => {
    draggingRef.current = false;
    setDragPreviewMounted(false);
    setFreeH(null);
    setMaximized(false);
    setMode("pill");
    inputRef.current?.blur();
    detentHaptic();
  }, [setDragPreviewMounted]);

  // The desktop bottom-bar host should not leave an unused INPUT-width window
  // floating over the user's work. Once onboarding is complete, the empty and
  // genuinely idle composer folds through the existing pill transition. This
  // is deliberately disabled for first-run/auth recovery and any state where
  // collapsing could hide work or an active interaction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputIdleEpoch is an intentional re-arm trigger for pointer/key activity that does not otherwise change composer state.
  React.useEffect(() => {
    const idleInput =
      fillHostAtHalf &&
      !firstRunOpen &&
      effectiveMode === "input" &&
      !hasDraft &&
      !hasImages &&
      !imageError &&
      !chatReplyTarget &&
      !chatActionsOpen &&
      !searchOpen &&
      !recording &&
      !listening &&
      !responding &&
      !speaking &&
      !transcriptionComposerActive &&
      !realtimeVoiceComposerVisible;
    if (!idleInput) return undefined;

    const timeout = window.setTimeout(
      collapseToPill,
      DESKTOP_INPUT_IDLE_COLLAPSE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [
    chatActionsOpen,
    chatReplyTarget,
    collapseToPill,
    effectiveMode,
    fillHostAtHalf,
    firstRunOpen,
    hasDraft,
    hasImages,
    imageError,
    inputIdleEpoch,
    listening,
    realtimeVoiceComposerVisible,
    recording,
    responding,
    searchOpen,
    speaking,
    transcriptionComposerActive,
  ]);

  // Landing for a drag released AT THE BOTTOM (thread height within the detent
  // magnet of 0): PILL when the gesture carried past the bottom into the
  // input→pill morph, OR when it started at/above the half detent (one big yank
  // from full/maximized = "put the chat away" — the screen edge leaves no room
  // to overshoot below a full-height sheet, so start height carries the
  // intent). Otherwise the INPUT bar (short closes, small free rests).
  const collapseFromRelease = React.useCallback(
    (collapseHighStart = true) => {
      // A gesture whose MID-DRAG pill commit already fired (haptic + blur +
      // mode flip, possibly not yet flushed by React) only needs its springs
      // settled — running collapseToPill again double-haptic'd every
      // drag-out-the-bottom.
      if (pillCommittedMidDragRef.current) {
        settleDrag();
        return;
      }
      // The overshoot test only applies to gestures that came DOWN through the
      // bottom (openProgress driven 1 → below the commit line). A drag that
      // started PILLED moves openProgress the other way (0 → up) — a half-open
      // pill morph must land on the INPUT, not read as "carried past bottom".
      if (
        (!pilled && openProgress.get() <= PILL_COMMIT_PROGRESS) ||
        (collapseHighStart &&
          dragStartHRef.current > halfH + SHEET_DETENT_MAGNET)
      ) {
        collapseToPill();
      } else {
        closeSheet();
      }
    },
    [pilled, openProgress, halfH, collapseToPill, closeSheet, settleDrag],
  );

  // Leaving the chat for Settings/Home: animate OUT of maximize and collapse the
  // sheet (closeSheet un-maximizes + springs the thread height down) BEFORE
  // swapping the page underneath, so it reads as the chat closing into the new
  // view rather than a jump-cut from full-screen. The page swap waits a beat for
  // the collapse spring to start (a touch longer when leaving MAXIMIZED, since
  // there's more to unwind); reduced motion navigates immediately.
  // Maximize via a vertical PULL, not a button (#13531). A pull-up that crosses
  // 90% of the viewport drops the inset and fills the remaining top strip, so
  // the panel goes edge-to-edge in one continuous gesture. The button-only
  // `toggleMaximize` is gone; this is the single entry into full-bleed and is
  // called from the pull-gesture release path (maybeMaximizeOnRelease) once the
  // peak visible panel height clears the same 90% line.
  const maximizeFromPull = React.useCallback(() => {
    if (!maximizeAllowed) return;
    // Snap the morph fully open BEFORE flipping to full-bleed so no in-flight
    // pill-open spring can leak a sub-1 scale into the maximized frame (top gap).
    draggingRef.current = false;
    stopThreadAnimation();
    stopOpenProgressAnimation();
    openProgress.set(1);
    setFreeH(null);
    setMode("full");
    setMaximized(true);
    if (reduce) {
      threadHeight.set(fullPanelMaxH);
    } else {
      animateThreadHeight(fullPanelMaxH);
    }
    // Finish the finger-driven morph to edge-to-edge explicitly: the drag left
    // fullBleedT partway (≥0.5) and the state effect is gated during the release
    // frame, so drive it home rather than waiting for the `fullBleed` flip.
    animateFullBleedTo(1);
    // Hand the cap to the maximized detent spring (`threadHeight` → fullPanelMaxH);
    // the finger-only pin fraction rests at 0.
    overpullCapT.set(0);
    detentHaptic();
  }, [
    maximizeAllowed,
    openProgress,
    reduce,
    threadHeight,
    fullPanelMaxH,
    stopThreadAnimation,
    stopOpenProgressAnimation,
    animateThreadHeight,
    animateFullBleedTo,
    overpullCapT,
  ]);

  // Restore OUT of full-bleed back to the inset FULL-detent overlay (#13531).
  // Driven by a downward pull that starts in the top strip of the maximized
  // panel; it drops full-bleed below 90% but keeps the thread open
  // at the FULL detent, so it reads as shrinking the edge-to-edge view back into
  // the overlay chat rather than collapsing the whole sheet (Escape/back still
  // collapse to the input).
  const restoreFromMaximized = React.useCallback(() => {
    draggingRef.current = false;
    stopThreadAnimation();
    setMaximized(false);
    setMode("full");
    detentHaptic();
  }, [stopThreadAnimation]);

  // The single detent→detent animator: whenever the settled detent (or viewport)
  // changes and we're not mid finger-drag, spring the history height to it. The
  // gesture / open paths just flip sheetOpen/expanded and this reacts — no
  // per-frame React state, so the live drag stays buttery.
  React.useEffect(() => {
    if (draggingRef.current) return;
    // Off-drag the cap belongs to `threadHeight`/`fullBleedT`; force the
    // finger-only pin fraction to 0 so no gesture that ended off the settle path
    // (flick, keyboard resize) can leave the resting cap inflated above the detent.
    overpullCapT.set(0);
    if (reduce) {
      stopThreadAnimation();
      threadHeight.set(baseH);
      return;
    }
    animateThreadHeight(baseH);
    return stopThreadAnimation;
  }, [
    baseH,
    reduce,
    threadHeight,
    overpullCapT,
    animateThreadHeight,
    stopThreadAnimation,
  ]);

  // Snap to one of the three iOS-style detents and settle the live drag. A
  // detent change fires a light haptic so the snap feels physical on device.
  // "collapsed" hides the history entirely (just the input); "half" is the
  // comfortable reading height; "full" the near-fullscreen reading mode.
  const goToDetent = React.useCallback(
    (to: "collapsed" | "half" | "full") => {
      // Flip the settled detent; the [baseH] effect springs the height to it.
      // A detent always clears any free-drag rest height. Full-bleed is a
      // separate, explicit maximize state: plain FULL is the inset full detent.
      draggingRef.current = false;
      setFreeH(null);
      setMaximized(false);
      // Closing through the flick-detent path must retain the same laid-out
      // transcript preview as closeSheet; otherwise mode=input unmounts the
      // thread before its height spring can paint the collapse. Reduced motion
      // deliberately skips that intermediate frame and settles immediately.
      if (to === "collapsed") setDragPreviewMounted(!reduce);
      // "collapsed" is the input bar (sheet closed); half/full open the thread.
      setMode(to === "collapsed" ? "input" : to);
      const target = to === "collapsed" ? 0 : to === "half" ? halfH : openH;
      if (reduce) {
        stopThreadAnimation();
        stopOpenProgressAnimation();
        threadHeight.set(target);
        openProgress.set(1);
      } else {
        animateThreadHeight(target);
        // Every detent is on the input side of the pill morph. A drag that
        // dipped past the bottom (openProgress < 1) then released upward onto a
        // detent must settle the morph home — the pilled effect won't re-fire
        // while `pilled` stays false, so an un-settled morph strands the glass
        // semi-transparent.
        animateOpenProgress(1);
      }
      // Settle the shape morph: every detent is inset; full-bleed only comes
      // from the explicit maximize path.
      animateFullBleedTo(0);
      // A flick-to-detent ends the gesture: drop the finger-only pin fraction so
      // it can't leave the resting cap inflated above the detent's own height.
      overpullCapT.set(0);
      // Stepping all the way down closes the keyboard (the chat is dismissed).
      if (to === "collapsed") inputRef.current?.blur();
      detentHaptic();
    },
    [
      halfH,
      openH,
      reduce,
      threadHeight,
      openProgress,
      stopThreadAnimation,
      stopOpenProgressAnimation,
      animateThreadHeight,
      animateOpenProgress,
      animateFullBleedTo,
      overpullCapT,
      setDragPreviewMounted,
    ],
  );

  // Trackpad two-finger swipe steps the sheet through its detents
  // (pill ↔ input ↔ half ↔ full ↔ maximized) — the macOS-feel complement to
  // the pointer drag. Wheel events accumulate with a short decay and step once
  // per threshold with a cooldown, so a single physical swipe moves ONE detent
  // (no accidental multi-jumps). Scoped to the sheet chrome: events that
  // originate inside an owned scroll region belong to that region and are
  // ignored here, so reading history or search results never resize the sheet.
  const wheelStepAccRef = React.useRef(0);
  const wheelStepCooldownRef = React.useRef(0);
  const wheelStepDecayRef = React.useRef<number | null>(null);
  const onSheetWheel = React.useCallback(
    (e: React.WheelEvent) => {
      // Search is a modal interaction inside the full-height sheet. Every wheel
      // gesture belongs to its query/results surface, including gestures that
      // begin over the pinned input rather than the scrolling result viewport.
      if (firstRunOpen || draggingRef.current || searchOpen) return;
      if (
        e.target instanceof Element &&
        e.target.closest("#continuous-thread, [data-chat-sheet-scroll-region]")
      ) {
        return;
      }
      const now = performance.now();
      if (now < wheelStepCooldownRef.current) return;
      if (wheelStepDecayRef.current !== null) {
        window.clearTimeout(wheelStepDecayRef.current);
      }
      wheelStepDecayRef.current = window.setTimeout(() => {
        wheelStepAccRef.current = 0;
        wheelStepDecayRef.current = null;
      }, 250);
      wheelStepAccRef.current += e.deltaY;
      const STEP_PX = 60;
      const acc = wheelStepAccRef.current;
      if (Math.abs(acc) < STEP_PX) return;
      wheelStepAccRef.current = 0;
      wheelStepCooldownRef.current = now + 450;
      // Natural-scroll semantics: swiping UP on the trackpad (content up,
      // deltaY > 0) grows the sheet; swiping down shrinks it.
      const grow = acc > 0;
      // A FREE rest reports mode "half" whatever its height — step relative to
      // the real height so an under-half rest grows to HALF (not straight to
      // FULL) and an above-half rest shrinks to HALF (not straight to INPUT):
      // one detent per swipe, never skipping.
      const freeBelowHalf = freeH != null && freeH < halfH;
      const freeAboveHalf =
        freeH != null && freeH > halfH + SHEET_DETENT_MAGNET;
      if (grow) {
        if (pilled) goToDetent("collapsed");
        else if (!sheetOpen) goToDetent("half");
        else if (!expanded) goToDetent(freeBelowHalf ? "half" : "full");
        else if (!maximized && maximizeAllowed) maximizeFromPull();
      } else {
        if (maximized) restoreFromMaximized();
        else if (expanded) goToDetent("half");
        else if (sheetOpen) goToDetent(freeAboveHalf ? "half" : "collapsed");
        else if (!pilled) collapseToPill();
      }
    },
    [
      firstRunOpen,
      searchOpen,
      pilled,
      sheetOpen,
      expanded,
      maximized,
      maximizeAllowed,
      freeH,
      halfH,
      goToDetent,
      maximizeFromPull,
      restoreFromMaximized,
      collapseToPill,
    ],
  );

  // First-run onboarding pin + release. In-app choices stay at HALF; external
  // sign-in minimizes to the regular compact composer. Successful
  // authentication opens the shared conversation at FULL so the continuation
  // is immediately visible.
  const wasFirstRunOpenRef = React.useRef(firstRunOpen);
  React.useEffect(() => {
    const was = wasFirstRunOpenRef.current;
    wasFirstRunOpenRef.current = firstRunOpen;
    if (minimizeForCloudLogin) {
      setFreeH(null);
      setMode("input");
      setMaximized(false);
      return;
    }
    if (firstRunOpen) {
      setFreeH(null);
      setMode("half");
      setMaximized(false);
      return;
    }
    if (releaseFirstRunToFull) {
      goToDetent("full");
      onFirstRunReleaseHandled?.();
      return;
    }
    if (was) {
      // A bare false -> true status probe is not onboarding completion. Until
      // the shell supplies mounted transcript-epoch authority, return to the
      // regular compact composer instead of manufacturing a FULL release.
      setFreeH(null);
      setMode("input");
      setMaximized(false);
    }
  }, [
    minimizeForCloudLogin,
    firstRunOpen,
    goToDetent,
    onFirstRunReleaseHandled,
    releaseFirstRunToFull,
  ]);

  const openFromGrabber = React.useCallback(() => {
    if (hasRevealableThread) {
      preFocusCollapsedRef.current = false;
      focusThreadRef.current = true;
      goToDetent("half");
      return;
    }
    inputRef.current?.focus();
  }, [goToDetent, hasRevealableThread]);

  // Collapsing always drops input focus, so the mobile keyboard goes away the
  // moment the chat is dismissed (pull-down, Escape, or click-out) — the chat is
  // no longer "focused". Blurring (rather than the old refocus dance) also means
  // there's no focus→expand bounce to guard against, so the model stays simple.
  const collapse = React.useCallback(() => {
    // Undismissable during onboarding: Escape (document, thread, composer),
    // outside taps, the grabber close, and the sheet-open grabber tap all
    // funnel here — every one is a no-op until first-run completes.
    if (pinnedOpen) return;
    // If focus is sitting inside the thread log, pull it out before the log
    // becomes aria-hidden / tabIndex=-1 — never park focus on a hidden element.
    if (
      typeof document !== "undefined" &&
      threadRef.current &&
      document.activeElement instanceof HTMLElement &&
      threadRef.current.contains(document.activeElement)
    ) {
      document.activeElement.blur();
    }
    closeSheet();
    inputRef.current?.blur();
  }, [closeSheet, pinnedOpen]);

  // The transparent desktop host only receives pointer events inside its
  // current native bounds. Clicking another app/window therefore cannot reach
  // the document-level outside-tap detector above, but the native shell does
  // report that focus loss (including a macOS key-window polling fallback).
  // Fold an open conversation to the compact composer, and forcibly close the
  // controlled actions portal so its temporary tall host bounds are released.
  // Onboarding stays pinned because collapse() owns that existing guard.
  useDesktopBridgeEvent(
    {
      rpcMessage: "desktopWindowBlur",
      ipcChannel: "desktop:windowBlur",
    },
    () => {
      setChatActionsOpen(false);
      if (sheetOpen) collapse();
    },
  );

  // Dismiss the keyboard and return to the resting state from BEFORE the composer
  // was focused — the single restore path shared by every "drop the keyboard"
  // gesture (tap the grabber, tap the scrim, tap outside the panel). A sheet that
  // was COLLAPSED before focus re-collapses (back to the input bar); one that was
  // ALREADY OPEN stays open and springs back to its detent size as the keyboard
  // retracts (the viewport grows → the [baseH] effect re-animates the height).
  // Never a surprise full close.
  const dismissKeyboardToPriorState = React.useCallback(() => {
    inputRef.current?.blur();
    if (preFocusCollapsedRef.current) collapse();
  }, [collapse]);

  // View navigation changes the canvas underneath this persistent composer; it
  // is not a chat dismissal. Preserve an actively focused input through every
  // in-shell route commit, including Home, even when a plugin view maps its view
  // id onto the generic `views` tab. Explicit close/open-window actions retain
  // their own focus ownership instead.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const preserveFocusedComposer = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      const action = detail?.action;
      const staysInShell =
        action !== "close" &&
        action !== "close-all" &&
        action !== "open-window";
      const shouldPreserve =
        staysInShell &&
        typeof document !== "undefined" &&
        document.activeElement === inputRef.current;
      preserveComposerFocusUntilRef.current = shouldPreserve
        ? performance.now() + 1000
        : 0;
      if (shouldPreserve) {
        window.requestAnimationFrame(() => {
          inputRef.current?.focus({ preventScroll: true });
        });
      }
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, preserveFocusedComposer);
    return () =>
      window.removeEventListener(NAVIGATE_VIEW_EVENT, preserveFocusedComposer);
  }, []);

  // The composer overlay floats over every view and survives tab changes, so
  // navigating away from a focused composer (chat → Settings / Home / …) would
  // otherwise leave the textarea holding DOM focus on the new view (its
  // collapsed/resting look is gated on sheet state, not on document focus). On
  // iOS that strands the keyboard input-accessory bar (the ‹ › chevrons +
  // "Done") at the bottom of the screen with no keyboard while the composer
  // reads as inactive. Drop composer focus whenever the active view changes to a
  // non-chat tab; an intentional tap to focus the composer on that view (no tab
  // change) is left untouched. Keyboard.hide() guarantees iOS dismisses the
  // accessory bar, not just the soft keyboard.
  React.useEffect(() => {
    const preserveUntil = preserveComposerFocusUntilRef.current;
    const preserveFocus =
      preserveUntil > 0 && preserveUntil >= performance.now();
    preserveComposerFocusUntilRef.current = 0;
    const input = inputRef.current;
    // A route can replace the textarea node while committing the new canvas.
    // Restore focus onto the CURRENT node rather than requiring the old node to
    // have survived the render; that requirement was why Home still needed a
    // second click even though the navigation event had armed a focus lease.
    if (preserveFocus) {
      input?.focus({ preventScroll: true });
      return;
    }
    if (currentTab === "chat") return;
    if (
      typeof document === "undefined" ||
      !input ||
      document.activeElement !== input
    ) {
      return;
    }
    input.blur();
    void import("@capacitor/keyboard")
      .then(({ Keyboard }) => Keyboard.hide())
      .catch(() => {
        // Web/desktop or no native bridge — blur() above already dropped focus.
      });
  }, [currentTab]);

  // Focusing or typing in the composer opens the chat (keyboard + history) when
  // there's a thread to show. Opens to HALF — the conversation is visible above
  // the keyboard without a full-screen takeover; the maximize button is for that.
  // Remember whether we opened from collapsed so dismissing the keyboard (tap the
  // handle) can return to that prior resting state. Clears any free-rest so the
  // height matches the detent (no stale freeH pinning it below half).
  const expandCore = React.useCallback(
    (snapshotPreFocus: boolean) => {
      if (!hasRevealableThread) {
        // Nothing to reveal YET — don't open an empty sheet, but remember the
        // intent: on boot the composer can gain focus while the restored
        // conversation's messages are still in flight, and dropping the expand
        // here made focus-to-open silently do nothing (#11112). The reveal-edge
        // effect below completes the open once the thread arrives, if the
        // composer is still focused.
        pendingExpandOnRevealRef.current = true;
        return;
      }
      pendingExpandOnRevealRef.current = false;
      if (snapshotPreFocus) preFocusCollapsedRef.current = !sheetOpen;
      setFreeH(null);
      // Open to at least HALF; if already at half/full, keep the taller mode.
      setMode((m) => (m === "half" || m === "full" ? m : "half"));
    },
    [hasRevealableThread, sheetOpen],
  );
  const expand = React.useCallback(() => expandCore(true), [expandCore]);

  // Talk is part of this conversation, so starting it reveals this same thread
  // at the reading detent without focusing the textarea or opening a keyboard.
  // The sheet remains open after Talk ends, leaving the just-persisted voice
  // turns visible and reviewable like typed turns.
  const voiceConversationActive = Boolean(
    realtimeVoice?.enabled &&
      (handsFree || realtimeVoice.active || realtimeVoice.connecting),
  );
  const voiceConversationWasActiveRef = React.useRef(false);
  React.useEffect(() => {
    const wasActive = voiceConversationWasActiveRef.current;
    voiceConversationWasActiveRef.current = voiceConversationActive;
    if (!voiceConversationActive || wasActive || pinnedOpen) return;
    preFocusCollapsedRef.current = false;
    setFreeH(null);
    goToDetent("half");
  }, [goToDetent, pinnedOpen, voiceConversationActive]);
  // Typing re-asserts the open but must NOT re-snapshot the pre-focus state:
  // the sheet is open by then, so re-snapshotting on every keystroke read
  // "open-before-focus" and a keyboard dismiss no longer returned a
  // collapsed-before-focus sheet to the INPUT bar. Only the focus edge (and
  // deliberate programmatic opens) record the restore point.
  const expandFromTyping = React.useCallback(
    () => expandCore(false),
    [expandCore],
  );

  // Reveal edge: the thread just became showable. If a focus→expand was parked
  // while there was nothing to reveal (see expand above), honor it now — but
  // only while the composer is STILL focused, so a long-abandoned focus can't
  // pop the sheet open. The intent is consumed either way (one-shot). A
  // pill-open keyboard-raise never parks an intent (its focus is suppressed
  // before expand runs), so the suppressExpandOnFocusRef contract holds.
  React.useEffect(() => {
    if (!hasRevealableThread || !pendingExpandOnRevealRef.current) return;
    pendingExpandOnRevealRef.current = false;
    if (
      typeof document === "undefined" ||
      document.activeElement !== inputRef.current
    ) {
      return;
    }
    expand();
  }, [hasRevealableThread, expand]);

  const pendingFirstRunAcknowledgementRef = React.useRef<{
    text: string;
    acknowledge: () => void;
  } | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const applyPrefill = (detail: ChatPrefillEventDetail) => {
      if (firstRunOpen) return;
      const text = typeof detail?.text === "string" ? detail.text : "";
      if (!text.trim()) return;
      setMode((m) => (m === "pill" ? "input" : m));
      setDraft(text);
      const focusComposer = () => {
        prefillFocusFrameRef.current = null;
        prefillFocusTimerRef.current = null;
        const input = inputRef.current;
        input?.focus();
        if (detail?.select) {
          input?.setSelectionRange(0, text.length);
        }
      };
      clearPrefillFocusSchedule();
      if (typeof window.requestAnimationFrame === "function") {
        prefillFocusFrameRef.current =
          window.requestAnimationFrame(focusComposer);
      } else {
        prefillFocusTimerRef.current = window.setTimeout(focusComposer, 0);
      }
    };
    const onPrefill = (event: Event) =>
      applyPrefill((event as CustomEvent<ChatPrefillEventDetail>).detail);
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    const unregister =
      !firstRunOpen && acceptPendingFirstRunText
        ? registerPendingFirstRunTextConsumer((text, acknowledge) => {
            pendingFirstRunAcknowledgementRef.current = { text, acknowledge };
            applyPrefill({ text, select: true });
          })
        : undefined;
    return () => {
      window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
      unregister?.();
      pendingFirstRunAcknowledgementRef.current = null;
    };
  }, [
    acceptPendingFirstRunText,
    clearPrefillFocusSchedule,
    firstRunOpen,
    setDraft,
  ]);

  React.useEffect(() => {
    if (!acceptPendingFirstRunText || firstRunOpen) return;
    const pending = pendingFirstRunAcknowledgementRef.current;
    if (!pending || pending.text !== draft) return;
    // A committed composer render acknowledges the complete draft; a remount
    // before this point leaves the durable onboarding intent available.
    pending.acknowledge();
    pendingFirstRunAcknowledgementRef.current = null;
  }, [acceptPendingFirstRunText, draft, firstRunOpen]);

  // "Open chat" intent (the launcher's Messages tile). Land the user IN an open
  // conversation instead of the wordless home with a collapsed pill: un-pill to
  // the composer and reveal the thread (a no-op when there's nothing to reveal
  // yet), then focus the input. Gated by the onboarding lock like the tour.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onOpen = () => {
      if (pinnedOpen) return;
      setMode((m) => (m === "pill" ? "input" : m));
      expand();
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener(CHAT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(CHAT_OPEN_EVENT, onOpen);
  }, [pinnedOpen, expand]);

  // Control-heavy views can explicitly ask the ambient sheet to yield focus.
  // Keep onboarding pinned: its chat choices are the active first-run UI and
  // must not be dismissed by background navigation.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onClose = () => {
      if (!pinnedOpen) collapse();
    };
    window.addEventListener(CHAT_CLOSE_EVENT, onClose);
    return () => window.removeEventListener(CHAT_CLOSE_EVENT, onClose);
  }, [pinnedOpen, collapse]);

  // The structural OS-intent authority routes untrusted launch text as a local
  // composer-prefill event (or targeted cross-window delivery), never as an
  // automatic send. The user reviews it here before submitting.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const consumePrefill = (event: Event) => {
      if (firstRunOpen) return;
      const detail = (event as CustomEvent<OsIntentComposerPrefillDetail>)
        .detail;
      if (!detail?.text) return;
      setMode((m) => (m === "pill" ? "input" : m));
      setDraft(detail.text);
      // Open the history sheet (no-op when there's no thread yet) and focus the
      // composer so the prefilled text is ready to review + send.
      expand();
      const focusComposer = () => {
        prefillFocusFrameRef.current = null;
        prefillFocusTimerRef.current = null;
        inputRef.current?.focus();
      };
      clearPrefillFocusSchedule();
      if (typeof window.requestAnimationFrame === "function") {
        prefillFocusFrameRef.current =
          window.requestAnimationFrame(focusComposer);
      } else {
        prefillFocusTimerRef.current = window.setTimeout(focusComposer, 0);
      }
    };
    window.addEventListener(OS_INTENT_COMPOSER_PREFILL_EVENT, consumePrefill);
    return () =>
      window.removeEventListener(
        OS_INTENT_COMPOSER_PREFILL_EVENT,
        consumePrefill,
      );
  }, [clearPrefillFocusSchedule, expand, firstRunOpen, setDraft]);

  // Push-to-talk dictation drops its final transcript into the composer draft
  // (no send): register the sink with the controller while this overlay is
  // mounted, appending to whatever the user has already typed.
  React.useEffect(() => {
    setDictationSink((text) => {
      // Append through the live draft ref — the shared context setter takes a
      // plain string (no functional-update form).
      const current = draftRef.current;
      setDraft(current ? `${current} ${text}` : text);
      inputRef.current?.focus();
      expand();
    });
    return () => setDictationSink(null);
  }, [setDictationSink, setDraft, expand]);

  // A completed transcription SESSION works like ChatGPT dictation: the full
  // transcript is INSERTED AS TEXT at the end of the composer draft — never
  // auto-sent, never a document chip the user has to open. The captured audio
  // becomes a pending AUDIO ATTACHMENT (the sharable artifact: sending it
  // routes the WAV through the content-addressed media store, so the thread
  // carries a playable, downloadable /api/media/<sha256>.wav recording). The
  // session is also archived (Transcript record + audio) for the Transcripts
  // view, best-effort and silent.
  React.useEffect(() => {
    setTranscriptSessionSink((segments, startedAtMs, audioWav) => {
      if (segments.length === 0) return;
      const text = transcriptPlainText(segments);
      const stamp = new Date(startedAtMs)
        .toISOString()
        .slice(0, 16)
        .replace("T", " ");
      if (text) {
        // Append at the END of whatever is already typed (through the live
        // ref — the shared context setter takes a plain string), mirroring the
        // push-to-talk dictation sink above.
        const current = draftRef.current;
        setDraft(current ? `${current} ${text}` : text);
      }
      const hasAudio = Boolean(audioWav && audioWav.byteLength > 0);
      if (audioWav && hasAudio) {
        // Enforce the SAME per-file media size cap the attach/paste/drop paths
        // go through (intakeAttachmentFiles → perFileByteCap): a several-minute
        // dictation produces a large WAV, and hand-attaching it unchecked would
        // blow past the server media limit and fail the whole send. Over the
        // cap, drop just the audio artifact — the transcript TEXT inserted above
        // is the primary output and always lands — and say so inline.
        if (audioWav.byteLength > MAX_CHAT_MEDIA_RAW_BYTES) {
          setImageError(
            `Recording too large to attach (max ${bytesToMb(
              MAX_CHAT_MEDIA_RAW_BYTES,
            )}MB) — transcript kept.`,
          );
        } else {
          const recording: ImageAttachment = {
            data: wavBytesToBase64(audioWav),
            mimeType: "audio/wav",
            name: `Recording ${stamp}.wav`,
          };
          setPendingImages((prev) =>
            [...prev, recording].slice(0, MAX_CHAT_IMAGES),
          );
        }
      }
      if (text || hasAudio) {
        expand();
        inputRef.current?.focus();
      }
      void client
        .createTranscript({
          segments,
          createdAt: startedAtMs,
          ...(audioWav
            ? {
                audioBase64: wavBytesToBase64(audioWav),
                audioContentType: "audio/wav",
              }
            : {}),
        })
        .catch(() => {
          /* archival is best-effort; a failed save just skips the record */
        });
    });
    return () => setTranscriptSessionSink(null);
  }, [setTranscriptSessionSink, setDraft, setPendingImages, expand]);

  // Tell the controller whether a draft is pending so the hands-free always-on
  // loop pauses while the user is typing (or editing a PTT dictation) and
  // resumes the prior voice state once the draft clears on send.
  React.useEffect(() => {
    setComposerHasDraft(hasDraft);
  }, [hasDraft, setComposerHasDraft]);

  // ── Slash commands ─────────────────────────────────────────────────────────
  // Inline command autocomplete: the menu derives from the draft + the loaded
  // catalog; Escape dismisses it (without clearing the draft); typing reopens.
  const slashMenu = useSlashMenu(draft, slash);
  // Short-circuit the slash parse on the common (non-slash) keystroke path — a
  // draft that doesn't start with "/" is never a slash command, so skip the work.
  const isSlashDraft = draft.startsWith("/") && parseSlashDraft(draft).isSlash;
  const slashOpen = slashMenu.open && !slashDismissed;
  // Combobox a11y for the composer input — only when a slash catalog is wired
  // in. Spread so the input is a plain message box (no role) otherwise.
  const comboboxAria: React.AriaAttributes & { role?: "combobox" } = slashProp
    ? {
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": slashOpen,
        "aria-controls": slashOpen ? "slash-command-listbox" : undefined,
        "aria-activedescendant":
          slashOpen && slashMenu.items[slashMenu.activeIndex]
            ? `slash-option-${slashMenu.items[slashMenu.activeIndex].id}`
            : undefined,
      }
    : {};

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft IS the trigger — any edit re-arms the menu after an Escape dismissal.
  React.useEffect(() => {
    setSlashDismissed(false);
  }, [draft]);

  // Run a resolved slash execution: agent commands flow through the normal send
  // pipeline; navigation/client commands run their app- or overlay-level effect
  // and clear the composer.
  const runExecution = React.useCallback(
    (exec: SlashExecution) => {
      if (exec.kind === "send") {
        submitText(exec.text);
        return;
      }
      // The CommandPalette is a Radix dialog (Z_DIALOG=170) that paints UNDER
      // the open chat glass (Z_SHELL_OVERLAY=9000): opening it from the
      // composer left an invisible, focus-trapped dialog behind the sheet.
      // Collapse first so the palette opens over the pill, fully visible and
      // dismissible; skip the composer refocus so focus stays in the palette.
      const opensPalette =
        exec.kind === "client" &&
        (exec.clientAction === "open-command-palette" ||
          exec.clientAction === "show-commands");
      const openPaletteCollapsed = () => {
        collapse();
        slash.openCommandPalette();
      };
      runSlashExecution(exec, {
        navigateTab: slash.navigateTab,
        navigateSettings: slash.navigateSettings,
        navigateView: slash.navigateView,
        // One continuous thread: reset plumbing remains available to internal
        // recovery flows, but slash/client actions cannot create or switch chats.
        clearChat: () => {},
        newConversation: () => {},
        toggleFullscreen: () => {},
        openCommandPalette: openPaletteCollapsed,
        showCommands: openPaletteCollapsed,
        toggleTranscription: toggleTranscriptionMode,
        send: (text) => submitText(text),
      });
      setDraft("");
      setSlashDismissed(true);
      if (!opensPalette) {
        inputRef.current?.focus();
      }
    },
    [slash, submitText, setDraft, toggleTranscriptionMode, collapse],
  );

  const submit = React.useCallback(() => {
    const shortcut =
      !firstRunOpen && pendingImages.length === 0
        ? resolveClientShortcutExecution(
            slash.commands,
            draft,
            slash.resolveSection,
            {
              // Natural language is always a real agent turn. Only explicit
              // slash syntax may execute client-side without consulting Eliza.
              allowNatural: false,
              resolveChoices: slash.resolveChoices,
              // #12087 Item 20: re-apply the sender's real authority so the
              // explicit slash path matches the visible menu.
              isAuthorized: slash.isAuthorized,
              isElevated: slash.isElevated,
            },
          )
        : null;
    if (shortcut) {
      if (
        shortcut.kind === "navigate-tab" ||
        shortcut.kind === "navigate-settings" ||
        shortcut.kind === "navigate-view"
      ) {
        runSlashExecution(shortcut, {
          navigateTab: slash.navigateTab,
          navigateSettings: slash.navigateSettings,
          navigateView: slash.navigateView,
          clearChat: () => {},
          newConversation: () => {},
          toggleFullscreen: () => {},
          openCommandPalette: () => {},
          showCommands: () => {},
          toggleTranscription: () => {},
          send: () => {},
        });
        submitText(draft, pendingImages);
        return;
      }
      runExecution(shortcut);
      return;
    }
    submitText(draft, pendingImages);
  }, [draft, pendingImages, firstRunOpen, runExecution, slash, submitText]);

  const pickSlashItem = React.useCallback(
    (index: number) => {
      const exec = slashMenu.resolve(index);
      if (exec) runExecution(exec);
    },
    [slashMenu, runExecution],
  );

  const cycleMessageHistory = React.useCallback(
    (
      direction: -1 | 1,
      event: React.KeyboardEvent<HTMLTextAreaElement>,
    ): boolean => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing ||
        event.currentTarget.selectionStart !==
          event.currentTarget.selectionEnd ||
        sentMessageHistory.length === 0
      ) {
        return false;
      }

      const cursor = messageHistoryCursorRef.current;
      if (cursor === null) {
        if (direction > 0) return false;
        const firstLineEnd = draft.indexOf("\n");
        if (
          firstLineEnd >= 0 &&
          event.currentTarget.selectionStart > firstLineEnd
        ) {
          return false;
        }
        messageHistoryDraftRef.current = draft;
        messageHistoryCursorRef.current = sentMessageHistory.length - 1;
      } else if (direction < 0) {
        messageHistoryCursorRef.current = Math.max(0, cursor - 1);
      } else if (cursor < sentMessageHistory.length - 1) {
        messageHistoryCursorRef.current = cursor + 1;
      } else {
        messageHistoryCursorRef.current = null;
        setDraft(messageHistoryDraftRef.current);
        return true;
      }

      const nextCursor = messageHistoryCursorRef.current;
      if (nextCursor === null) return false;
      const next = sentMessageHistory[nextCursor];
      if (next === undefined) {
        resetMessageHistory();
        return false;
      }
      setDraft(next);
      window.requestAnimationFrame(() => {
        inputRef.current?.setSelectionRange(next.length, next.length);
      });
      return true;
    },
    [draft, resetMessageHistory, sentMessageHistory, setDraft],
  );

  // The shared composer-core keydown: IME-commit guard (#9148) → slash-menu
  // interception → sent-message history → Enter sends → Escape collapses the
  // open sheet. The slash binding adapts the overlay's menu/executor onto the
  // core's key contract.
  const handleComposerKeyDown = useComposerKeydown<HTMLTextAreaElement>({
    onSend: submit,
    onHistory: cycleMessageHistory,
    slash: {
      open: slashOpen,
      move: (delta) => slashMenu.move(delta),
      complete: () => {
        const completed = slashMenu.complete();
        if (completed == null) return false;
        setDraft(completed);
        return true;
      },
      submit: () => {
        const exec = slashMenu.resolve();
        if (!exec) return false;
        runExecution(exec);
        return true;
      },
      dismiss: () => setSlashDismissed(true),
    },
    onEscape: () => {
      if (!sheetOpen) return false;
      collapse();
      return true;
    },
  });
  // The shared composer-core paste routing: an image/file paste attaches, an
  // oversized text paste becomes a collapsed text-attachment chip, small text
  // falls through to the textarea.
  const handleComposerPaste = useComposerPaste<HTMLTextAreaElement>({
    addFiles: addImageFiles,
    attachText: (attachment) =>
      setPendingImages((prev) =>
        [...prev, attachment].slice(0, MAX_CHAT_IMAGES),
      ),
  });

  // Whether a document-level pointer landed on one of the overlay's OWN
  // surfaces. CONTRACT: EVERY child of the overlay root counts as INSIDE the
  // chat for the outside-tap detectors below — the glass panel, the grabber,
  // AND the controls that render at the overlay root ABOVE the panel (the
  // audio-unlock chip, the live-transcript strip, the model-status pill). A
  // tap on any of them must never be swallowed as an outside tap nor collapse
  // the sheet; checking only `panelRef` made the audio-unlock chip unreachable
  // while the sheet was open. The single exception is the dimming backdrop:
  // it is pointer-transparent (`pointerEvents: "none"`), so a real tap "on"
  // it always lands on the view behind — an event that names it as target
  // (synthetic/test dispatch) stands in for tapping the dimmed background and
  // stays OUTSIDE.
  const isOverlayControlTarget = React.useCallback(
    (target: EventTarget | null): boolean => {
      if (
        target instanceof Element &&
        target.closest("[data-chat-overlay-control]")
      ) {
        return true;
      }
      if (!(target instanceof Node) || !overlayRef.current?.contains(target)) {
        return false;
      }
      return !(
        target instanceof Element &&
        target.closest('[data-testid="chat-sheet-backdrop"]')
      );
    },
    [],
  );

  // Tapping ANYWHERE outside the chat overlay drops the keyboard: if the
  // composer holds focus and the pointer lands outside the overlay, blur it.
  // This is the iOS-standard "tap the background to dismiss the keyboard"
  // behaviour and works whether the chat is open (over the scrim) or collapsed
  // (over the live view).
  React.useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const input = inputRef.current;
      const focused = !!input && document.activeElement === input;
      // Record the keyboard state at PRESS time: the scrim's click handler reads
      // this (focus may be gone by the time the click fires) to tell a first
      // "dismiss the keyboard" tap from a second "close the chat" tap.
      composerFocusedAtPressRef.current = focused;
      // Keyboard already down -> outside taps do nothing here; the grabber,
      // scrim, Escape key, and pull-down gesture own disclosure/collapse.
      if (!focused) return;
      // A tap on any overlay control (panel, grabber, audio-unlock chip, …)
      // is INSIDE — it must not dismiss the keyboard. The grabber in
      // particular is left to the gesture onTap; blurring here would preempt
      // the disclosure toggle and make press-time focus impossible to
      // distinguish from click-time focus.
      if (isOverlayControlTarget(event.target)) return;
      // Any other outside tap (incl. the dimming scrim) drops the keyboard and
      // returns to the pre-focus resting state — never a surprise full close.
      dismissKeyboardToPriorState();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [dismissKeyboardToPriorState, isOverlayControlTarget]);

  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onClick = (event: MouseEvent) => {
      if (!suppressNextOutsideClickRef.current) return;
      suppressNextOutsideClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
  }, []);

  // The backdrop is visual-only while the sheet is open so gestures can still
  // reach the active view or the inline home/app surface underneath. This
  // document-level detector keeps outside taps able to collapse the sheet
  // without stealing horizontal gestures or vertical scroll from the background.
  React.useEffect(() => {
    // While pinned for onboarding the chat is undismissable, so the outside-tap
    // swallower must not install: it capture-eats pointerup on everything
    // outside the sheet.
    if (typeof document === "undefined" || !sheetOpen || pinnedOpen) {
      outsideSheetPointerRef.current = null;
      suppressNextOutsideClickRef.current = false;
      return undefined;
    }

    // Surfaces painted ABOVE the chat glass (notification sheet/panel at
    // Z_NOTIFICATION_OVERLAY, any open Radix dialog) must win the tap — the
    // swallower otherwise eats their first tap AND collapses the chat under
    // them. "Tap outside collapses" is only for the background view.
    //
    // The inline home notification center (#15080) is a live INTERACTIVE
    // surface even though it sits BELOW the chat glass (inline on the home
    // column, not the old Z_NOTIFICATION_OVERLAY shade). Its rows own tap (open
    // / deep-link) and swipe-dismiss; without this
    // exemption the capture-phase pointerup below preventDefault +
    // stopImmediatePropagation'd the row's tap and set suppressNextOutsideClick,
    // so the click-swallower ate the row's onClick, tapping a notification did
    // NOTHING ("interacting is cooked", device r8). Exempt the ROWS via
    // `[data-notif-row]` so their own handlers win. Scope the exemption to the
    // rows, NOT the whole center
    // section: the section is `flex-1` and chromeless, so it fills most of the
    // home band with invisible field — exempting the section (as it once did)
    // killed outside-tap collapse everywhere around the rows. A real tap on the
    // bare field still collapses the chat; a pull-drag is a drag (not a tap) so
    // the swallower ignores it either way.
    const isAboveShellOverlay = (target: EventTarget | null): boolean =>
      target instanceof Element &&
      !!target.closest(
        '[data-above-shell-overlay], [role="dialog"], [data-notif-row], [data-notif-control]',
      );

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.pointerType === "mouse") return;
      // The whole overlay (panel, grabber, root-level controls like the
      // audio-unlock chip) is INSIDE — see isOverlayControlTarget's contract.
      if (
        isOverlayControlTarget(event.target) ||
        isAboveShellOverlay(event.target) ||
        // View controls remain usable beneath the non-modal chat. Consuming
        // their pointerup also ate Back/navigation clicks after model handoffs.
        isInteractiveGestureTarget(event.target)
      ) {
        outsideSheetPointerRef.current = null;
        return;
      }
      outsideSheetPointerRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        composerFocusedAtPress: composerFocusedAtPressRef.current,
        dragged: false,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - start.startX, event.clientY - start.startY) >
        OUTSIDE_SHEET_TAP_SLOP
      ) {
        start.dragged = true;
      }
    };

    const onPointerEnd = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      outsideSheetPointerRef.current = null;
      if (start.dragged) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      suppressNextOutsideClickRef.current = true;
      window.setTimeout(() => {
        suppressNextOutsideClickRef.current = false;
      }, 750);

      if (start.composerFocusedAtPress) {
        composerFocusedAtPressRef.current = false;
        return;
      }
      collapse();
    };
    const onPointerCancel = (event: PointerEvent) => {
      const start = outsideSheetPointerRef.current;
      if (!start || start.pointerId !== event.pointerId) return;
      outsideSheetPointerRef.current = null;
    };

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
    };
  }, [sheetOpen, pinnedOpen, collapse, isOverlayControlTarget]);

  // Escape collapses the chat from ANY open state, even a free-drag open with no
  // focused element (the element-level handlers on the textarea/thread only fire
  // when one of them holds focus). Registered only while open.
  React.useEffect(() => {
    if (typeof document === "undefined" || !sheetOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // An open Radix dialog (data-state="open" — e.g. the command palette)
        // sits above the chat: let ITS Escape handling win — collapsing here
        // too closed both at once (e.g. an invisible palette + the chat).
        // Scoped to exactly these; broad role="dialog" would match
        // always-mounted shell surfaces (AssistantOverlay, tutorial card) and
        // permanently disable Escape-collapse.
        //
        // Also defer while the transcript viewer is open or a per-message edit
        // is in progress: neither carries `[data-state="open"]`, so Escape must
        // close THAT first (the viewer's own handler / the editor's Cancel) and
        // NOT also collapse the whole sheet + discard the in-progress edit.
        if (
          document.querySelector(
            '[role="dialog"][data-state="open"], [data-testid="transcript-viewer"], [data-testid="thread-line-edit-input"]',
          )
        ) {
          return;
        }
        e.preventDefault();
        collapse();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen, collapse]);

  // Android hardware/gesture back closes the open chat sheet FIRST — the same
  // "dismiss the open surface" behavior desktop/web get from Escape (#9148).
  // `main.tsx` dispatches ELIZA_BACK_INTENT on the Capacitor `backButton` press;
  // while the sheet is open (and not pinned by onboarding) we collapse it via
  // the shared `collapse` path and flip `detail.handled` so native does NOT ALSO
  // run history.back()/minimizeApp() and navigate the app out from under it. At
  // rest (input/pill) — or while first-run pins the sheet open + undismissable —
  // we leave the intent unhandled so native falls through to its default back
  // (backgrounding the app instead of freezing). Web/desktop never dispatch the
  // event, so this is inert there.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onBackIntent = (event: Event) => {
      const detail = (event as CustomEvent<BackIntentEventDetail>).detail;
      if (!detail || detail.handled) return;
      if (!sheetOpen || pinnedOpen) return;
      detail.handled = true;
      collapse();
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
    return () =>
      window.removeEventListener(ELIZA_BACK_INTENT_EVENT, onBackIntent);
  }, [sheetOpen, pinnedOpen, collapse]);

  // Agent-driven Home navigation targets the persistent `/chat` canvas. The
  // chat is ambient app chrome, so returning Home must not dismiss it or drop a
  // draft/keyboard session. Only change the canvas underneath the current chat
  // detent; explicit user collapse gestures remain the sole dismissal owner.
  React.useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onNavigateHome = (event: Event) => {
      const detail = (event as CustomEvent<NavigateViewDetail>).detail;
      if (
        detail?.viewId !== "chat" &&
        detail?.viewId !== "home" &&
        detail?.viewPath !== "/chat" &&
        detail?.viewPath !== "/home"
      )
        return;
      goHome();
    };
    window.addEventListener(NAVIGATE_VIEW_EVENT, onNavigateHome);
    return () =>
      window.removeEventListener(NAVIGATE_VIEW_EVENT, onNavigateHome);
  }, []);

  // Auto-grow the composer with multi-line input: snap to the content height
  // (capped by `max-h` in CSS, which then scrolls). Runs on every draft change
  // so it also springs back to one line after a send clears the draft.
  React.useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!draft) {
      // An empty placeholder can wrap while the tab is hidden or the row is
      // briefly width-constrained, inflating scrollHeight even though there is
      // no draft. Clear the inline height so the one-line CSS minimum owns the
      // resting composer when the viewport becomes visible again.
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Open the input back out of the collapsed pill (tap or keyboard-activate).
  // A tap routes through the gesture's `onDrag(0)` first, which sets
  // draggingRef=true AND openProgress=0 — so we MUST clear draggingRef here, or
  // the pilled→openProgress effect early-returns and the morph stays stuck at 0
  // (a visible-but-inert pill, no input: the "bad state"). We also spring
  // openProgress → 1 directly so the open never depends on that effect's timing.
  const openFromPill = React.useCallback(() => {
    draggingRef.current = false;
    // A pill tap steps ONE state up the continuum: it forms the bare input bar,
    // nothing more. It must NOT jump to a thread detent and must NOT raise the
    // keyboard — revealing the thread (grabber tap) and focusing the composer
    // (composer tap) are each their own deliberate next gesture, so the sheet
    // never lurches taller or pops a keyboard the user didn't ask for. Because
    // nothing is focused, a later keyboard dismiss reads as a re-collapse.
    setMode("input");
    preFocusCollapsedRef.current = true;
    detentHaptic();
    if (reduce) {
      stopOpenProgressAnimation();
      openProgress.set(1);
    } else animateOpenProgress(1);
    // A stale thread-focus intent (queued by an earlier maximize/settle whose
    // sheetOpen edge never consumed it) would fire on the NEXT open and steal
    // focus the user never requested — this tap's endpoint is the unfocused
    // input bar, so void any queued intent.
    focusThreadRef.current = false;
  }, [openProgress, reduce, stopOpenProgressAnimation, animateOpenProgress]);

  // --- Pull gesture --------------------------------------------------------
  // The grabber is the draggable handle. A live drag sets the threadHeight motion
  // value DIRECTLY (no React state → no re-render per frame, so it tracks the
  // finger 1:1); release fires onPullUp/onPullDown (distance OR velocity, via
  // usePullGesture) to snap to a detent.
  //
  // FOLLOW-THE-POINTER CONTRACT. The drag is a clamped per-frame integrator
  // over ONE continuum coordinate `cont`:
  //
  //   -PILL_OPEN_DISTANCE ─ pill capsule
  //                     0 ─ input bar (openProgress 1, thread height 0)
  //        insetPanelMaxH ─ inset FULL detent
  //          fullPanelMaxH ─ edge-to-edge full-bleed ceiling
  //
  // Every pointer frame adds the frame's delta and clamps at both ends, so
  // travel past an edge is CONSUMED (never banked) and a reversal moves the
  // sheet on its very first pixel — an up-down-up mouse drag cannot drift out
  // of sync with the cursor. Nothing springs while the finger is down: the
  // morphs (openProgress, threadHeight, fullBleedT) are pure functions of
  // `cont`, and the only mid-drag React state change is the maximize flag at the
  // reversible 90% snap line. Release intent
  // (flick/detent/maximize/pill) lives in the onPull*/onSettleFree handlers.
  const onDragOffset = React.useCallback(
    (offset: number) => {
      // Onboarding pins the sheet at FULL: the live drag must not move it.
      if (pinnedOpen) return;
      if (!draggingRef.current) {
        stopThreadAnimation();
        stopOpenProgressAnimation();
        // Hand the shape morph to the finger — stop any in-flight settle spring
        // so a fresh over-pull tracks 1:1 instead of fighting a decay.
        stopFullBleedAnimation();
        // Fresh gesture: reset the peak-pull tracker (#13531) and record where
        // the sheet stood when the finger landed.
        maxPullRawRef.current = 0;
        // Seed the continuum from the DERIVED resting pose (detent/free-rest),
        // not the live threadHeight — the sheet visually rests at `baseH`, and
        // reading the motion value would pick up a mid-flight settle spring.
        let startH = baseH;
        // De-slack a capped OPEN sheet: at the FULL detent the thread's
        // flex-basis (baseH = panelMaxH) exceeds what actually fits — the thread
        // is flex-shrunk to the panel. Dragging DOWN would first have to drain
        // that invisible slack before the panel shrank (a ~chrome-px dead zone
        // where the finger moves but the sheet edge doesn't). Snap the seed to
        // the thread's REAL rendered height so a downward drag shrinks the panel
        // 1:1 from the first pixel. No visual change: the panel is already this
        // tall (capped), we only realign the motion value to it.
        if (sheetOpen && typeof document !== "undefined") {
          const threadEl = document.querySelector<HTMLElement>(
            '[data-testid="chat-thread"]',
          );
          const actualThreadH = threadEl?.getBoundingClientRect().height;
          if (
            actualThreadH != null &&
            actualThreadH > 0 &&
            actualThreadH < startH - 2
          ) {
            startH = actualThreadH;
            threadHeight.set(actualThreadH);
          }
        }
        const cont0 = pilled
          ? -PILL_OPEN_DISTANCE
          : sheetOpen
            ? startH
            : // The input bar is the continuum origin; a collapsed rest never
              // carries height.
              0;
        dragContRef.current = cont0;
        dragStartContRef.current = cont0;
        dragStartHRef.current = Math.max(0, cont0);
        // Offsets are measured from pointerdown, so the integrator's origin is
        // 0 — the first delivered frame's whole travel integrates (an rAF-
        // coalesced first move can already carry real distance).
        dragLastOffsetRef.current = 0;
        // Snapshot the gesture's resting pose for same-gesture reversal /
        // cancel settles and for the maximize thresholds (see the refs' docs).
        dragStartModeRef.current = pilled
          ? "pill"
          : !sheetOpen
            ? "input"
            : expanded
              ? "full"
              : "half";
        dragStartFreeHRef.current = freeH;
        pillCommittedMidDragRef.current = false;
        // Reset the measured-top maximize tracking for the fresh gesture. Never
        // seeded pinned: a gesture that starts at the ceiling (a restore grab)
        // is fully described by rawOverpullT — a pinned seed would misread the
        // whole downward track as measuredOverpullT = 1.
        const el0 = getPanelElement();
        dragMinTopRef.current = el0
          ? el0.getBoundingClientRect().top
          : Number.POSITIVE_INFINITY;
        dragPinnedRef.current = false;
        dragOffAtPinRef.current = 0;
        dragPinTopRef.current = 0;
        // Clear any stale pin fraction from a prior gesture; this frame re-sets it
        // from the fresh over-pull below.
        overpullCapT.set(0);
      }
      draggingRef.current = true;
      // Promote the panel + thread to their own GPU layer for the duration of
      // the drag (dropped on settle) so the live morph composites instead of
      // repainting per frame on iOS Safari. Skipped under reduced-motion: there
      // is no settle spring to composite, and the async clear below only runs on
      // the animated release path.
      if (!reduce) setDraggingState(true);
      // Integrate this frame's travel and clamp at the continuum edges. The
      // clamp IS the consumption: the next frame integrates from the clamped
      // value, so beyond-the-edge travel evaporates instead of becoming debt a
      // reversal must pay back before the sheet moves.
      const dy = offset - dragLastOffsetRef.current;
      dragLastOffsetRef.current = offset;
      const cont = Math.min(
        fullPanelMaxH,
        Math.max(-PILL_OPEN_DISTANCE, dragContRef.current + dy),
      );
      dragContRef.current = cont;
      // Apply the morphs — each a pure function of `cont`, all finger-locked.
      // Below 0 the travel is the input↔pill morph (the input scales down into
      // the capsule and crossfades out under the finger — in BOTH directions);
      // above 0 it is the thread height.
      openProgress.set(cont < 0 ? clamp01(1 + cont / PILL_OPEN_DISTANCE) : 1);
      const restorePinnedInsideSlop =
        restoreGestureRef.current && !restoreDidEngageRef.current;
      if (!restorePinnedInsideSlop) {
        // The live grabber owns height for the whole held gesture, including
        // the last 10% into full-screen and a same-gesture reversal. A restore
        // gesture is the sole exception for its tiny accidental-wobble slop.
        threadHeight.set(Math.max(0, cont));
      }
      // Mount the panel body on ANY pull that opens height, even with no
      // history yet, so the sheet follows the finger on a brand-new/empty chat
      // too (else it just darkened the scrim and sprang back — the "won't
      // drag" bug). Focus-to-open stays gated in `expand` so boot never
      // auto-pops an empty sheet.
      if (!sheetOpen) setDragPreviewMounted(cont > 0);
      // MAXIMIZE MORPH. Raw height keeps the sheet finger-locked through the
      // inset-FULL → edge-to-edge gap. The measured top-edge latch fills the
      // gap for short-content chats whose panel visually pins at its content
      // ceiling before the raw height has consumed the whole morph budget.
      const rawOverpullT = clamp01((cont - insetPanelMaxH) / maxOverPull);
      let measuredOverpullT = 0;
      let measuredPanelH = 0;
      let measuredPanelTop: number | null = null;
      // The latch only makes sense while the gesture is net-ABOVE its start —
      // a descending drag (a restore, or a pull-shut) is fully described by
      // rawOverpullT and must never re-engage the measured pin.
      if (cont > 0 && cont > dragStartContRef.current) {
        const el = getPanelElement();
        const rect = el?.getBoundingClientRect();
        const top = rect?.top ?? null;
        measuredPanelH = rect?.height ?? 0;
        measuredPanelTop = top;
        if (top != null) {
          if (!dragPinnedRef.current) {
            // Still rising: track the lowest (highest-on-screen) top reached.
            if (top < dragMinTopRef.current - 1) {
              dragMinTopRef.current = top;
            } else if (
              dy > 0 &&
              // The panel top has stopped rising while the finger keeps pulling
              // up AND the panel is TALL (top high on screen) → pinned at the
              // inset-full ceiling. Testing the ABSOLUTE top position (not "rose
              // ≥24px from the gesture start") is what makes this fire when the
              // drag BEGINS already at the ceiling — a pull up from the FULL
              // detent, where the panel cannot rise further on its own. Without
              // it the over-pull never engaged: the panel froze at the ceiling
              // until the finger went far past the screen top (the reported
              // "freezes at ~90%, have to drag beyond the screen to maximize").
              // `top > 2` keeps a gesture that BEGINS at the edge-to-edge
              // ceiling (a restore grab) from latching on its first frame.
              top < viewportH * 0.35 &&
              top > 2
            ) {
              // Latch the over-pull phase from here: further finger travel now
              // collapses the top margin (fullBleedT) 1:1, top pin→0.
              dragPinnedRef.current = true;
              dragOffAtPinRef.current = cont;
              dragPinTopRef.current = Math.max(1, dragMinTopRef.current);
            }
          }
          if (dragPinnedRef.current) {
            measuredOverpullT = clamp01(
              (cont - dragOffAtPinRef.current) /
                Math.max(1, dragPinTopRef.current),
            );
            // Reversed back below the pin → drop the over-pull phase.
            if (cont < dragOffAtPinRef.current - 4) {
              dragPinnedRef.current = false;
              dragMinTopRef.current = top;
            }
          }
        }
      }
      // Restore is the exact inverse of the pinned maximize segment. Its
      // continuum is intentionally de-slacked to the rendered thread height,
      // so deriving shape from `cont - insetPanelMaxH` collapses the whole
      // radius/width/rim morph on the first downward frame. Instead, unwind the
      // same real top-margin distance directly from the restore pointer travel.
      // Height and shape therefore leave fullscreen together, one pixel for one
      // pixel, without swapping visual owners under the held finger.
      const restoreOverpullT = restoreGestureRef.current
        ? clamp01(1 - Math.max(0, -offset) / maxOverPull)
        : null;
      const overpullT = maximizeAllowed
        ? (restoreOverpullT ?? Math.max(rawOverpullT, measuredOverpullT))
        : 0;
      // The snap line is a TOP-edge contract: once the window reaches the top
      // 10% of the viewport, it fills the rest. Include the small safe-area gap
      // below the bottom-anchored panel in this reach measurement; comparing the
      // panel's box height alone could miss 90% by a few pixels even though its
      // top had visibly crossed the line.
      const measuredPanelReach =
        measuredPanelH > 0 && measuredPanelTop != null
          ? viewportH - Math.max(0, measuredPanelTop)
          : 0;
      const livePanelH = Math.max(
        measuredPanelH,
        measuredPanelReach,
        Math.max(0, cont),
      );
      const crossedFullscreenLine =
        fullscreenCrossContRef.current != null
          ? cont >=
            fullscreenCrossContRef.current - FULLSCREEN_RELEASE_HYSTERESIS_PX
          : livePanelH >= fullscreenSnapH;
      if (dy > 0 && livePanelH > maxPullRawRef.current) {
        maxPullRawRef.current = livePanelH;
      }
      // Feed the finger's over-pull to the height cap so it lifts through the
      // inset-ceiling flex-overshoot dead zone (where `cont < insetPanelMaxH` yet
      // the panel is already pinned at the ceiling) — the panel edge keeps
      // tracking the finger instead of freezing until `cont` clears the ceiling.
      overpullCapT.set(overpullT);
      // Height and shape share the same held-gesture owner. Letting the 90%
      // state flip start an independent spring made the outer fieldset reach
      // viewport height before its painted/content box, exposing a large floor
      // strip until pointer-up. A restore remains pinned inside its top band;
      // once it exits that band the finger owns the reverse morph too.
      if (!restorePinnedInsideSlop) fullBleedT.set(overpullT);
      // The state boundary mounts the full-screen restore affordance and chooses
      // the resting endpoint. It does not take animation authority from a held
      // pointer; release settles the live values to the committed endpoint.
      // A real keyboard blocks maximize (the edge-to-edge panel would spill above
      // the keyboard-shrunk visual viewport); a pull-to-full with the keyboard up
      // settles at the inset FULL detent instead.
      if (
        crossedFullscreenLine &&
        maximizeAllowed &&
        !maximizedRef.current &&
        fullscreenCrossContRef.current == null &&
        !restoreGestureRef.current &&
        !keyboardBlocksMaximize
      ) {
        fullscreenCrossContRef.current = cont;
        setFreeH(null);
        setMode("full");
        setMaximized(true);
        // Sync the live mirrors — the release can run before React flushes.
        modeRef.current = "full";
        freeHRef.current = null;
        maximizedRef.current = true;
        maximizeReversedRef.current = false;
        focusThreadRef.current = true;
        detentHaptic();
      } else if (
        !crossedFullscreenLine &&
        // React may not have committed `maximized` before a coalesced pointer
        // stream reverses. The synchronous crossing ref is the authoritative
        // proof that this gesture entered full-screen and must now relinquish
        // its peak instead of re-maximizing on release.
        maximizedRef.current &&
        // A RESTORE drag owns its own visible-height crossing in onRestoreDrag;
        // this branch is only for a same-gesture reversal on the grabber. Letting
        // it also fire here
        // un-maximized on the restore's very first frame — before the strip's
        // slop branch could set restoreDragging/restoreDidEngageRef — so
        // the release discarded the drag and snapped back to FULL.
        !restoreGestureRef.current
      ) {
        setMaximized(false);
        maximizedRef.current = false;
        maximizeReversedRef.current = true;
        // Restore the gesture's STARTING pose: the mid-drag commit flipped
        // mode to "full" (and cleared freeH); leaving that in place made a
        // cancel settle at FULL instead of the detent the drag began on, and
        // misread the maximize thresholds for the rest of the gesture.
        setMode(dragStartModeRef.current);
        setFreeH(dragStartFreeHRef.current);
        modeRef.current = dragStartModeRef.current;
        freeHRef.current = dragStartFreeHRef.current;
        fullscreenCrossContRef.current = null;
        // Void the peak so the release decision does not re-maximize from an
        // abandoned high-water mark.
        maxPullRawRef.current = 0;
      }
      // MID-DRAG PILL COMMIT — the downward mirror of the maximize commit
      // (matrix "Mid-drag commit" table): an open-sheet drag carried
      // PILL_COMMIT_OVERSHOOT past the bottom — or an input-start drag whose
      // input→pill morph crossed halfway — flips the resting state to the PILL
      // under the held finger; the release then just settles where this
      // landed. No explicit reversal branch is needed: once `pilled`, the
      // gesture IS a pill-open drag and every pilled release path (flick, tap,
      // free settle) already lands it correctly if the finger pulls back up.
      const pillCommitCont =
        dragStartHRef.current > 0
          ? -PILL_COMMIT_OVERSHOOT
          : -PILL_OPEN_DISTANCE / 2;
      if (
        !pilled &&
        cont <= pillCommitCont &&
        !pillCommittedMidDragRef.current
      ) {
        setFreeH(null);
        setMaximized(false);
        setMode("pill");
        // Sync the live mirrors + the commit flag: the release handlers run in
        // the same event and must see the committed pill, not the stale mode.
        modeRef.current = "pill";
        freeHRef.current = null;
        pillCommittedMidDragRef.current = true;
        inputRef.current?.blur();
        detentHaptic();
      }
    },
    [
      pinnedOpen,
      pilled,
      sheetOpen,
      baseH,
      insetPanelMaxH,
      fullPanelMaxH,
      maxOverPull,
      viewportH,
      fullscreenSnapH,
      expanded,
      freeH,
      threadHeight,
      openProgress,
      fullBleedT,
      overpullCapT,
      reduce,
      setDraggingState,
      stopThreadAnimation,
      stopOpenProgressAnimation,
      stopFullBleedAnimation,
      setDragPreviewMounted,
      getPanelElement,
      keyboardBlocksMaximize,
      maximizeAllowed,
    ],
  );

  // Release-time mirror of the live 90% crossing. This catches coalesced pointer
  // streams whose final sample and pointer-up arrive in the same browser turn.
  // Preserve the one-gesture PILL→screen-top throw too: its first 120px unfold
  // the input, so the panel can finish just shy of 90% even though the finger
  // traversed the whole viewport. That legacy long-haul intent still fills the
  // screen on release; ordinary window drags use the visible 90% line.
  const maybeMaximizeOnRelease = React.useCallback((): boolean => {
    if (!maximizeAllowed) return false;
    if (pinnedOpen) return false;
    if (maximizeReversedRef.current) return false;
    // A real keyboard blocks the release-time maximize too (mirrors the mid-drag
    // gate): a pull-to-full with the keyboard up settles at the inset FULL detent
    // instead of an edge-to-edge maximize that would spill above the visible area.
    if (keyboardBlocksMaximize) return false;
    const peak = maxPullRawRef.current;
    const longHaulFromBottom =
      dragLastOffsetRef.current >= viewportH * 0.8 &&
      dragContRef.current >= halfH;
    if (peak >= fullscreenSnapH || longHaulFromBottom) {
      focusThreadRef.current = true;
      maximizeFromPull();
      return true;
    }
    return false;
  }, [
    maximizeAllowed,
    pinnedOpen,
    keyboardBlocksMaximize,
    viewportH,
    halfH,
    fullscreenSnapH,
    maximizeFromPull,
  ]);

  const pullBinding: PullGestureBinding = usePullGesture({
    preventTouchCompatibilityEvents: true,
    onStart: resetPullPeak,
    onDrag: onDragOffset,
    onDragReset: settleDrag,
    // A sideways drag dismisses an open chat to the pill. The collapsed
    // composer still classifies and consumes the track so a coalesced horizontal
    // release cannot masquerade as a tap, but it performs no navigation now
    // that Home and apps share one surface.
    swipeEnabled: true,
    onSwipeLeft: () => {
      settleDrag();
      if (sheetOpen) collapseToPill();
    },
    onSwipeRight: () => {
      settleDrag();
      if (sheetOpen) collapseToPill();
    },
    // Flicks step one detent; released drags from the collapsed input honor the
    // live height so a long pull can land full instead of snapping back to half.
    // The inline closures are rebuilt every render, so they always read the
    // current detent.
    onPullUp: () => {
      setDragPreviewMounted(false);
      // Read the pill state through the mid-drag commit flag too: the commit
      // can flip mode in the SAME event as this release, before React flushes
      // the closure's `pilled`.
      if (pilled || pillCommittedMidDragRef.current) {
        // PILL → open: a flick up opens; a HELD drag released with flick
        // velocity honors how far the finger actually carried the sheet — a
        // long pull from the pill lands FULL (or commits maximize past the 90%
        // threshold), a short flick lands HALF, so pill → input → chat →
        // full-screen is one continuum from the very bottom. Releasing
        // draggingRef first lets the pilled→openProgress effect spring the
        // morph 0→1.
        draggingRef.current = false;
        if (maybeMaximizeOnRelease()) return;
        const releasedH = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (releasedH < SHEET_DETENT_MAGNET && !hasRevealableThread) {
          // A short flick with no thread to open into → the bare input bar.
          setMode("input");
          if (reduce) {
            stopThreadAnimation();
            threadHeight.set(0);
          } else animateThreadHeight(0);
          detentHaptic();
          return;
        }
        focusThreadRef.current = true;
        goToDetent(releasedH >= halfH + SHEET_DETENT_MAGNET ? "full" : "half");
        return;
      }
      // Crossing the 90%-viewport threshold maximizes from ANY open state
      // (#13531) — this must win before the per-state detent settle below.
      if (maybeMaximizeOnRelease()) return;
      if (!sheetOpen) {
        // A committed pull-up opens even an empty chat (no early spring-back on
        // `!hasRevealableThread`) — the deliberate drag is the user asking to
        // open; `expand` still guards the passive focus-to-open path.
        const releasedH = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (releasedH >= halfH + SHEET_DETENT_MAGNET) {
          goToDetent("full");
        } else {
          goToDetent("half");
        }
        focusThreadRef.current = true;
      } else if (!expanded) {
        goToDetent("full");
        focusThreadRef.current = true;
      } else {
        settleDrag();
      }
    },
    onPullDown: () => {
      setDragPreviewMounted(false);
      // Onboarding: a pull-down must not step the pinned HALF sheet down.
      if (pinnedOpen) return settleDrag();
      // Already the lowest detent (incl. a same-event mid-drag pill commit
      // React hasn't flushed into the closure yet).
      if (pilled || pillCommittedMidDragRef.current) return settleDrag();
      if (sheetOpen) {
        // Step down from the LIVE height, so a flick and a held-drag-then-flick
        // both land where the finger left the sheet: a plain flick (height
        // barely moved) steps ONE detent — full → half → input, never skipping;
        // a held drag carried to the bottom released with downward velocity
        // lands at the bottom (pill/input by collapseFromRelease), not bounced
        // back up to a detent it deliberately left. A downward flick also
        // closes the keyboard — goToDetent("collapsed") blurs; half-step too.
        const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
        if (h <= SHEET_DETENT_MAGNET) return collapseFromRelease();
        if (h > halfH + 1) {
          inputRef.current?.blur();
          goToDetent("half");
        } else {
          goToDetent("collapsed");
        }
        return;
      }
      // INPUT → PILL: collapse the input away into a pill at the bottom.
      collapseToPill();
    },
    // A tap (no drag) on the handle. A tap on the PILL brings the input back —
    // one step only: no thread detent, no keyboard (openFromPill).
    // When OPEN, the grabber acts as a disclosure toggle: tap once to close.
    // When COLLAPSED, tap opens the thread or its loader; thread-less chats focus
    // the composer because there is nothing above the input to reveal.
    onTap: () => {
      if (pilled) {
        openFromPill();
        return;
      }
      if (sheetOpen) {
        if (composerFocusedAtPressRef.current) {
          composerFocusedAtPressRef.current = false;
          dismissKeyboardToPriorState();
          return;
        }
        collapse();
        return;
      }
      openFromGrabber();
    },
    // A deliberate (slow) drag: REST exactly where released instead of snapping
    // to a detent — drag the sheet to any size and it stays.
    onSettleFree: (direction) => {
      draggingRef.current = false;
      // Onboarding: a released drag always springs back to the pinned HALF.
      if (pinnedOpen) return settleDrag();
      // Include a same-event mid-drag pill commit (see onPullUp).
      if (pilled || pillCommittedMidDragRef.current) {
        // From the pill: a slow drag under the halfway-open mark (openProgress
        // < 0.5) springs back to the capsule; past it we commit to LEAVING the
        // pill — but we must NOT force the half detent. A short pull only forms
        // the input bar (threadHeight stays ~0 until the drag exceeds
        // PILL_OPEN_DISTANCE), so clear `pilled` and FALL THROUGH to the shared
        // detent magnetism below: a release near the input (threadHeight within
        // SHEET_DETENT_MAGNET of 0) settles at the INPUT state, and only a pull
        // that actually reached up into the thread opens to half/full. This is
        // what makes pill → input → chat one continuum instead of skipping the
        // input state straight to half on a short slow pull.
        const opened = direction === "up" && openProgress.get() >= 0.5;
        if (!opened) {
          settleDrag(); // springs openProgress → 0 (mode stays "pill") + thread → 0
          return;
        }
        // Leaving the pill: fall through to the magnetism below, which sets the
        // mode (input / half / full) from where the drag was released — so pill →
        // input → chat reads as one continuum.
        if (hasRevealableThread) focusThreadRef.current = true;
      }
      // From the collapsed input, a downward drag has nothing to "size" below
      // it. Require the input→pill morph to cross halfway before committing;
      // small thumb drift should spring back to the input, not collapse the
      // chat. (Open-sheet drags that reach the bottom land via the magnetism
      // below — collapseFromRelease picks pill vs input.)
      if (!sheetOpen && direction === "down") {
        if (dragContRef.current <= -PILL_OPEN_DISTANCE / 2) collapseToPill();
        else settleDrag();
        return;
      }
      // A slow upward pull past the 90%-viewport threshold maximizes
      // (#13531), even though the visible height rubber-banded at FULL — the
      // peak visible height (maxPullRawRef) carries the intent. Downward restore drags
      // must not re-enter full-bleed, even if a previous upward peak was visible
      // before the release settled.
      if (direction === "up" && maybeMaximizeOnRelease()) {
        setDragPreviewMounted(false);
        return;
      }
      const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
      // DETENT MAGNETISM — the resting positions are the detents {collapsed:0,
      // half, full}; a release within SHEET_DETENT_MAGNET of one snaps to it
      // (deterministic, no janky near-detent slivers), and only the clear gaps
      // between them keep the free-drag rest height. goToDetent commits the
      // honest flags so data-detent + the maximize header match the height.
      if (h <= SHEET_DETENT_MAGNET) {
        // Near the bottom → pill or input by gesture intent.
        collapseFromRelease();
        return;
      }
      focusThreadRef.current = true;
      if (h >= openH - SHEET_DETENT_MAGNET) {
        setDragPreviewMounted(false);
        goToDetent("full");
      } else if (Math.abs(h - halfH) <= SHEET_DETENT_MAGNET) {
        setDragPreviewMounted(false);
        goToDetent("half");
      } else {
        // In a gap between detents → rest exactly where released. `half` is the
        // open base; `freeH` overrides the actual height to where the finger
        // left. This leaves FULL without goToDetent, so drop full-bleed here
        // too — only the FULL detent may stay maximized (a stale flag would
        // re-maximize the next return to full).
        setDragPreviewMounted(false);
        setFreeH(h);
        setMode("half");
        setMaximized(false);
      }
    },
  });
  // Latch a press on the open-sheet grabber so its mount gate can't drop the
  // captured pointer between pointerdown and the integrator's first frame.
  const grabberBinding = React.useMemo(
    () => withPressLatch(pullBinding, grabberPressRef),
    [pullBinding],
  );

  // Top-bar pull-down-to-restore (#13531). While maximized (full-bleed) there is
  // no SheetGrabber; this binding drives the generous invisible top grab zone.
  // A deliberate downward pull drops full-bleed after a few pixels and then
  // LIVE-TRACKS the finger — the panel insets and shrinks 1:1 under the
  // pointer, resting where released (free rest, with detent magnetism at
  // half/full and a full collapse near the bottom). Keyboard (Enter/Space/
  // ArrowDown) does the discrete restore. Onboarding pins the sheet, so the zone
  // is never rendered during first-run (guarded anyway for safety).
  const restoreFromMaximizedGuarded = React.useCallback(() => {
    if (pinnedOpen) return;
    restoreFromMaximized();
  }, [pinnedOpen, restoreFromMaximized]);
  // Live drag: reuse the shared drag math (onDragOffset) so the panel tracks
  // the finger identically to a grabber drag — the height AND the edge-to-edge
  // ↔ inset shape morph (a pure function of the height in onDragOffset) both
  // run 1:1 under the pointer. The only extra step is dropping full-bleed the
  // moment the pull turns downward, so the inset layout is what follows the
  // finger; an upward hold leaves `maximized` set and rubber-bands at the
  // full-bleed ceiling.
  const onRestoreDrag = React.useCallback(
    (offset: number) => {
      if (pinnedOpen) return;
      // Fresh gesture (onDragOffset flips draggingRef on its first frame).
      if (!draggingRef.current) {
        restoreDidEngageRef.current = false;
        fullscreenCrossContRef.current = null;
      }
      // Claim the gesture BEFORE delegating so the integrator's own over-pull
      // hysteresis stands down — this strip owns the un-maximize (see
      // restoreGestureRef).
      restoreGestureRef.current = true;
      const downwardTravel = Math.max(0, -offset);
      if (
        !restoreDidEngageRef.current &&
        downwardTravel > RESTORE_UNMAX_SLOP_PX
      ) {
        fullscreenCrossContRef.current = null;
        // Flip the synchronous owners before the shared integrator runs this
        // frame. It can therefore apply the coalesced first move immediately,
        // with no viewport-sized dead zone. The committed maximize bit stays
        // stable until release, so no second handle or alternate render tree can
        // enter while this pointer owns the restore strip.
        restoreDidEngageRef.current = true;
        setRestoreDragging(true);
        maxPullRawRef.current = 0;
      }
      onDragOffset(offset);
    },
    [pinnedOpen, onDragOffset],
  );
  // Release from a restore drag: if it never un-maximized (an upward/stationary
  // gesture) keep it pinned full-bleed; otherwise settle at the released height —
  // free rest, snap to a nearby detent, or collapse near the bottom (the same
  // magnetism the grabber uses).
  const settleRestore = React.useCallback(() => {
    draggingRef.current = false;
    restoreGestureRef.current = false;
    setDragPreviewMounted(false);
    setRestoreDragging(false);
    if (pinnedOpen || !restoreDidEngageRef.current) return settleDrag();
    // A restore that un-maximized always lands on the inset shape; drive the
    // morph home (0) so a release mid-return finishes un-morphing the edges.
    animateFullBleedTo(0);
    // The live pin fraction is finger-only; hand the cap back to the settle springs.
    overpullCapT.set(0);
    const h = Math.max(0, Math.min(threadHeight.get(), panelMaxH));
    if (h <= SHEET_DETENT_MAGNET) {
      // A restore pull released close to the bottom lands on the INPUT bar.
      // Starting from MAXIMIZED must not itself mean "put the whole chat away";
      // only an actual overshoot into the input→pill morph may reach the pill.
      collapseFromRelease(false);
      return;
    }
    focusThreadRef.current = true;
    if (h >= openH - SHEET_DETENT_MAGNET) {
      goToDetent("full");
    } else if (Math.abs(h - halfH) <= SHEET_DETENT_MAGNET) {
      goToDetent("half");
    } else {
      setFreeH(h);
      setMode("half");
      setMaximized(false);
    }
  }, [
    pinnedOpen,
    settleDrag,
    threadHeight,
    panelMaxH,
    openH,
    halfH,
    collapseFromRelease,
    goToDetent,
    animateFullBleedTo,
    overpullCapT,
    setDragPreviewMounted,
  ]);
  // Cancel/tap on the strip: drop the drag flag and spring back to the current
  // detent (a tap keeps it maximized; a rotation-canceled drag re-settles).
  const resetRestore = React.useCallback(() => {
    restoreGestureRef.current = false;
    setRestoreDragging(false);
    settleDrag();
  }, [settleDrag]);
  const maximizeRestoreBinding: PullGestureBinding = usePullGesture({
    onStart: resetPullPeak,
    // Sideways swipe on the maximize grab strip dismisses the chat to the
    // pill — the same drag-the-chat-away gesture the open-sheet grabber owns
    // (fullBleed is derived from mode, so its settle animation unwinds the
    // full-bleed frame on the flip). Never nav: the chat is full-screen here.
    swipeEnabled: true,
    onSwipeLeft: () => {
      restoreGestureRef.current = false;
      setRestoreDragging(false);
      collapseToPill();
    },
    onSwipeRight: () => {
      restoreGestureRef.current = false;
      setRestoreDragging(false);
      collapseToPill();
    },
    onDrag: onRestoreDrag,
    onDragReset: resetRestore,
    // Flick or slow-release both settle at the current finger height.
    onPullUp: settleRestore,
    onPullDown: settleRestore,
    onSettleFree: settleRestore,
    // A pointercancel / lost capture (rotation, OS takeover) must NOT strand
    // `restoreDragging` true — that would keep the panel max-height full-screen
    // and break the next open. Settle it like any other release.
    onCancel: settleRestore,
  });
  // Latch a press on the restore strip. Without this the strip can unmount under
  // its own captured pointer the instant the drag drops full-bleed (before
  // `restoreDragging` has re-mounted it), stranding the release: `settleRestore`
  // never runs, so `restoreDragging`/`draggingRef` stay true and freeze the
  // sheet — the corrupted state the desktop-held drain leg then trips over.
  const restoreZoneBinding = React.useMemo(
    () => withPressLatch(maximizeRestoreBinding, restorePressRef),
    [maximizeRestoreBinding],
  );

  // NOTE: outside pointerdown only drops the keyboard. Outside TAP collapse is
  // handled by the document-level tap detector above so drag gestures can still
  // pass through the visual backdrop to the launcher/home surface underneath.

  // The sheet's EFFECTIVE detent, shared by `data-detent` (DOM/e2e channel) and
  // the sr-only probe below (accessibility-tree channel — data attributes are
  // invisible to the native iOS/Android AX tree, so the on-device XCUITest
  // gesture suite reads this as a static text instead; see
  // packages/app-core/platforms/ios/App/AppUITests/GestureSemanticsUITests.swift).
  // A free-rest at/near the top reads "full", a mid free-rest folds into
  // "half" — the label never disagrees with the rendered height.
  const detentLabel = pilled
    ? "pill"
    : !sheetOpen
      ? "collapsed"
      : // Onboarding is pinned at the shared half-height chat detent even when
        // a stale freeH value remains from a prior interaction.
        firstRunOpen
        ? "half"
        : freeH != null
          ? Math.min(freeH, panelMaxH) >= openH - 1
            ? "full"
            : "half"
          : expanded
            ? "full"
            : "half";

  React.useEffect(() => {
    onDetentChange?.(detentLabel === "collapsed" ? "input" : detentLabel);
  }, [detentLabel, onDetentChange]);

  // Onboarding-state probe: the newest first-run CHOICE turn's step id + option
  // values, surfaced as sr-only static AX text (mirrors chat-detent-probe /
  // home-launcher-page-probe) so an on-device XCUITest can observe and drive
  // first-run deterministically even where the WKWebView AX tree is imperfect.
  const firstRunProbe = React.useMemo(() => {
    if (!firstRunOpen) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const region = findChoiceRegions(messages[i].content).find(
        (r) => r.scope === "first-run" || r.scope.startsWith("first-run"),
      );
      if (region) {
        return {
          step: region.id,
          choices: region.options.map((o) => o.value).join(","),
        };
      }
    }
    return null;
  }, [firstRunOpen, messages]);

  // Native material only for the OPEN sheet at TRUE rest (finger up AND the
  // release spring finished — `sheetSettled`). Any motion reports a CSS tier
  // on the same render, so the frost never lags the finger, and the anchor
  // hook holds its CSS tier until BOTH the wallpaper and the region are
  // acknowledged natively — no transparent frame at either handoff edge.
  // Full-bleed stays opaque web paint (nothing to see through). Onboarding uses
  // this same inset composer material. iOS-only inside the hook (see its header).
  const nativeSheetTier = useNativeGlassAnchor(glassSurfaceRef, {
    enabled:
      sheetOpen &&
      sheetSettled &&
      !isDragging &&
      !restoreDragging &&
      !fullBleed,
    // The chat sheet is dark chrome even when the device appearance is light.
    // Match its native UIGlassEffect to the DOM fallback so the material never
    // becomes a bright slab over the conversation.
    colorScheme: "dark",
    // Native glass without a tint is transparent enough for home cards and
    // their text to compete with the conversation. Preserve refraction while
    // giving the sheet the same dark-warm reading field as the CSS fallback.
    tintColor: NATIVE_GLASS_DARK_TINT,
  });
  const nativeInsetSheet = nativeSheetTier === "native";
  // Why-not-native, as a slug (glass/native-backdrop.ts) — the observable
  // half of the tier system's J4 degrades, rendered into the AX probe below.
  const nativeGlassDiag = useNativeGlassDiag();

  return (
    <motion.div
      ref={overlayRef}
      className={cn(
        "pointer-events-none fixed inset-x-0 bottom-0 isolate flex w-full min-w-0 flex-col",
        // Resting on a landscape phone, the compact composer hugs the trailing
        // (inline-end) bottom corner — the conventional compose slot views leave
        // free — instead of centering a wide band over their controls (#14173).
        // Direction-aware: `items-end` is inline-end, so it lands bottom-left in
        // RTL. Full-width children (banners) are unaffected (they stay `w-full`).
        compactLanding ? "items-end" : "items-center",
        // The side inset (px) is driven by the shape spring below (`overlayPadX`),
        // not a class, so it eases 12→0 on maximize and 0→12 on de-maximize.
      )}
      // Lift the whole overlay above the on-screen keyboard (`bottom`); padding
      // below the composer is conditional on an actual keyboard lift, not focus
      // alone. With the keyboard up, only a small gap (0.75rem, matching the side
      // margin) sits between composer and keyboard. At rest, clear the
      // home-gesture zone (max safe-area / android inset) plus a hair, keeping the
      // chat low without touching that zone.
      style={{
        zIndex: Z_SHELL_OVERLAY,
        // At rest, the measured reclaim offset seats the composer at the
        // physical bottom on collapsed iOS standalone/native viewports. Off that
        // surface the custom property is zero. When the keyboard is visible,
        // effectiveKeyboardInset owns the lift instead of the reclaim offset.
        bottom: keyboardLiftActive
          ? effectiveKeyboardInset
          : STANDALONE_BOTTOM_RECLAIM_OFFSET,
        // Full-bleed uses no overlay bottom padding; gesture-zone clearance
        // lives inside the composer row so controls sit above the home indicator.
        // Non-full-bleed keeps the same safe-area clearance above the reclaimed
        // physical bottom, with the wallpaper/app floor owning everything below.
        // Side inset eases with the shape spring (12px inset → 0 at full-bleed).
        paddingLeft: overlayPadX,
        paddingRight: overlayPadX,
        // Bottom clearance: the keyboard-lift gap wins when the keyboard is up;
        // else, only WHILE maximizing/restoring does the composer inset ease with
        // the shape spring (its value equals the plain rest inset at the boundary,
        // so the switch is seamless) — at rest it stays the plain calc so the
        // home-indicator clearance contract is exact.
        paddingBottom: keyboardLiftActive
          ? `${KEYBOARD_COMPOSER_GAP_PX}px`
          : fullBleed || restoreDragging || isDragging
            ? overlayPadBottom
            : "calc(var(--eliza-mobile-nav-offset, 0px) + max(var(--safe-area-bottom, 0px), var(--android-gesture-inset-bottom, 0px)) + 0.5rem)",
      }}
      data-testid="chat-overlay"
      data-chat-overlay=""
      data-chat-gesture-surface=""
      data-open={sheetOpen ? "true" : undefined}
    >
      {/* NO reclaimed-bottom-floor element here (removed): it used to paint a
          transparent→var(--launch-bg) gradient over the strip below the
          composer, from when that strip was an UNPAINTED void that read as a
          dead black bar. The app shell now guarantees that zone is always
          painted underneath this overlay — the full-bleed wallpaper on
          shared-background routes (the transparent app-safe-area-floor lets it
          own the screen to the true bottom edge) and the dark `bg-bg` floor on
          opaque routes. Repainting it here with --launch-bg (a HOST-seeded
          launch color, orange on web) drew a visible tinted band over the
          wallpaper under the floating composer — the residual "gap" on the
          standalone home view. Everything below the composer must simply show
          whatever the shell paints: wallpaper, lockscreen-style. */}
      {/* Structural inset-0 marker behind the open chat. It NO LONGER dims the
          background — pulling the chat up used to darken everything behind it,
          which fought the frosted-glass panel; the panel's own backdrop blur now
          carries the separation, so the live view stays bright behind the glass.
          Kept as a transparent, pointer-transparent element (outside taps are
          owned by the document-level detector; e2e uses it as a coordinate
          target) with the same data-active flag consumers read. */}
      <motion.div
        aria-hidden="true"
        data-testid="chat-sheet-backdrop"
        data-active={sheetOpen ? "true" : "false"}
        className="fixed inset-0"
        style={{
          visibility: scrimVisibility,
          pointerEvents: "none",
        }}
      />

      {ttsError ? (
        <div className="pointer-events-auto relative mb-2 w-full max-w-3xl">
          <ChatVoiceStatusBar status="idle" ttsError={ttsError} visible />
        </div>
      ) : null}

      {/* Audio-unlock prompt. When autoplay policy blocks the first spoken
          reply, the ambient overlay would otherwise go silent with no recourse
          (the in-view status bar has its own unlock; this is the floating-shell
          equivalent). Warm accent = call-to-action; no blue. */}
      {needsAudioUnlock &&
      !realtimeVoiceComposerVisible &&
      !realtimeVoice?.error ? (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none relative mb-2 flex w-full justify-center"
        >
          <Button
            variant="warningOutline"
            size="pillDense"
            onClick={unlockAudio}
            data-testid="overlay-voice-audio-unlock"
            className={cn("pointer-events-auto", WALLPAPER_FLOAT_SHADOW)}
          >
            <Glyph d={SPEAKER_MUTED_GLYPH} />
            <span>Tap to enable sound</span>
          </Button>
        </div>
      ) : null}

      {/* Local model download/load status renders as the home-grid
          model-download widget only — no floating pill above the composer (the
          double status read as clutter). Send stays ungated; the server holds
          the turn until the model is ready. Boot status likewise has NO
          floating surface: a stalled boot speaks in the transcript via the
          boot-recovery conductor (use-boot-recovery-conductor.ts), and the
          in-transcript no-provider gate covers the unconfigured state. */}

      {/* THE chat — one connected object. Its base is the always-present input;
          the conversation grows UP out of it on a pull, inside this same panel.
          The drag handle floats above the panel in THIS non-clipped wrapper
          (the fieldset itself is overflow-hidden), so its big hit zone can reach
          up into the empty space above the input. Pull the handle up to reveal
          history; pull down to collapse the input into the pill. */}
      <motion.div
        // Width is the motion value above (rest: 48rem / 13rem compact-landing
        // #14173; edge-to-edge as the maximize morph completes) so the glass
        // grows in lock-step with the finger instead of popping on commit. The
        // grabber + pill are positioned relative to THIS wrapper, so they
        // shrink and re-corner with it.
        style={{ maxWidth: wrapperMaxW }}
        className="pointer-events-none relative flex w-full flex-col items-center"
      >
        {(!fullBleed && !restoreDragging) || grabberPressRef.current != null ? (
          // Suppressed while full-bleed (the restore strip owns the top) and
          // while a restore drag is in flight (the restore strip keeps that
          // pointer capture). A normal grabber remains mounted through its own
          // mid-drag pill/maximize commit because `grabberPressRef` retains the
          // accepted pointer id until its terminal event. Using the global drag
          // flag here mounted BOTH handles during restore. Onboarding hides the
          // grabber entirely: it is pinned and undismissable during setup.
          <SheetGrabber
            open={sheetOpen}
            onOpen={openFromGrabber}
            onClose={collapse}
            binding={grabberBinding}
            // The handle stays QUIET while the mic is recording — the composer
            // mic/voice glyphs already carry the "capture is hot" pulse right
            // next to the user's attention; a second pulsing bar above them
            // read as noise. Only the collapsed PILL (where no composer glyph
            // is visible) pulses for a live capture — see PillHandle below.
            breathing={(listening || responding) && !recording}
            opacity={grabberOpacity}
            pilled={pilled}
            locked={firstRunOpen}
          />
        ) : null}
        <Card asChild variant="transparentSquare">
          <motion.fieldset
            ref={bindPanelRef}
            aria-label="Chat composer"
            data-testid="chat-sheet"
            onWheel={onSheetWheel}
            data-variant={sheetOpen ? "open" : "closed"}
            data-detent={detentLabel}
            data-maximized={fullBleed ? "true" : undefined}
            data-revealed={threadPresented ? "true" : "false"}
            data-chat-state={chatState}
            data-header-shown={headerVisible ? "true" : "false"}
            data-theme="dark"
            // Preserve the active conversation identity for diagnostics and
            // persistence without exposing thread creation or switching in the
            // canonical one-conversation UI.
            data-conversation-id={conversationNav.activeId ?? undefined}
            data-conversation-index={conversationNav.index}
            // ONE persistent element across pill ↔ input ↔ chat (never remounts —
            // that pop was the core jank). It's a transparent scale/position
            // container; the liquid glass lives in an inner layer faded by
            // openProgress, so pill → input is a continuous scale + crossfade.
            // maxHeight keeps it from spilling off the top (thread scrolls instead).
            style={{
              ...CHAT_PANEL_THEME,
              // The desktop overlay is its own dark product surface. Never let
              // the host appearance, wallpaper, or a light app theme switch its
              // native controls and form affordances into a light color scheme.
              colorScheme: "dark",
              // Morph-driven cap: the inset ceiling at rest, growing to the
              // full-bleed ceiling in lock-step with the shape morph (see
              // panelCapH) so an over-pull grows 1:1 under the finger.
              maxHeight: panelCapH,
              // Resting full-screen needs an explicit height because an intrinsic
              // flexbox can shrink around the composer. During a drag and its
              // release spring, however, the thread/content box is the geometry
              // owner: forcing the outer fieldset to viewport height one frame
              // earlier exposes an unpainted floor below the still-moving content.
              // Returning to `auto` for that whole motion keeps surface, transcript,
              // and composer bottom-anchored as one object; the settled full-screen
              // endpoint switches to the same explicit cap only after they match.
              height: fullBleed && !isDragging ? panelCapH : "auto",
              // Full-bleed must be exactly scale 1 — a sub-1 morph scale with a
              // bottom transform-origin would drop the top edge below the status
              // bar (the "gap at the top when maximized" bug). While open (incl. a
              // restore drag) panelScale is already 1; the height, not a scale,
              // shrinks.
              scale: fullBleed ? 1 : panelScale,
              // Grow UP out of the pill at the bottom.
              transformOrigin: "bottom center",
              // Pilled: span the (invisible) input area but pass taps through to the
              // home screen — only the pill-capsule child re-enables pointer events.
              pointerEvents: pilled ? "none" : "auto",
            }}
            className={cn(
              // overflow-VISIBLE on the outer fieldset: the pill's tall grab zone
              // must bleed past the box. The rounded thread-clip lives on the inner
              // content wrapper instead, so clipping the scroll never clips a hard
              // square edge over the content.
              "relative m-0 flex w-full min-w-0 flex-col overflow-visible p-0",
            )}
          >
            {/* SURFACE — absolute fill; the frosted-glass bg/border + the live
              corner radius. Crossfades in by openProgress (compositor opacity).
              An open native-tier conversation keeps an opaque DOM fill above
              the OS material. Native glass used to replace that fill with
              transparency, which allowed launcher/view controls to remain
              visibly legible through the chat on iPad. The overlay already owns
              the shell's highest application layer; the opaque fill makes that
              paint-order contract visually true as well. */}
            <Card
              asChild
              surface="transparent"
              border="none"
              radius="none"
              visualStyle={{
                WebkitBackdropFilter: "var(--chat-sheet-backdrop-filter, none)",
                backdropFilter: "var(--chat-sheet-backdrop-filter, none)",
                backgroundColor: "var(--chat-sheet-background)",
                backgroundImage: "var(--chat-sheet-image, none)",
                borderRadius: "var(--chat-sheet-radius)",
                boxShadow: "var(--chat-sheet-shadow, none)",
              }}
            >
              <motion.div
                ref={glassSurfaceRef}
                aria-hidden="true"
                data-testid="chat-sheet-surface"
                data-glass-tier={nativeSheetTier}
                className="pointer-events-none absolute inset-0 z-0"
                style={{
                  opacity: glassOpacity,
                  ...({
                    // Corner radius eases with the full-screen shape spring: the inset
                    // sheet radius squares off as it maximizes and rounds back as it
                    // de-maximizes, in lockstep with the side/bottom insets.
                    "--chat-sheet-radius": morphRadius,
                    // Frosted glass at REST, black when OPEN. The resting composer
                    // keeps the token-system glass (`GLASS_SHEET_FILL` +
                    // `GLASS_SHEET_BACKDROP_FILTER` from `glass/tokens.ts`, heavy
                    // neutral blur, no saturate — saturate muddies the warm field to
                    // brown), and the drag-up blends the fill to the opaque panel
                    // `--bg` by the HALF detent (`surfaceBlackout`): the open sheet
                    // reads BLACK over any substrate — bright web pages and the warm
                    // wallpaper both washed the old translucent open sheet. `--card`
                    // / `--bg` are scoped by CHAT_PANEL_THEME on the fieldset, not
                    // the orange app theme behind. Full-bleed stays fully opaque (it
                    // covers the whole screen — there is nothing to see through, and
                    // the blur would be wasted battery).
                    "--chat-sheet-background":
                      firstRunOpen || nativeInsetSheet
                        ? "var(--bg)"
                        : surfaceBackgroundColor,
                    "--chat-sheet-backdrop-filter":
                      firstRunOpen || nativeInsetSheet
                        ? "none"
                        : surfaceBackdropFilter,
                    // The strong perimeter and drag handle own the sheet edge.
                    "--chat-sheet-shadow": "none",
                    "--chat-sheet-image": "none",
                  } satisfies ChatSheetMotionStyle),
                  // Full-bleed: extend the glass UP through the safe-area-top so the
                  // dark background reaches the true top of the screen. The panel
                  // height comes from visualViewport (which excludes the Android
                  // status bar) while the panel sits in a screen-top fixed container,
                  // so without this the glass starts a status-bar-height below the top
                  // (the "safe-area gap" above maximized chat). overflow-visible on the
                  // panel lets it bleed up; content (header, with its own safe-area
                  // padding) is untouched. Rides the shape spring (0px at rest) so
                  // the extension eases in with the morph instead of popping at
                  // commit. Harmless when the inset is 0.
                  top: glassTopExtension,
                }}
              />
            </Card>
            {/* AX-tree mirror of data-detent: the native gesture e2e suites
              (XCUITest) can only observe web state through the accessibility
              tree, and data attributes never surface there. sr-only text does.
              Not aria-live — it never announces on its own. Keep it after the
              visual surface so DOM e2e helpers that inspect the first child
              still read the glass layer. */}
            <span className="sr-only" data-testid="chat-detent-probe">
              {`chat-detent:${detentLabel}`}
            </span>
            {/* AX-tree mirror of data-maximized (#13531). `detentLabel` folds the
              full-bleed MAXIMIZED state into "full" (both rest at the top), so the
              detent probe alone cannot tell them apart — the on-device XCUITest
              maximize/restore leg reads this separate probe to observe whether the
              chat committed to edge-to-edge full-bleed. */}
            <span className="sr-only" data-testid="chat-maximized-probe">
              {`chat-maximized:${fullBleed ? "true" : "false"}`}
            </span>
            {/* AX-tree mirror of data-glass-tier: the on-device XCUITest legs for
              #15891 read this to prove the sheet adopted (or correctly refused)
              the native material at each detent/drag state. The diag suffix
              says WHY a css tier is showing (the observable half of the
              tier system's silent J4 degrades). */}
            <span className="sr-only" data-testid="chat-glass-tier-probe">
              {`chat-glass-tier:${nativeSheetTier} chat-glass-diag:${nativeGlassDiag} chat-glass-gate:o${sheetOpen ? 1 : 0}s${sheetSettled ? 1 : 0}d${isDragging ? 1 : 0}r${restoreDragging ? 1 : 0}b${fullBleed ? 1 : 0}f${firstRunOpen ? 1 : 0}`}
            </span>
            {firstRunProbe ? (
              <span className="sr-only" data-testid="onboarding-state-probe">
                {`onboarding-step:${firstRunProbe.step} onboarding-choices:${firstRunProbe.choices}`}
              </span>
            ) : null}
            {/* CONTENT — sheen, glow, thread, composer. Crossfades with the glass
              and goes fully inert while pilled (opacity 0 + `inert` removes it
              from pointer, tab order, and the a11y tree) so it can't be reached
              behind the pill capsule. */}
            <Card
              asChild
              surface="transparent"
              border="none"
              radius="none"
              visualStyle={{ borderRadius: "var(--chat-sheet-radius)" }}
            >
              <motion.div
                ref={contentRef}
                data-testid="chat-content"
                inert={pilled || undefined}
                // overflow-hidden + the live radius clips the sheen/thread to the
                // panel's rounded shape (the clip the fieldset used to do) WITHOUT
                // touching the sibling glass layer's shadow. Spans the FULL glass
                // width (no maxWidth here): the restore-drag strip (inset-x-0) and
                // the drag-and-drop file intake below both live on this element and
                // must cover the whole panel, including the edge-to-edge glass at
                // full-bleed on wide viewports — a pinned wrapper left dead margins
                // where a restore pull did nothing and a dropped file navigated the
                // tab away. Column width is pinned on the inner rows (header /
                // thread / composer all carry `mx-auto max-w-3xl`), so the chat
                // content never reflows through the maximize morph regardless.
                className="relative z-10 flex min-h-0 w-full flex-col overflow-hidden"
                style={{
                  opacity: glassOpacity,
                  pointerEvents: pilled ? "none" : "auto",
                  // Mirror the surface radius so the content clip matches it.
                  ...({
                    "--chat-sheet-radius": morphRadius,
                  } satisfies ChatSheetMotionStyle),
                  clipPath: contentClipPath,
                  WebkitClipPath: contentClipPath,
                }}
                // Drag-and-drop attachment intake (#10722). The old ChatView chat
                // surface accepted file drops; the overlay replaced it with only
                // paste + the attach button. Dropped files run the SAME intake
                // pipeline as both of those (addImageFiles → intakeAttachmentFiles),
                // so size caps, type support, and the pending-attachment strip all
                // behave identically. dragover must preventDefault for the browser
                // to allow the drop at all; only file drags are claimed so
                // text-selection drags keep their native behavior.
                onDragOver={(event) => {
                  if (event.dataTransfer?.types?.includes("Files")) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "copy";
                  }
                }}
                onDrop={(event) => {
                  // preventDefault for ANY claimed file drag (dragover advertised
                  // droppability): bailing on an empty file list would hand the
                  // drop to the browser default — navigating to the local file.
                  if (!event.dataTransfer?.types?.includes("Files")) return;
                  event.preventDefault();
                  const files = event.dataTransfer.files;
                  if (files.length > 0) {
                    addImageFiles(files);
                  }
                }}
              >
                {/* Top-bar pull-down-to-restore grab zone (#13531). Confined to the
                safe-area + MAXIMIZE_RESTORE_ZONE_PX strip at the very top so the
                transcript BELOW it stays freely scrollable (wheel + touch-drag)
                and an accidental tap can't jog the sheet out of full-screen — a
                deliberate DOWNWARD drag from the top edge is the only exit.
                Mounted while full-bleed AND for the duration of a restore drag
                (`restoreDragging`) so it keeps the pointer capture after the drag
                drops full-bleed. NOT during onboarding (the pinned half sheet
                keeps the inert grabber). `z-[15]` sits UNDER the header (`z-20`),
                whose empty space is `pointer-events-none`, so pulls that START
                over the top bar fall THROUGH to this strip. Keyboard-operable
                (Enter/Space/ArrowDown restore) so the gesture-only affordance
                stays WCAG 2.1.1 operable. */}
                {(fullBleed ||
                  restoreDragging ||
                  restorePressRef.current != null) &&
                !pinnedOpen ? (
                  <div
                    className="pointer-events-auto absolute inset-x-0 top-0 z-[15]"
                    style={{
                      height: `calc(var(--safe-area-top, 0px) + ${MAXIMIZE_RESTORE_ZONE_PX}px)`,
                    }}
                  >
                    <Button
                      {...restoreZoneBinding}
                      type="button"
                      variant="publicRow"
                      size="fill"
                      data-testid="chat-maximize-restore-zone"
                      aria-label="drag down to exit full screen"
                      onKeyDown={(e) => {
                        if (
                          e.key === "Enter" ||
                          e.key === " " ||
                          e.key === "ArrowDown"
                        ) {
                          e.preventDefault();
                          restoreFromMaximizedGuarded();
                        }
                      }}
                      className="touch-none"
                    />
                  </div>
                ) : null}

                {/* Sheet header — shown at the HALF detent and up (not just FULL).
              One infinite thread (#13531): no maximize/minimize (that's a
              vertical pull now) and no clear/new-chat (the thread never resets).
              It carries NO buttons — Home/search/upload live in the composer
              "+" menu — so the chat stops acting like a second app nav bar. The bar remains only to reserve
              the safe-area top inset at full-bleed and host the transcribe badge. */}
                {threadPresented ? (
                  <motion.div
                    data-testid="chat-sheet-header"
                    // Mounted while the sheet is open, or while an upward drag is
                    // previewing the sheet before release. It can FADE + LERP its
                    // space as the live height crosses the header threshold.
                    // `headerVisible` gates interactivity + the a11y tree.
                    inert={!sheetOpen || !headerVisible || undefined}
                    style={{
                      // Full-bleed is always fully open: show the header at full
                      // opacity (headerOpacity is already 1 at any height ≥ half,
                      // which full-bleed guarantees).
                      opacity: fullBleed ? 1 : headerOpacity,
                      // Height cap + safe-area top padding EASE with the shape
                      // morph (headerMaxHMorph / headerPadTopMorph) — a discrete
                      // swap at commit popped the header a status-bar height on
                      // notch devices. Collapsed → 0 top padding (no leaked margin
                      // above the composer); opens to ~10px as the header reveals;
                      // grows to safe-area + 8px as the glass squares off under the
                      // status bar. Set inline (not a Tailwind arbitrary class,
                      // whose env(...,0px) comma breaks the parser).
                      maxHeight: headerMaxHMorph,
                      paddingTop: headerPadTopMorph,
                    }}
                    className={cn(
                      // `pointer-events-none` on the bar itself so a pull-down that
                      // starts over the EMPTY top-bar space falls through to the
                      // restore strip beneath it (the "should work over the top bar"
                      // fix); interactive content inside the strip opts back in only
                      // when present.
                      "pointer-events-none relative z-20 flex shrink-0 items-center justify-between gap-1.5 overflow-hidden px-3",
                      // Always the centered reading column: pinned even mid-morph
                      // and full-bleed so the header never reflows while the glass
                      // widens (a no-op at rest, where the wrapper is the same 48rem).
                      "mx-auto w-full max-w-3xl",
                    )}
                  >
                    {/* The header carries no nav/search buttons — Home, Search, and
                    Upload live in the composer "+" menu. This bar exists only to reserve the safe-area
                    top inset at full-bleed and host the transcription badge. */}
                    {transcriptionComposerActive ? (
                      <Badge
                        variant="statusMuted"
                        size="pill"
                        data-testid="chat-transcribing-badge"
                        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap"
                      >
                        {transcriptionFinishing
                          ? "Finishing transcription…"
                          : "Transcribing — say “exit transcription mode” to stop"}
                      </Badge>
                    ) : null}
                  </motion.div>
                ) : null}

                {/* The conversation. Height animates 0 (collapsed) → half → full; the
            inner log scrolls. The grabber owns the drag, so dragging the messages
            just scrolls them. Rendered while the sheet is open or while an
            upward drag is actively previewing the sheet; at rest collapsed it
            is unmounted, so there is no hidden transcript layer. */}
                {threadPresented ? (
                  <motion.div
                    data-testid="chat-thread"
                    className={cn(
                      // `flex flex-col`: the thread is now a flex COLUMN so its lone
                      // child (the scroller) sizes via `flex-1 min-h-0` against this
                      // element's bounded height instead of `height:100%`. A flex
                      // item whose main size comes ONLY from `flex-basis` (the px
                      // MotionValue below) is NOT a definite height for a percentage
                      // `h-full` child on iOS Safari / WebKit (it resolves to auto →
                      // the scroller sizes to CONTENT and never overflows → the
                      // transcript can't scroll on mobile web, #chat-scroll-web). The
                      // flex algorithm gives a `min-h-0` flex child a definite
                      // resolved height regardless, so this makes the scroll viewport
                      // reliably bounded on every engine.
                      "relative z-10 flex min-h-0 w-full shrink grow-0 flex-col overflow-hidden",
                      // Always the centered reading column (a no-op at rest): the
                      // transcript stays this width THROUGH the maximize morph and
                      // at full-bleed — only the glass grows, the text never reflows.
                      // The transcript reaches the floating grabber; the viewport's
                      // edge fades soften content passing beneath it.
                      "mx-auto max-w-3xl",
                    )}
                    // Flex-basis IS the motion value (px string) — set 1:1 during a drag,
                    // spring-animated to a detent on release; no `animate`/`transition`,
                    // so no re-render. `shrink min-h-0` lets the panel's `maxHeight` cap
                    // win: a tall detent (or the keyboard) shrinks the thread (it
                    // scrolls) instead of pushing the panel off-screen.
                    // In-app onboarding (`pinnedOpen`) mounts locked at the shared
                    // HALF detent and
                    // never drags, but the `threadHeight` MotionValue that feeds
                    // `threadFlexBasis` starts at 0, so the FIRST paint renders the
                    // thread at 0 height and the composer stacks at the top — then a
                    // post-commit effect grows it to `halfH` and the composer drops a
                    // large panel distance to the bottom on the first frame a new
                    // user sees, #15214). During onboarding there is no drag to track,
                    // so pin the flex-basis to the settled open height statically at
                    // render time — first paint already matches the resting layout, no
                    // reflow. Reverts to the live MotionValue the moment onboarding
                    // releases. External browser sign-in is not pinned: it uses the
                    // enforced pill and therefore carries no hidden half-height box.
                    style={{
                      flexBasis: pinnedOpen ? `${halfH}px` : threadFlexBasis,
                    }}
                  >
                    {/* Message search (#14279): an in-sheet panel that covers the
                    transcript while open. Selecting a hit closes it and jumps
                    (handleSearchJump). Reachable via the composer "+" menu
                    ("Search chat…"), which only exists while the sheet is open;
                    gate on sheetOpen so the panel never intrudes on the resting
                    composer. */}
                    {searchOpen && sheetOpen ? (
                      <div
                        data-testid="chat-message-search"
                        data-keyboard-open={
                          keyboardLiftActive ? "true" : undefined
                        }
                        // The sheet already owns the glass surface. Search reuses
                        // that single layer while the transcript beneath is dimmed
                        // and inert, avoiding the opaque double-blur slab that a
                        // second backdrop produced. Only the inner results list
                        // scrolls, keeping the input pinned above the keyboard.
                        className="absolute inset-0 z-30 flex flex-col overflow-hidden px-4 pb-3 pt-2"
                      >
                        <MessageSearchPanel
                          search={runMessageSearch}
                          onJump={handleSearchJump}
                          onClose={closeSearch}
                          layout="keyboard-anchored"
                        />
                      </div>
                    ) : null}
                    <MessageScrollerProvider
                      key={activeConversationId ?? "unbound"}
                      autoScroll={!firstRunOpen}
                      defaultScrollPosition={firstRunOpen ? "start" : "end"}
                      scrollEdgeThreshold={MESSAGE_SCROLLER_END_THRESHOLD_PX}
                    >
                      <MessageScrollerSendFollow request={scrollToEndRequest} />
                      <MessageScrollerSearchBridge
                        scrollToMessageRef={searchScrollToMessageRef}
                      />
                      <MessageScroller>
                        <motion.div
                          inert={searchOpen || undefined}
                          className="flex size-full min-h-0 flex-col"
                          style={{
                            // Keep the transcript visible beneath search without letting
                            // its animated opacity overpower the result surfaces.
                            opacity: threadContentOpacity,
                            filter: searchOpen ? "opacity(0.4)" : undefined,
                          }}
                        >
                          <MessageScrollerViewport
                            id="continuous-thread"
                            data-testid="chat-thread-scroll"
                            // Match the composer fade at the grabber edge in every detent.
                            fade="both"
                            ref={threadRef}
                            preserveScrollOnPrepend={false}
                            onScroll={handleThreadScroll}
                            aria-label="conversation history"
                            aria-hidden={
                              !sheetOpen || searchOpen ? true : undefined
                            }
                            tabIndex={sheetOpen && !searchOpen ? 0 : -1}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.preventDefault();
                                collapse();
                              }
                            }}
                            // `flex-1 min-h-0` keeps the scroll viewport bounded by
                            // the motion-sized sheet on iOS. Momentum scrolling and
                            // the closed horizontal axis remain explicit because the
                            // outer draggable surface only negotiates vertical input.
                            className="scrollbar-hide relative min-h-0 w-full flex-1 touch-pan-y overflow-y-auto overflow-x-hidden overscroll-contain px-5 outline-none [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden"
                          >
                            {/* Empty-thread loading: a fresh/cleared chat awaiting its
                      greeting, a swipe past the prefetch window, or a sheet
                      opened before boot-time history hydration finished (a
                      programmatic open can land while the server transcript is
                      still in flight). Centered spinner so the open sheet reads
                      as "loading," never as a broken empty box. Cache-hit
                      swipes paint instantly, so this only shows on a genuine
                      wait; first-run owns its own empty state. */}
                            {visibleMessages.length === 0 &&
                            !firstRunOpen &&
                            (conversationLoading || booting) ? (
                              <div
                                data-testid="chat-thread-loading"
                                className="pointer-events-none absolute inset-0 grid place-items-center"
                              >
                                <Loader2 className="size-6 animate-spin text-accent" />
                              </div>
                            ) : null}
                            {/* Normal chat consumes only the free space in genuinely
                  short threads to keep their latest line near the composer.
                  Once content fills the viewport there is no free space to
                  distribute, so long transcripts retain their natural flow.
                  First-run starts at the top so the opening prompt reads like
                  the first turn. */}
                            <MessageScrollerContent
                              ref={threadContentRef}
                              aria-busy={responding}
                              className={cn(
                                "flex flex-col gap-0",
                                firstRunOpen
                                  ? "shrink-0 pt-8"
                                  : "mt-auto justify-end pb-3 pt-8",
                              )}
                            >
                              {/* Top sentinel for infinite upward scroll (#13532, #14279):
                        a zero-height marker just above the oldest turn. When it
                        nears the top of the scroller, useLoadOlderOnScroll
                        prefetches + prepends an older page a viewport early and
                        preserves the reader's anchor so the thread never jumps. */}
                              {!firstRunOpen &&
                              renderWindow.canLoadOlder &&
                              visibleMessages.length > 0 ? (
                                <div
                                  ref={topSentinelRef}
                                  data-testid="chat-transcript-top-sentinel"
                                  aria-hidden="true"
                                  className="pointer-events-none h-px w-full shrink-0"
                                />
                              ) : null}
                              {/* Topic metadata remains available to search and
                          memory consumers, but ordinary chat is always one
                          chronological transcript. */}
                              {visibleMessages.map((m, i) =>
                                renderThreadLine(m, i),
                              )}
                            </MessageScrollerContent>
                          </MessageScrollerViewport>
                        </motion.div>
                        {/* Reply gets a dedicated lane below the viewport. Its
                        measured height eases into the fixed scroller, so the
                        latest turn glides clear without moving the sheet. */}
                        <AnimatePresence initial={false}>
                          {chatReplyTarget ? (
                            <motion.div
                              key="chat-reply-target"
                              data-testid="chat-reply-lane"
                              initial={
                                reduce
                                  ? false
                                  : {
                                      height: 0,
                                      opacity: 0,
                                      transform: "translateY(5px)",
                                    }
                              }
                              animate={{
                                height: "auto",
                                opacity: 1,
                                transform: "translateY(0px)",
                              }}
                              exit={
                                reduce
                                  ? undefined
                                  : {
                                      height: 0,
                                      opacity: 0,
                                      transform: "translateY(5px)",
                                    }
                              }
                              transition={{
                                duration: reduce ? 0 : 0.32,
                                ease: OVERLAY_EASE,
                              }}
                              className="z-10 shrink-0 overflow-hidden"
                            >
                              <div className="px-3 pb-2 pt-1">
                                <ChatReplyPill
                                  appearance="glass"
                                  target={chatReplyTarget}
                                  onCancel={() => setChatReplyTarget(null)}
                                />
                              </div>
                            </motion.div>
                          ) : null}
                        </AnimatePresence>
                      </MessageScroller>
                    </MessageScrollerProvider>
                  </motion.div>
                ) : null}
                {/* Cloud-agent provisioning status — rendered IN the chat, just
                above the composer, NOT as a home widget floating above the
                sheet. The widget consumes the same `useCloudHandoffPhase` event
                and self-hides entirely unless a dedicated cloud agent is booting
                (or a credit/retry state is live), so this is inert in the common
                case. Full chat-column width, styled to sit in the sheet. */}
                <AgentProvisioningWidget spanClassName="relative z-10 mx-auto w-full max-w-3xl shrink-0 px-3 pt-2" />
                {/* Pending attachments share the sheet's pull binding so tile and
                gap pixels remain one continuous drag surface. Their remove
                controls sit below the grabber's narrow top hit band and stop
                the pointerdown from seeding a drag, preserving an independent
                44px-class target for each file. */}
                {hasImages || imageError ? (
                  <div
                    data-testid="chat-pending-attachments"
                    className="pointer-events-none relative z-10 flex shrink-0 flex-col gap-1.5 px-3 pt-2"
                  >
                    {hasImages ? (
                      <div
                        data-testid="chat-pending-attachment-list"
                        {...pullBinding}
                        className="pointer-events-auto flex touch-none flex-wrap gap-2"
                      >
                        {pendingImages.map((img, i) => {
                          const kind = chatUploadKind(img.mimeType);
                          const removeButton = (
                            <Button
                              variant="outlineMuted"
                              size="icon-sm"
                              aria-label={`remove ${img.name}`}
                              onPointerDown={(event) => event.stopPropagation()}
                              onClick={() => removeImage(i)}
                              // Small visual disc, but a 44px-class hit zone via the
                              // invisible `before` overlay so it's thumb-tappable
                              // without crowding the tile. Bottom placement keeps
                              // that hit zone clear of the grabber above the sheet.
                              shape="circle"
                              className="pointer-events-auto absolute -bottom-1.5 -right-1.5 z-30 before:absolute before:-inset-3 before:content-['']"
                            >
                              ×
                            </Button>
                          );
                          const tileKey = `${img.name}-${img.mimeType}-${img.data.length}`;
                          if (kind === "image") {
                            return (
                              <div
                                key={tileKey}
                                className="group relative size-14 shrink-0"
                              >
                                <Card
                                  asChild
                                  surface="transparent"
                                  border="strong"
                                  radius="large"
                                  className="overflow-hidden"
                                >
                                  <img
                                    src={`data:${img.mimeType};base64,${img.data}`}
                                    alt={img.name}
                                    className="size-14 object-cover"
                                  />
                                </Card>
                                {removeButton}
                              </div>
                            );
                          }
                          const KindIcon =
                            kind === "audio"
                              ? Music
                              : kind === "video"
                                ? Film
                                : FileText;
                          return (
                            <Card
                              surface="raised"
                              border="strong"
                              radius="large"
                              tone="text"
                              key={tileKey}
                              className="group relative flex h-14 min-w-[3.5rem] max-w-[10rem] shrink-0 items-center gap-2 px-2.5"
                              title={img.name}
                            >
                              <KindIcon className="size-5 shrink-0 text-muted-strong" />
                              <span className="min-w-0 truncate text-xs-tight leading-tight">
                                {img.name}
                              </span>
                              {removeButton}
                            </Card>
                          );
                        })}
                      </div>
                    ) : null}
                    {imageError ? (
                      <p
                        role="alert"
                        className={cn(
                          "text-xs",
                          WALLPAPER_TEXT.danger,
                          WALLPAPER_FLOAT_SHADOW,
                        )}
                      >
                        {imageError}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <Input
                  ref={fileInputRef}
                  type="file"
                  accept={CHAT_UPLOAD_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addImageFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                {/* The input row — the base of the panel, always visible. A hairline
            divider sits above it whenever the history is open. The whole content
            wrapper crossfades + scales in from the pill (openProgress), so this
            row needs no separate entrance — it just sits at the panel base. */}
                <Card
                  asChild
                  surface="transparent"
                  border="standard"
                  radius="full"
                  visualStyle={{
                    backgroundColor: "var(--chat-composer-background)",
                    borderColor: "var(--chat-composer-border)",
                    boxShadow: "var(--chat-composer-shadow, none)",
                  }}
                >
                  <motion.div
                    data-testid="chat-composer-row"
                    onPointerDownCapture={noteInputActivity}
                    className={cn(
                      // items-center vertically centers a single-line composer with
                      // the round +/mic buttons (the common case); a multi-line draft
                      // grows the textarea and the buttons stay centered. shrink-0
                      // keeps the input fully visible when the panel hits its
                      // maxHeight cap (only the thread above gives way).
                      // Equal inset on all sides (px == py): a round button nested in
                      // the pill's round end-cap reads as concentric, with the same
                      // gap on the sides as top/bottom.
                      // No divider above the composer — spacing separates it from the
                      // thread; the sheet is one continuous glass surface (#10710).
                      "relative z-10 flex min-w-0 shrink-0 items-center gap-[clamp(0.125rem,1.25vw,0.5rem)] px-[clamp(0.25rem,1.5vw,0.5rem)] py-[clamp(0.125rem,0.75dvh,0.375rem)] [&_textarea]:max-h-[8.5rem] [&_textarea]:min-h-8 [&_textarea]:border-none [&_textarea]:bg-transparent [&_textarea]:px-1.5 [&_textarea]:py-1 [&_textarea]:text-left [&_textarea]:text-sm [&_textarea]:text-txt [&_textarea]:outline-none [&_textarea]:placeholder:text-muted-strong pointer-coarse:[&_textarea]:text-base",
                      // While INSET the composer dissolves into the sheet (one
                      // continuous glass surface, #10710) — border/fill are morph-
                      // driven inline (transparent at rest). At FULL-BLEED they fade
                      // in to the resting input bar's own capsule chrome, so the
                      // maximized chat's input reads exactly like the default
                      // floating input. `border` reserves the hairline's layout.
                      // Always the transcript's centered column (a no-op at rest) so
                      // the composer sits under the messages through the morph and at
                      // full-bleed, never stretched edge-to-edge on a wide window.
                      "mx-auto max-w-3xl",
                    )}
                    // Full-bleed has no overlay bottom padding (the panel is
                    // edge-to-edge), so the composer carries the home-gesture
                    // clearance itself — as a MARGIN below the capsule, eased in
                    // with the shape morph (0 at rest). Skipped while the keyboard
                    // is up, which already covers that zone. The bevel shadow is
                    // discrete-on-commit (too subtle to morph); border/fill alphas
                    // ride the morph.
                    style={{
                      ...({
                        "--chat-composer-border": composerCapsuleBorder,
                        "--chat-composer-background": composerCapsuleBg,
                        "--chat-composer-shadow": composerCapsuleShadow,
                      } satisfies ChatSheetMotionStyle),
                      width: composerCapsuleWidth,
                      ...(keyboardLiftActive
                        ? {}
                        : { marginBottom: composerCapsuleMarginBottom }),
                    }}
                  >
                    {/* Inline slash-command autocomplete, floating just above the
                    input row. */}
                    {!transcriptionComposerActive &&
                    slashProp &&
                    !slashDismissed ? (
                      <SlashCommandMenu
                        state={slashMenu}
                        loading={isSlashDraft && slash.loading}
                        error={isSlashDraft && slash.error}
                        onPick={pickSlashItem}
                      />
                    ) : null}
                    {/* The "+" opens shell navigation plus surface-local Search and
                  Upload actions for this in-app conversation, never connector actions on a
                  Discord/Telegram room. Search is agent-driveable; Upload is a
                  pure client affordance. */}
                    {!transcriptionComposerActive ? (
                      <DropdownMenu
                        open={chatActionsOpen}
                        onOpenChange={setChatActionsOpen}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="overlayEdge"
                            size="icon"
                            aria-label="chat actions"
                            disabled={firstRunOpen}
                            data-testid="chat-composer-plus"
                            onPointerDown={(event) => {
                              // The action menu owns this press even when the
                              // composer is mounted over another shell drag surface.
                              event.stopPropagation();
                            }}
                            // Same responsive real target and 20px mark as the
                            // SoftButton controls, so the row reads as one family.
                            className="relative shrink-0 data-[state=open]:text-txt [&_svg]:size-5"
                          >
                            <Glyph d={PLUS_GLYPH} className="size-5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          data-chat-overlay-control
                          side="top"
                          align="start"
                          sideOffset={10}
                          // Above the shell overlay (z 9000); mirrors the config-select
                          // floating layer so the menu never hides behind the glass.
                          style={{
                            zIndex: CONFIG_SELECT_FLOATING_LAYER_Z_INDEX,
                          }}
                          // Unified liquid-glass menu chrome (glass/tokens.ts `menu`
                          // variant) instead of the flat opaque card.
                          glass
                          className="min-w-[13rem]"
                        >
                          {currentTab !== "chat" ? (
                            <DropdownMenuItem
                              className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                              onSelect={() => {
                                navigateHome?.();
                              }}
                            >
                              <House
                                className="size-4 shrink-0 text-muted"
                                aria-hidden
                              />
                              Back to Home
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem
                            className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                            onSelect={() => openSearch()}
                          >
                            <Search
                              className="size-4 shrink-0 text-muted"
                              aria-hidden
                            />
                            Search chat…
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="cursor-pointer gap-2.5 data-[highlighted]:bg-bg-hover"
                            disabled={pendingImages.length >= MAX_CHAT_IMAGES}
                            onSelect={() => fileInputRef.current?.click()}
                          >
                            <Paperclip
                              className="size-4 shrink-0 text-muted"
                              aria-hidden
                            />
                            Upload file
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                    {transcriptionComposerActive ? (
                      <ComposerMicActivity
                        analyser={analyser}
                        finishing={transcriptionFinishing}
                        reduceMotion={reduce}
                        transcript={transcript}
                      />
                    ) : realtimeVoiceComposerVisible && realtimeVoice ? (
                      <ComposerRealtimeVoiceActivity
                        connecting={realtimeVoice.connecting}
                        error={realtimeVoice.error}
                        needsAudioUnlock={needsAudioUnlock}
                        onUnlockAudio={unlockAudio}
                        paused={realtimeVoice.paused}
                        microphoneMuted={realtimeVoice.microphoneMuted}
                        reduceMotion={reduce}
                        status={realtimeVoice.status}
                        transcript={transcript}
                      />
                    ) : (
                      <Textarea
                        ref={inputRef}
                        rows={1}
                        value={draft}
                        // Hosted Cloud onboarding has one action: the transcript's
                        // sign-in CTA. Muting the composer avoids presenting a second,
                        // inert route while local/remote setup can still accept text.
                        disabled={cloudSignInRequired}
                        readOnly={cloudLoginWaiting}
                        onChange={(e) => {
                          const nextDraft = e.target.value;
                          resetMessageHistory();
                          if (
                            draft.trim().length > 0 &&
                            nextDraft.trim().length === 0
                          ) {
                            reportComposerActivity({
                              activity: "draft_abandoned",
                              surface: COMPOSER_ACTIVITY_SURFACE,
                              conversationId: activeConversationIdRef.current,
                              draftLength: 0,
                              reason: "cleared",
                            });
                          }
                          setDraft(nextDraft);
                          // Mirror the live draft to the active view (Help search etc.).
                          viewChatBinding?.onQuery?.(nextDraft);
                          if (nextDraft.trim().length > 0) expandFromTyping();
                        }}
                        onFocus={() => {
                          setChatComposerAccessoryBarHidden(true);
                          // Widen out of the short-landscape compact affordance (#14173)
                          // on focus, before the first keystroke.
                          setComposerFocused(true);
                          // A pill-open focus only raises the keyboard; it must not
                          // expand a history thread (see suppressExpandOnFocusRef).
                          if (suppressExpandOnFocusRef.current) {
                            suppressExpandOnFocusRef.current = false;
                          } else {
                            expand();
                          }
                        }}
                        onClick={() => {
                          // External sign-in deliberately makes the composer
                          // read-only, but the familiar bar remains the recovery
                          // affordance. A field that already owns focus will not emit
                          // another focus event, so the real click must reopen the
                          // transcript and its retry action explicitly.
                          if (cloudLoginWaiting) expand();
                        }}
                        onBlur={() => {
                          setChatComposerAccessoryBarHidden(false);
                          setComposerFocused(false);
                          // A suppress-expand flag armed for a focus that never landed
                          // (openFromPill arms it BEFORE focusing) must not survive to
                          // swallow the next genuine focus→expand.
                          suppressExpandOnFocusRef.current = false;
                        }}
                        onPaste={handleComposerPaste}
                        onKeyDown={(event) => {
                          noteInputActivity();
                          handleComposerKeyDown(event);
                        }}
                        // Attachments and voice stay gated during onboarding, while
                        // text can answer the conductor naturally.
                        // (This surface's strings are plain literals by design — see
                        // the imageError note above.)
                        placeholder={
                          compactLanding
                            ? "Message"
                            : cloudSignInRequired
                              ? "Sign in to get started"
                              : firstRunOpen
                                ? firstRunComposerPlaceholder
                                : viewChatBinding?.placeholder
                                  ? viewChatBinding.placeholder
                                  : noProviderConfigured
                                    ? "Connect a model provider in Settings to chat"
                                    : modelBlocksSend
                                      ? modelStatus?.kind === "downloading"
                                        ? `Downloading ${modelStatus.modelName ?? "your model"} — you can keep typing`
                                        : `Getting ${modelStatus?.modelName ?? "your model"} ready — you can keep typing`
                                      : booting
                                        ? `Message ${agentName} — waking up…`
                                        : "Hey Eliza…"
                        }
                        aria-label="message"
                        data-testid="chat-composer-textarea"
                        aria-describedby={
                          firstRunOpen
                            ? "cc-first-run-hint"
                            : booting && !noProviderConfigured
                              ? "cc-booting-hint"
                              : undefined
                        }
                        // Combobox semantics (role + aria-*) are applied as one spread,
                        // and only when a slash catalog is wired in — a plain message
                        // box otherwise.
                        {...comboboxAria}
                        // The floating composer is the primary chat affordance on the
                        // ambient home surface, so its placeholder must stay readable
                        // even when the glass pill sits over dark wallpaper. A locked
                        // Cloud composer is intentionally muted beneath the live CTA.
                        className="scrollbar-hide min-w-0 flex-1 resize-none self-center leading-relaxed disabled:pointer-events-none disabled:opacity-60"
                      />
                    )}
                    {!transcriptionComposerActive &&
                    booting &&
                    !noProviderConfigured &&
                    !firstRunOpen ? (
                      <span id="cc-booting-hint" className="sr-only">
                        {agentName} is waking up. You can type now; your message
                        sends and the reply arrives in a moment.
                      </span>
                    ) : null}
                    {firstRunOpen ? (
                      <span id="cc-first-run-hint" className="sr-only">
                        Your answer stays in setup until your agent is ready.
                      </span>
                    ) : null}
                    {/* Trailing controls. */}
                    <div
                      data-testid="chat-composer-trailing-controls"
                      className={cn(
                        "grid shrink-0 items-center",
                        realtimeVoiceControlsVisible
                          ? "grid-cols-2"
                          : "grid-cols-1",
                      )}
                    >
                      {realtimeVoiceControlsVisible && realtimeVoice ? (
                        <ComposerControlSlot
                          slot="left"
                          reduceMotion={reduce}
                          controlKey={
                            realtimeVoice.microphoneMuted
                              ? "voice-microphone-muted"
                              : "voice-microphone-live"
                          }
                        >
                          <SoftButton
                            icon={
                              realtimeVoice.microphoneMuted ||
                              realtimeVoice.status === "speaking"
                                ? MicOff
                                : Mic
                            }
                            label={
                              realtimeVoice.status === "speaking"
                                ? "Microphone paused while speaking"
                                : realtimeVoice.microphoneMuted
                                  ? "unmute microphone"
                                  : "mute microphone"
                            }
                            disabled={realtimeVoice.status === "speaking"}
                            active={realtimeVoice.microphoneMuted}
                            pressed={realtimeVoice.microphoneMuted}
                            onClick={realtimeVoice.toggleMicrophoneMute}
                            testId="chat-composer-voice-mute"
                          />
                        </ComposerControlSlot>
                      ) : null}
                      {/* One stable rightmost slot owns every primary action. Talk no
                    longer shares the row with an ambiguous second mic, and a
                    held pointer has exactly the same Cartesia action as a tap. */}
                      <ComposerControlSlot
                        slot="right"
                        reduceMotion={reduce}
                        controlKey={
                          transcriptionComposerActive
                            ? "transcription-stop"
                            : draftOwnsTrailingControl
                              ? "send"
                              : generationOwnsTrailingControl
                                ? "generation-stop"
                                : "voice"
                        }
                      >
                        {transcriptionComposerActive ? (
                          /* The rightmost transcription mic becomes Stop. Activity owns
                       every other composer pixel until capture finishes. */
                          <SoftButton
                            glyph={STOP_GLYPH}
                            label={
                              transcriptionFinishing
                                ? "finishing transcription"
                                : "stop transcription"
                            }
                            disabled={firstRunOpen || transcriptionFinishing}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => void finishTranscription()}
                            testId="chat-composer-transcription-stop"
                          />
                        ) : draftOwnsTrailingControl ? (
                          <SoftButton
                            icon={SendHorizontal}
                            label={
                              firstRunOpen
                                ? "send to setup assistant"
                                : !canSend
                                  ? "send (agent stopped)"
                                  : responding
                                    ? "send another"
                                    : "send"
                            }
                            disabled={
                              firstRunOpen
                                ? cloudLoginWaiting || !sendFirstRunText
                                : !canSend
                            }
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={submit}
                            testId="chat-composer-action"
                          />
                        ) : generationOwnsTrailingControl ? (
                          <SoftButton
                            glyph={STOP_GLYPH}
                            label={
                              turnStatus?.kind === "speaking"
                                ? "stop speaking"
                                : "stop generating"
                            }
                            onClick={() => stop()}
                            testId="chat-composer-stop"
                          />
                        ) : (
                          <SoftButton
                            glyph={handsFree ? STOP_GLYPH : undefined}
                            icon={handsFree ? undefined : AudioLines}
                            label={
                              realtimeVoice?.error
                                ? `retry talk — ${realtimeVoice.error}`
                                : realtimeVoice?.connecting
                                  ? "cancel voice connection"
                                  : handsFree
                                    ? "end conversation"
                                    : recording
                                      ? "stop listening"
                                      : "talk"
                            }
                            disabled={firstRunOpen}
                            active={handsFree}
                            pressed={recording || handsFree}
                            pulse={recording && !handsFree}
                            onClick={handleMicClick}
                            testId="chat-composer-mic"
                          />
                        )}
                      </ComposerControlSlot>
                    </div>
                  </motion.div>
                </Card>
              </motion.div>
            </Card>
            <Card
              asChild
              surface="transparent"
              border="strong"
              radius="none"
              visualStyle={{ borderRadius: "var(--chat-sheet-radius)" }}
            >
              <motion.div
                data-testid="chat-sheet-rim"
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 z-40"
                style={{
                  opacity: rimOpacity,
                  ...({
                    "--chat-sheet-radius": morphRadius,
                  } satisfies ChatSheetMotionStyle),
                }}
              />
            </Card>
            {/* PILL CAPSULE — the collapsed handle, crossfaded out as the input
              forms. Interactive only while pilled; sits over the (faded) input. */}
            <motion.div
              className="absolute inset-x-0 bottom-0 z-30 flex justify-center"
              style={{
                opacity: pillOpacity,
                pointerEvents: pilled ? "auto" : "none",
              }}
            >
              {pilled && responding && turnStatus && !fillHostAtHalf ? (
                <div
                  className={cn(
                    "pointer-events-none absolute bottom-7 max-w-[calc(100vw-2rem)] overflow-hidden whitespace-nowrap",
                    "[&_[data-slot=marker-content]]:truncate",
                    WALLPAPER_FLOAT_SHADOW,
                  )}
                  data-testid="chat-pill-turn-status"
                >
                  <TurnStatus status={turnStatus} showLabel={false} />
                </div>
              ) : null}
              <PillHandle
                binding={pullBinding}
                counterScale={pillCounterScale}
                onOpen={openFromPill}
                // The pill IS the whole chat while collapsed, so it alone pulses
                // for a live mic capture (`recording`) — the open-sheet grabber
                // deliberately does not (the composer glyphs carry that cue).
                breathing={listening || responding || recording}
                pilled={pilled}
                desktopOverlayHost={fillHostAtHalf}
              />
            </motion.div>
          </motion.fieldset>
        </Card>
      </motion.div>
    </motion.div>
  );
}
