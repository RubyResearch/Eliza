/** Verifies ChatOverlay through the package's configured test harness. */
// @vitest-environment jsdom
//
// Core behavior of the floating chat overlay: the mic ↔ send composer swap,
// draft persistence, thread rendering, back-intent/prefill events, and the
// press-and-hold copy gesture. Renders the real overlay in jsdom with the API
// client + clipboard mocked (no network).

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { motionValue } from "motion/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ChatComposerCtx,
  clearChatDraft,
  readChatDraft,
  useChatComposerDraftPersistence,
  writeChatDraft,
} from "../../state/ChatComposerContext.hooks";

// The resting overlay's suggestion strip fetches model suggestions via the
// shared client; stub it so the strip stays on its static fallback in tests.
vi.mock("../../api/client", () => ({
  // Voice's inert off-device diagnostics instantiate this re-export at module
  // load; keep the class shape while replacing only the shared singleton.
  ElizaClient: class {
    fetch = vi.fn();
  },
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    // Shell capability gates consult the configured agent base before mounting
    // the composer-adjacent provider indicator.
    getBaseUrl: vi.fn(() => ""),
    // Transcription archival is best-effort and fire-and-forget; resolve so the
    // attachment path (the user-facing behavior) is what the test asserts.
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
    // The header search control drives the real client method; per-test the
    // resolved value is the real `GET /api/conversations/messages/search`
    // response shape so the query→results→jump path is exercised end to end.
    searchConversationMessages: vi.fn(),
  },
}));

// The press-and-hold copy path writes to the clipboard; stub it so the gesture
// is assertable (and never throws "Clipboard API unavailable" in jsdom).
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../chat/report-composer-activity", () => ({
  reportComposerActivity: vi.fn(),
}));

const desktopBridgeEventHandlers = vi.hoisted(
  () => new Map<string, (payload: unknown) => void>(),
);

vi.mock("../../hooks/useDesktopBridgeEvent", () => ({
  useDesktopBridgeEvent: (
    options: { rpcMessage: string },
    handler: (payload: unknown) => void,
  ) => {
    desktopBridgeEventHandlers.set(options.rpcMessage, handler);
  },
}));

import * as React from "react";
import { client } from "../../api/client";
import type {
  Conversation,
  ConversationMessage,
  ConversationMessageSearchResult,
  ImageAttachment,
} from "../../api/client-types-chat";
import { reportComposerActivity } from "../../chat/report-composer-activity";
import type { SlashCommandCatalogItem } from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import {
  CHAT_PREFILL_EVENT,
  ELIZA_BACK_INTENT_EVENT,
  NAVIGATE_VIEW_EVENT,
} from "../../events";
import {
  resetNativeBackdropForTests,
  setNativeBackdropEncoderForTests,
  setNativeWallpaperSource,
} from "../../glass/native-backdrop";
import { resetGlassBridgeForTests } from "../../glass/native-bridge";
import {
  LAYOUT_SHIFT_INTENT_ATTR,
  LAYOUT_SHIFT_INTENT_TRANSIENT,
} from "../../hooks/useLayoutShiftMonitor";
import {
  OS_INTENT_COMPOSER_PREFILL_EVENT,
  type OsIntentComposerPrefillDetail,
} from "../../os-intent/host";
import { __setAppValueForTests } from "../../state/app-store";
import {
  getShellSurface,
  goLauncher,
  resetShellSurfaceForTests,
} from "../../state/shell-surface-store";
import {
  applyStreamingTextModification,
  type StreamingTextSetter,
} from "../../state/useStreamingText";
import { setViewChatBinding } from "../../state/view-chat-binding";
import { copyTextToClipboard } from "../../utils/clipboard";
import { ViewBackButton } from "../shared/ViewHeader";
import { ChatOverlay, PillHandle } from "./ChatOverlay";
import type { ShellMessage } from "./shell-state";
import {
  buildConversationNav,
  type ShellController,
} from "./useShellController";

beforeAll(() => {
  // jsdom has no scrollIntoView; the overlay calls it when the thread grows.
  Element.prototype.scrollIntoView = vi.fn();
  // jsdom has no text layout; range geometry is verified in the real browser.
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
  // The realtime status orb is a real Canvas component. The component still
  // mounts and exposes its semantic state in jsdom; pixel drawing belongs to
  // the browser evidence lane rather than a synthetic Canvas implementation.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => null),
  });
});

