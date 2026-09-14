/**
 * The single client-side first-run finalizer. `completeFirstRun` flips the
 * durable completion gate, notifies the startup coordinator, and lands the
 * user on a tab. It is invoked by the in-chat onboarding conductor (tutorial
 * pick / Settings escape), the remote CONNECT_EVENT adoption path, and the
 * cloud-provisioned-container skip. The deleted wizard's step-navigation and
 * remote-connect callbacks died with the wizard (#9952, #12178).
 */

import { type RefObject, useCallback } from "react";
import { getWindowNavigationPath, type Tab } from "../navigation";
import type { FirstRunStateHook } from "./useFirstRunState";

export interface FirstRunCallbacksDeps {
  /** Full result of useFirstRunState — state + dispatch. */
  firstRun: FirstRunStateHook;

  setPostFirstRunChecklistDismissed: (v: boolean) => void;

  /** Lifecycle / global */
  setFirstRunComplete: (v: boolean) => void;
  coordinatorFirstRunCompleteRef: RefObject<(() => void) | null>;
  initialTabSetRef: RefObject<boolean>;
  setTab: (tab: Tab) => void;
  defaultLandingTab: Tab;
  loadCharacter: () => Promise<void>;
}

export function useFirstRunCallbacks(deps: FirstRunCallbacksDeps) {
  const {
    firstRun,
    setPostFirstRunChecklistDismissed,
    setFirstRunComplete,
    coordinatorFirstRunCompleteRef,
    initialTabSetRef,
    setTab,
    defaultLandingTab,
    loadCharacter,
  } = deps;

  const { completionCommittedRef: firstRunCompletionCommittedRef } = firstRun;

  const completeFirstRun = useCallback(
    (landingTab: Tab = defaultLandingTab) => {
      firstRunCompletionCommittedRef.current = true;
      setPostFirstRunChecklistDismissed(false);
      setFirstRunComplete(true);
      coordinatorFirstRunCompleteRef.current?.();
      initialTabSetRef.current = true;
      // A Cloud account page can finish agent discovery in the background.
      // Complete onboarding without replacing the user's explicit management
      // destination with Chat after the sign-in callback has restored it.
      if (!/^\/cloud(?:\/|$)/.test(getWindowNavigationPath())) {
        setTab(landingTab);
      }
      void loadCharacter();
    },
    [
      firstRunCompletionCommittedRef,
      setFirstRunComplete,
      setPostFirstRunChecklistDismissed,
      setTab,
      defaultLandingTab,
      loadCharacter,
      coordinatorFirstRunCompleteRef,
      initialTabSetRef,
    ],
  );

  return {
    completeFirstRun,
  };
}
