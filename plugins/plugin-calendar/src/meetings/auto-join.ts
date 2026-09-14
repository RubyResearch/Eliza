/**
 * Calendar → meeting auto-join wiring on the frozen ScheduledTask spine.
 *
 * When a synced calendar event carries a conference link that
 * `parseMeetingUrl` recognizes AND the per-agent auto-join policy allows it,
 * this module keeps exactly one join task per event alive on the standard
 * scheduled-task runner (`@elizaos/plugin-scheduling`):
 *
 * - A per-event anchor `calendar_event.start:<eventId>` is registered on the
 *   runtime anchor registry (override on re-register), resolving to the
 *   event's current `startAt`. Rescheduled events re-register the anchor, so
 *   the join task follows the event without editing the task row.
 * - Policy `"all"`: one `kind: "custom"` task with
 *   `trigger: { kind: "relative_to_anchor", offsetMinutes: -1 }`,
 *   `subject: { kind: "calendar_event", id }`, dispatched through the
 *   `meeting_join` channel (see `meeting-join-dispatch.ts`).
 * - Policy `"ask"`: one `kind: "approval"` task anchored at `-15` minutes
 *   (delivered in-app via the spine's default channel), plus the join task
 *   with `trigger: { kind: "after_task", taskId: approval, outcome:
 *   "completed" }` so the agent only joins after the owner approves.
 * - Policy `"off"`: no tasks; any live auto-join tasks for the reconciled
 *   events are dismissed.
 *
 * No second scheduler, no promptInstructions-driven behavior — everything is
 * structural fields on the frozen `ScheduledTask` schema.
 */

import { type IAgentRuntime, logger } from "@elizaos/core";
import {
  createAnchorRegistry,
  getAnchorRegistry,
  getScheduledTaskRunner,
  registerAnchorRegistry,
  type ScheduledTask,
  type ScheduledTaskInput,
  type ScheduledTaskRunnerHandle,
} from "@elizaos/plugin-scheduling";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  MEETING_PLATFORM_LABELS,
  type ParsedMeetingUrl,
  parseMeetingUrl,
} from "@elizaos/shared";
import {
  type MeetingAutoJoinPolicy,
  readMeetingAutoJoinSettings,
} from "./auto-join-settings.js";
import { MEETING_JOIN_CHANNEL_KEY } from "./meeting-join-dispatch.js";

const LOG_PREFIX = "[CalendarMeetingAutoJoin]";
const CREATED_BY = "@elizaos/plugin-calendar";

/** Marker on every task this module owns. */
export const AUTO_JOIN_METADATA_FLAG = "calendarAutoJoin";

/** Join `offsetMinutes` relative to the event-start anchor. */
export const JOIN_OFFSET_MINUTES = -1;
/** Approval lead time before the event start (ask mode). */
export const APPROVAL_OFFSET_MINUTES = -15;

export function eventStartAnchorKey(eventId: string): string {
  return `calendar_event.start:${eventId}`;
}

/**
 * Register (or re-register) the per-event start anchor. Uses the runtime
 * anchor registry that the scheduling host (`plugin-personal-assistant`)
 * binds into the runner deps; when no registry exists yet, one is created and
 * registered so the host picks it up (its `resolveRuntimeAnchorRegistry`
 * prefers an existing per-runtime registry).
 */
export function registerEventStartAnchor(
  runtime: IAgentRuntime,
  eventId: string,
  startAtIso: string,
): void {
  let registry = getAnchorRegistry(runtime);
  if (!registry) {
    registry = createAnchorRegistry();
    registerAnchorRegistry(runtime, registry);
  }
  registry.register(
    {
      anchorKey: eventStartAnchorKey(eventId),
      describe: {
        label: `Calendar event ${eventId} start (${startAtIso})`,
        provider: CREATED_BY,
      },
      resolve() {
        return { atIso: startAtIso };
      },
    },
    { override: true },
  );
}

function resolveRunner(
  runtime: IAgentRuntime,
  agentId: string,
): ScheduledTaskRunnerHandle | null {
  try {
    return getScheduledTaskRunner(runtime, { agentId });
  } catch (error) {
    logger.warn(
      { src: "calendar:meeting-auto-join", agentId, error },
      `${LOG_PREFIX} ScheduledTask runner unavailable; skipping meeting auto-join reconcile.`,
    );
    return null;
  }
}

