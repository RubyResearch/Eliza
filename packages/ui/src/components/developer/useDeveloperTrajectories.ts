/** Poll only small summaries. Inspect one run; fetch wire payloads on demand. */
import { useEffect, useRef, useState } from "react";
import { client } from "../../api/client";
import type {
  TrajectoryDetailResult,
  TrajectoryRecord,
} from "../../api/client-types-cloud";

export function trajectoryRevision(run: TrajectoryRecord): string {
  return [
    run.id,
    run.status,
    run.updatedAt,
    run.llmCallCount,
    run.providerAccessCount,
    run.totalPromptTokens,
    run.totalCompletionTokens,
  ].join(":");
}

export function useDeveloperTrajectories(
  roomId: string | undefined,
  busy: boolean,
  loadInspection = true,
) {
  const [offset, setOffset] = useState(0);
  const [selectedId, select] = useState<string | null>(null);
  const [rows, setRows] = useState<TrajectoryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [inspection, setInspection] = useState<{
    scope: string;
    record: TrajectoryRecord;
    detail: TrajectoryDetailResult;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const cache = useRef<{
    revision: string;
    detail: TrajectoryDetailResult;
  } | null>(null);

  const scope = JSON.stringify([roomId, offset, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let denied = false;
    const poll = async () => {
      if (
        inFlight ||
        paused ||
        denied ||
        document.hidden ||
        controller.signal.aborted
      )
        return;
      // The chat needs its own foreground summaries. Global background runs
      // must not evict them, including on a fresh page load. The advanced
      // inspector keeps its independent global pagination.
      if (!loadInspection && !roomId) return;
      inFlight = true;
      try {
        const result = await client.getTrajectories(
          loadInspection
            ? { limit: 50, offset }
            : { limit: 50, offset: 0, roomId, source: "client_chat" },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setRows(result.trajectories);
        setTotal(result.total);
        const record = selectedId
          ? result.trajectories.find((row) => row.id === selectedId)
          : result.trajectories.find(
              (row) =>
                roomId && row.roomId === roomId && row.source === "client_chat",
            );
        if (record && loadInspection) {
          const revision = trajectoryRevision(record);
          if (cache.current?.revision !== revision) {
            const detail = await client.getTrajectoryDetail(record.id, {
              signal: controller.signal,
              includePayloads: false,
            });
            if (controller.signal.aborted) return;
            cache.current = { revision, detail };
          }
          setInspection({ scope, record, detail: cache.current.detail });
        } else setInspection(null);
        setError(null);
      } catch (failure) {
        // error-policy:J4 Inspector failures are visible and never interrupt chat.
        if (controller.signal.aborted) return;
        const status = (failure as { status?: number })?.status;
        denied = status === 401 || status === 403;
        setError(
          denied
            ? "This connection cannot read trajectories."
            : "Telemetry is unavailable. Retrying while this panel is visible.",
        );
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && !paused && !denied) {
          timer = setTimeout(() => void poll(), busy ? 500 : 5000);
        }
      }
    };
    const onVisibility = () => {
      if (timer) clearTimeout(timer);
      if (!document.hidden) void poll();
    };
    // Discarded StrictMode mounts must not dispatch reads.
    void Promise.resolve().then(poll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [roomId, offset, selectedId, paused, busy, scope, loadInspection]);

  return {
    rows,
    total,
    offset,
    setOffset,
    selectedId,
    select,
    inspection: inspection?.scope === scope ? inspection : null,
    error,
    paused,
    setPaused,
  };
}
