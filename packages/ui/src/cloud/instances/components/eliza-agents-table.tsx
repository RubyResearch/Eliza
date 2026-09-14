/**
 * Eliza Agents Table — lists hosted agent sandboxes on the Instances page.
 * Auto-refreshes while any sandbox is in an active (pending/provisioning) state.
 */
"use client";

import type {
  AgentSandboxStatus,
  NormalizedAgentListItemDto,
} from "@elizaos/cloud-sdk";
import {
  AGENT_PRICING,
  DEDICATED_COMPUTE_PRICE_HEADER,
  formatHourlyRate,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  BulkDeleteDialog,
  BulkSelectionBar,
  DashboardDataList,
  DashboardDataListDesktop,
  DashboardDataListFilteredCount,
  DashboardDataListMobile,
  DataListEmptyState,
  Input,
  runBulkDelete,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@elizaos/ui/cloud-ui";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpDown,
  Boxes,
  ExternalLink,
  Loader2,
  Moon,
  Pause,
  Play,
  Search,
  Sun,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "../../../bridge/toast";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { currentElizaAppOrigin } from "../../../utils/cloud-agent-base";
import { api, apiWithStatus } from "../../lib/api-client";
import { parseAgentsResponse } from "../lib/data/eliza-agents";
import { useT } from "../lib/i18n";
import { openWebUIWithPairing } from "../lib/open-web-ui";
import { statusDotColor } from "../lib/sandbox-status";
import { type TrackedJob, useJobPoller } from "../lib/use-job-poller";
import { useSandboxListPoll } from "../lib/use-sandbox-status-poll";
import { AgentCostBadge } from "./agent-cost-badge";
import { DedicatedStartConfirmation } from "./dedicated-start-confirmation";

/**
 * Envelope the agent provision/suspend job endpoints return. 202 and 409
 * responses carry a `jobId` to hand to the job poller; error responses carry
 * a human-readable `error`.
 */
interface AgentJobEnvelope {
  data?: { jobId?: string };
  error?: string;
}

/**
 * Merge a fresh API agent list onto the current rows for a background refresh.
 *
 * Updates each existing row from the API when present, keeps it otherwise, and
 * appends rows the API introduced. It NEVER removes a row just because this
 * fetch omitted it: a background status poll that came back short/empty (a
 * transient, a paging blip) must not blank the table while the authoritative
 * count still reads >0. Membership removal is owned elsewhere — the
 * `useAgents()` refetch (which replaces the list wholesale via the
 * `agents` prop resync) and explicit-delete tombstones (`tombstoned`).
 * Exported for direct unit coverage of that invariant.
 */

/**
 * How long a delete-tombstone hides an agent the API still returns. The
 * tombstone exists to absorb the eventual-consistency window after a DELETE (so
 * a lagging refetch can't resurrect a just-deleted row). But if the API keeps
 * returning the agent past this window, the delete evidently did NOT take — the
 * agent is still live and BILLED — so the tombstone must expire and the agent
 * must reappear. Never hide a billed agent forever ("1 running, $X/mo, but no
 * agent shown"). Long enough that a genuine container delete completes and the
 * agent leaves the API list first (retired cleanly, no flicker); short enough
 * that a delete that never took only hides the billed agent for ~a minute.
 */
const TOMBSTONE_GRACE_MS = 60_000;
// Derive the create-agent / "Open Eliza app" target from the CURRENT console
// host so a signed-in staging user isn't bounced to the PROD app (different
// tenant/session) — #15161. Resolved once at module load: the console host is
// stable for the lifetime of the page.
const ELIZA_APP_AGENT_CREATE_URL = currentElizaAppOrigin();

/**
 * Retire delete-tombstones by TIME only — the single retirement clock for both
 * the status poll (`mergeApiData`) and the react-query reconcile effect. A
 * tombstone lives its full grace window regardless of whether the API still
 * returns the agent:
 *  - delete took → both eventually-consistent reads drop the agent well before
 *    expiry, so at expiry there is nothing left to re-add (no resurrection);
 *  - delete did NOT take (agent still billed) → at expiry the agent reappears
 *    because the API keeps returning it.
 * Retiring by *absence* instead would race the two reads (poll drops the row →
 * tombstone lifted → the reconcile effect re-adds it from react-query's laggier
 * list) and resurrect a just-deleted row. Mutates `tombstones` in place;
 * exported for direct unit coverage of the invariant.
 */
export function retireExpiredTombstones(
  tombstones: Map<string, number>,
  now: number,
  graceMs: number,
): void {
  for (const [id, since] of tombstones) {
    if (now - since > graceMs) {
      tombstones.delete(id);
    }
  }
}

export function mergeAgentList(
  prev: NormalizedAgentListItemDto[],
  apiAgents: NormalizedAgentListItemDto[],
  tombstoned: ReadonlySet<string>,
): NormalizedAgentListItemDto[] {
  const apiById = new Map(apiAgents.map((a) => [a.id, a]));
  const updated = prev
    .filter((sb) => !tombstoned.has(sb.id))
    .map((sb) => {
      const agent = apiById.get(sb.id);
      return agent ?? sb;
    });
  const known = new Set(prev.map((sb) => sb.id));
  const added = apiAgents.filter(
    (agent) => !known.has(agent.id) && !tombstoned.has(agent.id),
  );
  return [...updated, ...added];
}

/**
 * Merge a background API refresh while retiring explicit-delete tombstones only
 * AFTER that refresh has used them to filter the existing local rows. The order
 * matters: the first API response that omits a deleted id is also the response
 * that should remove the local row, not resurrect it by clearing the tombstone
 * too early.
 */
function isDockerBacked(agent: NormalizedAgentListItemDto): boolean {
  return agent.executionTier === "custom" || Boolean(agent.dockerImage);
}

function getRuntimeKind(
  agent: NormalizedAgentListItemDto,
): "managed" | "shared" | "sandbox" | "notProvisioned" {
  if (isDockerBacked(agent)) return "managed";
  if (agent.executionTier === "shared") return "shared";
  if (
    agent.status === "running" ||
    agent.status === "provisioning" ||
    // Both states are post-provision lifecycle outcomes: stopped agents were
    // deliberately suspended, while disconnected agents lost contact after
    // provisioning. Neither should read as an agent that was never set up.
    agent.status === "stopped" ||
    agent.status === "disconnected" ||
    // A deactivated (sleeping) agent released its container but is still an
    // established sandbox with a restorable backup — "Not provisioned" would
    // misread as never-set-up.
    agent.status === "sleeping"
  ) {
    return "sandbox";
  }
  return "notProvisioned";
}

/**
 * Everything a single agent row needs to render, derived once from the raw row
 * plus the live poll/action state. The desktop table and the mobile card are
 * two views of the same row and must agree on status, action-availability, and
 * web-UI reachability; deriving here (rather than inline in each renderer) keeps
 * them from drifting and computes `runtimeKind` a single time.
 */
interface AgentRowViewModel {
  agent: NormalizedAgentListItemDto;
  isDocker: boolean;
  trackedJob: TrackedJob | undefined;
  isProvisioningActive: boolean;
  displayStatus: string;
  busy: boolean;
  canStart: boolean;
  canStop: boolean;
  /** Deactivate (sleep): only a running dedicated agent has compute to free —
   * shared-runtime rows have no container, so the endpoint would no-op. */
  canSleep: boolean;
  /** Reactivate (wake): offered exactly for the sleeping (deactivated) state. */
  canWake: boolean;
  /** The authenticated pairing endpoint owns final Web UI reachability. */
  hasStandaloneWebUi: boolean;
  runtimeKind: ReturnType<typeof getRuntimeKind>;
}

export function deriveAgentRow(
  agent: NormalizedAgentListItemDto,
  poller: Pick<ReturnType<typeof useJobPoller>, "getStatus" | "isActive">,
  actionInProgress: string | null,
): AgentRowViewModel {
  const isProvisioningActive = poller.isActive(agent.id);
  const displayStatus = isProvisioningActive ? "provisioning" : agent.status;
  const busy = actionInProgress === agent.id || isProvisioningActive;
  return {
    agent,
    isDocker: isDockerBacked(agent),
    trackedJob: poller.getStatus(agent.id),
    isProvisioningActive,
    displayStatus,
    busy,
    canStart:
      ["stopped", "error", "pending", "disconnected"].includes(displayStatus) &&
      !busy,
    canStop:
      displayStatus === "running" && agent.executionTier !== "shared" && !busy,
    canSleep:
      displayStatus === "running" && agent.executionTier !== "shared" && !busy,
    canWake: displayStatus === "sleeping" && !busy,
    hasStandaloneWebUi:
      displayStatus === "running" && agent.executionTier !== "shared",
    runtimeKind: getRuntimeKind(agent),
  };
}

/** Shared is the user's persistent Eliza; Dedicated keeps its chosen name. */
function getAgentDisplayName(
  agent: NormalizedAgentListItemDto,
  sharedAgentName: string,
  unnamedAgent: string,
) {
  return agent.executionTier === "shared"
    ? sharedAgentName
    : (agent.agentName ?? unnamedAgent);
}

function StatusCell({
  displayStatus,
  isProvisioning,
  trackedJob,
  errorMessage,
}: {
  displayStatus: string;
  isProvisioning: boolean;
  trackedJob?: { jobId: string } | null;
  errorMessage: string | null;
}) {
  const t = useT();
  const [prevStatus, setPrevStatus] = useState(displayStatus);
  const [animate, setAnimate] = useState<"success" | "error" | null>(null);

  useEffect(() => {
    if (prevStatus !== displayStatus) {
      if (
        displayStatus === "running" &&
        (prevStatus === "provisioning" || prevStatus === "pending")
      ) {
        setAnimate("success");
        const id = setTimeout(() => setAnimate(null), 1500);
        setPrevStatus(displayStatus);
        return () => clearTimeout(id);
      }
      if (displayStatus === "error") {
        setAnimate("error");
        const id = setTimeout(() => setAnimate(null), 600);
        setPrevStatus(displayStatus);
        return () => clearTimeout(id);
      }
      setPrevStatus(displayStatus);
    }
  }, [displayStatus, prevStatus]);

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={`transition-transform ${
          animate === "success"
            ? "animate-[scaleIn_0.3s_ease-out]"
            : animate === "error"
              ? "animate-[shake_0.3s_ease-in-out]"
              : ""
        }`}
      >
        <Badge
          variant="outline"
          size="compact"
          tone={
            displayStatus === "running"
              ? "success"
              : displayStatus === "pending"
                ? "warning"
                : ["disconnected", "error"].includes(displayStatus)
                  ? "danger"
                  : displayStatus === "provisioning"
                    ? "accent"
                    : "muted"
          }
          className="w-fit"
        >
          <span
            className={`inline-block size-1.5 rounded-full mr-1.5 ${statusDotColor(displayStatus)}`}
          />
          {displayStatus}
        </Badge>
      </div>
      {isProvisioning && trackedJob && (
        <span className="text-2xs text-muted flex items-center gap-1 pl-0.5">
          <Loader2 className="size-2.5 animate-spin" />
          {t("cloud.elizaAgentsTable.jobLabel", {
            jobId: trackedJob.jobId.slice(0, 8),
            defaultValue: "Job {{jobId}}",
          })}
        </span>
      )}
      {errorMessage && ["error", "disconnected"].includes(displayStatus) && (
        <p className="text-xs-tight text-destructive/80 max-w-[180px] pl-0.5">
          {t("cloud.elizaAgentsTable.agentNeedsAttention", {
            defaultValue: "Agent needs attention",
          })}
        </p>
      )}
    </div>
  );
}