interface AutoJoinTaskMetadata extends Record<string, unknown> {
  [AUTO_JOIN_METADATA_FLAG]: true;
  calendarEventId: string;
  meetingUrl: string;
  platform: ParsedMeetingUrl["platform"];
  eventStartAt: string;
  autoJoinMode: MeetingAutoJoinPolicy;
  role: "join" | "approval";
}

function isAutoJoinTask(task: ScheduledTask): boolean {
  return task.metadata?.[AUTO_JOIN_METADATA_FLAG] === true;
}

function isLive(task: ScheduledTask): boolean {
  return (
    task.state.status === "scheduled" ||
    task.state.status === "fired" ||
    task.state.status === "acknowledged"
  );
}

async function listAutoJoinTasksForEvent(
  runner: ScheduledTaskRunnerHandle,
  eventId: string,
): Promise<ScheduledTask[]> {
  const tasks = await runner.list({
    subject: { kind: "calendar_event", id: eventId },
    source: "plugin",
  });
  return tasks.filter(isAutoJoinTask);
}

async function dismissTasks(
  runner: ScheduledTaskRunnerHandle,
  tasks: ScheduledTask[],
  reason: string,
): Promise<void> {
  for (const task of tasks) {
    if (!isLive(task)) continue;
    await runner.apply(task.taskId, "dismiss", { reason });
  }
}

function startLabel(event: LifeOpsCalendarEvent): string {
  const parsed = Date.parse(event.startAt);
  if (!Number.isFinite(parsed)) return event.startAt;
  return new Date(parsed).toISOString();
}

function joinTaskInput(
  event: LifeOpsCalendarEvent,
  parsed: ParsedMeetingUrl,
  mode: MeetingAutoJoinPolicy,
  trigger: ScheduledTaskInput["trigger"],
): ScheduledTaskInput {
  const metadata: AutoJoinTaskMetadata = {
    [AUTO_JOIN_METADATA_FLAG]: true,
    calendarEventId: event.id,
    meetingUrl: parsed.meetingUrl,
    platform: parsed.platform,
    eventStartAt: event.startAt,
    autoJoinMode: mode,
    role: "join",
  };
  return {
    kind: "custom",
    promptInstructions: `Join the ${MEETING_PLATFORM_LABELS[parsed.platform]} meeting "${event.title.trim() || "Untitled event"}" as the owner's notetaker.`,
    trigger,
    priority: "high",
    escalation: {
      steps: [{ delayMinutes: 0, channelKey: MEETING_JOIN_CHANNEL_KEY }],
    },
    output: {
      destination: "channel",
      target: `${MEETING_JOIN_CHANNEL_KEY}:${event.id}`,
    },
    subject: { kind: "calendar_event", id: event.id },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: CREATED_BY,
    ownerVisible: true,
    metadata,
    executionProfile: "bg-heavy-fgs",
  };
}

function approvalTaskInput(
  event: LifeOpsCalendarEvent,
  parsed: ParsedMeetingUrl,
): ScheduledTaskInput {
  const metadata: AutoJoinTaskMetadata = {
    [AUTO_JOIN_METADATA_FLAG]: true,
    calendarEventId: event.id,
    meetingUrl: parsed.meetingUrl,
    platform: parsed.platform,
    eventStartAt: event.startAt,
    autoJoinMode: "ask",
    role: "approval",
  };
  return {
    kind: "approval",
    promptInstructions: `Send the agent to join "${event.title.trim() || "Untitled event"}" on ${MEETING_PLATFORM_LABELS[parsed.platform]} at ${startLabel(event)}? Approve to have it attend and transcribe the meeting.`,
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: APPROVAL_OFFSET_MINUTES,
    },
    priority: "high",
    subject: { kind: "calendar_event", id: event.id },
    respectsGlobalPause: true,
    source: "plugin",
    createdBy: CREATED_BY,
    ownerVisible: true,
    metadata,
    executionProfile: "bg-light-30s",
  };
}

function taskRole(task: ScheduledTask): "join" | "approval" | null {
  const role = task.metadata?.role;
  return role === "join" || role === "approval" ? role : null;
}

function taskMode(task: ScheduledTask): string | null {
  const mode = task.metadata?.autoJoinMode;
  return typeof mode === "string" ? mode : null;
}

/**
 * Reconcile one event against the current policy. Returns the tasks that are
 * live for the event after reconciliation (diagnostics/tests).
 */
