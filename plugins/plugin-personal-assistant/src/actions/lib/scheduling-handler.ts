/**
 * LifeOps scheduling-with-others handlers.
 *
 * Provides three handler functions dispatched from the CALENDAR umbrella:
 *
 *  - runProposeMeetingTimesHandler: reads the owner's busy calendar + meeting
 *    preferences (preferred hours, blackout windows, travel buffer) and
 *    returns candidate slots that can be offered to another party.
 *  - runCheckAvailabilityHandler: given an ISO start/end window, reports
 *    whether the owner is free or busy and lists overlapping events.
 *  - runUpdateMeetingPreferencesHandler: persist the owner's preferred
 *    meeting hours, blackout windows, and travel buffer to the LifeOps
 *    profile (stored alongside the existing owner profile in scheduler task
 *    metadata — no new table).
 *
 * Every user-visible reply runs through `renderLifeOpsActionReply` so the raw
 * data templates land in the agent's character voice instead of being streamed
 * raw. The structured `data` payload on each ActionResult is preserved verbatim
 * for downstream consumers (ACTION_STATE provider, scenario assertions, UI).
 */

import type {
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  applyGroundedActionReply,
  recentConversationTexts as collectRecentConversationTexts,
  ElizaError,
  ModelType,
  parseJsonModelRecord,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
  toWellFormedUnicode,
} from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared";
import { hasLifeOpsAccess, INTERNAL_URL } from "../../lifeops/access.js";
import { createApprovalQueue } from "../../lifeops/approval-queue.js";
import type {
  ApprovalChannel,
  ApprovalPayload,
  ApprovalRequest,
} from "../../lifeops/approval-queue.types.js";
import { getChannelRegistry } from "../../lifeops/channels/index.js";
import type { SchedulingMessageDraft } from "../../lifeops/domains/scheduling-service.js";
import { SCHEDULE_PLAN_INSTRUCTIONS } from "../../lifeops/optimized-prompt-instructions.js";
import {
  type LifeOpsMeetingPreferences,
  type LifeOpsMeetingPreferencesBlackout,
  type LifeOpsMeetingPreferencesPatch,
  normalizeLifeOpsMeetingPreferencesPatch,
  readLifeOpsMeetingPreferences,
  updateLifeOpsMeetingPreferences,
} from "../../lifeops/owner-profile.js";
import {
  readSchedulingApprovalCorrelation,
  schedulingApprovalExpiresAt,
  schedulingApprovalPayloadForDraft,
} from "../../lifeops/scheduling-approval.js";
import {
  prepareSchedulingDelivery,
  schedulingDeliveryIdempotencyKey,
} from "../../lifeops/scheduling-delivery.js";
import {
  type TransactionalDb,
  withRequiredTransaction,
} from "../../lifeops/sql.js";
import { inferTimeZoneFromLocationText } from "../../lifeops/time/timezone.js";
import { getZonedDateParts } from "../../lifeops/time.js";
import {
  messageText as getMessageText,
  renderLifeOpsActionReply,
} from "../../lifeops/voice/grounded-reply.js";
import { calendarSnapshotEffectProof } from "./calendar-effect-proof.js";

export { SCHEDULE_PLAN_INSTRUCTIONS } from "../../lifeops/optimized-prompt-instructions.js";

const MS_PER_MINUTE = 60_000;
const MAX_DAYS_LOOKAHEAD = 60;
const DEFAULT_DAYS_LOOKAHEAD = 7;
const DEFAULT_SLOTS_COUNT = 3;
const SLOT_STEP_MINUTES = 15;

function calendarFeedIssueSummary(
  feed: LifeOpsCalendarFeed,
): Array<{ provider: string; status: string; code: string | null }> {
  return feed.sources
    .filter((source) => source.status !== "fresh")
    .map((source) => ({
      provider: source.key.provider,
      status: source.status,
      code: source.error?.code ?? null,
    }));
}

async function incompleteCalendarResponse(args: {
  feed: LifeOpsCalendarFeed;
  respond: ReturnType<typeof makeSchedulingRespond>;
  scenario: string;
  knownConflicts?: readonly LifeOpsCalendarEvent[];
}): Promise<ActionResult> {
  const knownConflicts = args.knownConflicts ?? [];
  return args.respond({
    success: false,
    scenario: args.scenario,
    fallback:
      knownConflicts.length > 0
        ? `I can't confirm the full window because one or more calendars are stale or unavailable. The data I could read contains ${knownConflicts.length} possible conflict${knownConflicts.length === 1 ? "" : "s"}, so I won't call this time free.`
        : "I can't confirm availability because one or more calendars are stale or unavailable. I won't call this time free until every selected source is current.",
    context: {
      feedState: args.feed.state,
      knownConflictCount: knownConflicts.length,
      sourceIssues: calendarFeedIssueSummary(args.feed),
    },
    data: {
      error: "CALENDAR_INCOMPLETE",
      feedState: args.feed.state,
      isFree: null,
      knownConflicts: knownConflicts.map((event) => ({
        id: event.id,
        title: event.title,
        startAt: event.startAt,
        endAt: event.endAt,
      })),
      sourceIssues: calendarFeedIssueSummary(args.feed),
    },
  });
}

async function loadLifeOpsServiceModule() {
  return import("../../lifeops/service.js");
}

export type ProposedMeetingSlot = {
  startAt: string;
  endAt: string;
  durationMinutes: number;
  localStart: string;
  localEnd: string;
  timeZone: string;
};

export type ProposeMeetingTimesParameters = {
  durationMinutes?: number;
  daysAhead?: number;
  slotCount?: number;
  windowStart?: string;
  windowEnd?: string;
  timeZone?: string;
  counterparties?: string[];
};

export type CheckAvailabilityParameters = {
  startAt?: string;
  endAt?: string;
};

function parseTimeOfDayToMinutes(value: string): number {
  const [h, m] = value.split(":");
  return Number(h) * 60 + Number(m);
}