// Unmount between tests so renders don't accumulate in the shared document.
afterEach(() => {
  cleanup();
  resetShellSurfaceForTests();
  setViewChatBinding(null);
  vi.mocked(reportComposerActivity).mockClear();
  vi.mocked(client.searchConversationMessages).mockReset();
  vi.mocked(Element.prototype.scrollIntoView).mockClear();
  document.getElementById("chat-message-m-hit")?.remove();
  // Search-jump tests seed the AppContext store with spies; clear it so the
  // inert test-fallback proxy backs every other test again.
  __setAppValueForTests(null);
  (globalThis as { Capacitor?: unknown }).Capacitor = undefined;
  resetGlassBridgeForTests();
  resetNativeBackdropForTests();
  setNativeBackdropEncoderForTests(null);
  document.documentElement.classList.remove("eliza-native-backdrop");
});

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
      // whitespace-only → should be filtered out of the rendered thread
      { id: "b", role: "user", content: "   ", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    analyser: null,
    transcript: "",
    transcriptionMode: false,
    // Required ShellController surface the overlay reads unconditionally — the
    // real controller always supplies these, so the mock must too.
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    // A mic tap while transcribing routes through this master voice control.
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

function emitDesktopWindowBlur(): void {
  const handler = desktopBridgeEventHandlers.get("desktopWindowBlur");
  expect(handler).toBeTypeOf("function");
  act(() => handler?.(undefined));
}

/**
 * The app composition seam around the overlay, reproduced minimally: the
 * shared ChatComposerContext slot (real state), the app-level
 * useChatComposerDraftPersistence instance AppContext runs, and a
 * selectConversation that performs useChatCallbacks.handleSelectConversation's
 * flush/restore handoff — the path the overlay's conversation swipe routes
 * through in the real app. `selectRef` hands the select function to the test.
 */
function AppComposerHarness({
  initialActiveId,
  selectRef,
}: {
  initialActiveId: string;
  selectRef: { current: ((id: string) => void) | null };
}) {
  const [activeId, setActiveId] = React.useState(initialActiveId);
  const [chatInput, setChatInput] = React.useState("");
  const [chatPendingImages, setChatPendingImages] = React.useState<
    ImageAttachment[]
  >([]);
  const chatInputRef = React.useRef(chatInput);
  chatInputRef.current = chatInput;
  useChatComposerDraftPersistence({
    activeConversationId: activeId,
    chatInput,
    setChatInput,
  });
  selectRef.current = (id: string) => {
    // Mirrors useChatCallbacks.handleSelectConversation: flush the leaving
    // conversation's in-progress text under ITS OWN key, then repaint the
    // target's saved draft (or clear when it has none).
    writeChatDraft(activeId, chatInputRef.current);
    setChatInput(readChatDraft(id) ?? "");
    setActiveId(id);
  };
  const composerValue = React.useMemo(
    () => ({
      chatInput,
      chatSending: false,
      chatPendingImages,
      chatReplyTarget: null,
      setChatInput,
      setChatPendingImages,
      setChatReplyTarget: () => {},
    }),
    [chatInput, chatPendingImages],
  );
  const controller = React.useMemo(
    () =>
      makeController({
        conversationNav: {
          hasPrev: false,
          hasNext: false,
          goPrev: () => {},
          goNext: () => {},
          activeId,
          index: 0,
        },
      } as unknown as Partial<ShellController>),
    [activeId],
  );
  return (
    <ChatComposerCtx.Provider value={composerValue}>
      <span data-testid="harness-chat-input" hidden>
        {chatInput}
      </span>
      <ChatOverlay controller={controller} />
    </ChatComposerCtx.Provider>
  );
}

describe("ChatOverlay", () => {
  it("reports the shallow input detent before chat history opens", () => {
    const onDetentChange = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        onDetentChange={onDetentChange}
      />,
    );
    expect(onDetentChange).toHaveBeenLastCalledWith("input");
  });

  it("shows the mic and no send button when the draft is empty", () => {
    render(<ChatOverlay controller={makeController()} />);
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.getAllByTestId("chat-composer-mic")).toHaveLength(1);
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
    expect(screen.queryByLabelText("send")).toBeNull();
  });

  it("swaps mic → send once the user types (ChatGPT-style)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const controls = screen.getByTestId("chat-composer-trailing-controls");
    const voice = screen.getByLabelText("talk");
    const voiceTransition = voice.closest("[data-composer-control]");
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    const send = screen.getByLabelText("send");
    expect(screen.getByTestId("chat-composer-trailing-controls")).toBe(
      controls,
    );
    expect(controls.className).toContain("grid-cols-1");
    expect(screen.queryByTestId("chat-composer-control-slot-left")).toBeNull();
    expect(
      screen.getByTestId("chat-composer-control-slot-right").className,
    ).toContain("size-10");
    expect(voiceTransition?.getAttribute("aria-hidden")).toBe("true");
    expect(voiceTransition?.hasAttribute("inert")).toBe(true);
    expect(
      send.closest("[data-composer-control]")?.getAttribute("aria-hidden"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "talk" })).toBeNull();
  });

  it("reports typing start and pause from the real composer draft", () => {
    vi.useFakeTimers();
    try {
      render(<ChatOverlay controller={makeController()} />);
      fireEvent.change(screen.getByLabelText("message"), {
        target: { value: "hello" },
      });

      expect(reportComposerActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "typing_started",
          surface: "chat_overlay",
          draftLength: 5,
        }),
      );
      expect(reportComposerActivity).not.toHaveBeenCalledWith(
        expect.objectContaining({ activity: "typing_paused" }),
      );

      act(() => {
        vi.advanceTimersByTime(1_999);
      });
      expect(reportComposerActivity).not.toHaveBeenCalledWith(
        expect.objectContaining({ activity: "typing_paused" }),
      );

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(reportComposerActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          activity: "typing_paused",
          surface: "chat_overlay",
          draftLength: 5,
          idleForMs: 2_000,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports draft_abandoned only when the user clears typed text", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message");

    fireEvent.change(input, { target: { value: "discard me" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(reportComposerActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        activity: "draft_abandoned",
        surface: "chat_overlay",
        draftLength: 0,
        reason: "cleared",
      }),
    );

    vi.mocked(reportComposerActivity).mockClear();
    fireEvent.change(input, { target: { value: "send me" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(controller.send).toHaveBeenCalledWith("send me");
    expect(reportComposerActivity).not.toHaveBeenCalledWith(
      expect.objectContaining({ activity: "draft_abandoned" }),
    );
  });

  it("shows a disabled, no-op send control when the agent can't accept input (canSend false)", () => {
    const controller = makeController({ canSend: false });
    render(<ChatOverlay controller={controller} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "hello" },
    });
    // The control still swaps to send, but is labelled + guarded as unavailable
    // (aria-disabled keeps it focusable/announceable; the click is a no-op).
    const send = screen.getByLabelText("send (agent stopped)");
    expect(send.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(send);
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("swaps send → mic again once the draft is cleared", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "hello" } });
    expect(screen.getByLabelText("send")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "send" })).toBeNull();
  });

  it("submits the draft on Enter, calls send(), and clears the input", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("ping");
    expect(input.value).toBe("");
  });

  it("keeps natural-language view requests model-owned", () => {
    const controller = makeController();
    const navigateView = vi.fn();
    const command: SlashCommandCatalogItem = {
      key: "views",
      nativeName: "views",
      description: "Open views",
      textAliases: ["/views"],
      scope: "both",
      acceptsArgs: true,
      args: [
        {
          name: "view",
          description: "view",
          dynamicChoices: "views",
        },
      ],
      requiresAuth: false,
      requiresElevated: false,
      target: { kind: "navigate", tab: "views", path: "/views" },
      source: "builtin",
    };
    const slash: SlashCommandController = {
      commands: [command],
      loading: false,
      error: false,
      // Ordinary prose stays model-owned, including exact route requests.
      naturalShortcutsEnabled: true,
      resolveChoices: () => ["notes", "calendar"],
      describeChoice: () => "",
      resolveSection: () => undefined,
      isAuthorized: true,
      isElevated: false,
      navigateTab: vi.fn(),
      navigateSettings: vi.fn(),
      navigateView,
      clearChat: vi.fn(),
      openCommandPalette: vi.fn(),
    };

    render(<ChatOverlay controller={controller} slash={slash} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "open notes" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigateView).not.toHaveBeenCalled();
    expect(controller.send).toHaveBeenCalledWith("open notes");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("does NOT send on the Enter that commits an IME composition (CJK), only a real Enter", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "にほんご" } });

    // Enter while an IME candidate is being committed: `isComposing` is set
    // (legacy engines report keyCode 229). This Enter accepts the candidate and
    // MUST NOT submit the half-composed line.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(controller.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(controller.send).not.toHaveBeenCalled();
    // The draft survives — the premature send never cleared it.
    expect(input.value).toBe("にほんご");

    // A normal Enter (composition finished) sends as usual.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("にほんご");
  });

  it("prefills and focuses the composer from the shared chat prefill event", async () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLInputElement;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(CHAT_PREFILL_EVENT, {
          detail: { text: "Show my agent workspace status.", select: true },
        }),
      );
    });

    expect(input.value).toBe("Show my agent workspace status.");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("cancels pending prefill focus work on unmount", () => {
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 42);
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    try {
      const { unmount } = render(<ChatOverlay controller={makeController()} />);
      requestFrame.mockClear();
      cancelFrame.mockClear();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(CHAT_PREFILL_EVENT, {
            detail: {
              text: "Show my agent workspace status.",
              select: true,
            },
          }),
        );
      });

      expect(requestFrame).toHaveBeenCalled();
      const prefillFrameId =
        requestFrame.mock.results[requestFrame.mock.results.length - 1]?.value;
      unmount();
      expect(cancelFrame).toHaveBeenCalledWith(prefillFrameId);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("opens the sheet when the composer input is focused (type-to-open)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("adopts native glass only once the open sheet SETTLES, after both native acks", async () => {
    const bridge = {
      attachGlass: vi.fn(async () => ({ attached: true })),
      updateRect: vi.fn(async () => {}),
      detachGlass: vi.fn(async () => {}),
      setGrouping: vi.fn(async () => {}),
      setBackdrop: vi.fn(async () => ({ applied: true })),
      clearBackdrop: vi.fn(async () => {}),
      isAvailable: vi.fn(async () => ({ available: true })),
    };
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      registerPlugin: () => bridge,
    };
    resetGlassBridgeForTests();
    setNativeBackdropEncoderForTests(async () => "Zm9vYmFy");
    setNativeWallpaperSource({
      imageUrl: "https://localhost/wallpapers/canopy.webp",
      color: "#160d07",
    });

    render(<ChatOverlay controller={makeController()} />);
    const surface = screen.getByTestId("chat-sheet-surface");
    // Closed sheet: never native, and the CSS material is untouched.
    expect(surface.dataset.glassTier).toMatch(/^css-/);

    fireEvent.focus(screen.getByLabelText("message"));
    // The open detent runs the release spring; adoption must wait for TRUE
    // rest (sheetSettled), then for both native acknowledgements.
    await waitFor(() => expect(surface.dataset.glassTier).toBe("native"), {
      timeout: 10_000,
    });
    // Wallpaper hosted BEFORE the region attached — the ack order that
    // guarantees no frame ever samples the black window.
    const backdropOrder = bridge.setBackdrop.mock.invocationCallOrder[0] ?? 0;
    const attachOrder = bridge.attachGlass.mock.invocationCallOrder[0] ?? 0;
    expect(backdropOrder).toBeGreaterThan(0);
    expect(backdropOrder).toBeLessThan(attachOrder);
    expect(bridge.attachGlass).toHaveBeenCalledWith(
      expect.objectContaining({
        colorScheme: "dark",
        tintColor: "#16090DD9",
      }),
    );
    // The native material remains attached below the WebView, but the open
    // conversation owns an opaque DOM fill. Underlying launcher/view controls
    // must never remain visible through the chat surface on iPad.
    expect(surface.style.getPropertyValue("--chat-sheet-background")).toBe(
      "var(--bg)",
    );
    expect(surface.style.getPropertyValue("--chat-sheet-backdrop")).toBe("");
    expect(screen.getByTestId("chat-overlay").className).toContain("isolate");
    expect(screen.getByTestId("chat-glass-tier-probe").textContent).toContain(
      "chat-glass-tier:native",
    );
  }, 20_000);

  it("flips the overlay to data-open when the composer textarea is focused (the ui-smoke contract)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("chat-overlay");
    expect(overlay.getAttribute("data-open")).toBeNull();
    fireEvent.focus(screen.getByTestId("chat-composer-textarea"));
    expect(overlay.getAttribute("data-open")).toBe("true");
  });

  it("opens the sheet when the thread lands AFTER the composer was focused (focus wins the boot race, #11112)", () => {
    // Boot: the overlay renders (and can be focused) before the restored
    // conversation's messages arrive. The focus→expand used to be a one-shot
    // no-op with nothing revealable, so data-open never flipped.
    const { rerender } = render(
      <ChatOverlay controller={makeController({ messages: [] })} />,
    );
    const overlay = screen.getByTestId("chat-overlay");
    const composer = screen.getByTestId("chat-composer-textarea");
    act(() => {
      composer.focus();
    });
    // Nothing to reveal yet — focusing the bare input must not open an empty sheet.
    expect(overlay.getAttribute("data-open")).toBeNull();

    // The restored conversation's messages land while the composer is still
    // focused: the parked focus-open intent completes the open.
    rerender(<ChatOverlay controller={makeController()} />);
    expect(overlay.getAttribute("data-open")).toBe("true");
  });

  it("drops the parked focus-open intent if the composer blurred before the thread arrived", () => {
    const { rerender } = render(
      <ChatOverlay controller={makeController({ messages: [] })} />,
    );
    const overlay = screen.getByTestId("chat-overlay");
    const composer = screen.getByTestId("chat-composer-textarea");
    act(() => {
      composer.focus();
      composer.blur();
    });

    // The thread arriving later must NOT pop the sheet open — the user left.
    rerender(<ChatOverlay controller={makeController()} />);
    expect(overlay.getAttribute("data-open")).toBeNull();
  });

  it("does not move the overlay bottom padding just because the composer is focused", () => {
    render(<ChatOverlay controller={makeController()} />);
    const overlay = screen.getByTestId("chat-overlay");
    const initialPadding = overlay.style.paddingBottom;

    fireEvent.focus(screen.getByLabelText("message"));

    expect(screen.getByTestId("chat-sheet").getAttribute("data-variant")).toBe(
      "open",
    );
    expect(overlay.style.paddingBottom).toBe(initialPadding);
  });

  it("reserves only side clearance for the compact landscape composer", () => {
    const originalInnerWidth = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );
    const originalResizeObserver = globalThis.ResizeObserver;
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    class TestResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 800,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 390,
      });
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      rectSpy.mockReturnValue({
        width: 360,
        height: 72,
        x: 0,
        y: 0,
        top: 0,
        right: 360,
        bottom: 72,
        left: 0,
        toJSON: () => ({}),
      } as DOMRect);
      document.documentElement.style.removeProperty(
        "--eliza-chat-side-clearance",
      );
      document.documentElement.style.removeProperty("--eliza-chat-clearance");

      render(
        <ChatOverlay
          controller={makeController()}
          agentName="Playwright Smoke"
        />,
      );

      // #20024 renamed the compact-landing placeholder "Ask" → "Message" in
      // ChatOverlay.tsx without updating this assertion, leaving the suite red
      // on develop. The source is the intent; this follows it.
      expect(screen.getByLabelText("message").getAttribute("placeholder")).toBe(
        "Message",
      );

      expect(
        document.documentElement.style.getPropertyValue(
          "--eliza-chat-side-clearance",
        ),
      ).toBe("0px");
      expect(
        screen.getByTestId("chat-sheet").parentElement?.style.maxWidth,
      ).toBe("360px");
      expect(
        document.documentElement.style.getPropertyValue(
          "--eliza-chat-clearance",
        ),
      ).toBe("80px");

      fireEvent.focus(screen.getByLabelText("message"));

      expect(screen.getByLabelText("message").getAttribute("placeholder")).toBe(
        "Hey Eliza…",
      );

      expect(
        document.documentElement.style.getPropertyValue(
          "--eliza-chat-side-clearance",
        ),
      ).toBe("0px");
    } finally {
      rectSpy.mockRestore();
      if (originalInnerWidth) {
        Object.defineProperty(window, "innerWidth", originalInnerWidth);
      }
      if (originalInnerHeight) {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
      document.documentElement.style.removeProperty(
        "--eliza-chat-side-clearance",
      );
      document.documentElement.style.removeProperty("--eliza-chat-clearance");
    }
  });

  it("recomputes the resting composer after portrait-landscape rotation", async () => {
    const originalInnerWidth = Object.getOwnPropertyDescriptor(
      window,
      "innerWidth",
    );
    const originalInnerHeight = Object.getOwnPropertyDescriptor(
      window,
      "innerHeight",
    );

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 844,
      });
      render(<ChatOverlay controller={makeController()} />);

      const overlay = screen.getByTestId("chat-overlay");
      const wrapper = screen.getByTestId("chat-sheet").parentElement;
      expect(wrapper?.style.maxWidth).toBe("768px");
      expect(overlay.className).toContain("items-center");

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 844,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 390,
      });
      act(() => window.dispatchEvent(new Event("orientationchange")));

      await waitFor(() => {
        expect(wrapper?.style.maxWidth).toBe("360px");
        expect(overlay.className).toContain("items-end");
      });

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 390,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 844,
      });
      act(() => window.dispatchEvent(new Event("orientationchange")));

      await waitFor(() => {
        expect(wrapper?.style.maxWidth).toBe("768px");
        expect(overlay.className).toContain("items-center");
      });
    } finally {
      if (originalInnerWidth) {
        Object.defineProperty(window, "innerWidth", originalInnerWidth);
      }
      if (originalInnerHeight) {
        Object.defineProperty(window, "innerHeight", originalInnerHeight);
      }
    }
  });

  it("renders NO cosmetic bottom-floor strip under the composer (wallpaper owns the zone)", () => {
    // The old chat-bottom-floor painted a --launch-bg gradient over
    // the strip below the composer; with the app shell painting that zone
    // (wallpaper on shared-background routes), the repaint band WAS the
    // residual visible gap on the standalone home view. It must stay gone.
    render(<ChatOverlay controller={makeController()} />);
    expect(screen.queryByTestId("chat-bottom-floor")).toBeNull();
  });

  it("blurs the focused composer when the active view leaves chat (drops the iOS accessory bar)", () => {
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    expect(document.activeElement).toBe(composer);

    // Navigate to a non-chat view. The overlay floats over every view, so
    // without an explicit blur the textarea keeps DOM focus on Settings and iOS
    // strands the keyboard input-accessory bar (the ‹ › chevrons + "Done").
    rerender(
      <ChatOverlay
        controller={makeController({
          currentTab: "settings",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).not.toBe(composer);
  });

  it("preserves focused typing when an agent view id resolves through the views tab", () => {
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
      window.dispatchEvent(
        new CustomEvent(NAVIGATE_VIEW_EVENT, {
          detail: {
            viewId: "calendar",
            source: "agent",
          },
        }),
      );
    });

    rerender(
      <ChatOverlay
        controller={makeController({
          currentTab: "views",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).toBe(composer);
  });

  it("does not arm a focus lease for an agent open-window action", () => {
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
      window.dispatchEvent(
        new CustomEvent(NAVIGATE_VIEW_EVENT, {
          detail: {
            viewId: "notes",
            viewPath: "/notes",
            source: "agent",
            action: "open-window",
          },
        }),
      );
    });

    rerender(
      <ChatOverlay
        controller={makeController({
          currentTab: "notes",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).not.toBe(composer);
  });

  it("returns the launcher rail home without collapsing or blurring chat", () => {
    render(<ChatOverlay controller={makeController()} />);
    const composer = screen.getByLabelText("message") as HTMLTextAreaElement;
    const sheet = screen.getByTestId("chat-sheet");
    act(() => {
      goLauncher();
      composer.focus();
      fireEvent.focus(composer);
    });
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(getShellSurface().page).toBe("launcher");

    act(() => {
      window.dispatchEvent(
        new CustomEvent(NAVIGATE_VIEW_EVENT, {
          detail: {
            viewId: "chat",
            viewPath: "/home",
            source: "agent",
          },
        }),
      );
    });

    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(document.activeElement).toBe(composer);
    expect(getShellSurface().page).toBe("home");
  });

  it("keeps composer focus when the active view stays on chat (no spurious blur)", () => {
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    const composer = screen.getByLabelText("message");
    act(() => {
      composer.focus();
    });
    // A re-render that does not change the active view must not steal focus.
    rerender(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    expect(document.activeElement).toBe(composer);
  });

  it("does not route soft-keyboard visualViewport resize through the drag-settle handler", () => {
    const originalVisualViewport = window.visualViewport;
    const fakeVisualViewport = {
      height: 700,
      offsetTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: fakeVisualViewport as unknown as VisualViewport,
    });
    const windowAdd = vi.spyOn(window, "addEventListener");
    try {
      render(<ChatOverlay controller={makeController()} />);

      const windowResizeHandler = windowAdd.mock.calls.find(
        ([type]) => type === "resize",
      )?.[1];
      const visualResizeHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "resize",
        )?.[1];
      const visualScrollHandler =
        fakeVisualViewport.addEventListener.mock.calls.find(
          ([type]) => type === "scroll",
        )?.[1];

      expect(typeof windowResizeHandler).toBe("function");
      expect(typeof visualResizeHandler).toBe("function");
      expect(typeof visualScrollHandler).toBe("function");
      expect(visualResizeHandler).toBe(visualScrollHandler);
      expect(visualResizeHandler).not.toBe(windowResizeHandler);
    } finally {
      windowAdd.mockRestore();
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: originalVisualViewport,
      });
    }
  });

  it("opens the sheet on a pull-up drag of the grabber", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    // A deliberate upward drag past the distance threshold opens it.
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("keeps routed-view clearance fixed while the collapsed sheet is dragged open", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let panelHeight = 72;
    let publishPanelResize: (() => void) | undefined;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(
        () =>
          ({
            width: 380,
            height: panelHeight,
            x: 0,
            y: 0,
            top: 0,
            right: 380,
            bottom: panelHeight,
            left: 0,
            toJSON: () => ({}),
          }) as DOMRect,
      );
    class TestResizeObserver {
      constructor(private callback: () => void) {}
      observe(target: Element) {
        if (target.getAttribute("data-testid") === "chat-sheet") {
          publishPanelResize = this.callback;
        }
      }
      disconnect() {}
    }
    try {
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      render(<ChatOverlay controller={makeController()} />);
      const clearance = () =>
        document.documentElement.style.getPropertyValue(
          "--eliza-chat-clearance",
        );
      expect(clearance()).toBe("80px");
      expect(publishPanelResize).toBeTypeOf("function");
      const grabber = screen.getByTestId("chat-sheet-grabber");
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
      await act(async () => {
        await new Promise(requestAnimationFrame);
      });
      panelHeight = 212;
      // A delivery queued before the observer disconnects must not publish the
      // growing sheet as the resting composer footprint.
      act(() => publishPanelResize?.());
      expect(clearance()).toBe("80px");
      fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
      act(() => publishPanelResize?.());
      expect(clearance()).toBe("80px");
    } finally {
      cleanup();
      rectSpy.mockRestore();
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
      document.documentElement.style.removeProperty("--eliza-chat-clearance");
    }
  });

  // #14331: the waveform reflects only spoken-conversation capture. Dedicated
  // transcription replaces it with the neutral activity presentation below.
  describe("voice activity cues while capture is hot (#14331)", () => {
    it("does not pulse the mic while idle (neutral resting, no motion)", () => {
      render(<ChatOverlay controller={makeController()} />);
      const mic = screen.getByTestId("chat-composer-mic");
      expect(mic.className).not.toContain("animate-pulse");
      expect(mic.className).not.toContain("text-accent");
    });

    it("keeps the hands-free stop glyph static while the activity surface owns motion", () => {
      render(
        <ChatOverlay
          controller={makeController({ handsFree: true, recording: true })}
        />,
      );
      const stop = screen.getByTestId("chat-composer-mic");
      expect(stop.className).not.toContain("animate-pulse");
      expect(stop.className).toContain("text-inverse");
      expect(stop.className).not.toContain("text-accent");
      expect(stop.getAttribute("aria-label")).toBe("end conversation");
    });

    it("keeps the pulsing waveform neutral during voice capture", () => {
      render(<ChatOverlay controller={makeController({ recording: true })} />);
      const waveform = screen.getByTestId("chat-composer-mic");
      expect(waveform.className).toContain("animate-pulse");
      expect(waveform.className).not.toContain("text-accent");
    });

    it("drops the pulse the moment the capture predicate clears", () => {
      const { rerender } = render(
        <ChatOverlay controller={makeController({ recording: true })} />,
      );
      expect(screen.getByTestId("chat-composer-mic").className).toContain(
        "animate-pulse",
      );
      rerender(
        <ChatOverlay controller={makeController({ recording: false })} />,
      );
      expect(screen.getByTestId("chat-composer-mic").className).not.toContain(
        "animate-pulse",
      );
    });

    it("breathes the collapsed pill bar in white only while listening", () => {
      const { rerender } = render(
        <ChatOverlay controller={makeController()} />,
      );
      const sheet = screen.getByTestId("chat-sheet");
      const spanOf = () =>
        screen.getByTestId("chat-pill").querySelector("span");
      const barOf = () => spanOf()?.className ?? "";
      expect(barOf()).not.toContain("eliza-chat-handle-breathe");
      // The canonical handle surface owns explicit wallpaper-white paint rather
      // than inheriting an ambient muted token outside the panel theme.
      expect(barOf()).toContain("chat-handle-bar-surface");
      rerender(
        <ChatOverlay
          controller={makeController({ phase: "listening", recording: true })}
        />,
      );
      const grabber = screen.getByTestId("chat-sheet-grabber");
      fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
      expect(sheet.getAttribute("data-detent")).toBe("pill");
      expect(barOf()).toContain("eliza-chat-handle-breathe");
      expect(barOf()).not.toContain("shimmer");
      expect(barOf()).not.toContain("background-clip");
      expect(barOf()).not.toContain("bg-accent");
      expect(barOf()).not.toContain("animate-pulse");
      expect(barOf()).toContain("chat-handle-bar-surface");
    });
  });

  it("toggles the sheet open and closed on repeated grabber taps", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    // A real touch gesture also emits touchend after pointerup. The handle has
    // moved by then, so suppress the browser's compatibility click before it
    // can re-hit-test onto and focus the composer underneath the old point.
    expect(fireEvent.touchEnd(grabber)).toBe(false);

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("collapses an open sheet when a control-heavy view requests focus", () => {
    render(<ChatOverlay controller={makeController()} initialMode="half" />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent(window, new CustomEvent("eliza:chat:close"));

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("opens a loading conversation on the first grabber tap", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        })}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("leaves a horizontal swipe on the collapsed grabber to the combined home/apps surface", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 120,
      clientY: 414,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("dismisses the OPEN sheet to the pill on a horizontal swipe (left), never navigating", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    // Open the sheet first (tap → half detent).
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    // Drag the open chat sideways → dismiss to the pill (the put-the-chat-away
    // landing). Collapsed horizontal gestures have no navigation meaning.
    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 200,
      pointerId: 2,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 120,
      clientY: 206,
      pointerId: 2,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 120,
      clientY: 206,
      pointerId: 2,
    });

    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(getShellSurface().page).toBe("home");
  });

  it("dismisses the OPEN sheet to the pill on a horizontal swipe (right) too", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 420, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");

    fireEvent.pointerDown(grabber, {
      clientX: 120,
      clientY: 200,
      pointerId: 2,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 280,
      clientY: 206,
      pointerId: 2,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 280,
      clientY: 206,
      pointerId: 2,
    });

    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(getShellSurface().page).toBe("home");
  });

  it("ignores a collapsed grabber flick whose moves were coalesced into the release", () => {
    // REAL touch on a janked Android WebView delivers pointerdown → pointerup
    // with the whole travel between them (every pointermove coalesced away).
    // The unified surface has no horizontal destination, so the release must
    // stay inert rather than opening chat or changing shell state.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerUp(grabber, {
      clientX: 110,
      clientY: 414,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("ignores a collapsed grabber flick that ends in pointercancel", () => {
    // Android's touch pipeline can revoke the pointer AFTER the finger already
    // completed a horizontal track (renderer-unresponsive ack timeout). With
    // no horizontal destination, cancel must leave the shell unchanged.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(getShellSurface().page).toBe("home");

    fireEvent.pointerDown(grabber, {
      clientX: 260,
      clientY: 420,
      pointerId: 1,
    });
    fireEvent.pointerMove(grabber, {
      clientX: 110,
      clientY: 414,
      pointerId: 1,
    });
    fireEvent.pointerCancel(grabber, {
      clientX: 0,
      clientY: 0,
      pointerId: 1,
    });

    expect(getShellSurface().page).toBe("home");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  // Regression guard for #9142: the grabber bar was hardcoded `opacity-0`
  // unconditionally, so on desktop/web (no OS home indicator) the handle was
  // grabbable but the bar never painted. It must be visible off-iOS.
  it("paints a visible grabber bar off-iOS (sheet grabber + pill)", () => {
    render(<ChatOverlay controller={makeController()} />);
    // The test runtime resolves the Capacitor platform to "web", so isIOS is
    // false and both bars must render visibly (opacity-100, not opacity-0).
    const grabberBar = screen
      .getByTestId("chat-sheet-grabber")
      .querySelector("span[aria-hidden='true']");
    expect(grabberBar).toBeTruthy();
    expect(grabberBar?.className).toContain("opacity-100");
    expect(grabberBar?.className).not.toContain("opacity-0");

    const pillBar = screen
      .getByTestId("chat-pill")
      .querySelector("span[aria-hidden='true']");
    expect(pillBar).toBeTruthy();
    expect(pillBar?.className).toContain("opacity-100");
    expect(pillBar?.className).not.toContain("opacity-0");
  });

  it("steps COLLAPSED→HALF→FULL on successive pull-ups and back down again", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const pull = (fromY: number, toY: number) => {
      fireEvent.pointerDown(grabber, { clientY: fromY, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: toY, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: toY, pointerId: 1 });
    };
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    pull(420, 280); // up → HALF (one step, not straight to full)
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(420, 280); // up → FULL
    expect(sheet.getAttribute("data-detent")).toBe("full");
    pull(280, 420); // down → HALF
    expect(sheet.getAttribute("data-detent")).toBe("half");
    pull(280, 420); // down → COLLAPSED
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("keeps the transcript mounted while a downward flick collapses HALF→INPUT", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const flick = (fromY: number, toY: number) => {
      fireEvent.pointerDown(grabber, { clientY: fromY, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: toY, pointerId: 1 });
      fireEvent.pointerUp(grabber, { clientY: toY, pointerId: 1 });
    };

    flick(420, 280);
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-thread")).toBeTruthy();

    // Less than the distance threshold: synchronous release velocity chooses
    // the flick-detent path rather than the deliberate free-drag settle.
    flick(280, 304);
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-revealed")).toBe("true");
    expect(screen.getByTestId("chat-thread")).toBeTruthy();
    expect(
      document.getElementById("continuous-thread")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      document.getElementById("continuous-thread")?.getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("lands full when a collapsed drag is released above the half threshold", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    fireEvent.pointerDown(grabber, { clientY: 700, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 80, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 80, pointerId: 1 });

    expect(sheet.getAttribute("data-detent")).toBe("full");
  });

  it("opens on a fast flick even below the distance threshold (velocity)", () => {
    // Velocity = distance / event-timestamp delta. Pin the clock so a loaded
    // runner's slow event dispatch cannot dilute the flick below threshold.
    const now = vi.spyOn(performance, "now");
    const eventTimeStamp = vi
      .spyOn(Event.prototype, "timeStamp", "get")
      .mockImplementation(() => performance.now() || Number.MIN_VALUE);
    try {
      render(<ChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");
      // 15px travel (< 56px distance threshold) in 10ms → 1.5 px/ms flick.
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      now.mockReturnValue(5);
      fireEvent.pointerMove(grabber, { clientY: 405, pointerId: 1 });
      now.mockReturnValue(10);
      fireEvent.pointerUp(grabber, { clientY: 405, pointerId: 1 });
      expect(sheet.getAttribute("data-detent")).toBe("half");
    } finally {
      eventTimeStamp.mockRestore();
      now.mockRestore();
    }
  });

  it("springs back to the input when a slow downward drift stays above the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    // Changed-file coverage runs this test without the package setup that
    // bridges DOM event timestamps to the mocked monotonic clock.
    const eventTimeStamp = vi
      .spyOn(Event.prototype, "timeStamp", "get")
      .mockImplementation(() => performance.now() || Number.MIN_VALUE);
    try {
      render(<ChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 450, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 450, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    } finally {
      eventTimeStamp.mockRestore();
      now.mockRestore();
    }
  });

  it("collapses to the pill when a slow downward drag crosses the pill threshold", () => {
    const now = vi.spyOn(performance, "now");
    try {
      render(<ChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");

      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      now.mockReturnValue(0);
      fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
      fireEvent.pointerMove(grabber, { clientY: 500, pointerId: 1 });
      now.mockReturnValue(800);
      fireEvent.pointerUp(grabber, { clientY: 500, pointerId: 1 });

      expect(sheet.getAttribute("data-detent")).toBe("pill");
    } finally {
      now.mockRestore();
    }
  });

  it("opens to HALF when sending (conversation above the keyboard, not a full-screen takeover)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const input = screen.getByLabelText("message");
    fireEvent.change(input, { target: { value: "ping" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("half");
  });

  it("exposes the mic control with a stable test id at rest", () => {
    render(<ChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-mic")).toBeTruthy();
  });

  it("keeps the persistent composer at 16px on coarse pointers", async () => {
    await act(async () => {
      render(<ChatOverlay controller={makeController()} />);
    });
    const className = screen.getByTestId("chat-composer-textarea").className;
    expect(className).toContain("text-sm");
    expect(className).toContain("pointer-coarse:text-[16px]");
  });

  it("renders composer controls icon-only — no capsule/border/fill, neutral when active (#10711)", () => {
    // Resting: the + and one primary Talk control carry only the icon — no
    // round capsule, no border, no translucent white fill. The visible box is
    // 40px with a 20px mark (the "icons slightly too big" fix); the shared
    // Button primitive raises the real box to 44×44 on coarse pointers.
    const { unmount } = render(<ChatOverlay controller={makeController()} />);
    for (const id of ["chat-composer-plus", "chat-composer-mic"]) {
      const cls = screen.getByTestId(id).className;
      expect(cls).not.toMatch(/rounded-full/);
      expect(cls).not.toMatch(/\bborder\b/);
      expect(cls).not.toMatch(/bg-white/);
      expect(cls).toContain("bg-transparent");
      expect(cls).toContain("h-10");
      expect(cls).toContain("w-10");
      expect(cls).not.toContain("h-11");
      // The tighter 20px glyph (down from 22px)…
      expect(cls).toContain("[&_svg]:size-5");
      // …with a non-overlapping real 44px target on touch hardware.
      expect(cls).toContain("pointer-coarse:min-h-touch");
      expect(cls).toContain("pointer-coarse:min-w-touch");
      expect(cls).not.toContain("before:-inset-0.5");
    }
    unmount();

    // Active (hands-free): distinguishable via its stop glyph and pressed state,
    // never by reintroducing a background/border fill or competing animation.
    render(<ChatOverlay controller={makeController({ handsFree: true })} />);
    const mic = screen.getByTestId("chat-composer-mic");
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.className).toContain("text-inverse");
    expect(mic.className).not.toContain("text-accent");
    expect(mic.className).not.toContain("animate-pulse");
    expect(mic.className).not.toMatch(/bg-white/);
    expect(mic.className).not.toMatch(/\bborder\b/);
  });

  it("never renders a resting suggestion strip (removed — the agent is proactive)", () => {
    render(<ChatOverlay controller={makeController({ messages: [] })} />);
    expect(screen.queryByTestId("chat-suggestions")).toBeNull();
    expect(screen.queryByTestId("chat-suggestion-0")).toBeNull();
  });

  it("filters whitespace-only messages from the expanded thread", () => {
    render(<ChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    expect(log?.textContent).toContain("hi there");
    // one real message → exactly one transcript bubble
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(1);
  });

  it("renders a single-topic thread without topic chrome", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            {
              id: "a",
              role: "assistant",
              content: "hey, how can I help?",
              createdAt: 1,
              topics: ["greeting"],
            },
            {
              id: "b",
              role: "user",
              content: "just saying hi",
              createdAt: 2,
              topics: ["greeting"],
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByTestId("topic-chips-bar")).toBeNull();
    expect(screen.queryByTestId("topic-group-header")).toBeNull();
    expect(screen.queryByTestId("topic-group-pill")).toBeNull();
    const log = document.getElementById("continuous-thread");
    expect(log?.textContent).toContain("how can I help");
  });

  it("renders multiple-topic messages as one flat chronological transcript", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            {
              id: "a",
              role: "user",
              content: "deploy failing",
              createdAt: 1,
              topics: ["deployment"],
            },
            {
              id: "b",
              role: "user",
              content: "and my card was charged twice",
              createdAt: 2,
              topics: ["billing"],
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByTestId("topic-chips-bar")).toBeNull();
    expect(screen.queryByTestId("topic-group-header")).toBeNull();
    expect(screen.queryByTestId("topic-group-pill")).toBeNull();
    const lines = screen.getAllByTestId("thread-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toContain("deploy failing");
    expect(lines[1]?.textContent).toContain("charged twice");
  });

  it("aligns the assistant bubble left and the user bubble right", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
            { id: "b", role: "user", content: "hello back", createdAt: 2 },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const log = document.getElementById("continuous-thread");
    const lines = log?.querySelectorAll('[data-testid="thread-line"]');
    expect(lines?.length).toBe(2);
    const assistant = log?.querySelector('[data-role="assistant"]');
    const user = log?.querySelector('[data-role="user"]');
    expect(assistant?.getAttribute("data-align")).toBe("start");
    expect(user?.getAttribute("data-align")).toBe("end");
    expect(user?.className).not.toContain("justify-end");
    expect(
      log?.querySelector('[data-slot="message-scroller-content"]')?.className,
    ).toContain("pt-8");
  });

  it("reconciles optimistic turns without retaining animated duplicate rows", () => {
    const optimistic = makeController({
      messages: [
        {
          id: "temp-turn",
          role: "user",
          content: "hello",
          createdAt: 1,
        },
        {
          id: "temp-resp-turn",
          role: "assistant",
          content: "hi there",
          createdAt: 2,
        },
      ],
    });
    const { rerender } = render(<ChatOverlay controller={optimistic} />);
    fireEvent.focus(screen.getByLabelText("message"));

    const thread = document.getElementById("continuous-thread");
    expect(
      thread?.querySelectorAll('[data-testid="thread-line"]'),
    ).toHaveLength(2);

    rerender(
      <ChatOverlay
        controller={makeController({
          messages: [
            { id: "user-1", role: "user", content: "hello", createdAt: 1 },
            {
              id: "assistant-1",
              role: "assistant",
              content: "hi there",
              createdAt: 2,
            },
          ],
        })}
      />,
    );

    const rows = thread?.querySelectorAll('[data-testid="thread-line"]');
    expect(rows).toHaveLength(2);
    expect(thread?.querySelector('[data-message-id^="temp-"]')).toBeNull();
  });

  it("paints optimistic turns immediately during a fast view handoff", () => {
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          messages: [
            {
              id: "assistant-old",
              role: "assistant",
              content: "Earlier reply",
              createdAt: 1,
            },
          ],
        })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    rerender(
      <ChatOverlay
        controller={makeController({
          messages: [
            {
              id: "assistant-old",
              role: "assistant",
              content: "Earlier reply",
              createdAt: 1,
            },
            {
              id: "temp-navigation-request",
              role: "user",
              content: "open notes",
              createdAt: 2,
            },
            {
              id: "temp-navigation-reply",
              role: "assistant",
              content: "Opened Notes.",
              createdAt: 3,
            },
          ],
        })}
      />,
    );

    for (const text of ["open notes", "Opened Notes."]) {
      const row = screen
        .getByText(text)
        .closest<HTMLElement>('[data-testid="thread-line"]');
      expect(row).not.toBeNull();
      expect(row?.style.opacity).not.toBe("0");
    }
  });

  it("composes the in-flight status as a busy transcript row", () => {
    render(
      <ChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          messages: [
            { id: "u", role: "user", content: "hello", createdAt: 1 },
            { id: "a", role: "assistant", content: "", createdAt: 2 },
          ],
          turnStatus: { kind: "thinking" },
        })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const viewport = screen.getByTestId("chat-thread-scroll");
    const content = viewport.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    );
    const row = screen
      .getByTestId("turn-status-indicator")
      .closest<HTMLElement>('[data-slot="message-scroller-item"]');
    expect(viewport.getAttribute("aria-live")).toBeNull();
    expect(content?.getAttribute("role")).toBe("log");
    expect(content?.getAttribute("aria-busy")).toBe("true");
    expect(content?.className).toContain("justify-end");
    expect(content?.className).toContain("pb-3");
    expect(row?.parentElement).toBe(content);
    expect(row?.className).toContain("w-full");
  });

  it("keeps the expanded transcript free of decorative lighting beneath the grabber", () => {
    render(<ChatOverlay controller={makeController()} />);
    fireEvent.focus(screen.getByLabelText("message"));

    const rim = screen.getByTestId("chat-sheet-rim");
    const surface = screen.getByTestId("chat-sheet-surface");
    const viewport = screen.getByTestId("chat-thread-scroll");
    expect(screen.queryByTestId("chat-thread-top-fade")).toBeNull();
    expect(screen.queryByTestId("chat-sheet-top-sheen")).toBeNull();
    expect(rim.className).toContain("z-40");
    expect(rim.className).toContain("border-border-strong");
    expect(surface.style.getPropertyValue("--chat-sheet-shadow")).toBe("none");
    expect(surface.style.getPropertyValue("--chat-sheet-image")).toBe("none");
    expect(surface.className.split(/\s+/)).not.toContain("border");
    const content = screen.getByTestId("chat-content");
    expect(content.style.clipPath).toContain("inset(1px round");
    expect(viewport.style.maskImage).toBe("");
    expect(viewport.style.webkitMaskImage).toBe("");
  });
  it("closes the sheet on Escape", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("closes the sheet and marks the intent handled on an Android back-intent while open", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message");
    const sheet = screen.getByTestId("chat-sheet");
    // Open the sheet (type-to-open → half detent).
    fireEvent.focus(input);
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // main.tsx dispatches this synchronously and reads back `detail.handled`.
    const detail = { handled: false };
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }),
      );
    });

    expect(detail.handled).toBe(true);
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("leaves the Android back-intent unhandled while the sheet is at rest (native falls through)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    // At rest: the sheet is closed (collapsed input bar), not opened.
    expect(sheet.getAttribute("data-variant")).toBe("closed");

    const detail = { handled: false };
    act(() => {
      window.dispatchEvent(
        new CustomEvent(ELIZA_BACK_INTENT_EVENT, { detail }),
      );
    });

    // Nothing consumed it, so main.tsx would fall through to history.back() /
    // minimizeApp(); the sheet stays closed.
    expect(detail.handled).toBe(false);
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("collapsing blurs the composer so the mobile keyboard drops", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.focus(input); // onFocus → expand → sheetOpen true (flushed by act)
    input.focus(); // also move real activeElement (jsdom fireEvent.focus doesn't)
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Escape" }); // sheetOpen → collapse → blur
    expect(document.activeElement).not.toBe(input);
  });

  it("tapping outside the panel blurs the composer (drops the keyboard)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    input.focus();
    expect(document.activeElement).toBe(input);
    // A pointerdown anywhere outside the chat panel dismisses the keyboard.
    fireEvent.pointerDown(document.body);
    expect(document.activeElement).not.toBe(input);
  });

  it.each(["mouse", "touch"])(
    "lets a %s tap activate the view back button without consuming the chat draft",
    (pointerType) => {
      function ActiveView() {
        const [notesOpen, setNotesOpen] = React.useState(true);
        return (
          <>
            {notesOpen ? (
              <ViewBackButton onBack={() => setNotesOpen(false)} />
            ) : (
              <h1>Home</h1>
            )}
            <ChatOverlay controller={makeController()} />
          </>
        );
      }
      render(<ActiveView />);
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      // Model handoffs keep an already-open chat focused. Unlike focus from
      // collapsed, outside pointerdown must not unmount the capture handlers.
      fireEvent.focus(input);
      act(() => input.focus());
      fireEvent.change(input, { target: { value: "Keep this draft" } });
      const back = screen.getByRole("button", { name: "Back to launcher" });
      const icon = back.querySelector("svg");
      if (!icon) throw new Error("Back control must render its icon target");
      const pointer = {
        pointerId: 41,
        pointerType,
        button: 0,
        clientX: 24,
        clientY: 24,
      };
      fireEvent.pointerDown(icon, pointer);
      fireEvent.pointerUp(icon, pointer);
      fireEvent.click(icon, { clientX: 24, clientY: 24 });

      expect(screen.getByRole("heading", { name: "Home" })).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
      expect(input.value).toBe("Keep this draft");
      expect(
        screen.getByTestId("chat-sheet").getAttribute("data-variant"),
      ).toBe("open");
    },
  );

  it("composes multi-line with an auto-growing textarea (Enter still sends)", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    expect(input.tagName).toBe("TEXTAREA");
    // Shift+Enter must NOT submit (it inserts a newline); plain Enter submits.
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(controller.send).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("line one");
  });

  it("releases stale inline height when the composer becomes empty", () => {
    render(<ChatOverlay controller={makeController()} />);
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      value: 190,
    });

    fireEvent.change(input, { target: { value: "wrapped draft" } });
    expect(input.style.height).toBe("190px");

    fireEvent.change(input, { target: { value: "" } });
    expect(input.style.height).toBe("");
  });

  it("closes the sheet on a pull-down drag of the grabber", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("fades the backdrop in with the chat and COLLAPSES on an outside tap", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const backdrop = screen.getByTestId("chat-sheet-backdrop");
    // Collapsed: inactive + click-through (the live view behind stays usable).
    expect(backdrop.getAttribute("data-active")).toBe("false");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(backdrop.getAttribute("data-active")).toBe("true");
    // Tapping the dimmed view behind collapses the chat back to the input while
    // the visual backdrop itself remains pointer-transparent for drags.
    fireEvent.pointerDown(backdrop, { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.pointerUp(backdrop, { clientX: 20, clientY: 20, pointerId: 1 });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("collapses an open desktop chat when the user clicks another window", () => {
    const onStateChange = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        onStateChange={onStateChange}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(onStateChange).toHaveBeenLastCalledWith("OPEN_HALF_OR_OVER");

    emitDesktopWindowBlur();

    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");
  });

  it("cedes taps to a layer painted ABOVE the chat (stacked dialog) instead of collapsing", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Simulate a Radix dialog stacked above the chat glass (role="dialog" or
    // data-above-shell-overlay): its taps must NOT be swallowed into a chat
    // collapse — the overlay's own handlers win.
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    const rowButton = document.createElement("button");
    overlay.appendChild(rowButton);
    document.body.appendChild(overlay);
    try {
      fireEvent.pointerDown(rowButton, {
        clientX: 30,
        clientY: 30,
        pointerId: 5,
      });
      fireEvent.pointerUp(rowButton, {
        clientX: 30,
        clientY: 30,
        pointerId: 5,
      });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      overlay.remove();
    }
  });

  it("cedes taps to the INLINE home notification center (below the glass) instead of collapsing (device r8)", () => {
    // #15080 moved the notification inbox inline on the home column, BELOW the
    // chat glass (not the old Z_NOTIFICATION_OVERLAY shade). Its rows are live
    // interactive surfaces: without an exemption the outside-tap collapse-
    // swallower ate the row's tap (preventDefault + suppressNextOutsideClick),
    // so tapping a notification did NOTHING ("interacting is cooked"). The
    // swallower exempts [data-notif-row]; a tap on a row must leave the chat
    // OPEN and not be swallowed.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Mirror the notification center's real markers: a [data-notif-row] li with
    // its open button, under the [data-testid="home-notification-center"] host.
    const center = document.createElement("section");
    center.setAttribute("data-testid", "home-notification-center");
    const row = document.createElement("li");
    row.setAttribute("data-notif-row", "");
    const rowButton = document.createElement("button");
    let opened = false;
    rowButton.addEventListener("click", () => {
      opened = true;
    });
    row.appendChild(rowButton);
    center.appendChild(row);
    document.body.appendChild(center);
    try {
      fireEvent.pointerDown(rowButton, {
        clientX: 40,
        clientY: 40,
        pointerId: 7,
      });
      fireEvent.pointerUp(rowButton, {
        clientX: 40,
        clientY: 40,
        pointerId: 7,
      });
      // The chat stays open (tap NOT swallowed into a collapse)...
      expect(sheet.getAttribute("data-variant")).toBe("open");
      // ...and the row's own click is NOT suppressed by the swallower.
      fireEvent.click(rowButton, { clientX: 40, clientY: 40 });
      expect(opened).toBe(true);
    } finally {
      center.remove();
    }
  });

  it("still collapses on a tap of the notification center's bare field (not a row)", () => {
    // The exemption is scoped to [data-notif-row], not the whole flex-1
    // chromeless center section. A tap on the bare field AROUND the rows (which
    // looks like plain home background) must still collapse the chat — exempting
    // the whole section made most of the home band a dead zone (#15145 review).
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    // Focus alone keeps the sheet open but arms composerFocusedAtPress; blur so
    // the tap-outside path collapses rather than just clearing focus.
    fireEvent.blur(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    const center = document.createElement("section");
    center.setAttribute("data-testid", "home-notification-center");
    document.body.appendChild(center);
    try {
      fireEvent.pointerDown(center, { clientX: 40, clientY: 40, pointerId: 9 });
      fireEvent.pointerUp(center, { clientX: 40, clientY: 40, pointerId: 9 });
      expect(sheet.getAttribute("data-variant")).toBe("closed");
    } finally {
      center.remove();
    }
  });

  it("lets an open dialog own Escape — the chat only collapses once the dialog is gone", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // An open Radix dialog (e.g. the command palette) above the chat: Escape
    // must close IT, not also collapse the chat underneath.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      dialog.remove();
    }
    // Dialog gone: Escape collapses the chat as before.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("lets the transcript viewer own Escape — the chat only collapses once the viewer is gone (#9148)", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // The maximized transcript viewer (portal to body) carries role="dialog"
    // but NO data-state="open", so it wouldn't match the old guard — Escape
    // would close it AND collapse the chat underneath. It must close alone.
    const viewer = document.createElement("div");
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("data-testid", "transcript-viewer");
    document.body.appendChild(viewer);
    try {
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(sheet.getAttribute("data-variant")).toBe("open");
    } finally {
      viewer.remove();
    }
    // Viewer gone: Escape collapses the chat as before.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("Escape closes an in-progress message edit without collapsing the whole sheet (#9148)", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            { id: "u", role: "user", content: "fix my typo", createdAt: 1 },
          ],
          send: vi.fn(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    // Open the inline editor for the user turn.
    const bubble = screen
      .getByText("fix my typo")
      .closest('[data-testid="thread-line"]')
      ?.querySelector("div.select-text") as HTMLElement;
    fireEvent.click(bubble);
    fireEvent.click(screen.getByTestId("thread-line-edit"));
    const editInput = screen.getByTestId("thread-line-edit-input");

    // Escape closes THE EDITOR, and the sheet stays open (the edit-in-progress
    // must not be collapsed away with the whole chat).
    fireEvent.keyDown(editInput, { key: "Escape" });
    expect(screen.queryByTestId("thread-line-edit-input")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("renders the full thread as one scroll log when the sheet is open", () => {
    const controller = makeController({
      messages: [
        { id: "a", role: "assistant", content: "one", createdAt: 1 },
        { id: "b", role: "user", content: "two", createdAt: 2 },
        { id: "c", role: "assistant", content: "three", createdAt: 3 },
      ],
    } as unknown as Partial<ShellController>);
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));

    // The full transcript is one vertical scroll region while open.
    const log = document.getElementById("continuous-thread");
    expect(log?.querySelectorAll('[data-testid="thread-line"]').length).toBe(3);
    expect(log?.className).toContain("overflow-y-auto");
    // Vertical-only invariant (#14328): the horizontal axis is pinned closed so
    // an over-wide child can never turn the transcript into a two-axis scroller.
    expect(log?.className).toContain("overflow-x-hidden");
    expect(log?.textContent).toContain("one");
  });

  it("does not mount hidden header or transcript layers while collapsed", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-revealed")).toBe("false");
    expect(sheet.getAttribute("data-header-shown")).toBe("false");
    expect(document.getElementById("continuous-thread")).toBeNull();
    expect(screen.queryByTestId("chat-thread")).toBeNull();
    expect(screen.queryByTestId("chat-full-launcher")).toBeNull();

    const grabber = screen.getByTestId("chat-sheet-grabber");
    // The grab zone reaches a comfortable distance ABOVE the composer (so a
    // swipe-up begun just over it opens the chat) but stays bounded — it never
    // balloons up into the home widgets.
    expect(grabber.className).toContain("before:-top-6");
    expect(grabber.className).not.toContain("before:-top-16");
    expect(grabber.className).toContain("inset-x-[4.5rem]");
    expect(grabber.className).not.toContain("inset-x-6");
  });

  it("keeps the collapsed grabber and chat actions as exclusive gesture owners", () => {
    const parentPointerDown = vi.fn();
    render(
      <div onPointerDown={parentPointerDown}>
        <ChatOverlay controller={makeController()} />
      </div>,
    );

    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 51,
      pointerType: "mouse",
    });
    expect(parentPointerDown).not.toHaveBeenCalled();

    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, {
      button: 0,
      pointerId: 52,
      pointerType: "mouse",
      clientY: 420,
    });
    expect(parentPointerDown).not.toHaveBeenCalled();
  });

  it("mounts an inert transcript preview during an upward drag before release", async () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");

    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(screen.queryByTestId("chat-thread")).toBeNull();

    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 340, pointerId: 1 });

    const thread = await waitFor(() => screen.getByTestId("chat-thread"));
    const log = document.getElementById("continuous-thread");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-revealed")).toBe("true");
    expect(thread).toBeTruthy();
    expect(log?.getAttribute("aria-hidden")).toBe("true");
    expect(log?.getAttribute("tabindex")).toBe("-1");
  });

  it("shows the attach (+) control", () => {
    render(<ChatOverlay controller={makeController()} />);
    expect(screen.getByTestId("chat-composer-plus")).toBeTruthy();
    expect(screen.getByLabelText("chat actions")).toBeTruthy();
  });

  it("attaches an image and enables an image-only send", async () => {
    const controller = makeController({ messages: [] });
    render(<ChatOverlay controller={controller} />);
    // Empty draft + no image → mic, no send.
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByLabelText("send")).toBeNull();

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Once the read resolves, a thumbnail + send control appear.
    await screen.findByLabelText("send");
    const removeButton = screen.getByLabelText(/remove pic\.png/);
    expect(removeButton).toBeTruthy();
    expect(removeButton.className).toContain("pointer-events-auto");

    const attachments = screen.getByTestId("chat-pending-attachments");
    expect(attachments.className).toContain("pointer-events-none");
    const attachmentList = screen.getByTestId("chat-pending-attachment-list");
    expect(attachmentList.className).toContain("pointer-events-auto");
    expect(attachmentList.className).toContain("touch-none");
    expect(removeButton.className).toContain("-bottom-1.5");

    // Pending attachments must not disable the sheet's own drag handle. The
    // attachment tiles have their own controls; the handle remains the path to
    // reveal history without requiring the user to send or remove the image.
    const grabber = screen.getByTestId("chat-sheet-grabber");
    expect(grabber.style.pointerEvents).toBe("auto");
    fireEvent.pointerDown(attachmentList, { clientY: 420, pointerId: 21 });
    fireEvent.pointerMove(attachmentList, { clientY: 340, pointerId: 21 });
    await waitFor(() => expect(screen.getByTestId("chat-thread")).toBeTruthy());
    fireEvent.pointerUp(attachmentList, { clientY: 340, pointerId: 21 });

    fireEvent.click(screen.getByLabelText("send"));
    expect(controller.send).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ name: "pic.png", mimeType: "image/png" }),
        ]),
      }),
    );
  });

  it("clears the view search when sending the draft to the agent", () => {
    const onQuery = vi.fn();
    setViewChatBinding({ onQuery });
    const controller = makeController({ messages: [] });
    render(<ChatOverlay controller={controller} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "Save a document here" },
    });
    fireEvent.click(screen.getByLabelText("send"));
    expect(controller.send).toHaveBeenCalledWith("Save a document here");
    expect(onQuery).toHaveBeenLastCalledWith("");
  });

  it("a view-binding does NOT claim an image-bearing turn (images must not be lost)", async () => {
    // A focused cockpit session registers a text-only onSubmit binding. A turn
    // that also carries an image must fall through to the host agent (which can
    // send images), not be claimed by the binding — else the image vanishes.
    const onSubmit = vi.fn(() => true);
    setViewChatBinding({ onSubmit });
    const controller = makeController({ messages: [] });
    render(<ChatOverlay controller={controller} />);

    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["x"], "pic.png", { type: "image/png" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await screen.findByLabelText("send");
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "analyze this" },
    });

    fireEvent.click(screen.getByLabelText("send"));
    // binding must NOT have claimed it; host agent gets the text + image.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(controller.send).toHaveBeenCalledWith(
      "analyze this",
      expect.objectContaining({
        images: expect.arrayContaining([
          expect.objectContaining({ name: "pic.png" }),
        ]),
      }),
    );
  });

  it("toggles hands-free conversation when the mic is tapped", () => {
    const controller = makeController();
    render(<ChatOverlay controller={controller} />);
    fireEvent.click(screen.getByLabelText("talk"));
    expect(controller.toggleHandsFree).toHaveBeenCalled();
  });

  it("shows a waking-up placeholder while booting (typing allowed)", () => {
    render(
      <ChatOverlay
        controller={makeController({ phase: "booting", canSend: false })}
      />,
    );
    const input = screen.getByLabelText("message");
    expect(input.getAttribute("placeholder")).toContain("waking up");
    // You can type while the agent boots; the message sends once it's ready.
    expect(input.hasAttribute("readonly")).toBe(false);
  });

  it("uses the pulsing composer glyph instead of rendering interim transcript text", () => {
    render(
      <ChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
          transcript: "tell me about the coast",
        })}
      />,
    );
    expect(screen.queryByText(/tell me about the coast/)).toBeNull();
    // The "capture is hot" cue is the composer voice glyph's accent pulse —
    // NOT the drag handle: while the composer is visible the handle stays
    // quiet during a recording (a second pulsing bar right above the already-
    // pulsing glyph read as noise). Only the collapsed PILL pulses for a live
    // capture (see the morph regression suite).
    expect(screen.getByTestId("chat-composer-mic").className).toContain(
      "animate-pulse",
    );
    const grabberCue = screen
      .getByTestId("chat-sheet-grabber")
      .querySelector("span");
    expect(grabberCue?.className).not.toContain("animate-pulse");
  });

  it.each(["listening", "transcribing", "thinking", "speaking"] as const)(
    "renders the realtime %s phase and live Ink transcript",
    (status) => {
      render(
        <ChatOverlay
          controller={makeController({
            handsFree: true,
            recording: status === "listening" || status === "transcribing",
            transcript: "live words from Ink",
            realtimeVoice: {
              enabled: true,
              active: true,
              connecting: false,
              paused: false,
              microphoneMuted: false,
              status,
              error: null,
              toggleMicrophoneMute: vi.fn(),
            },
          })}
        />,
      );

      const activity = screen.getByTestId("chat-composer-realtime-voice");
      expect(activity.getAttribute("data-status")).toBe(status);
      const waveform = screen.getByTestId("chat-composer-realtime-waveform");
      expect(waveform.getAttribute("data-phase")).toBe(status);
      const expectedOrbState = {
        listening: "listening",
        transcribing: "listening",
        thinking: "working",
        speaking: "composing",
      }[status];
      expect(waveform.getAttribute("data-orb-state")).toBe(expectedOrbState);
      const orb = screen.getByTestId("chat-composer-thinking-orb");
      expect(orb.tagName).toBe("CANVAS");
      expect(orb.getAttribute("aria-hidden")).toBe("true");
      expect(orb.getAttribute("style")).toContain("width: 20px");
      expect(orb.getAttribute("style")).toContain("height: 20px");
      expect(activity.querySelector(".rounded-full.size-2")).toBeNull();
      const copy = screen.getByTestId("chat-composer-realtime-copy");
      const expectedPhaseLabel = {
        listening: "Listening…",
        transcribing: "Hearing you…",
        thinking: "Thinking…",
        speaking: "Speaking · mic paused",
      }[status];
      const listening = status === "listening" || status === "transcribing";
      expect(copy.textContent).toBe(
        listening ? "live words from Ink" : expectedPhaseLabel,
      );
      expect(activity.getAttribute("aria-label")).toBe(
        listening
          ? `${expectedPhaseLabel}: live words from Ink`
          : expectedPhaseLabel,
      );
      expect(
        screen
          .getByTestId("chat-composer-voice-mute")
          .getAttribute("aria-disabled"),
      ).toBe(String(status === "speaking"));
      expect(screen.queryByTestId("chat-overlay-voice-status")).toBeNull();
      expect(screen.queryByTestId("chat-composer-textarea")).toBeNull();
      expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
        "half",
      );
    },
  );

  it("keeps the newest wrapped Ink transcript visible without resizing the composer", () => {
    const firstTranscript =
      "This is a longer spoken thought with a manual line break\nand-a-single-unbroken-token-that-must-wrap-on-a-narrow-phone";
    const realtimeVoice = {
      enabled: true,
      active: true,
      connecting: false,
      paused: false,
      microphoneMuted: false,
      status: "listening" as const,
      error: null,
      toggleMicrophoneMute: vi.fn(),
    };
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          handsFree: true,
          recording: true,
          transcript: firstTranscript,
          realtimeVoice,
        })}
      />,
    );

    const activity = screen.getByTestId("chat-composer-realtime-voice");
    const copy = screen.getByTestId("chat-composer-realtime-copy");
    expect(copy.textContent).toBe(firstTranscript);
    expect(copy.getAttribute("title")).toBe(firstTranscript);
    expect(copy.className).not.toContain("truncate");
    expect(copy.className).toContain("whitespace-pre-wrap");
    expect(copy.className).toContain("max-h-10");
    expect(copy.className).toContain("[overflow-wrap:anywhere]");
    expect(copy.parentElement?.className).toContain("h-10");
    expect(activity.getAttribute("aria-label")).toBe(
      `Listening…: ${firstTranscript}`,
    );

    let observedScrollTop = -1;
    Object.defineProperty(copy, "scrollHeight", {
      configurable: true,
      value: 96,
    });
    Object.defineProperty(copy, "scrollTop", {
      configurable: true,
      get: () => observedScrollTop,
      set: (value: number) => {
        observedScrollTop = value;
      },
    });

    const nextTranscript = `${firstTranscript} plus the newest words`;
    rerender(
      <ChatOverlay
        controller={makeController({
          handsFree: true,
          recording: true,
          transcript: nextTranscript,
          realtimeVoice,
        })}
      />,
    );

    expect(screen.getByTestId("chat-composer-realtime-copy")).toBe(copy);
    expect(copy.textContent).toBe(nextTranscript);
    expect(observedScrollTop).toBe(96);

    rerender(
      <ChatOverlay
        controller={makeController({
          handsFree: true,
          recording: false,
          transcript: nextTranscript,
          realtimeVoice: { ...realtimeVoice, status: "thinking" },
        })}
      />,
    );
    expect(copy.textContent).toBe("Thinking…");
    expect(observedScrollTop).toBe(0);
  });

  it("keeps a retryable Cartesia error out of the text input surface", () => {
    render(
      <ChatOverlay
        controller={makeController({
          handsFree: false,
          needsAudioUnlock: true,
          realtimeVoice: {
            enabled: true,
            active: false,
            connecting: false,
            paused: false,
            microphoneMuted: false,
            status: "idle",
            error: "Cartesia voice could not connect. Tap Talk to retry.",
            toggleMicrophoneMute: vi.fn(),
          },
        })}
      />,
    );

    const input = screen.getByTestId("chat-composer-textarea");
    expect(input).toBeTruthy();
    expect(input.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByTestId("chat-composer-realtime-voice")).toBeNull();
    expect(screen.queryByTestId("chat-overlay-voice-status")).toBeNull();
    expect(screen.queryByTestId("overlay-voice-audio-unlock")).toBeNull();
    expect(
      screen.getByTestId("chat-composer-mic").getAttribute("aria-label"),
    ).toContain("retry talk");
  });

  it("exposes the canonical chat composer test id on the overlay input only", () => {
    render(<ChatOverlay controller={makeController()} />);

    expect(screen.getByTestId("chat-composer-textarea")).toBe(
      screen.getByLabelText("message"),
    );
    expect(screen.getAllByTestId("chat-composer-textarea")).toHaveLength(1);
  });

  it("keeps Home above the surface-local search and upload actions", () => {
    render(<ChatOverlay controller={makeController()} />);
    const plus = screen.getByTestId("chat-composer-plus");
    expect(screen.getByLabelText("chat actions")).toBeTruthy();

    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    const home = screen.getByText("Back to Home");
    const search = screen.getByText("Search chat…");
    expect(home).toBeTruthy();
    expect(search).toBeTruthy();
    expect(screen.getByText("Upload file")).toBeTruthy();
    expect(
      home.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Record long-form transcript…")).toBeNull();
    expect(screen.queryByText("Enable camera")).toBeNull();
    expect(screen.queryByText("Stop transcribing")).toBeNull();
  });

  it("grows only the native input host height while the portaled chat-actions menu is open", () => {
    const onStateChange = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        onStateChange={onStateChange}
      />,
    );
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");

    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(screen.getByText("Upload file")).toBeTruthy();
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT_MENU");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");
  });

  it("releases the temporary menu host bounds when the desktop window loses focus", () => {
    const onStateChange = vi.fn();
    render(
      <ChatOverlay
        controller={makeController()}
        onStateChange={onStateChange}
      />,
    );
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");

    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    expect(screen.getByText("Upload file")).toBeTruthy();
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT_MENU");

    emitDesktopWindowBlur();

    expect(screen.queryByText("Upload file")).toBeNull();
    expect(onStateChange).toHaveBeenLastCalledWith("INPUT");
  });

  it("returns to Home from the chat-actions menu", () => {
    const navigateHome = vi.fn();
    render(<ChatOverlay controller={makeController({ navigateHome })} />);

    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByText("Back to Home"));

    expect(navigateHome).toHaveBeenCalledTimes(1);
  });

  it("hides the redundant Home action while already on Home", () => {
    render(<ChatOverlay controller={makeController({ currentTab: "chat" })} />);

    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(screen.queryByText("Back to Home")).toBeNull();
    expect(screen.getByText("Search chat…")).toBeTruthy();
  });

  it("cycles sent messages with desktop arrow keys and restores the draft", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            { id: "u1", role: "user", content: "first", createdAt: 1 },
            {
              id: "a1",
              role: "assistant",
              content: "reply",
              createdAt: 2,
            },
            { id: "u2", role: "user", content: "second", createdAt: 3 },
          ],
        })}
      />,
    );
    const input = screen.getByTestId(
      "chat-composer-textarea",
    ) as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: "unfinished" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("second");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("first");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("second");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("unfinished");
  });

  it.each(["half", "full"] as const)(
    "keeps the %s sheet open while the portaled Upload action opens the file picker",
    (detent) => {
      render(<ChatOverlay controller={makeController()} />);
      const sheet = screen.getByTestId("chat-sheet");
      const grabber = screen.getByTestId("chat-sheet-grabber");
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;

      fireEvent.focus(input);
      expect(sheet.getAttribute("data-detent")).toBe("half");
      if (detent === "full") {
        fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 10 });
        fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 10 });
        fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 10 });
        expect(sheet.getAttribute("data-detent")).toBe("full");
      }

      const fileInput = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      const openPicker = vi
        .spyOn(fileInput, "click")
        .mockImplementation(() => {});
      fireEvent.pointerDown(screen.getByTestId("chat-composer-plus"), {
        button: 0,
        pointerId: 11,
        pointerType: "mouse",
      });
      fireEvent.pointerUp(screen.getByTestId("chat-composer-plus"), {
        button: 0,
        pointerId: 11,
        pointerType: "mouse",
      });
      const upload = screen
        .getByText("Upload file")
        .closest('[role="menuitem"]');
      if (!(upload instanceof HTMLElement)) {
        throw new Error("Upload menu item not found");
      }

      // The regression lives in the document capture handlers; a synthetic
      // click alone cannot prove the portaled menu is treated as sheet chrome.
      fireEvent.pointerDown(upload, {
        button: 0,
        clientX: 40,
        clientY: 40,
        pointerId: 12,
        pointerType: "mouse",
      });
      fireEvent.pointerUp(upload, {
        button: 0,
        clientX: 40,
        clientY: 40,
        pointerId: 12,
        pointerType: "mouse",
      });
      fireEvent.click(upload);

      expect(openPicker).toHaveBeenCalledTimes(1);
      expect(sheet.getAttribute("data-detent")).toBe(detent);
    },
  );

  it("renders no prompt-suggestion chips while the strip is flagged off", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [],
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(
      document.querySelectorAll('[data-testid^="chat-suggestion-"]'),
    ).toHaveLength(0);
  });

  it("keeps a new user turn at the live bottom", async () => {
    const base = [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }];
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          messages: base,
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message")); // open the sheet
    const viewport = screen.getByTestId("chat-thread-scroll");
    let scrollHeight = 400;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, value: 300, writable: true },
    });
    // Messaging-style follow: a new user turn stays at the live bottom instead
    // of using shadcn's optional turn-anchor behavior to move it near the top.
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
    try {
      scrollHeight = 500;
      rerender(
        <ChatOverlay
          controller={makeController({
            messages: [
              ...base,
              { id: "b", role: "user", content: "new line", createdAt: 2 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith(
          expect.objectContaining({ behavior: "auto", top: 400 }),
        );
      });
      expect(
        document
          .querySelector('[data-message-id="b"]')
          ?.getAttribute("data-scroll-anchor"),
      ).toBe("false");
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("reanchors a bottom-pinned transcript during sheet resize without moving a reader in history", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const callbacks = new Map<Element, ResizeObserverCallback[]>();
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        const targetCallbacks = callbacks.get(target) ?? [];
        targetCallbacks.push(this.callback);
        callbacks.set(target, targetCallbacks);
      }
      disconnect() {}
      unobserve() {}
    }

    try {
      vi.stubGlobal("ResizeObserver", TestResizeObserver);
      render(<ChatOverlay controller={makeController()} />);
      fireEvent.focus(screen.getByLabelText("message"));

      const viewport = screen.getByTestId("chat-thread-scroll");
      let clientHeight = 100;
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, get: () => clientHeight },
        scrollHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, value: 400, writable: true },
        // The primitive reconciles its own observer on a queued frame. Keep the
        // real viewport API on this detached jsdom node so that late frame can
        // finish without leaking into the next test.
        scrollTo: { configurable: true, value: vi.fn() },
      });
      const resizeViewport = () => {
        for (const callback of callbacks.get(viewport) ?? []) {
          callback([], {} as ResizeObserver);
        }
      };

      fireEvent.scroll(viewport);
      clientHeight = 80;
      resizeViewport();
      expect(viewport.scrollTop).toBe(420);

      viewport.scrollTop = 120;
      fireEvent.scroll(viewport);
      clientHeight = 60;
      resizeViewport();
      expect(viewport.scrollTop).toBe(120);
      await act(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );
      expect(viewport.scrollTop).toBe(120);
    } finally {
      vi.stubGlobal("ResizeObserver", originalResizeObserver);
    }
  });

  it("returns to the live bottom when the user sends from history", async () => {
    const controller = makeController();
    const scrollTo = vi.fn();
    Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
    try {
      render(<ChatOverlay controller={controller} />);
      const input = screen.getByLabelText("message");
      fireEvent.focus(input);

      const viewport = screen.getByTestId("chat-thread-scroll");
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, value: 120, writable: true },
      });
      // A wheel/touch/key scroll opts out of automatic following while reading
      // history. An explicit send must opt back into the live conversation.
      fireEvent.wheel(viewport, { deltaY: -40 });
      scrollTo.mockClear();

      fireEvent.change(input, { target: { value: "back to live" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(controller.send).toHaveBeenCalledWith("back to live");
      await waitFor(() => {
        expect(scrollTo).toHaveBeenCalledWith({
          behavior: "auto",
          top: 400,
        });
      });
    } finally {
      delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it("marks chat transcript changes as transient layout motion", () => {
    vi.useFakeTimers();
    try {
      const base = [
        { id: "a", role: "assistant", content: "hi", createdAt: 1 },
      ];
      const { rerender } = render(
        <ChatOverlay
          controller={makeController({
            messages: base,
          } as unknown as Partial<ShellController>)}
        />,
      );
      const root = screen.getByTestId("chat-overlay");

      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();

      rerender(
        <ChatOverlay
          controller={makeController({
            messages: [
              ...base,
              { id: "b", role: "user", content: "new line", createdAt: 2 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );

      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBe(
        LAYOUT_SHIFT_INTENT_TRANSIENT,
      );
      act(() => {
        vi.advanceTimersByTime(181);
      });
      expect(root.getAttribute(LAYOUT_SHIFT_INTENT_ATTR)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT close on an outside pointer-down while the keyboard is DOWN", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    // fireEvent.focus drives the React open state but does NOT move
    // document.activeElement in jsdom — i.e. the composer isn't really focused
    // (no soft keyboard). An outside tap in that state must NOT close the chat;
    // closing is a pull-down, the scrim, or Escape.
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(document.activeElement).not.toBe(screen.getByLabelText("message"));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("does NOT close when the underlying app scrolls", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");
    fireEvent.scroll(document.body);
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("shows a stop control while a reply streams (and wires it)", () => {
    const stop = vi.fn();
    render(
      <ChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          stop,
          turnStatus: { kind: "thinking" },
        } as unknown as Partial<ShellController>)}
      />,
    );
    // No draft + responding → the trailing control is STOP, not mic or send.
    expect(screen.queryByTestId("chat-composer-mic")).toBeNull();
    expect(screen.queryByLabelText("send")).toBeNull();
    const stopBtn = screen.getByTestId("chat-composer-stop");
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reverts the trailing control to send the moment a draft exists mid-stream", () => {
    render(
      <ChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          turnStatus: { kind: "thinking" },
        })}
      />,
    );
    expect(screen.getByTestId("chat-composer-stop")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "queued" },
    });
    expect(
      screen.queryByRole("button", { name: "stop generating" }),
    ).toBeNull();
    expect(screen.getByLabelText(/send/)).toBeTruthy();
  });

  it("renders the no_provider failure as a recovery gate with a Settings jump, while a normal turn still renders its content", () => {
    const openSettings = vi.fn();
    render(
      <ChatOverlay
        controller={makeController({
          openSettings,
          messages: [
            {
              id: "ok",
              role: "assistant",
              content: "here is a normal answer",
              createdAt: 1,
            },
            {
              id: "np",
              role: "assistant",
              content: "No model provider is configured.",
              createdAt: 2,
              failureKind: "no_provider",
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    // The no_provider turn renders the STRUCTURED gate (heading + Settings CTA),
    // not an empty/near-empty bubble — this is the actionable recovery the user
    // needs on a first-message provider failure.
    expect(screen.getByText("Connect a provider to chat")).toBeTruthy();
    const gate = screen
      .getByTestId("chat-no-provider-settings")
      .closest('[data-failure="no_provider"]') as HTMLElement;
    expect(gate).toBeTruthy();
    // The server's fallback text rides inside the gate body (not dropped).
    expect(gate.textContent).toContain("No model provider is configured.");

    // The Settings CTA jumps to settings nav (setTab("settings") via the
    // controller's openSettings).
    fireEvent.click(screen.getByTestId("chat-no-provider-settings"));
    expect(openSettings).toHaveBeenCalledTimes(1);

    // A normal assistant turn in the same thread is UNAFFECTED — it still
    // renders its plain content as a thread bubble, not the gate.
    const normal = screen.getByText("here is a normal answer");
    expect(normal).toBeTruthy();
    expect(normal.closest('[data-failure="no_provider"]')).toBeNull();
  });

  it("renders the insufficient_credits failure as the out-of-credits gate with an Add credits jump and no Retry chip", () => {
    const openSettings = vi.fn();
    render(
      <ChatOverlay
        controller={makeController({
          openSettings,
          messages: [
            { id: "u1", role: "user", content: "hi", createdAt: 1 },
            {
              id: "credits",
              role: "assistant",
              content: "Your organization is out of credits.",
              createdAt: 2,
              failureKind: "insufficient_credits",
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    // The 402 turn renders the STRUCTURED out-of-credits gate (banner + Add
    // credits CTA), not a plain-text bubble — retrying re-hits the same empty
    // balance, so the CTA is the only actionable affordance.
    expect(screen.getByText("Out of credits")).toBeTruthy();
    const gate = screen
      .getByTestId("chat-insufficient-credits-add")
      .closest('[data-failure="insufficient_credits"]') as HTMLElement;
    expect(gate).toBeTruthy();
    // The server's own message rides inside the gate body (not dropped).
    expect(gate.textContent).toContain("Your organization is out of credits.");

    // No Retry chip — a retry cannot fix a drained balance.
    expect(screen.queryByTestId("thread-line-retry")).toBeNull();

    // The CTA jumps to Settings where the top-up/redeem flow lives.
    fireEvent.click(screen.getByTestId("chat-insufficient-credits-add"));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("press-and-hold copies without mounting a floating confirmation", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ChatOverlay
          controller={makeController({
            messages: [
              {
                id: "a",
                role: "assistant",
                content: "the answer is 42",
                createdAt: 1,
              },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("the answer is 42")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div.select-text") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(450); // past the hold threshold
      });
      expect(copyTextToClipboard).toHaveBeenCalledWith("the answer is 42");
      expect(screen.queryByTestId("thread-line-copied")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps chat message text selectable for normal highlight/copy", () => {
    render(
      <ChatOverlay
        controller={makeController({
          messages: [
            {
              id: "u",
              role: "user",
              content: "copy my question",
              createdAt: 1,
            },
            {
              id: "a",
              role: "assistant",
              content: "copy my answer",
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    for (const text of ["copy my question", "copy my answer"]) {
      const textNode = screen.getByText(text);
      const bubble = screen
        .getByText(text)
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div.select-text") as HTMLElement;
      expect(bubble.className).toContain("select-text");
      expect(bubble.className).not.toContain("select-none");
      expect(textNode.closest('[data-chat-selectable="true"]')).toBeTruthy();
    }
  });

  it("a quick tap (released before the hold threshold) does NOT copy", () => {
    vi.useFakeTimers();
    try {
      vi.mocked(copyTextToClipboard).mockClear();
      render(
        <ChatOverlay
          controller={makeController({
            messages: [
              { id: "a", role: "assistant", content: "tap me", createdAt: 1 },
            ],
          } as unknown as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      const bubble = screen
        .getByText("tap me")
        .closest('[data-testid="thread-line"]')
        ?.querySelector("div") as HTMLElement;
      fireEvent.pointerDown(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(200);
      fireEvent.pointerUp(bubble, { clientX: 10, clientY: 10, pointerId: 1 });
      vi.advanceTimersByTime(400);
      expect(copyTextToClipboard).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pulls DOWN from the input to collapse into a recoverable pill", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const content = screen.getByTestId("chat-content");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(content.style.clipPath).toContain("inset(1px round");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
    // A downward drag past the threshold collapses the input away into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(screen.getByTestId("chat-pill")).toBeTruthy();
    // In pill mode the composer is hidden away: kept mounted for the
    // pill→input morph but made inert (opacity 0 + `inert`) so it's unreachable
    // behind the pill capsule.
    expect(content.hasAttribute("inert")).toBe(true);
  });

  it("returns an idle desktop input bar to the existing pill after 10 seconds", () => {
    vi.useFakeTimers();
    try {
      render(<ChatOverlay controller={makeController()} fillHostAtHalf />);
      const sheet = screen.getByTestId("chat-sheet");
      expect(sheet.getAttribute("data-detent")).toBe("collapsed");
      expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");

      act(() => vi.advanceTimersByTime(9_999));
      expect(sheet.getAttribute("data-detent")).toBe("collapsed");

      act(() => vi.advanceTimersByTime(1));
      expect(sheet.getAttribute("data-detent")).toBe("pill");
      expect(sheet.getAttribute("data-chat-state")).toBe("CLOSED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the desktop input idle timer when the user interacts", () => {
    vi.useFakeTimers();
    try {
      render(<ChatOverlay controller={makeController()} fillHostAtHalf />);
      const sheet = screen.getByTestId("chat-sheet");

      act(() => vi.advanceTimersByTime(9_000));
      fireEvent.pointerDown(screen.getByTestId("chat-composer-row"));
      act(() => vi.advanceTimersByTime(9_999));
      expect(sheet.getAttribute("data-detent")).toBe("collapsed");

      act(() => vi.advanceTimersByTime(1));
      expect(sheet.getAttribute("data-detent")).toBe("pill");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the collapsed pill handle non-interactive while the input is formed", () => {
    // The pill handle is always mounted over the (faded) composer so it can
    // crossfade pill→input. Its hit zone (w-full/pt-10) sits over the textarea,
    // so while NOT pilled it must be pointer-events-none — otherwise it
    // intercepts the tap meant for the composer and the mobile keyboard never
    // opens.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const pill = screen.getByTestId("chat-pill");
    expect(pill.className).toContain("pointer-events-none");
    expect(pill.className).not.toContain("pointer-events-auto");
    // Kept out of the tab order / a11y tree while it's not the active handle.
    expect(pill.getAttribute("tabindex")).toBe("-1");
    expect(pill.getAttribute("aria-hidden")).toBe("true");
    // The pill's swipe-up grab zone spans the full width (not a narrow centred
    // px-16 stub) so a swipe-up from anywhere across the bottom opens.
    expect(pill.className).toContain("w-full");
  });

  it("makes the pill handle interactive (drag-to-open) once collapsed to the pill", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    const pill = screen.getByTestId("chat-pill");
    // Now the handle owns the gesture: it re-enables pointer events so the user
    // can grab/drag it open (verified by the flick-up recovery test below).
    expect(pill.classList.contains("pointer-events-auto")).toBe(true);
    expect(pill.classList.contains("pointer-events-none")).toBe(false);
    expect(pill.getAttribute("aria-hidden")).toBeNull();
    // Restored to the tab order once it's the active handle — the symmetric half
    // of the collapsed assertion above (tabindex "-1" while NOT pilled). The
    // PillHandle sets tabIndex={pilled ? undefined : -1}, so the attribute is
    // absent (null) when pilled and keyboard users can Tab to + Enter the pill.
    expect(pill.getAttribute("tabindex")).toBeNull();
  });

  it("shows the live turn phase while a response runs behind the collapsed pill", () => {
    const { rerender } = render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    rerender(
      <ChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          turnStatus: {
            kind: "running_action",
            actionName: "VIEWS",
          },
        })}
      />,
    );

    const status = screen.getByTestId("chat-pill-turn-status");
    expect(status.className).toContain("pointer-events-none");
    expect(screen.getByTestId("turn-status-label").textContent).toBe(
      "Running Views",
    );
  });

  it("keeps the collapsed pill quiet when no response is active", () => {
    render(<ChatOverlay controller={makeController()} />);
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });

    expect(screen.queryByTestId("chat-pill-turn-status")).toBeNull();
  });

  it("centers 64x12 resting material in a 64x44 detached desktop hit target", () => {
    render(<ChatOverlay controller={makeController()} fillHostAtHalf />);
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });

    const pill = screen.getByTestId("chat-pill");
    const mark = screen.getByTestId("chat-pill-mark");
    expect(pill.style.width).toBe("64px");
    expect(pill.style.height).toBe("44px");
    expect(pill.className).not.toContain("pt-10");
    expect(pill.className).not.toContain("px-8");
    expect(mark.className).toContain("chat-handle-bar-surface");
    expect(mark.className).toContain("h-3");
  });

  it("steps a pill tap to the INPUT bar — never the thread detent, never the keyboard", () => {
    // A pill tap is ONE step up the continuum: it forms the bare input bar.
    // Even with a conversation to show it must NOT jump to half (the grabber
    // tap reveals the thread) and must NOT focus the composer (a composer tap
    // raises the keyboard) — the sheet never lurches taller or pops a keyboard
    // the user didn't ask for.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A tap = pointer down + up with no travel. The pill has no onClick; the
    // pull-gesture binding is the single tap authority (onPointerUp → onTap).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    const textarea = screen.getByTestId("chat-composer-textarea");
    expect(textarea).toBeTruthy();
    // No keyboard: the composer is present but NOT focused.
    expect(document.activeElement).not.toBe(textarea);
    // The formed input bar is interactive — leaving the pill state cleared the
    // `inert` the content carried while pilled.
    expect(screen.getByTestId("chat-content").hasAttribute("inert")).toBe(
      false,
    );
  });

  it("steps a thread-less pill tap to the same INPUT bar (no keyboard)", () => {
    // No conversation changes nothing: the tap forms the input bar and leaves
    // the keyboard down — focusing is the composer tap's job.
    render(<ChatOverlay controller={makeController({ messages: [] })} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 400, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
    expect(document.activeElement).not.toBe(
      screen.getByTestId("chat-composer-textarea"),
    );
  });

  it("opens the pill on keyboard activation (Enter)", () => {
    // Keyboard users still open the pill via onKeyDown even though the native
    // onClick was removed in favour of the gesture binding. Activation matches
    // a tap: one step to the INPUT bar.
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    fireEvent.keyDown(screen.getByTestId("chat-pill"), { key: "Enter" });
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("opens exactly once when native keyboard activation emits a compatibility click", () => {
    const onOpen = vi.fn();
    const handler = vi.fn();
    render(
      <PillHandle
        binding={{
          onPointerDown: handler,
          onPointerMove: handler,
          onPointerUp: handler,
          onPointerCancel: handler,
          onLostPointerCapture: handler,
        }}
        counterScale={motionValue(1)}
        onOpen={onOpen}
        breathing={false}
        pilled
        desktopOverlayHost
      />,
    );

    const pill = screen.getByRole("button", { name: "open chat" });
    fireEvent.keyDown(pill, { key: "Enter" });
    fireEvent.click(pill, { detail: 0 });

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("flicks UP from the pill to recover the input", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    const pill = screen.getByTestId("chat-pill");
    // A quick upward flick on the pill opens straight into the chat (the thread
    // has history), recovering the composer — a flick reaches the chat rather
    // than stopping at the bare input (that's the tap path; see the test above).
    fireEvent.pointerDown(pill, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(pill, { clientY: 360, pointerId: 1 });
    fireEvent.pointerUp(pill, { clientY: 360, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(screen.getByTestId("chat-composer-textarea")).toBeTruthy();
  });

  it("keeps exactly one primary Talk control in the rightmost trailing slot", () => {
    render(<ChatOverlay controller={makeController()} />);
    const voice = screen.getByTestId("chat-composer-mic");
    const rightSlot = screen.getByTestId("chat-composer-control-slot-right");
    expect(rightSlot.contains(voice)).toBe(true);
    expect(screen.getAllByTestId("chat-composer-mic")).toHaveLength(1);
    expect(screen.queryByTestId("chat-composer-control-slot-left")).toBeNull();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("replaces the trailing Talk control while a draft exists", () => {
    render(<ChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "typing…" },
    });
    expect(screen.queryByRole("button", { name: "talk" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "start transcription" }),
    ).toBeNull();
    expect(screen.getByTestId("chat-composer-action")).toBeTruthy();
  });

  it("adds one microphone mute toggle immediately left of Stop during realtime voice", () => {
    const toggleMicrophoneMute = vi.fn();
    const realtimeVoice = {
      enabled: true,
      active: true,
      connecting: false,
      paused: false,
      microphoneMuted: false,
      status: "listening" as const,
      error: null,
      toggleMicrophoneMute,
    };
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          handsFree: true,
          phase: "listening",
          recording: true,
          realtimeVoice,
        })}
      />,
    );
    const stop = screen.getByTestId("chat-composer-mic");
    const mute = screen.getByTestId("chat-composer-voice-mute");
    expect(
      screen.getByTestId("chat-composer-control-slot-right").contains(stop),
    ).toBe(true);
    expect(
      screen.getByTestId("chat-composer-control-slot-left").contains(mute),
    ).toBe(true);
    expect(mute.getAttribute("aria-label")).toBe("mute microphone");
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(mute);
    expect(toggleMicrophoneMute).toHaveBeenCalledTimes(1);

    rerender(
      <ChatOverlay
        controller={makeController({
          handsFree: true,
          phase: "listening",
          recording: true,
          realtimeVoice: { ...realtimeVoice, microphoneMuted: true },
        })}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "unmute microphone" })
        .getAttribute("aria-label"),
    ).toBe("unmute microphone");
    expect(
      screen
        .getByRole("button", { name: "unmute microphone" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getAllByTestId("chat-composer-mic")).toHaveLength(1);
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("gives transcription one exclusive stop control", async () => {
    const toggleTranscriptionMode = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatOverlay
        controller={makeController({
          transcriptionMode: true,
          handsFree: true,
          recording: true,
          responding: true,
          canSend: false,
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );

    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(screen.getByTestId("chat-transcribing-badge")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-plus")).toBeNull();
    expect(screen.queryByTestId("chat-composer-textarea")).toBeNull();
    expect(screen.getByTestId("chat-composer-mic-activity")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-mic")).toBeNull();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
    expect(screen.queryByTestId("chat-composer-action")).toBeNull();
    expect(
      screen
        .getByTestId("chat-composer-mic-activity")
        .querySelectorAll("span[style]").length,
    ).toBe(15);

    const stopTranscription = screen.getByTestId(
      "chat-composer-transcription-stop",
    );
    expect(stopTranscription.getAttribute("aria-label")).toBe(
      "stop transcription",
    );
    await user.click(stopTranscription);
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
    // A stopped agent blocks delivery, not finalization back into the draft.
    expect(stopTranscription.getAttribute("aria-disabled")).toBe("false");
    expect(
      screen
        .getByTestId("chat-composer-trailing-controls")
        .contains(stopTranscription),
    ).toBe(true);
    expect(screen.queryByTestId("chat-composer-transcribe-status")).toBeNull();
  });

  it("keeps the single transcription stop keyboard- and touch-operable", async () => {
    const toggleTranscriptionMode = vi.fn();
    const user = userEvent.setup();
    render(
      <ChatOverlay
        controller={makeController({
          transcriptionMode: true,
          recording: true,
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );

    const stopTranscription = screen.getByRole("button", {
      name: "stop transcription",
    });
    stopTranscription.focus();
    await user.keyboard("{Enter}");
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);

    await user.pointer([
      { keys: "[TouchA>]", target: stopTranscription },
      { keys: "[/TouchA]", target: stopTranscription },
    ]);
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(2);
    expect(
      screen
        .getByTestId("chat-composer-control-slot-right")
        .classList.contains("pointer-coarse:size-11"),
    ).toBe(true);
  });

  it("an empty finalization never sends and ignores a second in-flight tap", async () => {
    let releaseDrain: (() => void) | null = null;
    const send = vi.fn();
    const toggleTranscriptionMode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    render(
      <ChatOverlay
        controller={makeController({
          transcriptionMode: true,
          send,
          toggleTranscriptionMode,
        } as unknown as Partial<ShellController>)}
      />,
    );
    const stopTranscription = screen.getByTestId(
      "chat-composer-transcription-stop",
    );
    fireEvent.click(stopTranscription);
    fireEvent.click(stopTranscription);
    expect(toggleTranscriptionMode).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(
      screen
        .getByTestId("chat-composer-mic-activity")
        .getAttribute("aria-label"),
    ).toBe("Finishing transcription");
    expect(
      screen
        .getByTestId("chat-composer-transcription-stop")
        .getAttribute("aria-label"),
    ).toBe("finishing transcription");
    expect(screen.queryByTestId("chat-composer-action")).toBeNull();

    await act(async () => {
      releaseDrain?.();
    });
  });

  it("the audio-unlock chip works while the sheet is open (not swallowed as an outside tap)", () => {
    // The unlock chip renders at the overlay root ABOVE the glass panel. The
    // document-level outside-tap detectors treated everything outside the panel
    // as "outside", so the chip's tap was swallowed (click suppressed) and the
    // sheet collapsed — enabling voice output was impossible while the chat was
    // open. The whole overlay now counts as inside.
    const unlockAudio = vi.fn();
    render(
      <ChatOverlay
        controller={makeController({
          needsAudioUnlock: true,
          unlockAudio,
        } as unknown as Partial<ShellController>)}
      />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    fireEvent.focus(screen.getByLabelText("message"));
    expect(sheet.getAttribute("data-variant")).toBe("open");

    const chip = screen.getByTestId("overlay-voice-audio-unlock");
    // Real pointer sequence: the document-level detectors see pointerdown/up in
    // the capture phase before the click reaches the button.
    fireEvent.pointerDown(chip, { clientX: 200, clientY: 200, pointerId: 7 });
    fireEvent.pointerUp(chip, { clientX: 200, clientY: 200, pointerId: 7 });
    fireEvent.click(chip, { clientX: 200, clientY: 200 });

    expect(unlockAudio).toHaveBeenCalledTimes(1);
    // The sheet must stay open — the chip tap is not an outside collapse.
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("treats a held Talk pointer as the same Cartesia toggle, never hidden batch dictation", () => {
    vi.useFakeTimers();
    try {
      const startRecording = vi.fn();
      const stopRecording = vi.fn();
      const toggleHandsFree = vi.fn();
      render(
        <ChatOverlay
          controller={makeController({
            startRecording,
            stopRecording,
            toggleHandsFree,
          } as unknown as Partial<ShellController>)}
        />,
      );

      const mic = screen.getByTestId("chat-composer-mic");
      fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
      act(() => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.pointerUp(mic, { button: 0, pointerId: 1 });
      expect(startRecording).not.toHaveBeenCalled();
      expect(stopRecording).not.toHaveBeenCalled();
      expect(toggleHandsFree).not.toHaveBeenCalled();

      // A browser's click follows the release. There is one action regardless
      // of hold duration, and it is the Cartesia-owned Talk toggle.
      fireEvent.click(mic);
      expect(toggleHandsFree).toHaveBeenCalledTimes(1);
      expect(mic.getAttribute("aria-label")).toBe("talk");
    } finally {
      vi.useRealTimers();
    }
  });

  it("inserts the finished transcript at the END of the draft and attaches the recording (ChatGPT-style dictation)", () => {
    let sink:
      | ((
          segments: Array<Record<string, unknown>>,
          startedAt: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null = null;
    const controller = makeController({
      setTranscriptSessionSink: ((fn: unknown) => {
        sink = fn as typeof sink;
      }) as unknown as ShellController["setTranscriptSessionSink"],
    });
    render(<ChatOverlay controller={controller} />);
    expect(typeof sink).toBe("function");

    // Text typed BEFORE the session must survive — the transcript appends.
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "notes so far" } });

    vi.mocked(client.createTranscript).mockClear();
    act(() => {
      sink?.(
        [
          {
            id: "s1",
            startMs: 0,
            endMs: 1000,
            text: "hello world",
            words: [],
          },
        ],
        1_700_000_000_000,
        new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]),
      );
    });

    // The transcript lands as TEXT at the end of the draft — no markdown chip
    // to open, matching ChatGPT dictation …
    expect(input.value).toBe("notes so far hello world");
    expect(screen.queryByText(/^Transcript .*\.md$/)).toBeNull();
    // … and is NOT auto-sent — the user sends it when ready.
    expect(controller.send).not.toHaveBeenCalled();
    // The captured audio becomes a pending audio attachment — the sharable
    // artifact that rides the next send into the content-addressed media store
    // (attached synchronously here since the WAV bytes are already in hand;
    // an over-cap recording is dropped with an inline notice — see the sink).
    expect(screen.getByText(/^Recording .*\.wav$/)).toBeTruthy();
    // The session is still archived (record + audio) for the Transcripts view.
    expect(client.createTranscript).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.createTranscript).mock.calls[0][0]).toMatchObject({
      audioContentType: "audio/wav",
    });
  });

  it("a transcript with no captured audio still inserts text and attaches nothing", () => {
    let sink:
      | ((
          segments: Array<Record<string, unknown>>,
          startedAt: number,
          audioWav: Uint8Array | null,
        ) => void)
      | null = null;
    const controller = makeController({
      setTranscriptSessionSink: ((fn: unknown) => {
        sink = fn as typeof sink;
      }) as unknown as ShellController["setTranscriptSessionSink"],
    });
    render(<ChatOverlay controller={controller} />);
    act(() => {
      sink?.(
        [{ id: "s1", startMs: 0, endMs: 900, text: "just words", words: [] }],
        1_700_000_000_000,
        null,
      );
    });
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("just words");
    expect(screen.queryByText(/^Recording .*\.wav$/)).toBeNull();
    expect(controller.send).not.toHaveBeenCalled();
  });

  // ── SheetGrabber inert-while-pilled (the symmetric half of the PillHandle
  // pilled-gating above; #8772). The grabber and the pill capsule occupy the
  // same bottom region; exactly ONE may own the gesture / a11y tree at a time.
  // While the input is formed (not pilled) the GRABBER is live; once collapsed
  // to the pill, the grabber must go fully inert so it can't steal the pill's
  // taps or sit in the tab order behind it.
  it("keeps the sheet grabber live + in the a11y tree while NOT pilled", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");

    const grabber = screen.getByTestId("chat-sheet-grabber");
    // SheetGrabber: pointerEvents auto, tabIndex undefined (attr absent → in
    // tab order), aria-hidden undefined (attr absent → exposed) while !pilled.
    expect(grabber.style.pointerEvents).toBe("auto");
    expect(grabber.getAttribute("tabindex")).toBeNull();
    expect(grabber.getAttribute("aria-hidden")).toBeNull();
  });

  it("makes the sheet grabber fully inert (pointer/tab/a11y) once collapsed to the pill", () => {
    render(<ChatOverlay controller={makeController()} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Collapse the input down into the pill.
    fireEvent.pointerDown(grabber, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 380, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 380, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("pill");

    // The (still-mounted) grabber is now invisible behind the pill capsule, so
    // it must not intercept taps meant for the pill or pass them through to the
    // home screen, and must drop out of the tab order + a11y tree.
    // SheetGrabber: pointerEvents none, tabIndex -1, aria-hidden "true" pilled.
    expect(grabber.style.pointerEvents).toBe("none");
    expect(grabber.getAttribute("tabindex")).toBe("-1");
    expect(grabber.getAttribute("aria-hidden")).toBe("true");
  });

  // ── chat-full header carries NO nav buttons. Search / upload / camera /
  // transcribe moved to the composer "+" menu and Home lives in the launcher,
  // so the top bar no longer acts as a mini app nav (it only reserves the
  // safe-area inset + hosts the transcription badge).
  it("renders no nav buttons in the chat-full header", () => {
    render(
      <ChatOverlay
        controller={makeController({
          currentTab: "chat",
        } as Partial<ShellController>)}
      />,
    );
    openSheetToFull();

    expect(screen.queryByTestId("chat-full-launcher")).toBeNull();
    expect(screen.queryByTestId("chat-full-search")).toBeNull();
    expect(screen.queryByTestId("chat-full-home")).toBeNull();
    expect(screen.queryByTestId("chat-full-views")).toBeNull();
    expect(screen.queryByTestId("chat-full-settings")).toBeNull();
  });

  // Open the sheet to the FULL detent so the chat-full header is revealed and
  // interactive. Half keeps the header inert.
  function openSheetToFull(): void {
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("full");
  }

  // ── Rich turn-status indicator (#8813) ──────────────────────────────────
  describe("turn status indicator", () => {
    it("does not paint a standalone status row before the assistant slot exists", () => {
      render(
        <ChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            turnStatus: { kind: "thinking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.queryByTestId("turn-status-indicator")).toBeNull();
    });

    it("humanizes the action name inside the assistant response slot", () => {
      render(
        <ChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            messages: [
              { id: "u", role: "user", content: "open notes", createdAt: 1 },
              { id: "a", role: "assistant", content: "", createdAt: 2 },
            ],
            turnStatus: { kind: "running_action", actionName: "SEND_MESSAGE" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByTestId("turn-status-label").textContent).toBe(
        "Running Send message",
      );
    });

    it("shows one shimmering status marker inside the in-flight assistant row", () => {
      render(
        <ChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            // Last turn is an empty assistant bubble (the in-flight placeholder).
            messages: [
              { id: "u", role: "user", content: "do it", createdAt: 1 },
              { id: "a", role: "assistant", content: "", createdAt: 2 },
            ],
            turnStatus: { kind: "waking" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));
      // Exactly one indicator (no double-up between the bubble + standalone row).
      const indicators = screen.getAllByTestId("turn-status-indicator");
      expect(indicators).toHaveLength(1);
      expect(indicators[0].getAttribute("data-status-kind")).toBe("waking");
      const label = screen.getByTestId("turn-status-label");
      expect(label.textContent).toBe("Waking the agent");
      expect(label.className).toContain("shimmer");
      expect(screen.queryByTestId("typing-dots")).toBeNull();
    });

    it("hides reasoning disclosure while the latest assistant turn is streaming", () => {
      render(
        <ChatOverlay
          controller={makeController({
            phase: "responding",
            responding: true,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Draft answer",
                reasoning: "private chain of thought",
                createdAt: 2,
              },
            ],
            turnStatus: { kind: "running_action", actionName: "OPEN_VIEW" },
          } as Partial<ShellController>)}
        />,
      );
      fireEvent.focus(screen.getByLabelText("message"));

      expect(screen.getByText("Draft answer")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
      expect(screen.queryByTestId("turn-status-indicator")).toBeNull();
    });

    it("keeps internal reasoning out of the consumer transcript after settle", () => {
      render(
        <ChatOverlay
          controller={makeController({
            phase: "idle",
            responding: false,
            messages: [
              { id: "u", role: "user", content: "explain it", createdAt: 1 },
              {
                id: "a",
                role: "assistant",
                content: "Final answer",
                reasoning: "compact reasoning summary",
                createdAt: 2,
              },
            ],
          } as Partial<ShellController>)}
        />,
      );

      fireEvent.focus(screen.getByLabelText("message"));
      expect(screen.getByText("Final answer")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
      expect(screen.queryByText("compact reasoning summary")).toBeNull();
    });

    it("holds the first label through a fast phase change (min-dwell, no flicker)", () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(
          <ChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              messages: [
                { id: "u", role: "user", content: "do it", createdAt: 1 },
                { id: "a", role: "assistant", content: "", createdAt: 2 },
              ],
              turnStatus: { kind: "thinking" },
            } as Partial<ShellController>)}
          />,
        );
        fireEvent.focus(screen.getByLabelText("message"));
        // The first phase already carries its word (thinking is labelled).
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Thinking",
        );
        // A near-instant change to running_action must NOT flip the label yet —
        // the first status is held for the min dwell so words don't strobe in.
        rerender(
          <ChatOverlay
            controller={makeController({
              phase: "responding",
              responding: true,
              messages: [
                { id: "u", role: "user", content: "do it", createdAt: 1 },
                { id: "a", role: "assistant", content: "", createdAt: 2 },
              ],
              turnStatus: {
                kind: "running_action",
                actionName: "SEND_MESSAGE",
              },
            } as Partial<ShellController>)}
          />,
        );
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Thinking",
        );
        // After the dwell window elapses the new phase is shown.
        act(() => {
          vi.advanceTimersByTime(400);
        });
        expect(screen.getByTestId("turn-status-label").textContent).toContain(
          "Running Send message",
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Single infinite thread (#13531): the chat-to-chat horizontal swipe was
 * REMOVED. This suite drives the REAL overlay with a REAL `conversationNav`
 * (built via the production `buildConversationNav` helper) and proves a
 * committed horizontal drag on the transcript NO LONGER selects an adjacent
 * conversation and NO swipe edge hint renders. (The collapsed-composer
 * home↔launcher swipe is a separate binding, covered elsewhere.)
 */
describe("ChatOverlay single-thread (no chat swipe, #13531)", () => {
  function conv(id: string): Conversation {
    return {
      id,
      title: id,
      roomId: `room-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  // The list is most-recent-first: [newest "a", "b", oldest "c"]. Active "b" is
  // in the middle so both directions WOULD have been navigable pre-#13531.
  const CONVERSATIONS = [conv("a"), conv("b"), conv("c")];

  function makeSwipeController(overrides: Partial<ShellController> = {}) {
    const onSelect = vi.fn<(id: string) => void>();
    const conversationNav = buildConversationNav(CONVERSATIONS, "b", onSelect);
    const controller = makeController({
      conversationNav,
      ...overrides,
    } as unknown as Partial<ShellController>);
    return { controller, onSelect };
  }

  function openSheet() {
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(sheet.getAttribute("data-detent")).toBe("full");
  }

  // Search moved off the header into the composer "+" actions menu; open it the
  // way a user now does — tap "+", then "Search chat…".
  function openSearchFromComposerMenu(): void {
    const plus = screen.getByTestId("chat-composer-plus");
    fireEvent.pointerDown(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(plus, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByText("Search chat…"));
  }

  function thread(): HTMLElement {
    const el = document.getElementById("continuous-thread");
    if (!el) throw new Error("thread region not mounted");
    return el;
  }

  it("a committed LEFT drag does NOT switch to the next conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // The exact gesture that used to navigate LEFT (→ "c") pre-#13531.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 280, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 180, clientY: 302, pointerId: 2 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a committed RIGHT drag does NOT switch to the previous conversation", () => {
    const { controller, onSelect } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // The exact gesture that used to navigate RIGHT (→ "a") pre-#13531.
    fireEvent.pointerDown(el, { clientX: 180, clientY: 300, pointerId: 2 });
    fireEvent.pointerMove(el, { clientX: 200, clientY: 302, pointerId: 2 });
    fireEvent.pointerUp(el, { clientX: 300, clientY: 302, pointerId: 2 });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("never renders a conversation-swipe edge hint mid-drag", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    const el = thread();
    // Hold mid-drag (no pointerUp): pre-#13531 this lit the RIGHT edge hint.
    fireEvent.pointerDown(el, { clientX: 300, clientY: 300, pointerId: 3 });
    fireEvent.pointerMove(el, { clientX: 240, clientY: 302, pointerId: 3 });

    expect(screen.queryByTestId("conversation-swipe-hint-right")).toBeNull();
    expect(screen.queryByTestId("conversation-swipe-hint-left")).toBeNull();
  });

  it("exposes no maximize / minimize button (maximize is a pull now)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // Maximize/minimize became a vertical pull in #13531 — still no button.
    expect(screen.queryByTestId("chat-full-maximize")).toBeNull();
  });

  it("exposes no left header controls (search + new-chat moved off the header)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // The thread is one infinite conversation and the header carries no
    // buttons: search moved to the composer "+" menu, and there is deliberately
    // no new-chat/clear/refresh control anywhere.
    expect(screen.queryByTestId("chat-full-search")).toBeNull();
    expect(screen.queryByTestId("chat-full-clear")).toBeNull();
  });

  it("carries no voice control in the top bar — voice lives on the composer mic", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // The redundant top-bar mic was removed: voice has exactly one entry point,
    // the composer mic. A tap there enters/exits the hands-free conversation.
    expect(screen.queryByTestId("chat-full-voice")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-composer-mic"));
    expect(controller.toggleHandsFree).toHaveBeenCalledTimes(1);
  });

  it("opens the message-search panel from the composer + menu (#14279)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // Panel is closed at rest.
    expect(screen.queryByTestId("chat-message-search")).toBeNull();
    // "+" → "Search chat…" reveals the search panel over the transcript.
    openSearchFromComposerMenu();
    const searchLayer = screen.getByTestId("chat-message-search");
    expect(searchLayer.className).not.toContain("bg-black/20");
    expect(searchLayer.className).not.toContain("backdrop-blur");
    expect(screen.getByTestId("message-search-panel")).toBeTruthy();
    const transcript = screen.getByTestId("chat-thread-scroll");
    expect(transcript.getAttribute("aria-hidden")).toBe("true");
    expect(transcript.getAttribute("tabindex")).toBe("-1");
    expect(transcript.closest("[inert]")).toBeTruthy();
  });

  it("keeps search-result scrolling from stepping or closing the chat sheet", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();
    openSearchFromComposerMenu();

    const sheet = screen.getByTestId("chat-sheet");
    const searchScroller = screen.getByTestId("message-search-scroll");
    expect(sheet.getAttribute("data-detent")).toBe("full");

    // This bubbles through the fieldset's trackpad-detent handler. The search
    // viewport must claim it before that handler interprets it as a sheet pull.
    fireEvent.wheel(searchScroller, { deltaY: -120 });

    // The pinned input is a sibling of the scroll viewport. Its wheel gesture
    // still belongs to the open search mode and must never resize the sheet.
    fireEvent.wheel(screen.getByTestId("message-search-input"), {
      deltaY: -120,
    });

    expect(sheet.getAttribute("data-detent")).toBe("full");
    expect(screen.getByTestId("chat-message-search")).toBeTruthy();
  });

  it("drives the header search → query → jump path against the real search API shape (#14330)", async () => {
    // Real jump plumbing: the overlay pulls handleSelectConversation from the
    // AppContext store, so seed it with a spy the jump must call. Mirror the
    // inert test-fallback proxy (noop for everything else the overlay reads via
    // other selectors) so only the jump collaborators are observable.
    const selectSpy = vi.fn<(id: string) => Promise<void>>(async () => {});
    const aroundSpy = vi.fn(async () => false);
    const noop = () => {};
    __setAppValueForTests(
      new Proxy({} as never, {
        get(_t, prop) {
          if (prop === "handleSelectConversation") return selectSpy;
          if (prop === "loadConversationMessagesAround") return aroundSpy;
          if (prop === "t") return (k: string) => k;
          if (prop === "uiLanguage") return "en";
          if (prop === "navigation") {
            return { scheduleAfterTabCommit: (fn: () => void) => fn() };
          }
          return noop;
        },
      }),
    );

    // The panel renders exactly what the server route returns; use its real
    // response shape (ranked hits with snippet/role/createdAt).
    const hit: ConversationMessageSearchResult = {
      messageId: "m-hit",
      conversationId: "conv-42",
      roomId: "room-1",
      role: "assistant",
      text: "the quarterly budget review is on friday",
      snippet: "the quarterly …budget… review is on friday",
      createdAt: 1_700_000_000_000,
      score: 12.5,
    };
    vi.mocked(client.searchConversationMessages).mockResolvedValue({
      results: [hit],
      count: 1,
    });

    const { controller } = makeSwipeController({
      messages: [
        {
          id: "m-hit",
          role: "assistant",
          content: "the quarterly budget review is on friday",
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    render(<ChatOverlay controller={controller} />);
    openSheet();

    openSearchFromComposerMenu();
    const input = screen.getByTestId("message-search-input");
    fireEvent.change(input, { target: { value: "budget" } });

    // The debounced (250ms) search calls the real client method and lists the
    // ranked snippet result.
    const result = await waitFor(() =>
      screen.getByTestId("message-search-result"),
    );
    expect(client.searchConversationMessages).toHaveBeenCalledWith(
      "budget",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.textContent).toContain("budget");

    // Selecting a result already mounted in the canonical message scroller
    // uses its coordinated jump API, flashes only the contained bubble, and
    // never falls through to the around-message network fetch.
    fireEvent.click(result);
    expect(selectSpy).toHaveBeenCalledWith("conv-42");
    const anchor = document.getElementById("chat-message-m-hit");
    expect(anchor).toBeTruthy();
    const bubble = anchor?.querySelector<HTMLElement>(
      '[data-chat-message-bubble="true"]',
    );
    await waitFor(() =>
      expect(
        bubble?.querySelector(
          '[data-chat-selectable="true"][data-chat-search-highlight="true"]',
        ),
      ).toBeTruthy(),
    );
    expect(aroundSpy).not.toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("chat-message-search")).toBeNull(),
    );
  });

  it("renders a distinguishable error state when the search API rejects (#14330)", async () => {
    // Three-state rule: a rejected search must surface an error render, never a
    // fabricated empty result.
    vi.mocked(client.searchConversationMessages).mockRejectedValue(
      new Error("search route 500"),
    );

    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    openSearchFromComposerMenu();
    fireEvent.change(screen.getByTestId("message-search-input"), {
      target: { value: "budget" },
    });

    await waitFor(() =>
      expect(screen.getByTestId("message-search-error")).toBeTruthy(),
    );
    // The error state is NOT the empty state — a caught failure must not read as
    // "no matches".
    expect(screen.queryByTestId("message-search-empty")).toBeNull();
  });

  it("never invokes clearConversation from the header (no new-chat control)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // The new-chat header control was removed: nothing in the header may
    // reset the thread.
    expect(screen.queryByTestId("chat-full-clear")).toBeNull();
    expect(controller.clearConversation).not.toHaveBeenCalled();
  });

  it("renders the infinite-scroll top sentinel above a populated thread (#14279)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    openSheet();

    // The load-older prefetch sentinel mounts above the oldest turn so
    // useLoadOlderOnScroll can page older history in as the reader scrolls up.
    const sentinel = screen.getByTestId("chat-transcript-top-sentinel");
    expect(sentinel.className).toContain("h-px");
    expect(sentinel.childElementCount).toBe(0);
  });

  // Maximize is a PULL now, not a button (#13531). A big upward over-pull of the
  // grabber — far past the FULL detent — flips the sheet to edge-to-edge
  // full-bleed (data-maximized="true", data-chat-state="MAXIMIZED").
  function bigPullUp() {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    // Start low, drag all the way to the very top: a deliberate slow over-pull
    // whose peak raw height clears the maximize threshold.
    fireEvent.pointerDown(grabber, { clientY: 760, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 400, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 40, pointerId: 7 });
    fireEvent.pointerMove(grabber, { clientY: 0, pointerId: 7 });
    fireEvent.pointerUp(grabber, { clientY: 0, pointerId: 7 });
  }

  it("a big upward over-pull of the grabber maximizes to full-bleed", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
  });

  it("fades the fullscreen transcript with its scroll mask instead of a painted rectangle", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);

    const surface = screen.getByTestId("chat-sheet-surface");
    expect(screen.queryByTestId("chat-sheet-top-sheen")).toBeNull();
    expect(surface.style.getPropertyValue("--chat-sheet-image")).toBe("none");

    bigPullUp();

    const viewport = screen.getByTestId("chat-thread-scroll");
    expect(viewport.className.split(/\s+/)).toContain("scroll-fade");
    expect(viewport.className.split(/\s+/)).not.toContain("scroll-fade-b");
    expect(screen.queryByTestId("chat-thread-top-fade")).toBeNull();
    expect(screen.queryByTestId("chat-sheet-top-sheen")).toBeNull();
    expect(surface.style.getPropertyValue("--chat-sheet-image")).toBe("none");
  });

  it("snaps to full-screen at 90% while held and reverses below the same line", async () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    const grabber = screen.getByTestId("chat-sheet-grabber");
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const startY = viewportHeight;
    const snapHeight = viewportHeight * 0.9;

    fireEvent.pointerDown(grabber, { clientY: startY, pointerId: 71 });
    fireEvent.pointerMove(grabber, {
      clientY: startY - (snapHeight - 20),
      pointerId: 71,
    });
    await waitFor(() =>
      expect(sheet.getAttribute("data-maximized")).toBeNull(),
    );

    fireEvent.pointerMove(grabber, {
      clientY: startY - (snapHeight + 20),
      pointerId: 71,
    });
    await waitFor(() =>
      expect(sheet.getAttribute("data-maximized")).toBe("true"),
    );

    fireEvent.pointerMove(grabber, {
      clientY: startY - (snapHeight - 30),
      pointerId: 71,
    });
    await waitFor(() =>
      expect(sheet.getAttribute("data-maximized")).toBeNull(),
    );
    fireEvent.pointerUp(grabber, {
      clientY: startY - (snapHeight - 30),
      pointerId: 71,
    });
  });

  it("renders the top-bar pull-down restore zone ONLY while maximized", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    // Not present at rest / half.
    openSheet();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();
    // Appears once maximized.
    bigPullUp();
    expect(screen.getByTestId("chat-maximize-restore-zone")).toBeTruthy();
    expect(screen.queryByTestId("chat-maximize-restore-handle")).toBeNull();
  });

  it("a downward pull in the top-20% restore zone exits full-bleed back to the overlay (not a full collapse)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    const zone = screen.getByTestId("chat-maximize-restore-zone");
    // A committed downward pull starting in the top-20% zone.
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 8 });
    fireEvent.pointerMove(zone, { clientY: 200, pointerId: 8 });
    fireEvent.pointerUp(zone, { clientY: 320, pointerId: 8 });

    // Back to the inset overlay: no longer maximized, but the sheet stays OPEN
    // (the thread didn't collapse to the input).
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("keeps a tap inert but follows a deliberate restore pull immediately", async () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    const zone = screen.getByTestId("chat-maximize-restore-zone");
    const startY = 20;
    fireEvent.pointerDown(zone, { clientY: startY, pointerId: 81 });
    fireEvent.pointerMove(zone, {
      clientY: startY + 4,
      pointerId: 81,
    });
    await waitFor(() =>
      expect(sheet.getAttribute("data-maximized")).toBe("true"),
    );

    fireEvent.pointerMove(zone, {
      clientY: startY + 24,
      pointerId: 81,
    });
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(screen.queryByTestId("chat-maximize-restore-handle")).toBeNull();
    expect(screen.queryByTestId("chat-sheet-grabber")).toBeNull();
    expect(sheet.style.height).toBe("auto");
    fireEvent.pointerUp(zone, {
      clientY: startY + 24,
      pointerId: 81,
    });
    await waitFor(() =>
      expect(sheet.getAttribute("data-maximized")).toBeNull(),
    );
  });

  it("rests a maximized restore below half at the released window height", async () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();

    const zone = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 82 });
    fireEvent.pointerMove(zone, { clientY: 500, pointerId: 82 });
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(screen.queryByTestId("chat-sheet-grabber")).toBeNull();
    fireEvent.pointerUp(zone, { clientY: 500, pointerId: 82 });

    await waitFor(() =>
      expect(sheet.getAttribute("data-chat-state")).toBe("OPEN_UNDER_HALF"),
    );
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(sheet.getAttribute("data-detent")).toBe("half");
    expect(sheet.style.height).toBe("auto");
  });

  it("lands a near-bottom maximized restore on the input instead of the pill", async () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();

    const zone = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 83 });
    fireEvent.pointerMove(zone, { clientY: 730, pointerId: 83 });
    fireEvent.pointerUp(zone, { clientY: 730, pointerId: 83 });

    await waitFor(() =>
      expect(sheet.getAttribute("data-chat-state")).toBe("INPUT"),
    );
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-detent")).toBe("collapsed");
  });

  it("a FULL downward pull in the restore zone drops full-bleed and collapses the sheet all the way (the un-maximize→collapse bug)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    // Drag the restore zone from the top all the way past the bottom: the strip
    // must stay grabbable through the un-maximize (it un-mounts on `fullBleed`,
    // so a naive gate would freeze the drag here) and drive the sheet to closed.
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(zone, { clientY: 20, pointerId: 9 });
    fireEvent.pointerMove(zone, { clientY: 400, pointerId: 9 });
    fireEvent.pointerMove(zone, { clientY: 900, pointerId: 9 });
    fireEvent.pointerUp(zone, { clientY: 900, pointerId: 9 });

    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(sheet.getAttribute("data-detent")).toBe("pill");
  });

  it("keyboard-activates the restore zone (ArrowDown exits full-bleed)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    fireEvent.keyDown(screen.getByTestId("chat-maximize-restore-zone"), {
      key: "ArrowDown",
    });
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
  });

  it("Escape from maximized collapses the whole sheet (not just restore)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  // ---- Full state-machine round-trips (long drags + gestures) --------------
  // Drive the sheet back and forth across every openness state with real
  // pointer drags on the grabber and the restore strip, asserting the machine
  // (data-chat-state / data-maximized / data-variant) never wedges in a state
  // it can't leave. These cover the reported "can't get back down from
  // maximized" bug from every entry angle.
  function grabberDrag(...ys: number[]): void {
    const g = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(g, { clientY: ys[0], pointerId: 33 });
    for (let i = 1; i < ys.length; i += 1) {
      fireEvent.pointerMove(g, { clientY: ys[i], pointerId: 33 });
    }
    fireEvent.pointerUp(g, { clientY: ys[ys.length - 1], pointerId: 33 });
  }
  function restoreZoneDrag(...ys: number[]): void {
    const z = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(z, { clientY: ys[0], pointerId: 34 });
    for (let i = 1; i < ys.length; i += 1) {
      fireEvent.pointerMove(z, { clientY: ys[i], pointerId: 34 });
    }
    fireEvent.pointerUp(z, { clientY: ys[ys.length - 1], pointerId: 34 });
  }

  it("round-trips INPUT → open → MAXIMIZED → open → re-MAXIMIZED → collapsed with no wedged state", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");

    // Rest is the composer-only INPUT state; no restore strip yet.
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    expect(sheet.getAttribute("data-variant")).toBe("closed");
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // INPUT → open (pull the grabber up). The grabber owns this.
    openSheet();
    expect(sheet.getAttribute("data-variant")).toBe("open");
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // open → MAXIMIZED (over-pull past the 80% threshold).
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
    expect(screen.getByTestId("chat-maximize-restore-zone")).toBeTruthy();

    // MAXIMIZED → open (a partial restore pull drops full-bleed, stays open).
    restoreZoneDrag(20, 200, 300);
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("open");
    // The grabber is back and the restore strip is gone once inset.
    expect(screen.getByTestId("chat-sheet-grabber")).toBeTruthy();
    expect(screen.queryByTestId("chat-maximize-restore-zone")).toBeNull();

    // open → MAXIMIZED again (prove the round-trip left no stuck flag).
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");

    // MAXIMIZED → collapsed (a full restore pull to the bottom closes it).
    restoreZoneDrag(20, 400, 900);
    expect(sheet.getAttribute("data-maximized")).toBeNull();
    expect(sheet.getAttribute("data-variant")).toBe("closed");
  });

  it("toggles MAXIMIZED ⇄ open cleanly across repeated cycles (no drift)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    openSheet();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      bigPullUp();
      expect(sheet.getAttribute("data-maximized")).toBe("true");
      expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");

      // Partial restore back to an inset open sheet.
      restoreZoneDrag(20, 200, 300);
      expect(sheet.getAttribute("data-maximized")).toBeNull();
      expect(sheet.getAttribute("data-variant")).toBe("open");
    }
  });

  it("steps INPUT → pill (CLOSED) on a grabber pull-down, then back to INPUT on tap", () => {
    const { controller } = makeSwipeController();
    const onPilledChange = vi.fn();
    render(
      <ChatOverlay controller={controller} onPilledChange={onPilledChange} />,
    );
    const sheet = screen.getByTestId("chat-sheet");
    expect(sheet.getAttribute("data-chat-state")).toBe("INPUT");
    expect(onPilledChange).toHaveBeenLastCalledWith(false);

    // INPUT → pill: a downward pull folds the composer into the pill capsule.
    grabberDrag(600, 700, 800);
    expect(sheet.getAttribute("data-detent")).toBe("pill");
    expect(sheet.getAttribute("data-chat-state")).toBe("CLOSED");
    expect(onPilledChange).toHaveBeenLastCalledWith(true);

    // pill → back: a tap on the pill leaves the CLOSED/pill state (it re-forms
    // the bare input bar; thread reveal and keyboard are later gestures).
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 780, pointerId: 35 });
    fireEvent.pointerUp(grabber, { clientY: 780, pointerId: 35 });
    expect(sheet.getAttribute("data-detent")).not.toBe("pill");
    expect(sheet.getAttribute("data-chat-state")).not.toBe("CLOSED");
    expect(onPilledChange).toHaveBeenLastCalledWith(false);
  });

  it("an upward hold in the restore zone keeps it MAXIMIZED (only a downward pull exits)", () => {
    const { controller } = makeSwipeController();
    render(<ChatOverlay controller={controller} />);
    const sheet = screen.getByTestId("chat-sheet");
    bigPullUp();
    expect(sheet.getAttribute("data-maximized")).toBe("true");

    // A pull that only moves UP (or holds) inside the strip must not un-maximize.
    restoreZoneDrag(300, 200, 120);
    expect(sheet.getAttribute("data-maximized")).toBe("true");
    expect(sheet.getAttribute("data-chat-state")).toBe("MAXIMIZED");
  });
});

// The reported bug: clearing the chat dropped all messages, which unmounted the
// whole thread region, collapsing the open sheet to just the header + composer.
// The fix renders the thread whenever the sheet is OPEN (not only when there are
// messages), so an emptied/cleared conversation keeps its size and shows a
// loading state until its greeting lands.
describe("ChatOverlay — empty thread while the sheet is open", () => {
  function openSheetToHalf(): void {
    const grabber = screen.getByTestId("chat-sheet-grabber");
    fireEvent.pointerDown(grabber, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(grabber, { clientY: 280, pointerId: 1 });
    fireEvent.pointerUp(grabber, { clientY: 280, pointerId: 1 });
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
  }

  it("keeps the thread mounted (no collapse) when the open conversation empties, and shows the loading spinner", () => {
    // Open with messages present (the gesture needs a thread to open into).
    const { rerender } = render(<ChatOverlay controller={makeController()} />);
    openSheetToHalf();
    expect(document.getElementById("continuous-thread")).not.toBeNull();

    // Emptying the conversation (a clear in flight, awaiting the greeting) must
    // NOT unmount the thread — the sheet stays open at its size with a spinner.
    rerender(
      <ChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: true,
        } as Partial<ShellController>)}
      />,
    );
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.getByTestId("chat-sheet").getAttribute("data-detent")).toBe(
      "half",
    );
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();
  });

  it("shows no spinner on an empty open thread that is not loading", () => {
    const { rerender } = render(<ChatOverlay controller={makeController()} />);
    openSheetToHalf();

    rerender(
      <ChatOverlay
        controller={makeController({
          messages: [],
          conversationLoading: false,
        } as Partial<ShellController>)}
      />,
    );
    // Thread stays mounted, but with no in-flight load there is no spinner.
    expect(document.getElementById("continuous-thread")).not.toBeNull();
    expect(screen.queryByTestId("chat-thread-loading")).toBeNull();
  });

  it("reads as loading, not designed-empty, when opened during boot-time hydration", () => {
    // A programmatic open (boot-recovery, deep link) can expand the sheet
    // before the server transcript has hydrated. An empty sheet there is a
    // loading state, never a broken empty box.
    const { rerender } = render(<ChatOverlay controller={makeController()} />);
    openSheetToHalf();

    rerender(
      <ChatOverlay
        controller={makeController({
          phase: "booting",
          messages: [],
          conversationLoading: false,
        } as Partial<ShellController>)}
      />,
    );
    expect(screen.getByTestId("chat-thread-loading")).toBeTruthy();
  });
});

describe("ChatOverlay — streaming + consumer activity render (#10712)", () => {
  it("keeps an empty interrupted receipt visible after the turn becomes idle", () => {
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          phase: "idle",
          messages: [
            {
              id: "stop-request",
              role: "user",
              content: "Open my appointments",
              createdAt: 1,
            },
            {
              id: "stop-receipt",
              role: "assistant",
              content: "",
              interrupted: true,
              createdAt: 2,
            },
            {
              id: "ordinary-empty",
              role: "assistant",
              content: "",
              createdAt: 3,
            },
          ],
        })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByText("Response interrupted")).toBeTruthy();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(document.getElementById("chat-message-stop-receipt")).toBeTruthy();
    expect(document.getElementById("chat-message-ordinary-empty")).toBeNull();
  });

  function assistantTurnBody(messageId: string): HTMLElement {
    const body = document
      .getElementById(`chat-message-${messageId}`)
      ?.querySelector<HTMLElement>(
        '[data-testid="overlay-assistant-turn-body"]',
      );
    expect(body).toBeTruthy();
    return body as HTMLElement;
  }

  it("shows interrupted receipts as status without a pending spinner or invented prose", () => {
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: [
            {
              id: "empty-interruption",
              role: "assistant",
              content: "",
              interrupted: true,
              createdAt: 1,
            },
            {
              id: "partial-interruption",
              role: "assistant",
              content: "The model's partial reply",
              interrupted: true,
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    const empty = assistantTurnBody("empty-interruption");
    const partial = assistantTurnBody("partial-interruption");
    for (const body of [empty, partial]) {
      expect(body.dataset.phase).toBe("interrupted");
      expect(
        body.querySelector('[data-testid="turn-status-indicator"]'),
      ).toBeNull();
      expect(body.textContent).toContain("(Response interrupted)");
    }
    expect(empty.dataset.hasMessageText).toBe("false");
    expect(empty.textContent).toBe("(Response interrupted)");
    expect(partial.dataset.hasMessageText).toBe("true");
    expect(partial.textContent).toBe(
      "The model's partial reply(Response interrupted)",
    );
  });

  it("marks parsed prose, not attachment or inline-widget chrome, as message text", () => {
    const form = JSON.stringify({
      id: "trip-details",
      title: "Trip details",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    });
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: [
            {
              id: "a-interrupted",
              role: "assistant",
              content: "Partial durable answer",
              interrupted: true,
              createdAt: 1,
            },
            {
              id: "a-attachment-only",
              role: "assistant",
              content: "",
              attachments: [
                {
                  id: "generated-image",
                  url: "data:image/png;base64,iVBORw0KGgo=",
                  contentType: "image",
                  title: "Generated image",
                },
              ],
              createdAt: 2,
            },
            {
              id: "a-choice-only",
              role: "assistant",
              content:
                "[CHOICE:approval id=choice-only]\nyes=Approve\nno=Reject\n[/CHOICE]",
              createdAt: 3,
            },
            {
              id: "a-form-only",
              role: "assistant",
              content: `[FORM]\n${form}\n[/FORM]`,
              createdAt: 4,
            },
            {
              id: "a-prose-widget",
              role: "assistant",
              content:
                "Choose next:\n[CHOICE:next id=choice-with-prose]\ncontinue=Continue\n[/CHOICE]",
              createdAt: 5,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    const interruptedRow = screen
      .getByText("Partial durable answer")
      .closest<HTMLElement>('[data-testid="thread-line"]');
    expect(interruptedRow?.dataset.interrupted).toBe("true");
    expect(
      interruptedRow?.querySelector<HTMLElement>(
        '[data-testid="overlay-assistant-turn-body"]',
      )?.dataset.hasMessageText,
    ).toBe("true");

    const attachmentRow = screen
      .getByTestId("message-attachments")
      .closest<HTMLElement>('[data-testid="thread-line"]');
    const attachmentBody = attachmentRow?.querySelector<HTMLElement>(
      '[data-testid="overlay-assistant-turn-body"]',
    );
    expect(attachmentBody?.dataset.phase).toBe("reply");
    expect(attachmentBody?.dataset.hasMessageText).toBe("false");

    expect(screen.getByTestId("choice-shell-choice-only")).toBeTruthy();
    expect(assistantTurnBody("a-choice-only").dataset.hasMessageText).toBe(
      "false",
    );
    expect(screen.getByTestId("form-request")).toBeTruthy();
    expect(assistantTurnBody("a-form-only").dataset.hasMessageText).toBe(
      "false",
    );
    expect(screen.getByText("Choose next:")).toBeTruthy();
    expect(assistantTurnBody("a-prose-widget").dataset.hasMessageText).toBe(
      "true",
    );
  });

  it("does not promote hidden or structured-only markup to assistant prose", () => {
    const uiSpec = JSON.stringify({
      root: "heading",
      state: {},
      elements: {
        heading: {
          type: "Heading",
          props: { text: "Structured only", level: "h2" },
          children: [],
        },
      },
    });
    const permissionRequest = JSON.stringify({
      action: "permission_request",
      permission: "camera",
      reason: "Scan a code.",
      feature: "scanner.qr.read",
    });
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: [
            {
              id: "a-hidden-only",
              role: "assistant",
              content: "<think>private reasoning</think>",
              createdAt: 1,
            },
            {
              id: "a-code-only",
              role: "assistant",
              content: "```ts\nconst answer = 42;\n```",
              createdAt: 2,
            },
            {
              id: "a-config-only",
              role: "assistant",
              content: "[CONFIG:weather]",
              createdAt: 3,
            },
            {
              id: "a-ui-only",
              role: "assistant",
              content: `\`\`\`json\n${uiSpec}\n\`\`\``,
              createdAt: 4,
            },
            {
              id: "a-permission-only",
              role: "assistant",
              content: `\`\`\`json\n${permissionRequest}\n\`\`\``,
              createdAt: 5,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    expect(screen.queryByText("private reasoning")).toBeNull();
    expect(screen.getByTestId("code-block")).toBeTruthy();
    expect(screen.getByTestId("permission-card")).toBeTruthy();
    for (const messageId of [
      "a-hidden-only",
      "a-code-only",
      "a-config-only",
      "a-ui-only",
      "a-permission-only",
    ]) {
      expect(assistantTurnBody(messageId).dataset.hasMessageText).toBe("false");
    }
  });

  it("renders the reply while keeping tool traces and reasoning in diagnostics", () => {
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: [
            { id: "u", role: "user", content: "open notes", createdAt: 1 },
            {
              id: "a",
              role: "assistant",
              content: "Opening Notes now.",
              reasoning: "The Notes view is registered, so I selected it.",
              toolEvents: [
                {
                  id: "views-1",
                  type: "tool_result",
                  actionName: "VIEWS",
                  args: { action: "show", target: "notes" },
                  result: { success: true },
                  status: "completed",
                },
              ],
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByText("Opening Notes now.")).toBeTruthy();
    expect(screen.queryByTestId("tool-call-event-log")).toBeNull();
    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
    expect(
      screen.queryByText("The Notes view is registered, so I selected it."),
    ).toBeNull();
  });

  it("renders one navigation reply while hiding the matching VIEWS result prose", () => {
    render(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: [
            { id: "u", role: "user", content: "open calendar", createdAt: 1 },
            {
              id: "a",
              role: "assistant",
              content: "Opening your calendar now.",
              toolEvents: [
                {
                  id: "views-calendar",
                  type: "tool_result",
                  actionName: "VIEWS",
                  args: { action: "show", target: "calendar" },
                  result: {
                    success: true,
                    userFacingText: "Opening your calendar now.",
                  },
                  status: "completed",
                },
              ],
              createdAt: 2,
            },
          ],
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));

    expect(screen.getAllByText("Opening your calendar now.")).toHaveLength(1);
    expect(screen.queryByText("VIEWS")).toBeNull();
    expect(screen.queryByText("Args")).toBeNull();
    expect(screen.queryByText("Result")).toBeNull();
  });

  it("replaces Thinking with token one in the same assistant row", async () => {
    let conversationMessages: ConversationMessage[] = [
      {
        id: "u-stream",
        role: "user",
        text: "stream the answer",
        timestamp: 1,
      },
      {
        id: "a-stream",
        role: "assistant",
        text: "",
        timestamp: 2,
      },
    ];
    const setConversationMessages: StreamingTextSetter = (next) => {
      conversationMessages =
        typeof next === "function" ? next(conversationMessages) : next;
    };
    const toShellMessages = (): ShellMessage[] =>
      conversationMessages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.text,
        createdAt: message.timestamp,
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      }));

    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "thinking" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const pendingRow = screen
      .getByTestId("turn-status-indicator")
      .closest('[data-testid="thread-line"]');
    expect(pendingRow).toBeTruthy();
    const stableAssistantBody = screen.getByTestId(
      "overlay-assistant-turn-body",
    );
    expect(stableAssistantBody.getAttribute("data-phase")).toBe("status");
    expect(stableAssistantBody.className).toContain("min-h-[1.4375rem]");

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "replace",
      fullText: "Token one",
    });
    rerender(
      <ChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "streaming" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    const token = screen.getByText("Token one");
    expect(token).toBeTruthy();
    expect(token.closest('[data-testid="thread-line"]')).toBe(pendingRow);
    expect(screen.getByTestId("overlay-assistant-turn-body")).toBe(
      stableAssistantBody,
    );
    expect(stableAssistantBody.getAttribute("data-phase")).toBe("reply");
    await waitFor(() => {
      expect(screen.queryByTestId("turn-status-indicator")).toBeNull();
    });
    expect(screen.queryByText("Token one and two")).toBeNull();
    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "replace",
      fullText: "Token one and two",
    });
    rerender(
      <ChatOverlay
        controller={makeController({
          responding: true,
          turnStatus: { kind: "streaming" },
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(screen.getByText("Token one and two")).toBeTruthy();

    applyStreamingTextModification(setConversationMessages, {
      messageId: "a-stream",
      mode: "complete",
      fullText: "Token one and two",
      reasoning: "Waited for the done frame before showing reasoning.",
    });
    rerender(
      <ChatOverlay
        controller={makeController({
          responding: false,
          messages: toShellMessages(),
        } as unknown as Partial<ShellController>)}
      />,
    );

    expect(screen.getByText("Token one and two")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /thinking/i })).toBeNull();
    expect(
      screen.queryByText("Waited for the done frame before showing reasoning."),
    ).toBeNull();
  });

  it("keeps the future assistant row through microphone barge-in", () => {
    const messages: ShellMessage[] = [
      { id: "u-barge", role: "user", content: "read it", createdAt: 1 },
      { id: "a-barge", role: "assistant", content: "", createdAt: 2 },
    ];
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({
          phase: "responding",
          responding: true,
          messages,
          turnStatus: { kind: "thinking" },
        } as Partial<ShellController>)}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const responseRow = screen
      .getByTestId("turn-status-indicator")
      .closest('[data-testid="thread-line"]');

    rerender(
      <ChatOverlay
        controller={makeController({
          phase: "listening",
          responding: true,
          recording: true,
          messages,
          turnStatus: { kind: "thinking" },
        } as Partial<ShellController>)}
      />,
    );

    expect(
      screen
        .getByTestId("turn-status-indicator")
        .closest('[data-testid="thread-line"]'),
    ).toBe(responseRow);

    rerender(
      <ChatOverlay
        controller={makeController({
          phase: "listening",
          responding: false,
          recording: true,
          messages,
          turnStatus: null,
        } as Partial<ShellController>)}
      />,
    );
    expect(screen.queryByTestId("turn-status-indicator")).toBeNull();
    expect(document.querySelector('[data-message-id="a-barge"]')).toBeNull();
  });
});

// Per-message click-to-reveal action row (#10713): assistant → Copy + Play,
// user → Copy + in-place Edit, temp turns are not editable.
describe("ChatOverlay — per-message action row (#10713)", () => {
  function openThreadWith(overrides: Partial<ShellController>) {
    render(
      <ChatOverlay
        controller={makeController(overrides as Partial<ShellController>)}
      />,
    );
    // Focusing the composer opens the sheet so the transcript renders.
    fireEvent.focus(screen.getByLabelText("message"));
  }

  function bubbleFor(text: string): HTMLElement {
    return screen
      .getByText(text)
      .closest('[data-testid="thread-line"]')
      ?.querySelector("div.select-text") as HTMLElement;
  }

  it("reserves an animated reply lane, focuses the composer, and clears it when the sheet closes", async () => {
    openThreadWith({
      messages: [
        {
          id: "reply-source",
          role: "assistant",
          content: "Reply without moving the sheet",
          createdAt: 1,
        },
      ],
    });
    const sheet = screen.getByTestId("chat-sheet");
    const input = screen.getByLabelText("message");
    input.focus();
    expect(document.activeElement).toBe(input);
    input.blur();
    const detentBeforeReply = sheet.getAttribute("data-detent");

    fireEvent.click(bubbleFor("Reply without moving the sheet"));
    fireEvent.click(screen.getByTestId("thread-line-reply"));

    const replyPill = screen.getByTestId("chat-reply-pill");
    expect(screen.getByTestId("chat-thread").contains(replyPill)).toBe(true);
    const replyLane = screen.getByTestId("chat-reply-lane");
    expect(replyLane.className).toContain("shrink-0");
    expect(replyLane.className).toContain("overflow-hidden");
    expect(replyLane.className).not.toContain("absolute");
    expect(sheet.getAttribute("data-detent")).toBe(detentBeforeReply);
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByTestId("chat-reply-pill")).toBeNull();
    });
  });

  it("reveals Copy + Play on an assistant message and no top-menu copy button", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "the answer", createdAt: 1 },
      ],
      speak,
      speaking: false,
    });
    const actions = screen.getByTestId("thread-line-actions");
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
    expect(actions.style.opacity).toBe("0");
    fireEvent.click(bubbleFor("the answer"));
    expect(screen.getByTestId("thread-line-actions")).toBe(actions);
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.hasAttribute("inert")).toBe(false);
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.getByTestId("thread-line-speak")).toBeTruthy();
    // Assistant has no edit affordance.
    expect(screen.queryByTestId("thread-line-edit")).toBeNull();
    // The removed "copy conversation" top-menu button stays gone.
    expect(
      screen.queryByRole("button", { name: /copy conversation/i }),
    ).toBeNull();
  });

  it("keeps a failed speech attempt visible and clears it when playback recovers", () => {
    const controller = makeController({
      ttsError: {
        engine: "speech-sequence",
        message:
          "The reply changed after speech was queued. Play the completed reply again.",
        atMs: 1,
      },
    });
    const { rerender } = render(<ChatOverlay controller={controller} />);
    expect(screen.getByTestId("chat-voice-tts-error").textContent).toContain(
      "reply changed",
    );
    rerender(<ChatOverlay controller={{ ...controller, ttsError: null }} />);
    expect(screen.queryByText(/reply changed after speech/)).toBeNull();
  });

  it("Play speaks the assistant message via the controller", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "read me aloud", createdAt: 1 },
      ],
      speak,
      speaking: false,
    });
    fireEvent.click(bubbleFor("read me aloud"));
    fireEvent.click(screen.getByTestId("thread-line-speak"));
    expect(speak).toHaveBeenCalledWith("read me aloud");
  });

  it("Play toggles to Stop once THIS message is the one playing", () => {
    const speak = vi.fn();
    const stopSpeaking = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "now playing", createdAt: 1 },
      ],
      speak,
      stopSpeaking,
      speaking: true,
    });
    fireEvent.click(bubbleFor("now playing"));
    const play = screen.getByTestId("thread-line-speak");
    // The agent is globally speaking, but nothing has been Played from THIS
    // bubble, so it still offers Play (not a spurious Stop — the old bug).
    expect(play.getAttribute("aria-label")).toBe("Play audio");
    // Tapping Play speaks this message and marks it as the one playing.
    fireEvent.click(play);
    expect(speak).toHaveBeenCalledWith("now playing");
    const stop = screen.getByTestId("thread-line-speak");
    expect(stop.getAttribute("aria-label")).toBe("Stop");
    // Tapping again stops playback instead of re-speaking.
    fireEvent.click(stop);
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("shows Stop only on the actually-playing bubble, not every assistant bubble while anything speaks (#9148)", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "first answer", createdAt: 1 },
        { id: "b", role: "assistant", content: "second answer", createdAt: 2 },
      ],
      speak,
      speaking: true,
      responding: true,
      turnStatus: { kind: "speaking" },
    });
    // Reveal both action rows. With the global `speaking` flag set but nothing
    // Played yet, NEITHER bubble claims Stop (the old bug lit every bubble).
    fireEvent.click(bubbleFor("first answer"));
    fireEvent.click(bubbleFor("second answer"));
    expect(
      screen
        .getAllByTestId("thread-line-speak")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Play audio", "Play audio"]);
    // Play the FIRST message → only its bubble flips to Stop; the second stays
    // on Play even though the agent is still globally speaking.
    fireEvent.click(screen.getAllByTestId("thread-line-speak")[0]);
    expect(speak).toHaveBeenCalledWith("first answer");
    expect(
      screen
        .getAllByTestId("thread-line-speak")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Stop", "Play audio"]);
  });

  it("keeps automatic speaking in the composer without revealing message actions", () => {
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "first answer", createdAt: 1 },
        { id: "u", role: "user", content: "follow up", createdAt: 2 },
        { id: "b", role: "assistant", content: "second answer", createdAt: 3 },
      ],
      speaking: true,
      responding: true,
      turnStatus: { kind: "speaking" },
    });

    expect(screen.queryByTestId("speaking-status-accessory")).toBeNull();
    const rails = screen.getAllByTestId("thread-line-actions");
    expect(
      rails.every((rail) => rail.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
    expect(rails.every((rail) => rail.className.includes("invisible"))).toBe(
      true,
    );
    expect(screen.getByTestId("chat-composer-stop")).toBeTruthy();
  });

  it("moves speaking shimmer to the exact assistant selected for playback", () => {
    const speak = vi.fn();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "first answer", createdAt: 1 },
        { id: "b", role: "assistant", content: "second answer", createdAt: 2 },
      ],
      speak,
      speaking: true,
    });

    fireEvent.click(bubbleFor("first answer"));
    fireEvent.click(screen.getAllByTestId("thread-line-speak")[0]);

    const accessory = screen.getByTestId("speaking-status-accessory");
    expect(
      accessory.closest('[data-testid="thread-line"]')?.textContent,
    ).toContain("first answer");
    expect(screen.getAllByTestId("speaking-status-accessory")).toHaveLength(1);
    expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
    expect(screen.getByLabelText("talk")).toBeTruthy();
    expect(screen.queryByTestId("chat-composer-transcribe")).toBeNull();
  });

  it("does not alter a message action lane when automatic speaking starts", () => {
    const messages = [
      {
        id: "a",
        role: "assistant" as const,
        content: "stable speaking row",
        createdAt: 1,
      },
    ];
    const { rerender } = render(
      <ChatOverlay
        controller={makeController({ messages, speaking: false })}
      />,
    );
    fireEvent.focus(screen.getByLabelText("message"));
    const actions = screen.getByTestId("thread-line-actions");
    expect(screen.queryByTestId("speaking-status-accessory")).toBeNull();

    rerender(
      <ChatOverlay
        controller={makeController({
          messages,
          speaking: true,
          responding: true,
          turnStatus: { kind: "speaking" },
        })}
      />,
    );
    expect(screen.getByTestId("thread-line-actions")).toBe(actions);
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.className).toContain("invisible");
    expect(screen.queryByTestId("speaking-status-accessory")).toBeNull();
    expect(screen.getByTestId("chat-composer-stop")).toBeTruthy();

    rerender(
      <ChatOverlay
        controller={makeController({ messages, speaking: false })}
      />,
    );
    expect(screen.getByTestId("thread-line-actions")).toBe(actions);
    expect(screen.queryByTestId("speaking-status-accessory")).toBeNull();
  });

  it("row Copy writes the message text to the clipboard", () => {
    vi.mocked(copyTextToClipboard).mockClear();
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "copy this text", createdAt: 1 },
      ],
      speak: vi.fn(),
    });
    fireEvent.click(bubbleFor("copy this text"));
    fireEvent.click(screen.getByTestId("thread-line-copy"));
    expect(copyTextToClipboard).toHaveBeenCalledWith("copy this text");
  });

  it("edits a user message in place without creating a duplicate turn", async () => {
    const send = vi.fn();
    const stopSpeaking = vi.fn();
    const handleChatEdit = vi.fn().mockResolvedValue(true);
    const noop = () => {};
    __setAppValueForTests(
      new Proxy({} as never, {
        get(_target, prop) {
          if (prop === "handleChatEdit") return handleChatEdit;
          return noop;
        },
      }),
    );
    openThreadWith({
      messages: [{ id: "u", role: "user", content: "helo wrld", createdAt: 1 }],
      send,
      stopSpeaking,
    });
    fireEvent.click(bubbleFor("helo wrld"));
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.getByTestId("thread-line-edit")).toBeTruthy();
    // User turns have no play control.
    expect(screen.queryByTestId("thread-line-speak")).toBeNull();

    fireEvent.click(screen.getByTestId("thread-line-edit"));
    expect(
      screen.getByTestId("thread-line-actions").getAttribute("aria-hidden"),
    ).toBe("false");
    expect(screen.getByTestId("thread-line-edit-controls")).toBeTruthy();
    const input = screen.getByTestId(
      "thread-line-edit-input",
    ) as HTMLTextAreaElement;
    expect(input.value).toBe("helo wrld");
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(screen.getByTestId("thread-line-edit-save"));
    await waitFor(() => {
      expect(handleChatEdit).toHaveBeenCalledWith("u", "hello world");
    });
    expect(stopSpeaking).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not offer Edit on an optimistic temp- user turn", () => {
    openThreadWith({
      messages: [
        { id: "temp-123", role: "user", content: "pending turn", createdAt: 1 },
      ],
      send: vi.fn(),
    });
    fireEvent.click(bubbleFor("pending turn"));
    expect(screen.getByTestId("thread-line-copy")).toBeTruthy();
    expect(screen.queryByTestId("thread-line-edit")).toBeNull();
  });

  it("dismisses the row on an outside tap", () => {
    openThreadWith({
      messages: [
        { id: "a", role: "assistant", content: "tap away", createdAt: 1 },
      ],
      speak: vi.fn(),
    });
    const actions = screen.getByTestId("thread-line-actions");
    fireEvent.click(bubbleFor("tap away"));
    expect(screen.getByTestId("thread-line-actions")).toBe(actions);
    expect(actions.getAttribute("aria-hidden")).toBe("false");
    expect(actions.hasAttribute("inert")).toBe(false);
    fireEvent.pointerDown(document.body);
    expect(screen.getByTestId("thread-line-actions")).toBe(actions);
    expect(actions.getAttribute("aria-hidden")).toBe("true");
    expect(actions.hasAttribute("inert")).toBe(true);
    expect(actions.style.opacity).toBe("0");
  });

  it("Escape cancels the inline editor without resending", () => {
    const send = vi.fn();
    openThreadWith({
      messages: [{ id: "u", role: "user", content: "keep me", createdAt: 1 }],
      send,
    });
    fireEvent.click(bubbleFor("keep me"));
    fireEvent.click(screen.getByTestId("thread-line-edit"));
    const input = screen.getByTestId("thread-line-edit-input");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("thread-line-edit-input")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("ChatOverlay — routed OS-intent composer prefill (#9148, #16441)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("prefills the composer from the routing authority's review event", () => {
    render(<ChatOverlay controller={makeController()} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent<OsIntentComposerPrefillDetail>(
          OS_INTENT_COMPOSER_PREFILL_EVENT,
          { detail: { text: "Remind me at 5" } },
        ),
      );
    });
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("Remind me at 5");
  });

  it("does not independently parse a launch hash", () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?text=Water%20plants&source=macos-shortcuts&assistant.launchId=launch-once",
    );
    render(<ChatOverlay controller={makeController()} />);
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("never starts voice capture from a composer-prefill event", () => {
    const toggleHandsFree = vi.fn();
    render(<ChatOverlay controller={makeController({ toggleHandsFree })} />);
    act(() => {
      window.dispatchEvent(
        new CustomEvent<OsIntentComposerPrefillDetail>(
          OS_INTENT_COMPOSER_PREFILL_EVENT,
          { detail: { text: "start talking" } },
        ),
      );
    });
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("start talking");
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("ignores an untrusted-source hash (no prefill, no voice)", () => {
    const toggleHandsFree = vi.fn();
    window.history.replaceState(
      null,
      "",
      "/#chat?text=malicious&source=unknown-shortcut&voice=1",
    );
    render(<ChatOverlay controller={makeController({ toggleHandsFree })} />);
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(toggleHandsFree).not.toHaveBeenCalled();
  });

  it("uses the shared reply-only callback for a stored effect failure without resending", async () => {
    let finish!: () => void;
    const handleChatRetry = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    __setAppValueForTests({ handleChatRetry } as never);
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "Create a note", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "The reply failed.",
          createdAt: 2,
          failureKind: "provider_issue",
          replyRecoveryAvailable: true,
          terminalFailure: {
            kind: "provider_issue",
            transient: false,
            message: "Reply failed.",
          },
        },
      ],
    });
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const retry = screen.getByRole("button", { name: "Regenerate reply" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(handleChatRetry).toHaveBeenCalledTimes(1);
    expect(handleChatRetry).toHaveBeenCalledWith("a1");
    expect(controller.send).not.toHaveBeenCalled();
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect(retry.textContent).toContain("Regenerating reply…");
    await act(async () => {
      finish();
    });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows Retry on planner exhaustion and re-sends the preceding user turn", () => {
    const controller = makeController({
      messages: [
        {
          id: "u1",
          role: "user",
          content: "what's the weather?",
          createdAt: 1,
        },
        {
          id: "a1",
          role: "assistant",
          content: "",
          createdAt: 2,
          failureKind: "planner_exhaustion",
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const retry = screen.getByTestId("thread-line-retry");
    expect(retry).toBeTruthy();
    fireEvent.click(retry);
    expect(controller.send).toHaveBeenCalledWith("what's the weather?");
  });

  it("marks a non-retryable normal assistant failure without showing Retry", () => {
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "hi", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "The required capability is unavailable.",
          createdAt: 2,
          failureKind: "missing_capability",
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    const failedTurn = screen
      .getByText("The required capability is unavailable.")
      .closest('[data-testid="thread-line"]');
    expect(failedTurn?.getAttribute("data-failure")).toBe("missing_capability");
    expect(screen.queryByTestId("thread-line-retry")).toBeNull();
  });

  it("shows Retry when a typed terminal failure explicitly marks a normally permanent kind transient", () => {
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "fix it", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "Shell execution failed.",
          createdAt: 2,
          failureKind: "coding_tool_failure",
          terminalFailure: {
            kind: "coding_tool_failure",
            message: "Shell execution failed.",
            transient: true,
            code: "SHELL_UNAVAILABLE",
          },
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.getByTestId("thread-line-retry")).toBeTruthy();
  });

  it("hides Retry when a typed terminal failure marks a normally retryable kind permanent", () => {
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "try it", createdAt: 1 },
        {
          id: "a1",
          role: "assistant",
          content: "The planner cannot continue.",
          createdAt: 2,
          failureKind: "planner_exhaustion",
          terminalFailure: {
            kind: "planner_exhaustion",
            message: "The planner cannot continue.",
            transient: false,
          },
        },
      ],
    } as unknown as Partial<ShellController>);
    render(<ChatOverlay controller={controller} />);
    fireEvent.focus(screen.getByLabelText("message"));
    expect(screen.queryByTestId("thread-line-retry")).toBeNull();
  });

  it("restores the persisted composer draft for the active conversation (shared app composer slot)", () => {
    // The overlay reads the SHARED ChatComposerContext draft; the app-level
    // persistence hook (AppContext runs the same one this harness runs)
    // restores a saved draft into that slot on mount, which must repaint the
    // overlay's composer.
    clearChatDraft("conv-draft-x");
    writeChatDraft("conv-draft-x", "half-written thought");
    render(
      <AppComposerHarness
        initialActiveId="conv-draft-x"
        selectRef={{ current: null }}
      />,
    );
    expect(
      (screen.getByLabelText("message") as HTMLTextAreaElement).value,
    ).toBe("half-written thought");
    clearChatDraft("conv-draft-x");
  });

  it("typing in the overlay edits the shared app composer slot (one draft across surfaces)", () => {
    render(
      <AppComposerHarness
        initialActiveId="conv-a"
        selectRef={{ current: null }}
      />,
    );
    const input = screen.getByLabelText("message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "shared draft" } });
    expect(screen.getByTestId("harness-chat-input").textContent).toBe(
      "shared draft",
    );
    clearChatDraft("conv-a");
  });

  // Draft handoff on conversation switch. The overlay no longer owns any
  // handoff logic: its draft is the shared ChatComposerContext slot, and the
  // app's select path (useChatCallbacks.handleSelectConversation — which the
  // controller's conversationNav swipe routes through) flushes the leaving
  // conversation's text under ITS OWN key and repaints the target's draft (or
  // clears it). The harness runs that exact seam around the real overlay.
  describe("draft handoff on conversation switch", () => {
    beforeEach(() => {
      clearChatDraft("conv-a");
      clearChatDraft("conv-b");
    });

    afterEach(() => {
      clearChatDraft("conv-a");
      clearChatDraft("conv-b");
    });

    it("switching A(typed) → B(no draft) clears the composer and saves the text under A's key — never B's", async () => {
      const selectRef: {
        current: ((id: string) => void) | null;
      } = { current: null };
      render(
        <AppComposerHarness initialActiveId="conv-a" selectRef={selectRef} />,
      );
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "half-typed for A" } });

      act(() => selectRef.current?.("conv-b"));

      // The draftless target CLEARS — A's text must not stay visible in B.
      expect(input.value).toBe("");
      // The handoff flushed the text under the LEAVING conversation's key
      // synchronously (the debounced persister's pending timer is cancelled
      // by the switch, so only the explicit flush can have written this).
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
      expect(readChatDraft("conv-b")).toBeNull();

      // Outlast the 500ms persist debounce: the wrong-conversation write
      // (A's text under B's key) must NEVER land.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect(readChatDraft("conv-b")).toBeNull();
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
    });

    it("switching A(typed) → B(saved draft) restores B's own draft and keeps A's under A's key", () => {
      writeChatDraft("conv-b", "B's parked reply");
      const selectRef: {
        current: ((id: string) => void) | null;
      } = { current: null };
      render(
        <AppComposerHarness initialActiveId="conv-a" selectRef={selectRef} />,
      );
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "half-typed for A" } });

      act(() => selectRef.current?.("conv-b"));

      expect(input.value).toBe("B's parked reply");
      expect(readChatDraft("conv-a")).toBe("half-typed for A");
      expect(readChatDraft("conv-b")).toBe("B's parked reply");
    });

    it("a successful send still clears both the composer and the active conversation's saved draft", () => {
      writeChatDraft("conv-a", "stale saved draft");
      const controller = makeController({
        conversationNav: {
          hasPrev: false,
          hasNext: false,
          goPrev: () => {},
          goNext: () => {},
          activeId: "conv-a",
          index: 0,
        },
      } as unknown as Partial<ShellController>);
      render(<ChatOverlay controller={controller} />);
      const input = screen.getByLabelText("message") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "ship it" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("ship it");
      expect(input.value).toBe("");
      // The submit path drops the persisted draft immediately (not just via
      // the debounced persist of the now-empty draft).
      expect(readChatDraft("conv-a")).toBeNull();
    });
  });
});