async function reconcileEvent(
  runtime: IAgentRuntime,
  runner: ScheduledTaskRunnerHandle,
  event: LifeOpsCalendarEvent,
  policy: MeetingAutoJoinPolicy,
  nowMs: number,
): Promise<ScheduledTask[]> {
  const parsed = event.conferenceLink
    ? parseMeetingUrl(event.conferenceLink)
    : null;
  const existing = await listAutoJoinTasksForEvent(runner, event.id);
  const live = existing.filter(isLive);

  const endMs = Date.parse(event.endAt);
  const eventOver = Number.isFinite(endMs) && endMs <= nowMs;

  if (!parsed || policy === "off" || eventOver) {
    if (live.length > 0) {
      const reason = !parsed
        ? "conference link removed or unrecognized"
        : policy === "off"
          ? "meeting auto-join disabled"
          : "event already ended";
      await dismissTasks(runner, live, reason);
      logger.info(
        {
          src: "calendar:meeting-auto-join",
          eventId: event.id,
          dismissed: live.length,
          reason,
        },
        `${LOG_PREFIX} Dismissed ${live.length} auto-join task(s) for event ${event.id}: ${reason}.`,
      );
    }
    return [];
  }

  // Keep the anchor current so a rescheduled event fires at the new start.
  registerEventStartAnchor(runtime, event.id, event.startAt);

  // Live tasks created under a different policy mode are stale — dismiss and
  // recreate under the current mode.
  const stale = live.filter((task) => taskMode(task) !== policy);
  if (stale.length > 0) {
    await dismissTasks(
      runner,
      stale,
      `auto-join policy changed to "${policy}"`,
    );
  }
  const current = live.filter((task) => taskMode(task) === policy);

  // A task of the same role that already reached a terminal state for this
  // same event start under the current policy is settled: the agent joined,
  // or the owner answered the approval, and the meeting is still in progress.
  // Recreating it would anchor a fresh join at start - 1 min, which is already
  // due, so the agent would join the same meeting a second time (#29961). A
  // failed task is not settled, so a failed join stays retryable; settlement
  // is per role, so a completed approval never settles the join on its behalf.
  // A rescheduled event carries a new startAt and is reconciled afresh.
  const findSettled = (role: "join" | "approval"): ScheduledTask | undefined =>
    existing.find(
      (task) =>
        !isLive(task) &&
        task.state.status !== "failed" &&
        taskRole(task) === role &&
        taskMode(task) === policy &&
        task.metadata?.eventStartAt === event.startAt,
    );
  const joinAtStart = (mode: MeetingAutoJoinPolicy): ScheduledTaskInput =>
    joinTaskInput(event, parsed, mode, {
      kind: "relative_to_anchor",
      anchorKey: eventStartAnchorKey(event.id),
      offsetMinutes: JOIN_OFFSET_MINUTES,
    });

  if (policy === "all") {
    const join = current.find((task) => taskRole(task) === "join");
    if (join) return [join];
    if (findSettled("join")) return current;
    const scheduled = await runner.schedule(joinAtStart("all"));
    logger.info(
      {
        src: "calendar:meeting-auto-join",
        eventId: event.id,
        taskId: scheduled.taskId,
        platform: parsed.platform,
      },
      `${LOG_PREFIX} Scheduled meeting join for event ${event.id} (${parsed.platform}) at event start.`,
    );
    return [scheduled];
  }

  // policy === "ask"
  let approval = current.find((task) => taskRole(task) === "approval");
  const settledApproval = findSettled("approval");
  if (!approval && !settledApproval) {
    approval = await runner.schedule(approvalTaskInput(event, parsed));
    logger.info(
      {
        src: "calendar:meeting-auto-join",
        eventId: event.id,
        taskId: approval.taskId,
      },
      `${LOG_PREFIX} Scheduled join approval for event ${event.id}.`,
    );
  }
  let join = current.find((task) => taskRole(task) === "join");
  if (!join && !findSettled("join")) {
    if (approval) {
      join = await runner.schedule(
        joinTaskInput(event, parsed, "ask", {
          kind: "after_task",
          taskId: approval.taskId,
          outcome: "completed",
        }),
      );
      logger.info(
        {
          src: "calendar:meeting-auto-join",
          eventId: event.id,
          taskId: join.taskId,
          approvalTaskId: approval.taskId,
        },
        `${LOG_PREFIX} Scheduled approval-gated meeting join for event ${event.id}.`,
      );
    } else if (settledApproval?.state.status === "completed") {
      // The owner already approved and the join itself failed. An after_task
      // child only fires when its parent transitions, and that approval is
      // already terminal, so the retry is anchored at the event start instead
      // of re-prompting an owner who has answered.
      join = await runner.schedule(joinAtStart("ask"));
      logger.info(
        {
          src: "calendar:meeting-auto-join",
          eventId: event.id,
          taskId: join.taskId,
          approvalTaskId: settledApproval.taskId,
        },
        `${LOG_PREFIX} Rescheduled failed meeting join for event ${event.id} under the owner's existing approval.`,
      );
    }
    // An approval the owner dismissed, skipped, or let expire grants nothing;
    // no join is scheduled for it.
  }
  return [approval, join].filter(
    (task): task is ScheduledTask => task !== undefined,
  );
}