function formatLocalForDisplay(iso: string, timeZone: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

function dayOfWeekInTz(date: Date, timeZone: string): number {
  // Compute the local Y/M/D in the target IANA zone, then derive day-of-week
  // from a UTC anchor. Avoids any reliance on locale-specific weekday strings.
  const parts = getZonedDateParts(date, timeZone);
  return new Date(
    Date.UTC(parts.year, Math.max(0, parts.month - 1), parts.day, 12, 0, 0),
  ).getUTCDay();
}

function buildBusyIntervals(
  events: readonly LifeOpsCalendarEvent[],
  travelBufferMinutes: number,
): Array<{ start: number; end: number }> {
  const bufferMs = travelBufferMinutes * MS_PER_MINUTE;
  const intervals = events
    .filter((e) => e.status !== "cancelled")
    .map((e) => ({
      start: Date.parse(e.startAt) - bufferMs,
      end: Date.parse(e.endAt) + bufferMs,
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function overlapsBusy(
  slotStart: number,
  slotEnd: number,
  busy: Array<{ start: number; end: number }>,
): boolean {
  for (const interval of busy) {
    if (slotStart < interval.end && slotEnd > interval.start) return true;
  }
  return false;
}

function getZonedMinuteOfDay(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function overlapsBlackout(
  slotStart: Date,
  slotEnd: Date,
  timeZone: string,
  blackouts: readonly LifeOpsMeetingPreferencesBlackout[],
): boolean {
  if (blackouts.length === 0) return false;
  const slotStartMin = getZonedMinuteOfDay(slotStart, timeZone);
  const slotEndMin = getZonedMinuteOfDay(slotEnd, timeZone);
  const dow = dayOfWeekInTz(slotStart, timeZone);

  for (const window of blackouts) {
    if (window.daysOfWeek && window.daysOfWeek.length > 0) {
      if (!window.daysOfWeek.includes(dow)) continue;
    }
    const bStart = parseTimeOfDayToMinutes(window.startLocal);
    const bEnd = parseTimeOfDayToMinutes(window.endLocal);
    if (slotStartMin < bEnd && slotEndMin > bStart) return true;
  }
  return false;
}

function endOfLocalDayMs(date: Date, timeZone: string): number {
  const parts = getZonedDateParts(date, timeZone);
  const remainingMinutes = 24 * 60 - (parts.hour * 60 + parts.minute);
  return date.getTime() + remainingMinutes * MS_PER_MINUTE;
}

export function computeProposedSlots(args: {
  now: Date;
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  slotCount: number;
  preferences: LifeOpsMeetingPreferences;
  events: readonly LifeOpsCalendarEvent[];
}): ProposedMeetingSlot[] {
  const {
    now,
    windowStart,
    windowEnd,
    durationMinutes,
    slotCount,
    preferences,
    events,
  } = args;
  const tz = preferences.timeZone;
  const busy = buildBusyIntervals(events, preferences.travelBufferMinutes);

  const preferredStart = parseTimeOfDayToMinutes(
    preferences.preferredStartLocal,
  );
  const preferredEnd = parseTimeOfDayToMinutes(preferences.preferredEndLocal);

  const results: ProposedMeetingSlot[] = [];
  const seenDays = new Set<string>();

  const step = SLOT_STEP_MINUTES * MS_PER_MINUTE;
  const cursor =
    Math.ceil(Math.max(windowStart.getTime(), now.getTime()) / step) * step;
  const endMs = windowEnd.getTime();
  const durationMs = durationMinutes * MS_PER_MINUTE;

  for (let pass = 0; pass < 2 && results.length < slotCount; pass++) {
    const onePerDay = pass === 0;
    let t = cursor;
    while (t + durationMs <= endMs && results.length < slotCount) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t + durationMs);

      const slotStartMin = getZonedMinuteOfDay(slotStart, tz);
      const slotEndMin = getZonedMinuteOfDay(slotEnd, tz);
      const parts = getZonedDateParts(slotStart, tz);
      const endParts = getZonedDateParts(slotEnd, tz);
      const sameLocalDay =
        parts.year === endParts.year &&
        parts.month === endParts.month &&
        parts.day === endParts.day;
      const withinPreferred =
        sameLocalDay &&
        slotStartMin >= preferredStart &&
        slotEndMin <= preferredEnd;

      if (
        withinPreferred &&
        !overlapsBusy(slotStart.getTime(), slotEnd.getTime(), busy) &&
        !overlapsBlackout(slotStart, slotEnd, tz, preferences.blackoutWindows)
      ) {
        const dayKey = `${parts.year}-${parts.month}-${parts.day}`;
        if (!onePerDay || !seenDays.has(dayKey)) {
          seenDays.add(dayKey);
          results.push({
            startAt: slotStart.toISOString(),
            endAt: slotEnd.toISOString(),
            durationMinutes,
            localStart: formatLocalForDisplay(slotStart.toISOString(), tz),
            localEnd: formatLocalForDisplay(slotEnd.toISOString(), tz),
            timeZone: tz,
          });
          if (onePerDay) {
            t = endOfLocalDayMs(slotStart, tz);
            continue;
          }
        }
      }
      t += step;
    }
  }

  return results;
}

function formatSlotsText(slots: readonly ProposedMeetingSlot[]): string {
  if (slots.length === 0) {
    return "I couldn't find any open slots matching your preferences in that window.";
  }
  const lines = slots.map(
    (slot, idx) =>
      `${idx + 1}. ${slot.localStart} – ${slot.localEnd} (${slot.durationMinutes} min)`,
  );
  return `Here ${slots.length === 1 ? "is an available option" : `are ${slots.length} options`} you can offer:\n${lines.join("\n")}`;
}

function cleanBundledCounterparty(value: string): string {
  return toWellFormedUnicode(value)
    .replace(/^(?:with|for|and|also|maybe|please)\s{1,32}/iu, "")
    .replace(/\s{1,32}(?:at|if|while|during|thanks|please)\b.{0,1024}$/iu, "")
    .replace(/[.?!,;:]+$/u, "")
    .trim();
}

export function extractBundledMeetingCounterparties(
  messageText: string,
): string[] {
  const trimmed = toWellFormedUnicode(messageText.trim());
  if (trimmed.length === 0) {
    return [];
  }

  const patterns = [
    /\bschedule\s{1,32}(.{1,2048}?)(?:\s{1,32}at\s{1,32}the\s{1,32}same\s{1,32}time\b|\s{1,32}same\s{1,32}day\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
    /\bbundle\s{1,32}(.{1,2048}?)(?:\s{1,32}together\b|\s{1,32}on\s{1,32}the\s{1,32}same\s{1,32}day\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
    /\bmeetings?\s{1,32}with\s{1,32}(.{1,2048}?)(?:\s{1,32}on\s{1,32}the\s{1,32}same\s{1,32}day\b|\s{1,32}at\s{1,32}the\s{1,32}same\s{1,32}time\b|\s{1,32}if\s{1,32}possible\b|[.?!]|$)/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    const raw = match?.[1]?.trim();
    if (!raw) {
      continue;
    }
    const counterparties = raw
      .split(/\s{0,32}(?:,|&|\band\b)\s{0,32}/iu)
      .map(cleanBundledCounterparty)
      .filter((value) => value.length > 0);
    if (counterparties.length >= 2) {
      return counterparties;
    }
  }

  return [];
}

function formatCounterpartyList(counterparties: readonly string[]): string {
  if (counterparties.length === 0) {
    return "those meetings";
  }
  if (counterparties.length === 1) {
    return counterparties[0] ?? "that meeting";
  }
  if (counterparties.length === 2) {
    return `${counterparties[0]} and ${counterparties[1]}`;
  }
  return `${counterparties.slice(0, -1).join(", ")}, and ${counterparties[counterparties.length - 1]}`;
}

function deriveBundleLocationLabel(messageText: string): string | null {
  const lowered = messageText.toLowerCase();
  const inMatch =
    /\b(?:in|while i(?:'| a)?m in|while im in)\s+([a-z][a-z\s._-]{1,40}?)(?:\s+(?:for|with|so|and)\b|[,.!?]|$)/iu.exec(
      lowered,
    );
  const candidate = inMatch?.[1]?.replace(/[_]+/g, " ").trim();
  if (!candidate) {
    return null;
  }
  return candidate
    .split(/\s+/u)
    .map((part) =>
      part.length > 0
        ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`
        : part,
    )
    .join(" ");
}

type ProposedSlotsReplyContext = {
  counterparties?: string[];
  bundleLocationLabel?: string | null;
  timeZone: string;
};

export function formatProposedSlotsReply(args: {
  slots: readonly ProposedMeetingSlot[];
  context?: ProposedSlotsReplyContext;
}): string {
  const counterparties = args.context?.counterparties ?? [];
  const locationLabel = args.context?.bundleLocationLabel?.trim();
  const targetLabel = formatCounterpartyList(counterparties);
  const windowLabel = locationLabel
    ? `${locationLabel}-time`
    : args.context?.timeZone;

  if (counterparties.length >= 2) {
    if (args.slots.length === 0) {
      return `I couldn't find ${windowLabel} slots that keep ${targetLabel} in the same window. If you want, I can widen the search or split them across nearby times.`;
    }
    const lines = args.slots.map(
      (slot, idx) =>
        `${idx + 1}. ${slot.localStart} – ${slot.localEnd} (${slot.durationMinutes} min)`,
    );
    return `Here ${args.slots.length === 1 ? "is 1" : `are ${args.slots.length}`} ${windowLabel} option${args.slots.length === 1 ? "" : "s"} that keep ${targetLabel} in the same window:\n${lines.join("\n")}`;
  }

  return formatSlotsText(args.slots);
}

function parseOptionalIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getParams<T>(options: HandlerOptions | undefined): Partial<T> {
  const params = (options as HandlerOptions | undefined)?.parameters as
    | Partial<T>
    | undefined;
  return params ?? {};
}

async function denyIfNoAccess(
  runtime: IAgentRuntime,
  message: Memory,
): Promise<boolean> {
  return !(await hasLifeOpsAccess(runtime, message));
}

type SchedulingRespondPayload<
  T extends NonNullable<ActionResult["data"]> | undefined,
> = {
  success: boolean;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  data?: T;
  values?: ActionResult["values"];
};

function makeSchedulingRespond(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  callback: HandlerCallback | undefined;
  actionName: string;
}): <T extends NonNullable<ActionResult["data"]> | undefined>(
  payload: SchedulingRespondPayload<T>,
) => Promise<ActionResult> {
  const intent = getMessageText(args.message).trim();
  return async (payload) => {
    const reply = await renderLifeOpsActionReply({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
      intent,
      scenario: payload.scenario,
      fallback: payload.fallback,
      context: payload.context,
    });
    if (reply.kind === "model") {
      await args.callback?.({
        text: reply.text,
        source: "action",
        action: args.actionName,
      });
    }
    return applyGroundedActionReply(
      {
        success: payload.success,
        ...(payload.values ? { values: payload.values } : {}),
        ...(payload.data ? { data: payload.data } : {}),
      },
      reply,
    );
  };
}

// Dispatched from the CALENDAR umbrella (action=propose_times).
// Not a planner-visible Action — no name:, similes:, or registration.
export async function runProposeMeetingTimesHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const respond = makeSchedulingRespond({
    runtime,
    message,
    state,
    callback,
    actionName: "PROPOSE_MEETING_TIMES",
  });

  if (await denyIfNoAccess(runtime, message)) {
    return respond({
      success: false,
      scenario: "scheduling_access_denied",
      fallback:
        "Scheduling actions are restricted to the owner and authorized users.",
      data: { error: "PERMISSION_DENIED" },
    });
  }

  const params = getParams<ProposeMeetingTimesParameters>(options);
  const preferences = await readLifeOpsMeetingPreferences(runtime);
  const messageBody =
    typeof message.content.text === "string" ? message.content.text : "";
  const inferredTimeZone =
    (typeof params.timeZone === "string" && params.timeZone.trim().length > 0
      ? params.timeZone.trim()
      : null) ?? inferTimeZoneFromLocationText(messageBody);
  const effectivePreferences = inferredTimeZone
    ? { ...preferences, timeZone: inferredTimeZone }
    : preferences;
  const counterparties =
    Array.isArray(params.counterparties) && params.counterparties.length > 0
      ? params.counterparties
      : extractBundledMeetingCounterparties(messageBody);
  const bundleLocationLabel = deriveBundleLocationLabel(messageBody);
  const durationMinutes =
    typeof params.durationMinutes === "number" &&
    params.durationMinutes >= 5 &&
    params.durationMinutes <= 480
      ? Math.floor(params.durationMinutes)
      : effectivePreferences.defaultDurationMinutes;
  const slotCount =
    typeof params.slotCount === "number" &&
    params.slotCount >= 1 &&
    params.slotCount <= 10
      ? Math.floor(params.slotCount)
      : DEFAULT_SLOTS_COUNT;
  const daysAhead =
    typeof params.daysAhead === "number" &&
    params.daysAhead >= 1 &&
    params.daysAhead <= MAX_DAYS_LOOKAHEAD
      ? Math.floor(params.daysAhead)
      : DEFAULT_DAYS_LOOKAHEAD;

  const now = new Date();
  const explicitStart = parseOptionalIso(params.windowStart);
  const explicitEnd = parseOptionalIso(params.windowEnd);
  const windowStart = explicitStart ?? now;
  const windowEnd =
    explicitEnd ??
    new Date(windowStart.getTime() + daysAhead * 24 * 60 * 60_000);

  const { LifeOpsService, LifeOpsServiceError } =
    await loadLifeOpsServiceModule();
  const service = new LifeOpsService(runtime);
  let feed: LifeOpsCalendarFeed;
  try {
    feed = await service.getCalendarFeed(INTERNAL_URL, {
      includeHiddenCalendars: true,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: effectivePreferences.timeZone,
    });
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      const fallback =
        error.status === 403
          ? "I can't propose times yet because calendar access is not available. Grant Apple Calendar access or connect Google Calendar and try again."
          : `I couldn't read your calendar (${error.message}).`;
      return respond({
        success: false,
        scenario: "scheduling_calendar_unavailable",
        fallback,
        context: { status: error.status, detail: error.message },
        data: {
          error: "CALENDAR_UNAVAILABLE",
          status: error.status,
          detail: error.message,
        },
      });
    }
    throw error;
  }
  if (feed.state !== "complete") {
    return incompleteCalendarResponse({
      feed,
      respond,
      scenario: "scheduling_calendar_incomplete",
    });
  }

  const slots = computeProposedSlots({
    now,
    windowStart,
    windowEnd,
    durationMinutes,
    slotCount,
    preferences: effectivePreferences,
    events: feed.events,
  });

  const fallback = formatProposedSlotsReply({
    slots,
    context: {
      counterparties,
      bundleLocationLabel,
      timeZone: effectivePreferences.timeZone,
    },
  });
  return respond({
    success: true,
    scenario: "scheduling_proposed_slots",
    fallback,
    context: {
      slotCount: slots.length,
      durationMinutes,
      timeZone: effectivePreferences.timeZone,
      counterparties,
      bundleLocationLabel,
    },
    data: {
      slots,
      durationMinutes,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timeZone: effectivePreferences.timeZone,
      preferences: effectivePreferences,
      counterparties,
      bundleLocationLabel,
      calendarSnapshot: calendarSnapshotEffectProof(feed),
    },
  });
}

// Dispatched from the CALENDAR umbrella (action=check_availability).
// Not a planner-visible Action — no name:, similes:, or registration.
export async function runCheckAvailabilityHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const respond = makeSchedulingRespond({
    runtime,
    message,
    state,
    callback,
    actionName: "CHECK_AVAILABILITY",
  });

  if (await denyIfNoAccess(runtime, message)) {
    return respond({
      success: false,
      scenario: "scheduling_access_denied",
      fallback:
        "Scheduling actions are restricted to the owner and authorized users.",
      data: { error: "PERMISSION_DENIED" },
    });
  }

  const params = getParams<CheckAvailabilityParameters>(options);
  const windowStart = parseOptionalIso(params.startAt);
  const windowEnd = parseOptionalIso(params.endAt);
  if (!windowStart || !windowEnd || windowEnd <= windowStart) {
    return respond({
      success: false,
      scenario: "scheduling_invalid_window",
      fallback:
        "I need a valid ISO start and end time to check availability (end must be after start).",
      data: { error: "INVALID_WINDOW" },
    });
  }

  const preferences = await readLifeOpsMeetingPreferences(runtime);
  const { LifeOpsService, LifeOpsServiceError } =
    await loadLifeOpsServiceModule();
  const service = new LifeOpsService(runtime);
  let feed: LifeOpsCalendarFeed;
  try {
    feed = await service.getCalendarFeed(INTERNAL_URL, {
      includeHiddenCalendars: true,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      timeZone: preferences.timeZone,
    });
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      const fallback =
        error.status === 403
          ? "I can't check availability because calendar access is not available. Grant Apple Calendar access or connect Google Calendar."
          : `I couldn't read your calendar (${error.message}).`;
      return respond({
        success: false,
        scenario: "scheduling_calendar_unavailable",
        fallback,
        context: { status: error.status, detail: error.message },
        data: {
          error: "CALENDAR_UNAVAILABLE",
          status: error.status,
          detail: error.message,
        },
      });
    }
    throw error;
  }

  const windowStartMs = windowStart.getTime();
  const windowEndMs = windowEnd.getTime();
  const conflicts = feed.events.filter((event) => {
    const s = Date.parse(event.startAt);
    const e = Date.parse(event.endAt);
    return s < windowEndMs && e > windowStartMs;
  });
  if (feed.state !== "complete") {
    return incompleteCalendarResponse({
      feed,
      respond,
      scenario: "scheduling_calendar_incomplete",
      knownConflicts: conflicts,
    });
  }

  const isFree = conflicts.length === 0;
  const fallback = isFree
    ? `You're free from ${formatLocalForDisplay(windowStart.toISOString(), preferences.timeZone)} to ${formatLocalForDisplay(windowEnd.toISOString(), preferences.timeZone)}.`
    : `You have ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} in that window: ${conflicts.map((c) => c.title || "Untitled").join(", ")}.`;

  return respond({
    success: true,
    scenario: isFree ? "scheduling_window_free" : "scheduling_window_busy",
    fallback,
    context: {
      isFree,
      conflictCount: conflicts.length,
      timeZone: preferences.timeZone,
    },
    data: {
      isFree,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      conflicts: conflicts.map((c) => ({
        id: c.id,
        title: c.title,
        startAt: c.startAt,
        endAt: c.endAt,
      })),
      timeZone: preferences.timeZone,
      calendarSnapshot: calendarSnapshotEffectProof(feed),
    },
  });
}

// Dispatched from the CALENDAR umbrella (action=update_preferences).
// Not a planner-visible Action — no name:, similes:, or registration.
export async function runUpdateMeetingPreferencesHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const respond = makeSchedulingRespond({
    runtime,
    message,
    state,
    callback,
    actionName: "UPDATE_MEETING_PREFERENCES",
  });

  if (await denyIfNoAccess(runtime, message)) {
    return respond({
      success: false,
      scenario: "scheduling_access_denied",
      fallback:
        "Scheduling actions are restricted to the owner and authorized users.",
      data: { error: "PERMISSION_DENIED" },
    });
  }

  const params = getParams<Record<string, unknown>>(options);
  const patch: LifeOpsMeetingPreferencesPatch =
    normalizeLifeOpsMeetingPreferencesPatch(params);

  if (Object.keys(patch).length === 0) {
    return respond({
      success: false,
      scenario: "scheduling_preferences_no_fields",
      fallback:
        "No valid preference fields were provided. Supply preferredStartLocal/preferredEndLocal as HH:MM, numeric defaultDurationMinutes/travelBufferMinutes, or a blackoutWindows array.",
      data: { error: "NO_FIELDS" },
    });
  }

  const update = await updateLifeOpsMeetingPreferences(runtime, patch);
  if (!update) {
    return respond({
      success: false,
      scenario: "scheduling_preferences_update_failed",
      fallback: "Could not persist meeting preferences.",
      data: { error: "PREFERENCES_UPDATE_FAILED" },
    });
  }

  const updated = update.preferences;
  const fallback = `Updated meeting preferences (${updated.preferredStartLocal}–${updated.preferredEndLocal} ${updated.timeZone}, default ${updated.defaultDurationMinutes} min, travel buffer ${updated.travelBufferMinutes} min, ${updated.blackoutWindows.length} blackout window${updated.blackoutWindows.length === 1 ? "" : "s"}).`;
  return respond({
    success: true,
    scenario: "scheduling_preferences_updated",
    fallback,
    context: {
      preferredStartLocal: updated.preferredStartLocal,
      preferredEndLocal: updated.preferredEndLocal,
      timeZone: updated.timeZone,
      defaultDurationMinutes: updated.defaultDurationMinutes,
      travelBufferMinutes: updated.travelBufferMinutes,
      blackoutWindowCount: updated.blackoutWindows.length,
    },
    data: {
      preferences: updated,
      preferenceTaskId: update.taskId,
      updatedFields: Object.keys(patch),
    },
  });
}

