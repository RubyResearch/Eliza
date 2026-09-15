/** Message-scoped, on-demand access to the shared full trajectory viewer. */
import { useEffect, useId, useMemo, useState } from "react";
import { client } from "../../api/client";
import type { TrajectoryRecord } from "../../api/client-types-cloud";
import { TrajectoryDetailView } from "../pages/TrajectoryDetailView";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { trajectoryRevision } from "./useDeveloperTrajectories";

export const isReplyRecoveryRun = (record: TrajectoryRecord) =>
  record.metadata?.replyRecovery === true;

const runLabel = (record: TrajectoryRecord) =>
  `${isReplyRecoveryRun(record) ? "Reply recovery" : record.source === "client_chat" ? "Chat run" : record.source === "background_memory" ? "Background memory" : record.source.replace(/_/g, " ")} · ${record.llmCallCount} model ${record.llmCallCount === 1 ? "attempt" : "attempts"} · ${record.status}`;

export function useMessageTrajectories({
  records,
  roomId,
  messageId,
  enabled,
}: {
  records: TrajectoryRecord[];
  roomId?: string;
  messageId?: string;
  enabled: boolean;
}) {
  const [found, setFound] = useState<TrajectoryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  // New runs arriving in the small live-summary poll trigger another lookup.
  // Token/count updates refresh only the open run, not this history search.
  const runIds = records
    .map((record) => record.id)
    .sort()
    .join(":");
  // biome-ignore lint/correctness/useExhaustiveDependencies: New run ids and explicit retry invalidate the message lookup.
  useEffect(() => {
    if (!enabled || !roomId || !messageId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void (async () => {
      const matches = new Map<string, TrajectoryRecord>();
      let offset = 0;
      do {
        const page = await client.getTrajectories(
          { search: messageId, limit: 100, offset },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        for (const row of page.trajectories) {
          // Search can also match prompt text; accept only the exact owner.
          if (row.roomId === roomId && row.metadata?.messageId === messageId)
            matches.set(row.id, row);
        }
        offset += page.trajectories.length;
        if (!page.trajectories.length || offset >= page.total) break;
      } while (!controller.signal.aborted);
      setFound([...matches.values()]);
    })()
      .catch(() => {
        // error-policy:J4 Inspector failures never interrupt the conversation.
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, roomId, messageId, runIds, retry]);

  const runs = useMemo(() => {
    const byId = new Map(
      found
        .filter(
          (row) =>
            row.roomId === roomId && row.metadata?.messageId === messageId,
        )
        .map((record) => [record.id, record]),
    );
    for (const record of records) byId.set(record.id, record);
    return [...byId.values()].sort(
      (a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id),
    );
  }, [found, records, roomId, messageId]);

  return { runs, loading, error, retry: () => setRetry((value) => value + 1) };
}

export function DeveloperTrajectories({
  runs,
  loading,
  error,
  retry,
}: ReturnType<typeof useMessageTrajectories>) {
  const [selectedId, setSelectedId] = useState<string>();
  const selectId = useId();
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  return (
    <div className="developer-run-browser">
      {loading ? (
        <p role="status" className="text-xs text-muted">
          Finding all runs for this message…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm">
          Couldn’t load all runs. The list may be incomplete.{" "}
          <Button size="touch" variant="outline" onClick={retry}>
            Retry
          </Button>
        </div>
      ) : null}
      {!loading && !error && !runs.length ? (
        <p role="status">No recorded trajectories for this message.</p>
      ) : null}
      {selected ? (
        <>
          <div className="developer-run-selector">
            {runs.length > 1 ? (
              <>
                <label htmlFor={selectId}>Run</label>
                <NativeSelect
                  id={selectId}
                  value={selected.id}
                  onChange={(event) => setSelectedId(event.target.value)}
                >
                  {runs.map((run, index) => (
                    <option key={run.id} value={run.id}>
                      {index + 1}. {runLabel(run)}
                    </option>
                  ))}
                </NativeSelect>
              </>
            ) : (
              <p>{runLabel(selected)}</p>
            )}
          </div>
          <TrajectoryDetailView
            key={selected.id}
            trajectoryId={selected.id}
            revision={trajectoryRevision(selected)}
            collapsibleCalls
          />
        </>
      ) : null}
    </div>
  );
}
