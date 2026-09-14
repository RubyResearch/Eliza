/** First-run completion preserves account management entered during sign-in. */
// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFirstRunCallbacks } from "./useFirstRunCallbacks";
import { useFirstRunState } from "./useFirstRunState";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

it.each([
  ["/cloud/agents?filter=running#agent", true],
  ["/cloud/billing", true],
  ["/cloud", true],
  ["/cloudish", false],
  ["/", false],
  ["/settings", false],
])(
  "finishes onboarding on %s without losing an account route",
  (path, preserve) => {
    window.history.replaceState(null, "", path);
    const setTab = vi.fn();
    const setFirstRunComplete = vi.fn();
    const coordinatorComplete = vi.fn();
    const initialTabSetRef = { current: false };
    const loadCharacter = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => {
      const firstRun = useFirstRunState();
      return {
        firstRun,
        ...useFirstRunCallbacks({
          firstRun,
          setPostFirstRunChecklistDismissed: vi.fn(),
          setFirstRunComplete,
          coordinatorFirstRunCompleteRef: { current: coordinatorComplete },
          initialTabSetRef,
          setTab,
          defaultLandingTab: "chat",
          loadCharacter,
        }),
      };
    });

    act(() => result.current.completeFirstRun("chat"));

    expect(result.current.firstRun.completionCommittedRef.current).toBe(true);
    expect(setFirstRunComplete).toHaveBeenCalledExactlyOnceWith(true);
    expect(coordinatorComplete).toHaveBeenCalledOnce();
    expect(initialTabSetRef.current).toBe(true);
    expect(loadCharacter).toHaveBeenCalledOnce();
    if (preserve) {
      expect(setTab).not.toHaveBeenCalled();
      expect(
        window.location.pathname +
          window.location.search +
          window.location.hash,
      ).toBe(path);
    } else {
      expect(setTab).toHaveBeenCalledExactlyOnceWith("chat");
    }
  },
);