export interface ReconcileMeetingAutoJoinArgs {
  runtime: IAgentRuntime;
  agentId: string;
  /** Current (post-sync) events for the synced window. */
  events: readonly LifeOpsCalendarEvent[];
  /** Event ids removed from the window by this sync. */
  removedEventIds?: readonly string[];
  now?: () => Date;
}

/**
 * Sync-time entry point. Called by `CalendarService` after each Google/Apple
 * feed sync (and on policy change). Never throws — auto-join failures must
 * not break calendar sync.
 */
export async function reconcileMeetingAutoJoin(
  args: ReconcileMeetingAutoJoinArgs,
): Promise<void> {
  const { runtime, agentId, events, removedEventIds = [] } = args;
  const runner = resolveRunner(runtime, agentId);
  if (!runner) return;
  const nowMs = (args.now?.() ?? new Date()).getTime();
  try {
    const settings = await readMeetingAutoJoinSettings(runtime);
    for (const event of events) {
      await reconcileEvent(runtime, runner, event, settings.policy, nowMs);
    }
    for (const eventId of removedEventIds) {
      const live = (await listAutoJoinTasksForEvent(runner, eventId)).filter(
        isLive,
      );
      if (live.length > 0) {
        await dismissTasks(runner, live, "calendar event deleted");
        logger.info(
          {
            src: "calendar:meeting-auto-join",
            eventId,
            dismissed: live.length,
          },
          `${LOG_PREFIX} Dismissed ${live.length} auto-join task(s) for deleted event ${eventId}.`,
        );
      }
    }
  } catch (error) {
    logger.error(
      { src: "calendar:meeting-auto-join", agentId, error },
      `${LOG_PREFIX} Meeting auto-join reconcile failed.`,
    );
  }
}

/**
 * Dismiss every live auto-join task owned by this module. Used when the
 * policy is switched to `"off"`.
 */
export async function cancelAllMeetingAutoJoinTasks(
  runtime: IAgentRuntime,
  agentId: string,
): Promise<number> {
  const runner = resolveRunner(runtime, agentId);
  if (!runner) return 0;
  const tasks = (await runner.list({ source: "plugin" }))
    .filter(isAutoJoinTask)
    .filter(isLive);
  await dismissTasks(runner, tasks, "meeting auto-join disabled");
  if (tasks.length > 0) {
    logger.info(
      { src: "calendar:meeting-auto-join", agentId, dismissed: tasks.length },
      `${LOG_PREFIX} Dismissed ${tasks.length} auto-join task(s): policy set to off.`,
    );
  }
  return tasks.length;
}

/**
 * Boot-time anchor restore. Anchor registrations are in-memory, so after a
 * restart the persisted join tasks would sit `anchor_unresolved` until the
 * next feed sync. This re-registers the start anchor for every upcoming
 * event that still has a live auto-join task.
 */
export async function restoreMeetingAutoJoinAnchors(
  runtime: IAgentRuntime,
  _agentId: string,
  events: readonly LifeOpsCalendarEvent[],
): Promise<void> {
  const settings = await readMeetingAutoJoinSettings(runtime);
  if (settings.policy === "off") return;
  for (const event of events) {
    const parsed = event.conferenceLink
      ? parseMeetingUrl(event.conferenceLink)
      : null;
    if (!parsed) continue;
    registerEventStartAnchor(runtime, event.id, event.startAt);
  }
}