// ── Multi-turn scheduling negotiation action ─────────────────────────────

type SchedulingApprovalEnqueueResult = {
  request: ApprovalRequest;
  reused: boolean;
  needsSurface: boolean;
};

function approvalChannelForDraft(
  draft: SchedulingMessageDraft,
): ApprovalChannel {
  switch (draft.transportChannel) {
    case "email":
    case "telegram":
    case "discord":
    case "whatsapp":
    case "imessage":
    case "sms":
      return draft.transportChannel;
  }
}

function approvalPayloadForDraft(
  draft: SchedulingMessageDraft,
  senderGrantId?: string,
): ApprovalPayload {
  return schedulingApprovalPayloadForDraft(draft, senderGrantId);
}

async function resolveSchedulingSender(
  runtime: IAgentRuntime,
  channel: string | undefined,
): Promise<{ grantId: string; email: string } | null> {
  if (channel !== "email") return null;
  const { LifeOpsService } = await loadLifeOpsServiceModule();
  const grant = await new LifeOpsService(runtime).requireGoogleGmailSendGrant(
    INTERNAL_URL,
    "local",
    "owner",
  );
  if (!grant.id || !grant.identityEmail)
    throw new ElizaError(
      "Reconnect the Google sender before creating an email approval.",
      { code: "SCHEDULING_SENDER_UNAVAILABLE" },
    );
  return { grantId: grant.id, email: grant.identityEmail };
}

