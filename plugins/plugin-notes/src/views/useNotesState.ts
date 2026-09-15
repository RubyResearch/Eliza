/**
 * Synchronizes the mounted Notes view with the server-owned state document.
 * Revision ordering prevents a slow refresh or cross-view event from replacing
 * a newer mutation result, while explicit loading and error phases keep a
 * broken transport visually distinct from an empty notes collection.
 */

import { client } from "@elizaos/ui/api";
import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotesSnapshot } from "../types.js";
import {
  fetchNotesState,
  interact,
  NOTES_STATE_UPDATED_EVENT,
  NOTES_UPDATED_EVENT,
  type NotesInteractResult,
} from "./notesData.js";

export interface NotesState {
  snapshot: NotesSnapshot | null;
  loading: boolean;
  busy: boolean;
  /**
   * Keep transport classification intact for the view. In particular, Shared
   * capability responses carry an ApiError code and structured retryability
   * data that must not be flattened into display copy here.
   */
  error: Error | null;
  refresh: () => Promise<void>;
  mutate: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<NotesInteractResult>;
}

function notesError(cause: unknown): Error {
  return cause instanceof Error
    ? cause
    : new Error("Notes could not reach the local agent.", { cause });
}

interface AuthorityState<T> {
  authority: string;
  value: T;
}

export function useNotesState(): NotesState {
  const authority = useActiveAgentAuthority();
  const authorityRef = useRef(authority);
  authorityRef.current = authority;
  const [snapshotState, setSnapshotState] =
    useState<AuthorityState<NotesSnapshot> | null>(null);
  const [loadingState, setLoadingState] = useState<AuthorityState<boolean>>({
    authority,
    value: true,
  });
  const [busyState, setBusyState] = useState<AuthorityState<boolean>>({
    authority,
    value: false,
  });
  const [errorState, setErrorState] = useState<AuthorityState<Error> | null>(
    null,
  );
  const mounted = useRef(true);
  const refreshGeneration = useRef(0);
  const refreshAbortController = useRef<AbortController | null>(null);

  // Authority-tagged state masks the prior agent synchronously during render,
  // before the new authority's refresh effect runs. Async work also checks the
  // live authority ref so an agent-A response can never publish into agent-B.
  const snapshot =
    snapshotState?.authority === authority ? snapshotState.value : null;
  const loading =
    loadingState.authority === authority ? loadingState.value : true;
  const busy = busyState.authority === authority ? busyState.value : false;
  const error = errorState?.authority === authority ? errorState.value : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      refreshAbortController.current?.abort("Notes view unmounted");
    };
  }, []);

  const acceptSnapshot = useCallback(
    (next: NotesSnapshot, requestAuthority = authority) => {
      if (!mounted.current || authorityRef.current !== requestAuthority) {
        return;
      }
      setSnapshotState((current) => {
        if (
          current?.authority === requestAuthority &&
          current.value.revision > next.revision
        ) {
          return current;
        }
        return { authority: requestAuthority, value: next };
      });
    },
    [authority],
  );

  const refresh = useCallback(async () => {
    const requestAuthority = authority;
    const generation = ++refreshGeneration.current;
    refreshAbortController.current?.abort("Notes refresh superseded");
    const abortController = new AbortController();
    refreshAbortController.current = abortController;
    if (mounted.current && authorityRef.current === requestAuthority) {
      setLoadingState({ authority: requestAuthority, value: true });
    }
    try {
      acceptSnapshot(
        await fetchNotesState(abortController.signal),
        requestAuthority,
      );
      if (
        mounted.current &&
        authorityRef.current === requestAuthority &&
        generation === refreshGeneration.current
      ) {
        // Keep a cached snapshot's sync warning until a newer request succeeds;
        // starting a retry does not establish that the connection recovered.
        setErrorState(null);
      }
    } catch (cause) {
      if (abortController.signal.aborted) return;
      // error-policy:J4 render transport failure distinctly from empty state.
      if (
        mounted.current &&
        authorityRef.current === requestAuthority &&
        generation === refreshGeneration.current
      ) {
        setErrorState({
          authority: requestAuthority,
          value: notesError(cause),
        });
      }
    } finally {
      if (refreshAbortController.current === abortController) {
        refreshAbortController.current = null;
      }
      if (
        !abortController.signal.aborted &&
        mounted.current &&
        authorityRef.current === requestAuthority &&
        generation === refreshGeneration.current
      ) {
        setLoadingState({ authority: requestAuthority, value: false });
      }
    }
  }, [acceptSnapshot, authority]);

  useEffect(() => {
    void refresh();
    return () => {
      refreshAbortController.current?.abort("Notes authority changed");
    };
  }, [refresh]);

  useViewEvent(NOTES_STATE_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);

  useViewEvent(NOTES_UPDATED_EVENT, () => {
    void refresh();
  }, [refresh]);

  useViewEvent(VIEW_EVENTS.VIEW_REFRESH, () => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const refreshAfterReconnect = () => {
      void refresh();
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    const unsubscribeReconnect = client.onWsEvent(
      "ws-reconnected",
      refreshAfterReconnect,
    );
    window.addEventListener("online", refreshAfterReconnect);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      unsubscribeReconnect();
      window.removeEventListener("online", refreshAfterReconnect);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  const mutate = useCallback(
    async (capability: string, params?: Record<string, unknown>) => {
      const requestAuthority = authority;
      if (mounted.current && authorityRef.current === requestAuthority) {
        setBusyState({ authority: requestAuthority, value: true });
        setErrorState(null);
      }
      try {
        const result = await interact(capability, params);
        acceptSnapshot(result.state, requestAuthority);
        return result;
      } catch (cause) {
        // error-policy:J4 preserve visible state and surface the failed mutation.
        if (mounted.current && authorityRef.current === requestAuthority) {
          setErrorState({
            authority: requestAuthority,
            value: notesError(cause),
          });
        }
        throw cause;
      } finally {
        if (mounted.current && authorityRef.current === requestAuthority) {
          setBusyState({ authority: requestAuthority, value: false });
        }
      }
    },
    [acceptSnapshot, authority],
  );

  return { snapshot, loading, busy, error, refresh, mutate };
}