// The floating boot pill was removed outright: boot state has NO surface above
// the chat. A stalled boot speaks INSIDE the transcript via the boot-recovery
// conductor (use-boot-recovery-conductor.test.tsx covers that path); this pins
// the overlay's side of the contract — no pill ever, no matter how long the
// boot runs.
describe("ChatOverlay — no floating boot pill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never renders a floating boot-status pill, even deep into a cold boot", () => {
    render(<ChatOverlay controller={makeController({ phase: "booting" })} />);
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(screen.queryByTestId("chat-boot-status")).toBeNull();
  });
});

// When no LLM/model provider is configured the agent's `canRespond` never flips,
// so `phase` stays "booting" forever. The controller flags `noProviderConfigured`
// and the overlay stops promising the agent is "waking up" — the in-transcript
// no_provider gate is the real error surface.
describe("ChatOverlay — no LLM provider configured", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("swaps the 'waking up…' composer placeholder for a Settings CTA hint", () => {
    render(
      <ChatOverlay
        controller={makeController({
          phase: "booting",
          noProviderConfigured: true,
        })}
      />,
    );
    const input = screen.getByLabelText("message");
    const placeholder = input.getAttribute("placeholder") ?? "";
    expect(placeholder).not.toContain("waking up");
    expect(placeholder).toContain("Settings");
    // Typing is still allowed (the send comes back with the gate again if needed).
    expect(input.hasAttribute("readonly")).toBe(false);
  });
});