async function enqueueSchedulingDraft(args: {
  runtime: IAgentRuntime;
  message: Memory;
  draft: SchedulingMessageDraft;
  sender: { grantId: string; email: string } | null;
  tx: TransactionalDb;
}): Promise<SchedulingApprovalEnqueueResult> {
  const channel = getChannelRegistry(args.runtime)?.get(
    args.draft.transportChannel,
  );
  if (!channel?.send || channel.receiptContract !== "provider_receipt_id") {
    throw new ElizaError(
      `[SchedulingApproval] ${args.draft.transportChannel} cannot provide a durable provider receipt`,
      {
        code: "SCHEDULING_PROVIDER_RECEIPT_UNSUPPORTED",
        context: {
          channel: args.draft.transportChannel,
          negotiationId: args.draft.negotiationId,
          proposalId: args.draft.proposalId,
        },
        severity: "ephemeral",
      },
    );
  }
  const subjectUserId =
    typeof args.message.entityId === "string" &&
    args.message.entityId.trim().length > 0
      ? args.message.entityId
      : String(args.runtime.agentId);
  const payload = approvalPayloadForDraft(args.draft, args.sender?.grantId);
  const scheduling = readSchedulingApprovalCorrelation(payload);
  if (!scheduling) {
    throw new ElizaError(
      "[SchedulingApproval] scheduling draft lost its typed correlation",
      {
        code: "SCHEDULING_APPROVAL_CORRELATION_LOST",
        context: {
          negotiationId: args.draft.negotiationId,
          proposalId: args.draft.proposalId,
          messageKind: args.draft.messageKind,
        },
        severity: "fatal",
      },
    );
  }
  const reason = [
    `Review exact ${args.draft.messageKind} scheduling draft before sending.`,
    `Channel: ${args.draft.transportChannel}`,
    ...(args.sender ? [`From: ${args.sender.email}`] : []),
    `To: ${args.draft.recipientName} (${args.draft.recipient})`,
    ...(payload.action === "send_email" ? [`Subject: ${payload.subject}`] : []),
    "Message:",
    args.draft.body,
    `Content SHA-256: ${scheduling.contentSha256}`,
  ].join("\n");
  const input = {
    requestedBy: "PERSONAL_ASSISTANT",
    subjectUserId,
    action: payload.action,
    payload,
    channel: approvalChannelForDraft(args.draft),
    reason,
    idempotencyKey: schedulingDeliveryIdempotencyKey(scheduling.contentSha256),
    expiresAt: schedulingApprovalExpiresAt(scheduling.sourceUpdatedAt),
  } as const;
  const queue = createApprovalQueue(args.runtime, {
    agentId: args.runtime.agentId,
  });
  const enqueued = await queue.enqueueTransactional(input, args.tx);
  await prepareSchedulingDelivery(args.tx, {
    agentId: args.runtime.agentId,
    request: enqueued.request,
    correlation: scheduling,
  });
  return {
    request: enqueued.request,
    reused: enqueued.reused,
    needsSurface: !enqueued.reused,
  };
}