export function ElizaAgentsTable({
  agents,
}: {
  agents: NormalizedAgentListItemDto[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Deactivate (sleep) needs a billing-transparency confirm before the job is
  // enqueued; the row Moon button stages the id here and the dialog confirms.
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<{
    id: string;
    action: "provision" | "wake";
  } | null>(null);
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );

  const [localAgents, setLocalAgents] =
    useState<NormalizedAgentListItemDto[]>(agents);
  const initialAgentIdsRef = useRef(
    [...agents.map((agent) => agent.id)].sort().join(","),
  );
  const lastAuthoritativeAgentsRef = useRef(agents);

  // Delete tombstones: the backend list is eventually consistent, so a refetch
  // right after a successful DELETE can still contain the deleted agent and
  // resurrect its row (the "deleted but still shown until refresh" bug). Ids
  // stay tombstoned — filtered from every merge — until the API stops
  // returning them, then the entry is dropped.
  // id → the time it was tombstoned, so tombstones can expire (see
  // TOMBSTONE_GRACE_MS) instead of hiding a still-billed agent forever.
  const deletedIdsRef = useRef(new Map<string, number>());
  const withoutDeleted = useCallback(
    (rows: NormalizedAgentListItemDto[]) =>
      rows.filter((agent) => !deletedIdsRef.current.has(agent.id)),
    [],
  );

  // Bumped by a post-grace timer scheduled on each delete so the reconcile
  // effect re-runs to expire the tombstone even when react-query returns a
  // byte-identical payload (structural sharing → same data ref → no re-render,
  // so the effect would otherwise never re-fire and the billed agent would stay
  // hidden the whole session). Cleared on unmount.
  const [reconcileTick, setReconcileTick] = useState(0);
  const expiryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(
    () => () => {
      for (const timer of expiryTimersRef.current) clearTimeout(timer);
      expiryTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    // reconcileTick is a deliberate re-run trigger, not a data value:
    // handleDelete's post-grace timer bumps it so this effect fires to expire a
    // tombstone even when react-query returns a byte-identical payload.
    void reconcileTick;

    // Retire by time (the single retirement clock — no path retires by absence).
    // This reconciles against react-query's list, which lags the faster status
    // poll; absence-retiring here would lift a tombstone before the laggier view
    // catches up and let a just-deleted row reappear.
    retireExpiredTombstones(
      deletedIdsRef.current,
      Date.now(),
      TOMBSTONE_GRACE_MS,
    );

    const newIds = [...agents.map((agent) => agent.id)].sort().join(",");
    const wanted = withoutDeleted(agents);
    const authoritativePayloadChanged =
      lastAuthoritativeAgentsRef.current !== agents;
    lastAuthoritativeAgentsRef.current = agents;

    if (newIds !== initialAgentIdsRef.current || authoritativePayloadChanged) {
      // The parent query is authoritative for both membership and every DTO
      // field. Replace when its payload changes even if the id-set did not, so
      // stopped/non-active rows receive name, status, URL, and error updates
      // rather than remaining stale until an unrelated active-status poll.
      initialAgentIdsRef.current = newIds;
      setLocalAgents((prev) =>
        prev.length === wanted.length &&
        prev.every((agent, index) => agent === wanted[index])
          ? prev
          : wanted,
      );
      return;
    }

    // id-set unchanged, but a non-tombstoned API agent is missing from the local
    // list — a tombstone that just expired (a delete that never took). Re-add it
    // WITHOUT wiping optimistic rows. The old "only when the local list is empty"
    // guard left this billed agent hidden for every case where OTHER agents
    // remained visible (banner "N running", table shows N-1).
    const localIds = new Set(localAgents.map((agent) => agent.id));
    const missing = wanted.filter((agent) => !localIds.has(agent.id));
    if (missing.length > 0) {
      setLocalAgents((prev) => {
        const have = new Set(prev.map((agent) => agent.id));
        const toAdd = missing.filter((agent) => !have.has(agent.id));
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
    }
  }, [agents, localAgents, reconcileTick, withoutDeleted]);

  const mergeApiData = useCallback(
    (apiAgents: NormalizedAgentListItemDto[]) => {
      // Retire tombstones by TIME ONLY — one clock for every retirement path.
      // Retiring by *absence* here (drop the tombstone the moment this poll stops
      // returning the agent) races the reconcile effect: on a real delete the fast
      // poll drops the row first, this clears the tombstone, and then the effect's
      // missing-add re-adds the agent from react-query's laggier list that still
      // holds it — resurrecting a just-deleted row. Letting the tombstone live its
      // full grace window means both eventually-consistent reads converge to
      // "gone" before it expires, so nothing is left to re-add. Snapshot the set
      // before the updater: StrictMode double-invokes updaters, and an in-updater
      // mutation of the shared set would diverge between invocations.
      retireExpiredTombstones(
        deletedIdsRef.current,
        Date.now(),
        TOMBSTONE_GRACE_MS,
      );
      const tombstoned: ReadonlySet<string> = new Set(
        deletedIdsRef.current.keys(),
      );
      setLocalAgents((prev) => mergeAgentList(prev, apiAgents, tombstoned));
    },
    [],
  );

  const refreshData = useCallback(async () => {
    try {
      // The typed cloud client (Bearer → api.eliza.app). A same-origin
      // fetch here 404s on the console hosts, which serve no /api/*.
      const response = await api<unknown>("/api/v1/eliza/agents");
      mergeApiData(parseAgentsResponse(response));
      // Keep the parent useAgents() cache honest too, so navigating away and
      // back doesn't rehydrate pre-action rows.
      await queryClient.invalidateQueries({ queryKey: ["agent", "agents"] });
    } catch {
      // error-policy:J4 list refresh is opportunistic after an action; the
      // 15s useAgents poll reconciles on the next tick if this read fails.
    }
  }, [mergeApiData, queryClient]);

  const jobActionById = useRef(new Map<string, string>());

  const poller = useJobPoller({
    autoRefresh: false,
    onComplete: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.success(
        t("cloud.elizaAgentsTable.jobCompleted", {
          action:
            action ??
            t("cloud.elizaAgentsTable.agentJob", {
              defaultValue: "Agent job",
            }),
          defaultValue: "{{action}} completed",
        }),
      );
      void refreshData();
    },
    onFailed: (job) => {
      const action = jobActionById.current.get(job.jobId);
      jobActionById.current.delete(job.jobId);
      toast.error(
        job.error ??
          t("cloud.elizaAgentsTable.jobFailed", {
            action:
              action ??
              t("cloud.elizaAgentsTable.agentJob", {
                defaultValue: "Agent job",
              }),
            defaultValue: "{{action}} failed",
          }),
      );
      void refreshData();
    },
  });

  useEffect(() => {
    for (const agent of localAgents) {
      const job = agent.activeJob;
      if (!job) continue;
      poller.track(agent.id, job.id, {
        status: job.status,
        startedAt: Date.parse(job.startedAt ?? job.createdAt),
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        estimatedCompletionAt: job.estimatedCompletionAt,
      });
    }
  }, [localAgents, poller.track]);

  useSandboxListPoll(
    localAgents.map((agent) => ({
      id: agent.id,
      status: poller.isActive(agent.id) ? "provisioning" : agent.status,
    })),
    {
      intervalMs: 10_000,
      onTransitionToRunning: (_id, name) => {
        toast.success(
          t("cloud.elizaAgentsTable.nowRunning", {
            name:
              name ??
              t("cloud.elizaAgentsTable.agent", { defaultValue: "Agent" }),
            defaultValue: "{{name}} is now running!",
          }),
        );
      },
      onDataRefresh: mergeApiData,
    },
  );

  const [searchQuery, setSearchQuery] = useState("");
  const [sortField, setSortField] = useState<"name" | "status" | "created">(
    "created",
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const handleSort = (field: typeof sortField) => {
    setSortDir((prev) =>
      sortField === field && prev === "asc" ? "desc" : "asc",
    );
    setSortField(field);
  };

  const filtered = useMemo(() => {
    const list = localAgents.filter((agent) => {
      const q = searchQuery.toLowerCase();
      const matchSearch =
        !q ||
        (agent.agentName ?? "").toLowerCase().includes(q) ||
        agent.id.toLowerCase().includes(q);
      return matchSearch;
    });

    list.sort((a, b) => {
      let cmp = 0;
      const aStatus = poller.isActive(a.id) ? "provisioning" : a.status;
      const bStatus = poller.isActive(b.id) ? "provisioning" : b.status;
      if (sortField === "name") {
        cmp = (a.agentName ?? "").localeCompare(b.agentName ?? "");
      } else if (sortField === "status") {
        cmp = aStatus.localeCompare(bStatus);
      } else {
        cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [localAgents, searchQuery, sortField, sortDir, poller.isActive]);

  /**
   * Shared skeleton of the async agent-job actions (provision/suspend): set
   * the optimistic row status, fire the request, then branch on the job
   * protocol — 409 attach-to-existing-job, non-2xx throw, 202 queue-track,
   * fallback plain success. The two callers differ only in request, optimistic
   * status, copy, and the provision-only 202-without-job branch (#13916).
   */
  async function runAgentJob(
    id: string,
    opts: {
      request: () => Promise<{ status: number; data?: AgentJobEnvelope }>;
      optimisticStatus: AgentSandboxStatus;
      labels: {
        jobAction: string;
        inProgress: string;
        failed: string;
        queued: string;
        /** Provision-only: 202 with no jobId means "started, nothing to track". */
        startedNoJob?: string;
        alreadyDone: string;
      };
      onError: (err: unknown) => void;
    },
  ) {
    const { request, optimisticStatus, labels, onError } = opts;
    setActionInProgress(id);
    setLocalAgents((prev) =>
      prev.map((agent) =>
        agent.id === id ? { ...agent, status: optimisticStatus } : agent,
      ),
    );
    try {
      const { status, data } = await request();
      const jobId = data?.data?.jobId;

      // 409 — the job is already in flight. Attach to it when the backend
      // returned one; either way this is informational, not an error.
      if (status === 409) {
        if (jobId) {
          jobActionById.current.set(jobId, labels.jobAction);
          poller.track(id, jobId);
        } else {
          void refreshData();
        }
        toast.info(labels.inProgress);
        return;
      }

      if (status < 200 || status >= 300) {
        void refreshData();
        throw new Error(data?.error ?? labels.failed);
      }

      // 202 — accepted: the backend queued a job to track.
      if (status === 202 && jobId) {
        jobActionById.current.set(jobId, labels.jobAction);
        poller.track(id, jobId);
        toast.success(labels.queued);
        return;
      }
      if (status === 202 && labels.startedNoJob) {
        toast.success(labels.startedNoJob);
        void refreshData();
        return;
      }

      toast.success(labels.alreadyDone);
      void refreshData();
    } catch (err) {
      void refreshData();
      onError(err);
    } finally {
      setActionInProgress(null);
    }
  }

  function handleProvision(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(
          `/api/v1/eliza/agents/${id}/provision`,
          {
            method: "POST",
            headers: {
              [DEDICATED_COMPUTE_PRICE_HEADER]:
                getDedicatedComputePriceAcceptance(),
            },
          },
        ),
      optimisticStatus: "provisioning",
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentProvisioning", {
          defaultValue: "Agent provisioning",
        }),
        inProgress: t("cloud.elizaAgentsTable.provisioningInProgress", {
          defaultValue: "Provisioning already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.provisionFailed", {
          defaultValue: "Provision failed",
        }),
        queued: t("cloud.elizaAgentsTable.provisioningQueued", {
          defaultValue: "Agent provisioning queued",
        }),
        startedNoJob: t("cloud.elizaAgentsTable.provisioningStarted", {
          defaultValue: "Agent provisioning started",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyRunning", {
          defaultValue: "Agent is already running",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToStart", {
            message,
            defaultValue: "Failed to start agent: {{message}}",
          }),
        );
      },
    });
  }

  function handleSuspend(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}`, {
          method: "PATCH",
          json: { action: "suspend" },
        }),
      optimisticStatus: "stopped",
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentSuspend", {
          defaultValue: "Agent suspend",
        }),
        inProgress: t("cloud.elizaAgentsTable.suspendInProgress", {
          defaultValue: "Suspend already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.suspendFailed", {
          defaultValue: "Suspend failed",
        }),
        queued: t("cloud.elizaAgentsTable.suspendQueued", {
          defaultValue: "Suspend queued",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.suspendComplete", {
          defaultValue: "Agent suspended",
        }),
      },
      onError: () => {
        toast.error(
          t("cloud.elizaAgentsTable.failedToSuspend", {
            defaultValue: "Failed to suspend agent",
          }),
        );
      },
    });
  }

  /** Deactivate = the `sleep` lifecycle action: durable encrypted backup, then
   * container + compute slot released, so hourly billing stops entirely. Fired
   * from the confirm dialog only — never directly from the row button. */
  function handleSleep(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}/sleep`, {
          method: "POST",
        }),
      optimisticStatus: "sleeping",
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentDeactivation", {
          defaultValue: "Agent deactivation",
        }),
        inProgress: t("cloud.elizaAgentsTable.deactivateInProgress", {
          defaultValue: "Agent provisioning is still in progress",
        }),
        failed: t("cloud.elizaAgentsTable.deactivateFailed", {
          defaultValue: "Deactivate failed",
        }),
        queued: t("cloud.elizaAgentsTable.deactivateQueued", {
          defaultValue: "Deactivation queued — retaining your agent data",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyDeactivated", {
          defaultValue: "Agent is already deactivated",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToDeactivate", {
            message,
            defaultValue: "Failed to deactivate agent: {{message}}",
          }),
        );
      },
    });
  }

  /** Reactivate = the `wake` lifecycle action: re-provisions compute and
   * restores the encrypted backup. Can take minutes — the tracked job keeps
   * the row in its in-progress state until the poll sees completion. */
  function handleWake(id: string) {
    return runAgentJob(id, {
      request: () =>
        apiWithStatus<AgentJobEnvelope>(`/api/v1/eliza/agents/${id}/wake`, {
          method: "POST",
          headers: {
            [DEDICATED_COMPUTE_PRICE_HEADER]:
              getDedicatedComputePriceAcceptance(),
          },
        }),
      optimisticStatus: "provisioning",
      labels: {
        jobAction: t("cloud.elizaAgentsTable.agentReactivation", {
          defaultValue: "Agent reactivation",
        }),
        inProgress: t("cloud.elizaAgentsTable.reactivateInProgress", {
          defaultValue: "Reactivation already in progress",
        }),
        failed: t("cloud.elizaAgentsTable.reactivateFailed", {
          defaultValue: "Reactivate failed",
        }),
        queued: t("cloud.elizaAgentsTable.reactivateQueued", {
          defaultValue:
            "Reactivation queued — restoring your agent data (this can take a few minutes)",
        }),
        alreadyDone: t("cloud.elizaAgentsTable.alreadyRunning", {
          defaultValue: "Agent is already running",
        }),
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(
          t("cloud.elizaAgentsTable.failedToReactivate", {
            message,
            defaultValue: "Failed to reactivate agent: {{message}}",
          }),
        );
      },
    });
  }

  /**
   * Delete one or many agents. Rows leave the list immediately and their ids
   * are tombstoned so the eventually-consistent list API can't resurrect them
   * on the next refetch; a failed DELETE lifts its tombstone and restores its
   * row. One implementation serves the row action and the bulk bar.
   */
  async function handleDelete(ids: string[]) {
    setIsDeleting(true);
    const rowById = new Map(localAgents.map((agent) => [agent.id, agent]));
    const now = Date.now();
    for (const id of ids) deletedIdsRef.current.set(id, now);
    setLocalAgents((prev) => prev.filter((agent) => !ids.includes(agent.id)));
    // Force a reconcile just past the grace window: react-query may return a
    // byte-identical payload (no re-render → the reconcile effect never re-fires
    // on its own), so without this a delete that never took server-side would
    // hide the still-billed agent for the whole session.
    const timer = setTimeout(() => {
      expiryTimersRef.current.delete(timer);
      setReconcileTick((n) => n + 1);
    }, TOMBSTONE_GRACE_MS + 500);
    expiryTimersRef.current.add(timer);
    try {
      const outcome = await runBulkDelete(ids, (id) =>
        api(`/api/v1/eliza/agents/${id}`, { method: "DELETE" }),
      );
      const failed = outcome.failed;
      if (failed.length > 0) {
        for (const id of failed) deletedIdsRef.current.delete(id);
        // Restore failed rows, but skip any the poll/refetch already re-added
        // while the DELETE was in flight — re-appending them would duplicate
        // React keys.
        setLocalAgents((prev) => {
          const present = new Set(prev.map((agent) => agent.id));
          const restored = failed
            .map((id) => rowById.get(id))
            .filter(
              (agent): agent is NormalizedAgentListItemDto =>
                agent !== undefined && !present.has(agent.id),
            );
          return [...prev, ...restored];
        });
        const firstError = outcome.firstError;
        toast.error(
          t("cloud.elizaAgentsTable.deleteSomeFailed", {
            count: failed.length,
            defaultValue: "Failed to delete {{count}} agent(s)",
          }),
          {
            description:
              firstError instanceof Error ? firstError.message : undefined,
          },
        );
      }
      const deleted = ids.length - failed.length;
      if (deleted > 0) {
        toast.success(
          deleted === 1
            ? t("cloud.elizaAgentsTable.agentDeleted", {
                defaultValue: "Agent deleted",
              })
            : t("cloud.elizaAgentsTable.agentsDeleted", {
                count: deleted,
                defaultValue: "{{count}} agents deleted",
              }),
        );
      }
      setSelectedIds(new Set());
      void refreshData();
    } finally {
      setIsDeleting(false);
      setDeleteIds(null);
    }
  }

  const deleteTargetBusy = (deleteIds ?? []).some((id) => poller.isActive(id));

  if (localAgents.length === 0) {
    // Agent creation lives in the Eliza app, not the console; this surface only
    // lists and manages existing agents.
    return (
      <DataListEmptyState
        title={t("cloud.elizaAgentsTable.noAgentsYet", {
          defaultValue: "No agents yet",
        })}
        description={t("cloud.elizaAgentsTable.noAgentsYetDesc", {
          defaultValue:
            "Your Shared or Dedicated Agent will appear here when available.",
        })}
        icon={Boxes}
        action={
          <Button asChild size="sm">
            <a
              href={ELIZA_APP_AGENT_CREATE_URL}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink className="size-4" />
              {t("cloud.elizaAgentsTable.openElizaApp", {
                defaultValue: "Open Eliza app",
              })}
            </a>
          </Button>
        }
      />
    );
  }

  const selectableIds = filtered
    .filter((sb) => sb.executionTier !== "shared" && !poller.isActive(sb.id))
    .map((sb) => sb.id);
  const allSelected =
    selectableIds.length > 0 &&
    selectableIds.every((id) => selectedIds.has(id));
  const toggleSelected = (id: string, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  return (
    <TooltipProvider>
      <DedicatedStartConfirmation
        open={startTarget !== null}
        disabled={
          !!actionInProgress ||
          (startTarget !== null && poller.isActive(startTarget.id))
        }
        onOpenChange={(open) => {
          if (!open) setStartTarget(null);
        }}
        onConfirm={() => {
          const target = startTarget;
          setStartTarget(null);
          if (target)
            void (target.action === "wake"
              ? handleWake(target.id)
              : handleProvision(target.id));
        }}
      />
      <DashboardDataList>
        <BulkSelectionBar
          count={selectedIds.size}
          onClear={() => setSelectedIds(new Set())}
          onDelete={() =>
            setDeleteIds(
              [...selectedIds].filter((id) =>
                localAgents.some(
                  (agent) =>
                    agent.id === id && agent.executionTier !== "shared",
                ),
              ),
            )
          }
          deleteDisabled={isDeleting}
          labels={{
            selected: t("cloud.elizaAgentsTable.selectedCount", {
              count: selectedIds.size,
              defaultValue: "{{count}} selected",
            }),
            clear: t("cloud.elizaAgentsTable.clearSelection", {
              defaultValue: "Clear",
            }),
            deleteSelected: t("cloud.elizaAgentsTable.deleteSelected", {
              defaultValue: "Delete selected",
            }),
          }}
        />
        {/* Search the authoritative agent set. Each runnable row owns its one
            launch affordance: Open Web UI. */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            variant="config"
            density="compact"
            adornment="leading"
            placeholder={t("cloud.elizaAgentsTable.searchAgents", {
              defaultValue: "Search agents…",
            })}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {searchQuery && (
          <DashboardDataListFilteredCount
            filtered={filtered.length}
            total={localAgents.length}
            label={t("cloud.elizaAgentsTable.agentsLabel", {
              defaultValue: "agents",
            })}
          />
        )}

        {/* Desktop table */}
        <DashboardDataListDesktop>
          <Table>
            <TableHeader>
              <TableRow className="bg-bg-muted border-b border-border hover:bg-bg-muted">
                <TableHead className="w-10">
                  <Checkbox
                    aria-label={t("cloud.elizaAgentsTable.selectAll", {
                      defaultValue: "Select all agents",
                    })}
                    checked={allSelected}
                    onCheckedChange={(checked) =>
                      setSelectedIds(
                        checked === true ? new Set(selectableIds) : new Set(),
                      )
                    }
                  />
                </TableHead>
                <TableHead className="w-[30%]">
                  <Button
                    variant="ghostMuted"
                    size="content"
                    type="button"
                    onClick={() => handleSort("name")}
                  >
                    {t("cloud.elizaAgentsTable.colAgent", {
                      defaultValue: "Agent",
                    })}
                    <ArrowUpDown className="size-3" />
                  </Button>
                </TableHead>
                <TableHead>
                  <Button
                    variant="ghostMuted"
                    size="content"
                    type="button"
                    onClick={() => handleSort("status")}
                  >
                    {t("cloud.elizaAgentsTable.colStatus", {
                      defaultValue: "Status",
                    })}
                    <ArrowUpDown className="size-3" />
                  </Button>
                </TableHead>
                <TableHead className="text-xs-tight font-medium uppercase tracking-widest text-muted">
                  {t("cloud.elizaAgentsTable.colWebUi", {
                    defaultValue: "Web UI",
                  })}
                </TableHead>
                <TableHead className="text-right text-xs-tight font-medium uppercase tracking-widest text-muted">
                  {t("cloud.elizaAgentsTable.colActions", {
                    defaultValue: "Actions",
                  })}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center">
                    <div className="flex flex-col items-center justify-center gap-1 text-muted">
                      <Search className="size-5 mb-1" />
                      <p className="text-sm">
                        {t("cloud.elizaAgentsTable.noMatch", {
                          defaultValue: "No agents match your filters",
                        })}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((sb) => {
                  const vm = deriveAgentRow(sb, poller, actionInProgress);
                  const {
                    trackedJob,
                    isProvisioningActive,
                    displayStatus,
                    busy,
                    canStart,
                    canStop,
                    hasStandaloneWebUi,
                  } = vm;

                  return (
                    <TableRow
                      key={sb.id}
                      className="hover:bg-bg-hover transition-colors border-b border-border"
                    >
                      <TableCell className="w-10">
                        <Checkbox
                          aria-label={t("cloud.elizaAgentsTable.selectAgent", {
                            defaultValue: "Select agent",
                          })}
                          checked={selectedIds.has(sb.id)}
                          disabled={
                            isProvisioningActive ||
                            sb.executionTier === "shared"
                          }
                          onCheckedChange={(checked) =>
                            toggleSelected(sb.id, checked === true)
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-txt-strong">
                              {getAgentDisplayName(
                                sb,
                                t("cloud.elizaAgentsTable.sharedAgentName", {
                                  defaultValue: "Shared Agent",
                                }),
                                t("cloud.elizaAgentsTable.unnamedAgent", {
                                  defaultValue: "Unnamed Agent",
                                }),
                              )}
                            </span>
                            <AgentCostBadge
                              status={displayStatus}
                              executionTier={sb.executionTier}
                            />
                          </div>
                        </div>
                      </TableCell>

                      <TableCell>
                        <StatusCell
                          displayStatus={displayStatus}
                          isProvisioning={isProvisioningActive}
                          trackedJob={trackedJob}
                          errorMessage={sb.errorMessage}
                        />
                      </TableCell>

                      <TableCell>
                        {hasStandaloneWebUi ? (
                          <Button
                            variant="externalLink"
                            size="content"
                            type="button"
                            onClick={() => openWebUIWithPairing(sb.id)}
                          >
                            <ExternalLink className="size-3" />
                            {t("cloud.elizaAgentsTable.openWebUi", {
                              defaultValue: "Open Web UI",
                            })}
                          </Button>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </TableCell>

                      <TableCell className="text-right">
                        <div className="flex justify-end gap-0.5">
                          {canStart && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="surfaceAccent"
                                  size="icon-lg"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.resumeAgent",
                                    { defaultValue: "Resume agent" },
                                  )}
                                  onClick={() =>
                                    setStartTarget({
                                      id: sb.id,
                                      action: "provision",
                                    })
                                  }
                                  disabled={busy}
                                >
                                  <Play className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.resumeAgent", {
                                  defaultValue: "Resume agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {canStop && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghostMuted"
                                  size="icon-lg"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.suspendAgent",
                                    { defaultValue: "Suspend agent" },
                                  )}
                                  onClick={() => handleSuspend(sb.id)}
                                  disabled={busy}
                                >
                                  <Pause className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.suspendAgent", {
                                  defaultValue: "Suspend agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {vm.canWake && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="surfaceAccent"
                                  size="icon-lg"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.reactivateAgent",
                                    { defaultValue: "Reactivate agent" },
                                  )}
                                  onClick={() =>
                                    setStartTarget({
                                      id: sb.id,
                                      action: "wake",
                                    })
                                  }
                                  disabled={busy}
                                >
                                  <Sun className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.reactivateAgent", {
                                  defaultValue: "Reactivate agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {vm.canSleep && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghostMuted"
                                  size="icon-lg"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.deactivateAgent",
                                    { defaultValue: "Deactivate agent" },
                                  )}
                                  onClick={() =>
                                    !busy && setDeactivateId(sb.id)
                                  }
                                  disabled={busy}
                                >
                                  <Moon className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.deactivateAgent", {
                                  defaultValue: "Deactivate agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}

                          {sb.executionTier !== "shared" && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="dangerGhost"
                                  size="icon-lg"
                                  type="button"
                                  aria-label={t(
                                    "cloud.elizaAgentsTable.deleteAgent",
                                    { defaultValue: "Delete agent" },
                                  )}
                                  onClick={() => !busy && setDeleteIds([sb.id])}
                                  disabled={isDeleting || busy}
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-card border-border">
                                {t("cloud.elizaAgentsTable.deleteAgent", {
                                  defaultValue: "Delete agent",
                                })}
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </DashboardDataListDesktop>

        {/* Mobile card list */}
        <DashboardDataListMobile>
          {filtered.length === 0 ? (
            <div className="border border-border bg-card p-6 text-center">
              <Search className="size-5 mx-auto mb-2 text-muted" />
              <p className="text-sm text-muted">
                {t("cloud.elizaAgentsTable.noMatch", {
                  defaultValue: "No agents match your filters",
                })}
              </p>
            </div>
          ) : (
            filtered.map((sb) => {
              const vm = deriveAgentRow(sb, poller, actionInProgress);
              const {
                trackedJob,
                isProvisioningActive,
                displayStatus,
                busy,
                canStart,
                canStop,
                hasStandaloneWebUi,
              } = vm;

              return (
                <div
                  key={sb.id}
                  className="border border-border bg-card p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <span className="block truncate font-medium text-txt-strong">
                        {getAgentDisplayName(
                          sb,
                          t("cloud.elizaAgentsTable.sharedAgentName", {
                            defaultValue: "Shared Agent",
                          }),
                          t("cloud.elizaAgentsTable.unnamedAgent", {
                            defaultValue: "Unnamed Agent",
                          }),
                        )}
                      </span>
                      <AgentCostBadge
                        status={displayStatus}
                        executionTier={sb.executionTier}
                      />
                    </div>
                    <StatusCell
                      displayStatus={displayStatus}
                      isProvisioning={isProvisioningActive}
                      trackedJob={trackedJob}
                      errorMessage={sb.errorMessage}
                    />
                  </div>

                  {(hasStandaloneWebUi ||
                    canStart ||
                    canStop ||
                    vm.canWake ||
                    vm.canSleep ||
                    sb.executionTier !== "shared") && (
                    <div className="flex items-center justify-end gap-1 border-t border-border pt-3">
                      {hasStandaloneWebUi && (
                        <Button
                          variant="externalLink"
                          size="touch"
                          type="button"
                          onClick={() => openWebUIWithPairing(sb.id)}
                        >
                          <ExternalLink className="size-3.5" />
                          {t("cloud.elizaAgentsTable.openWebUi", {
                            defaultValue: "Open Web UI",
                          })}
                        </Button>
                      )}

                      {canStart && (
                        <Button
                          variant="surfaceAccent"
                          size="touch"
                          type="button"
                          aria-label={t("cloud.elizaAgentsTable.resumeAgent", {
                            defaultValue: "Resume agent",
                          })}
                          onClick={() =>
                            setStartTarget({ id: sb.id, action: "provision" })
                          }
                          disabled={busy}
                        >
                          <Play className="size-3.5" />
                        </Button>
                      )}

                      {canStop && (
                        <Button
                          variant="ghostMuted"
                          size="touch"
                          type="button"
                          aria-label={t("cloud.elizaAgentsTable.suspendAgent", {
                            defaultValue: "Suspend agent",
                          })}
                          onClick={() => handleSuspend(sb.id)}
                          disabled={busy}
                        >
                          <Pause className="size-3.5" />
                        </Button>
                      )}

                      {vm.canWake && (
                        <Button
                          variant="surfaceAccent"
                          size="touch"
                          type="button"
                          aria-label={t(
                            "cloud.elizaAgentsTable.reactivateAgent",
                            {
                              defaultValue: "Reactivate agent",
                            },
                          )}
                          onClick={() =>
                            setStartTarget({ id: sb.id, action: "wake" })
                          }
                          disabled={busy}
                        >
                          <Sun className="size-3.5" />
                        </Button>
                      )}

                      {vm.canSleep && (
                        <Button
                          variant="ghostMuted"
                          size="touch"
                          type="button"
                          aria-label={t(
                            "cloud.elizaAgentsTable.deactivateAgent",
                            {
                              defaultValue: "Deactivate agent",
                            },
                          )}
                          onClick={() => !busy && setDeactivateId(sb.id)}
                          disabled={busy}
                        >
                          <Moon className="size-3.5" />
                        </Button>
                      )}

                      {sb.executionTier !== "shared" && (
                        <Button
                          variant="dangerGhost"
                          size="touch"
                          type="button"
                          aria-label={t("cloud.elizaAgentsTable.deleteAgent", {
                            defaultValue: "Delete agent",
                          })}
                          onClick={() => !busy && setDeleteIds([sb.id])}
                          disabled={isDeleting || busy}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </DashboardDataListMobile>
      </DashboardDataList>

      {/* Delete confirmation — one dialog for the row action and the bulk bar */}
      <BulkDeleteDialog
        open={deleteIds !== null}
        onOpenChange={() => setDeleteIds(null)}
        title={
          (deleteIds?.length ?? 0) > 1
            ? t("cloud.elizaAgentsTable.deleteAgentsTitle", {
                count: deleteIds?.length,
                defaultValue: "Delete {{count}} Agents",
              })
            : t("cloud.elizaAgentsTable.deleteAgentTitle", {
                defaultValue: "Delete Agent",
              })
        }
        description={
          deleteTargetBusy
            ? t("cloud.elizaAgentsTable.deleteBusyDesc", {
                defaultValue:
                  "This agent is still provisioning. Wait for the job to finish before deleting.",
              })
            : (deleteIds?.length ?? 0) > 1
              ? t("cloud.elizaAgentsTable.deleteManyDesc", {
                  count: deleteIds?.length,
                  defaultValue:
                    "This will permanently delete {{count}} agents and stop them if they are running.",
                })
              : t("cloud.elizaAgentsTable.deleteDesc", {
                  defaultValue:
                    "This will permanently delete the agent and stop it if it is running.",
                })
        }
        cancelLabel={t("cloud.elizaAgentsTable.cancel", {
          defaultValue: "Cancel",
        })}
        confirmLabel={
          isDeleting
            ? t("cloud.elizaAgentsTable.deleting", {
                defaultValue: "Deleting…",
              })
            : t("cloud.elizaAgentsTable.delete", { defaultValue: "Delete" })
        }
        confirmDisabled={isDeleting || deleteTargetBusy}
        onConfirm={() =>
          deleteIds &&
          deleteIds.length > 0 &&
          !deleteTargetBusy &&
          handleDelete(deleteIds)
        }
      />

      {/* Deactivate confirm — the non-destructive counterpart to delete. The
          copy is shared with the detail page's dialog (same flat i18n keys) so
          the billing-transparency story reads identically on both surfaces. */}
      <AlertDialog
        open={deactivateId !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateId(null);
        }}
      >
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-txt-strong">
              {t("cloud.containers.agentActions.deactivateTitle", {
                defaultValue: "Deactivate this agent?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-muted">
              <span className="block">
                {t("cloud.containers.agentActions.deactivateBody1", {
                  defaultValue:
                    "Your agent stops running and stops consuming hourly credits (currently {{rate}} while running).",
                  rate: formatHourlyRate(AGENT_PRICING.RUNNING_HOURLY_RATE),
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody2", {
                  defaultValue:
                    "Eliza retains your agent data during deactivation. If deactivation cannot complete, the agent stays running and billing continues.",
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateMinimum", {
                  defaultValue:
                    "Any remaining activation minimum is charged when you stop.",
                })}
              </span>
              <span className="block mt-2">
                {t("cloud.containers.agentActions.deactivateBody3", {
                  defaultValue:
                    "Reactivation restores the agent's retained data and can take a few minutes; it requires available credits.",
                })}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-border bg-transparent text-txt hover:bg-surface">
              {t("cloud.elizaAgentsTable.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <Button
              type="button"
              disabled={
                deactivateId !== null &&
                (poller.isActive(deactivateId) ||
                  actionInProgress === deactivateId)
              }
              onClick={() => {
                if (!deactivateId) return;
                const id = deactivateId;
                setDeactivateId(null);
                void handleSleep(id);
              }}
            >
              <Moon className="size-4" />
              {t("cloud.containers.agentActions.deactivateConfirm", {
                defaultValue: "Yes, deactivate",
              })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}