async function surfaceSchedulingApproval(
  runtime: IAgentRuntime,
  approval: SchedulingApprovalEnqueueResult | null,
): Promise<void> {
  if (!approval?.needsSurface) return;
  const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
  try {
    await queue.surfaceEnqueuedApproval(approval.request);
  } catch (error) {
    // error-policy:J7 The queue row and domain mutation are already committed
    // atomically. Reporting preserves recovery visibility; deleting either
    // would lose the owner's durable approval target.
    runtime.reportError("SchedulingApproval.surface", error, {
      requestId: approval.request.id,
      idempotencyKey: approval.request.idempotencyKey,
    });
  }
}

type SchedulingSubaction =
  | "start"
  | "propose"
  | "respond"
  | "finalize"
  | "cancel"
  | "list_active"
  | "list_proposals";

export type SchedulingActionParameters = {
  subaction?: SchedulingSubaction;
  intent?: string;
  negotiationId?: string;
  proposalId?: string;
  subject?: string;
  startAt?: string;
  endAt?: string;
  durationMinutes?: number;
  response?: "accepted" | "declined" | "expired";
  confirmed?: boolean;
  relationshipId?: string;
  timezone?: string;
  proposedBy?: "agent" | "owner" | "counterparty";
  reason?: string;
};

type SchedulingLlmPlan = {
  subaction: SchedulingSubaction | null;
  shouldAct?: boolean | null;
  response?: string;
};

function normalizeSchedulingSubaction(
  value: unknown,
): SchedulingSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "start":
    case "propose":
    case "respond":
    case "finalize":
    case "cancel":
    case "list_active":
    case "list_proposals":
      return normalized;
    default:
      return null;
  }
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildSchedulingPlanPrompt(args: {
  runtime: IAgentRuntime;
  currentMessage: string;
  intent: string;
  params: SchedulingActionParameters;
  recentConversation: string;
}): string {
  const instructions = resolveOptimizedPromptForRuntime(
    args.runtime,
    "schedule_plan",
    SCHEDULE_PLAN_INSTRUCTIONS,
  );
  return [
    instructions,
    "",
    `Current request:\n${args.currentMessage}`,
    `Resolved intent:\n${args.intent}`,
    `Structured parameters:\n${Object.entries(args.params)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join("\n")}`,
    `Recent conversation:\n${args.recentConversation}`,
  ].join("\n");
}

async function resolveSchedulingPlanWithLlm(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  params: SchedulingActionParameters;
}): Promise<SchedulingLlmPlan> {
  const recentConversation = (
    await collectRecentConversationTexts({
      runtime: args.runtime,
      message: args.message,
      state: args.state,
    })
  ).join("\n");
  const currentMessage =
    typeof args.message.content.text === "string"
      ? args.message.content.text
      : "";
  const prompt = buildSchedulingPlanPrompt({
    runtime: args.runtime,
    currentMessage,
    intent: args.intent,
    params: args.params,
    recentConversation,
  });

  try {
    const result = await runWithTrajectoryPurpose("schedule_plan", () =>
      args.runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      }),
    );
    const rawResponse = typeof result === "string" ? result : "";
    const parsed = parseJsonModelRecord<Record<string, unknown>>(rawResponse);
    if (!parsed) {
      return {
        subaction: null,
        shouldAct: null,
      };
    }
    return {
      subaction: normalizeSchedulingSubaction(parsed.subaction),
      shouldAct: normalizeShouldAct(parsed.shouldAct),
      response: normalizePlannerResponse(parsed.response),
    };
  } catch (error) {
    args.runtime.logger.warn(
      {
        src: "action:scheduling",
        error: error instanceof Error ? error.message : String(error),
      },
      "Scheduling planning model call failed",
    );
    return {
      subaction: null,
      shouldAct: null,
    };
  }
}

function formatNegotiationSummary(n: {
  id: string;
  subject: string;
  state: string;
  durationMinutes: number;
}): string {
  return `Negotiation ${n.id} — "${n.subject}" (${n.durationMinutes} min, state=${n.state})`;
}

function formatProposalSummary(p: {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  proposedBy: string;
}): string {
  return `Proposal ${p.id}: ${p.startAt} → ${p.endAt} by ${p.proposedBy} (status=${p.status})`;
}

// Internal scheduling-negotiation lifecycle handler. The surface is delegated
// to from the registered PERSONAL_ASSISTANT umbrella in owner-surfaces.ts;
// scheduling negotiations no longer publish a planner-visible Action.
export async function runSchedulingNegotiationHandler(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: unknown,
  callback?: HandlerCallback,
): Promise<ActionResult> {
  const respond = makeSchedulingRespond({
    runtime,
    message,
    state,
    callback,
    actionName: "PERSONAL_ASSISTANT",
  });

  const params =
    ((options as HandlerOptions | undefined)?.parameters as
      | SchedulingActionParameters
      | undefined) ?? {};
  const messageBody =
    typeof message.content.text === "string" ? message.content.text : "";
  const planIntent = (params.intent ?? messageBody).trim();
  const explicitSubaction = normalizeSchedulingSubaction(params.subaction);
  const llmPlan = await resolveSchedulingPlanWithLlm({
    runtime,
    message,
    state,
    intent: planIntent,
    params,
  });
  const subaction = explicitSubaction ?? llmPlan.subaction;

  if (llmPlan.shouldAct === false && !explicitSubaction) {
    const fallback =
      llmPlan.response ??
      "Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?";
    return respond({
      success: false,
      scenario: "scheduling_negotiation_clarification",
      fallback,
      values: {
        success: false,
        error: "PLANNER_SHOULDACT_FALSE",
        noop: true,
      },
      data: { noop: true, error: "PLANNER_SHOULDACT_FALSE" },
    });
  }

  if (!subaction) {
    const fallback =
      llmPlan.response ??
      "Do you want to start, propose, respond, finalize, cancel, or list scheduling negotiations?";
    return respond({
      success: false,
      scenario: "scheduling_negotiation_missing_subaction",
      fallback,
      values: { requiresConfirmation: true },
      data: {
        error: "MISSING_SUBACTION",
        requiresConfirmation: true,
      },
    });
  }

  const { LifeOpsService, LifeOpsServiceError } =
    await loadLifeOpsServiceModule();
  const service = new LifeOpsService(runtime);
  try {
    if (subaction === "start") {
      const subject = params.subject ?? params.intent ?? messageBody.trim();
      if (!subject) {
        return respond({
          success: false,
          scenario: "scheduling_negotiation_start_missing_subject",
          fallback:
            "I need a subject (what the meeting is about) to start a negotiation.",
          values: { requiresConfirmation: true },
          data: {
            error: "MISSING_SUBJECT",
            requiresConfirmation: true,
          },
        });
      }
      // Contact graph stores do not accept the PA transaction handle. Resolve
      // the delivery target before opening the transaction so PGlite does not
      // deadlock on a second connection while the negotiation write is open.
      // Execution-time revalidation resolves it again and rejects any change.
      const counterparty =
        await service.resolveCounterpartyTargetForRelationship(
          params.relationshipId ?? null,
        );
      const sender = await resolveSchedulingSender(
        runtime,
        counterparty?.channel,
      );
      const { neg, approval } = await withRequiredTransaction(
        runtime,
        async (tx) => {
          const neg = await service.startNegotiation({
            subject,
            relationshipId: params.relationshipId ?? null,
            durationMinutes: params.durationMinutes,
            timezone: params.timezone,
            tx,
          });
          const draft = await service.draftOpeningMessage(neg, counterparty);
          const approval = draft
            ? await enqueueSchedulingDraft({
                runtime,
                message,
                draft,
                sender,
                tx,
              })
            : null;
          return { neg, approval };
        },
      );
      await surfaceSchedulingApproval(runtime, approval);
      const fallback = approval
        ? `Started ${formatNegotiationSummary(neg)} and queued an opening message draft for owner approval. Nothing was sent.`
        : `Started ${formatNegotiationSummary(neg)} without an attached counterparty. No message was drafted or sent.`;
      return respond({
        success: true,
        scenario: "scheduling_negotiation_started",
        fallback,
        context: {
          negotiationId: neg.id,
          subject: neg.subject,
          durationMinutes: neg.durationMinutes,
          state: neg.state,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          sent: false,
          calendarEventCreated: false,
        },
        data: {
          negotiation: neg,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          approvalReused: approval?.reused ?? false,
          deliveryStatus: approval ? "awaiting_approval" : "not_drafted",
          sent: false,
          calendarEventCreated: false,
        },
      });
    }

    if (subaction === "propose") {
      if (!params.negotiationId || !params.startAt || !params.endAt) {
        // Selection + execution were correct: the user wanted to propose
        // times, the handler ran, and we now need the user to fill in the
        // missing fields. Mark as awaiting-confirmation.
        return respond({
          success: false,
          scenario: "scheduling_negotiation_propose_missing_fields",
          fallback:
            "Propose needs negotiationId, startAt, and endAt (ISO-8601).",
          values: { requiresConfirmation: true },
          data: {
            error: "MISSING_PROPOSAL_FIELDS",
            requiresConfirmation: true,
          },
        });
      }
      const proposedBy = params.proposedBy ?? "agent";
      const negotiationId = params.negotiationId;
      const startAt = params.startAt;
      const endAt = params.endAt;
      const negotiationBeforeMutation =
        await service.getNegotiation(negotiationId);
      const counterparty = negotiationBeforeMutation
        ? await service.resolveCounterpartyTarget(negotiationBeforeMutation)
        : null;
      const sender = await resolveSchedulingSender(
        runtime,
        counterparty?.channel,
      );
      const { proposal, approval } = await withRequiredTransaction(
        runtime,
        async (tx) => {
          const proposal = await service.proposeTime({
            negotiationId,
            startAt,
            endAt,
            proposedBy,
            tx,
          });
          const negotiation = await service.getNegotiation(
            proposal.negotiationId,
            tx,
          );
          if (!negotiation) {
            throw new ElizaError(
              `[SchedulingApproval] negotiation ${proposal.negotiationId} disappeared after proposal persistence`,
              {
                code: "SCHEDULING_NEGOTIATION_RELOAD_FAILED",
                context: {
                  negotiationId: proposal.negotiationId,
                  proposalId: proposal.id,
                },
                severity: "fatal",
              },
            );
          }
          const draft =
            proposedBy === "counterparty"
              ? null
              : await service.draftProposalMessage(
                  negotiation,
                  proposal,
                  counterparty,
                );
          const approval = draft
            ? await enqueueSchedulingDraft({
                runtime,
                message,
                draft,
                sender,
                tx,
              })
            : null;
          return { proposal, approval };
        },
      );
      await surfaceSchedulingApproval(runtime, approval);
      const fallback =
        proposedBy === "counterparty"
          ? `Recorded the counterparty's ${formatProposalSummary(proposal)}. No outbound message was sent.`
          : approval
            ? `Recorded ${formatProposalSummary(proposal)} and queued the exact proposal message for owner approval. Nothing was sent.`
            : `Recorded ${formatProposalSummary(proposal)} without an attached counterparty. No message was drafted or sent.`;
      return respond({
        success: true,
        scenario: "scheduling_negotiation_proposed",
        fallback,
        context: {
          proposalId: proposal.id,
          startAt: proposal.startAt,
          endAt: proposal.endAt,
          proposedBy,
          status: proposal.status,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          sent: false,
          calendarEventCreated: false,
        },
        data: {
          proposal,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          approvalReused: approval?.reused ?? false,
          deliveryStatus:
            proposedBy === "counterparty"
              ? "not_applicable"
              : approval
                ? "awaiting_approval"
                : "not_drafted",
          sent: false,
          calendarEventCreated: false,
        },
      });
    }

    if (subaction === "respond") {
      if (!params.proposalId || !params.response) {
        return respond({
          success: false,
          scenario: "scheduling_negotiation_respond_missing_fields",
          fallback: "Respond needs proposalId and response.",
          data: { error: "MISSING_RESPONSE_FIELDS" },
        });
      }
      const proposal = await service.respondToProposal(
        params.proposalId,
        params.response,
      );
      return respond({
        success: true,
        scenario: "scheduling_negotiation_respond",
        fallback: `Proposal ${proposal.id} is now ${proposal.status}.`,
        context: { proposalId: proposal.id, status: proposal.status },
        data: { proposal },
      });
    }

    if (subaction === "finalize") {
      if (!params.negotiationId || !params.proposalId) {
        return respond({
          success: false,
          scenario: "scheduling_negotiation_finalize_missing_fields",
          fallback: "Finalize needs negotiationId and proposalId.",
          data: { error: "MISSING_FINALIZE_FIELDS" },
        });
      }
      const negotiationId = params.negotiationId;
      const proposalId = params.proposalId;
      const negotiationBeforeMutation =
        await service.getNegotiation(negotiationId);
      const counterparty = negotiationBeforeMutation
        ? await service.resolveCounterpartyTarget(negotiationBeforeMutation)
        : null;
      const sender = await resolveSchedulingSender(
        runtime,
        counterparty?.channel,
      );
      const { neg, proposal, approval } = await withRequiredTransaction(
        runtime,
        async (tx) => {
          const neg = await service.finalizeNegotiation(
            negotiationId,
            proposalId,
            tx,
          );
          const proposal = (await service.listProposals(neg.id, tx)).find(
            (candidate) => candidate.id === proposalId,
          );
          if (!proposal) {
            throw new ElizaError(
              `[SchedulingApproval] proposal ${proposalId} disappeared after selection`,
              {
                code: "SCHEDULING_PROPOSAL_RELOAD_FAILED",
                context: {
                  negotiationId: neg.id,
                  proposalId,
                },
                severity: "fatal",
              },
            );
          }
          const draft = await service.draftConfirmationMessage(
            neg,
            proposal,
            counterparty,
          );
          const approval = draft
            ? await enqueueSchedulingDraft({
                runtime,
                message,
                draft,
                sender,
                tx,
              })
            : null;
          return { neg, proposal, approval };
        },
      );
      await surfaceSchedulingApproval(runtime, approval);
      const fallback = approval
        ? `Selected accepted proposal ${proposal.id} for ${formatNegotiationSummary(neg)} and queued a confirmation-message draft for owner approval. Nothing was sent, and no calendar event was created or changed.`
        : `Selected accepted proposal ${proposal.id} for ${formatNegotiationSummary(neg)} without an attached counterparty. No message was sent, and no calendar event was created or changed.`;
      return respond({
        success: true,
        scenario: "scheduling_negotiation_finalized",
        fallback,
        context: {
          negotiationId: neg.id,
          subject: neg.subject,
          durationMinutes: neg.durationMinutes,
          state: neg.state,
          acceptedProposalId: proposal.id,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          sent: false,
          calendarEventCreated: false,
        },
        data: {
          negotiation: neg,
          acceptedProposalId: proposal.id,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          approvalReused: approval?.reused ?? false,
          deliveryStatus: approval ? "awaiting_approval" : "not_drafted",
          sent: false,
          calendarEventCreated: false,
        },
      });
    }

    if (subaction === "cancel") {
      if (!params.negotiationId) {
        return respond({
          success: false,
          scenario: "scheduling_negotiation_cancel_missing_id",
          fallback: "Cancel needs negotiationId.",
          data: { error: "MISSING_NEGOTIATION_ID" },
        });
      }
      const negotiationId = params.negotiationId;
      const negotiationBeforeMutation =
        await service.getNegotiation(negotiationId);
      const counterparty = negotiationBeforeMutation
        ? await service.resolveCounterpartyTarget(negotiationBeforeMutation)
        : null;
      const sender = await resolveSchedulingSender(
        runtime,
        counterparty?.channel,
      );
      const { negotiation, approval } = await withRequiredTransaction(
        runtime,
        async (tx) => {
          const negotiation = await service.cancelNegotiation(
            negotiationId,
            params.reason,
            tx,
          );
          const draft = await service.draftCancellationMessage(
            negotiation,
            params.reason,
            counterparty,
          );
          const approval = draft
            ? await enqueueSchedulingDraft({
                runtime,
                message,
                draft,
                sender,
                tx,
              })
            : null;
          return { negotiation, approval };
        },
      );
      await surfaceSchedulingApproval(runtime, approval);
      const fallback = approval
        ? `Cancelled local negotiation ${negotiationId} and queued a cancellation-message draft for owner approval. Nothing was sent, and no calendar event was changed.`
        : `Cancelled local negotiation ${negotiationId} without an attached counterparty. No message was sent, and no calendar event was changed.`;
      return respond({
        success: true,
        scenario: "scheduling_negotiation_cancelled",
        fallback,
        context: {
          negotiationId,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          sent: false,
          calendarEventChanged: false,
        },
        data: {
          negotiation,
          approvalRequestId: approval?.request.id ?? null,
          approvalState: approval?.request.state ?? null,
          approvalReused: approval?.reused ?? false,
          deliveryStatus: approval ? "awaiting_approval" : "not_drafted",
          sent: false,
          calendarEventChanged: false,
        },
      });
    }

    if (subaction === "list_proposals") {
      if (!params.negotiationId) {
        return respond({
          success: false,
          scenario: "scheduling_negotiation_list_proposals_missing_id",
          fallback: "list_proposals needs negotiationId.",
          data: { error: "MISSING_NEGOTIATION_ID" },
        });
      }
      const proposals = await service.listProposals(params.negotiationId);
      const fallback = proposals.length
        ? `Proposals for ${params.negotiationId}:\n${proposals.map(formatProposalSummary).join("\n")}`
        : `No proposals for ${params.negotiationId}.`;
      return respond({
        success: true,
        scenario: "scheduling_negotiation_list_proposals",
        fallback,
        context: {
          negotiationId: params.negotiationId,
          proposalCount: proposals.length,
        },
        data: { proposals },
      });
    }

    // list_active
    const active = await service.listActiveNegotiations();
    const fallback = active.length
      ? `Active negotiations:\n${active.map(formatNegotiationSummary).join("\n")}`
      : "No active scheduling negotiations.";
    return respond({
      success: true,
      scenario: "scheduling_negotiation_list_active",
      fallback,
      context: { activeCount: active.length },
      data: { negotiations: active },
    });
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      // Selection + execution were correct: the user asked to schedule, the
      // action ran, and the lifeops service surfaced a needs-human signal
      // (no counterparty contact, missing scheduling field, etc.). Mark as
      // awaiting-confirmation so the native planner
      // stops chaining and the benchmark scorer treats this as completed.
      return respond({
        success: false,
        scenario: "scheduling_negotiation_service_error",
        fallback: `Scheduling error: ${error.message}`,
        context: { status: error.status, detail: error.message },
        values: { requiresConfirmation: true },
        data: {
          error: "SERVICE_ERROR",
          status: error.status,
          detail: error.message,
          requiresConfirmation: true,
        },
      });
    }
    throw error;
  }
}
