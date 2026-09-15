/**
 * OWNER_SCREENTIME action implementation — planning, parameter parsing, and
 * recap shaping for screen-time queries. Registered by host plugins via the
 * factories in `./index.ts`; owner access checks and persistence stay in the host.
 * "Today" is the calendar day in the zone the host's `resolveTimeZone` adapter
 * returns, matching the local-day keys screen-time rows are stored under.
 */
import type {
  Action,
  ActionParameter,
  ActionResult,
  GroundedActionReply,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  applyGroundedActionReply,
  resolveOptimizedPromptForRuntime,
  runWithTrajectoryPurpose,
} from "@elizaos/core";
import { normalizeTimeZone } from "@elizaos/shared";
import type {
  LifeOpsScreenTimeDaily,
  LifeOpsScreenTimeSource,
  LifeOpsScreenTimeSummary,
} from "../contracts/lifeops.js";
import { getLocalDateKey, getZonedDateParts } from "../util/time.js";
import { SCREENTIME_RECAP_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

export { SCREENTIME_RECAP_INSTRUCTIONS } from "./optimized-prompt-instructions.js";

const ACTION_NAME = "SCREEN_TIME";
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;

type Subaction =
  | "summary"
  | "today"
  | "weekly"
  | "weekly_average_by_app"
  | "by_app"
  | "by_website"
  | "activity_report"
  | "time_on_app"
  | "time_on_site"
  | "browser_activity";

interface OwnerScreenTimeParams {
  source?: "app" | "website";
  identifier?: string;
  date?: string;
  days?: number;
  limit?: number;
  windowDays?: number;
  windowHours?: number;
  appNameOrBundleId?: string;
  domain?: string;
  deviceId?: string;
}

interface SubactionSpec<TParams = Record<string, unknown>> {
  description: string;
  descriptionCompressed: string;
  required: ReadonlyArray<keyof TParams & string>;
  optional?: ReadonlyArray<keyof TParams & string>;
}

type SubactionsMap<TSubaction extends string = string> = {
  readonly [K in TSubaction]: SubactionSpec;
};

type ResolveActionArgsResult<TSubaction extends string, TParams> =
  | {
      ok: true;
      subaction: TSubaction;
      params: TParams;
    }
  | {
      ok: false;
      missing: string[];
      clarification: string;
      partial?: Partial<TParams>;
    };

type ScreenTimeWeeklyAverage = {
  daysInWindow: number;
  totalSeconds: number;
  items: Array<{
    source: "app";
    identifier: string;
    displayName: string;
    totalSeconds: number;
    averageSecondsPerDay: number;
    averageMinutesPerDay: number;
  }>;
};

type ActivityReport = {
  sinceMs: number;
  untilMs: number;
  totalMs: number;
  apps: Array<{ appName: string; bundleId: string; totalMs: number }>;
};

type TimeOnAppResult = {
  totalMs: number;
  matchedBy: "appName" | "bundleId" | "none" | string;
};

type BrowserDomainActivity = {
  totalMs: number;
  reportCount: number;
};

type BrowserActivitySnapshot = {
  deviceId: string | null;
  windowEnd: string;
  domains: Array<{
    domain: string;
    focusMs: number;
    sessionCount: number;
  }>;
};

export interface ScreenTimeActionService {
  getScreenTimeDaily(opts: {
    date: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    limit?: number;
  }): Promise<LifeOpsScreenTimeDaily[]>;
  getScreenTimeSummary(opts: {
    since: string;
    until: string;
    source?: LifeOpsScreenTimeSource;
    identifier?: string;
    topN?: number;
  }): Promise<LifeOpsScreenTimeSummary>;
  getScreenTimeWeeklyAverageByApp(opts: {
    since: string;
    until: string;
    daysInWindow: number;
    identifier?: string;
    topN?: number;
  }): Promise<ScreenTimeWeeklyAverage>;
}

export interface CreateScreenTimeActionRunnerOptions {
  hasAccess: (runtime: IAgentRuntime, message: Memory) => Promise<boolean>;
  createService: (runtime: IAgentRuntime) => ScreenTimeActionService;
  messageText: (message: Memory) => string;
  /** IANA zone whose calendar day is the owner's "today". */
  resolveTimeZone: (runtime: IAgentRuntime) => string | Promise<string>;
  renderReply: (args: {
    runtime: IAgentRuntime;
    message: Memory;
    state: State | undefined;
    intent: string;
    scenario: string;
    fallback: string;
    context?: Record<string, unknown>;
    additionalRules?: string[];
  }) => Promise<GroundedActionReply>;
  resolveActionArgs: <TSubaction extends string, TParams>(input: {
    runtime: IAgentRuntime;
    message: Memory;
    state?: State;
    options?: HandlerOptions;
    actionName: string;
    subactions: SubactionsMap<TSubaction>;
    defaultSubaction?: TSubaction;
    intentHint?: string;
  }) => Promise<ResolveActionArgsResult<TSubaction, TParams>>;
  isDarwin: () => boolean;
  getActivityReport: (
    runtime: IAgentRuntime,
    agentId: string,
    opts: { windowMs: number; limit?: number },
  ) => Promise<ActivityReport>;
  getTimeOnApp: (
    runtime: IAgentRuntime,
    agentId: string,
    appNameOrBundleId: string,
    opts: { windowMs: number },
  ) => Promise<TimeOnAppResult>;
  getBrowserDomainActivity: (
    runtime: IAgentRuntime,
    opts: { domain: string; sinceMs: number; untilMs: number },
  ) => Promise<BrowserDomainActivity>;
  getBrowserActivitySnapshot: (
    runtime: IAgentRuntime,
    opts: { deviceId?: string; limit?: number },
  ) => Promise<BrowserActivitySnapshot>;
}

const SUBACTIONS: SubactionsMap<Subaction> = {
  summary: {
    description: "Rolling-window screen-time summary across apps and websites.",
    descriptionCompressed: "rolling-window screen-time summary apps+websites",
    required: [],
    optional: ["windowDays", "source", "identifier"],
  },
  today: {
    description: "Per-day screen-time breakdown for a specific date.",
    descriptionCompressed: "per-day screen-time breakdown date",
    required: [],
    optional: ["date", "source", "identifier"],
  },
  weekly: {
    description: "Screen-time over the last N days (default 7).",
    descriptionCompressed: "screen-time last-N-days default-7",
    required: [],
    optional: ["days", "source", "identifier"],
  },
  weekly_average_by_app: {
    description: "Average screen-time per app per day across the window.",
    descriptionCompressed: "avg screen-time per-app per-day window",
    required: [],
    optional: ["days", "identifier"],
  },
  by_app: {
    description: "Top apps by dwell time in the window.",
    descriptionCompressed: "top apps dwell-time window",
    required: [],
    optional: ["limit", "windowDays"],
  },
  by_website: {
    description: "Top websites by dwell time in the window.",
    descriptionCompressed: "top websites dwell-time window",
    required: [],
    optional: ["limit", "windowDays"],
  },
  activity_report: {
    description:
      "Per-app focus minutes from the macOS native activity tracker for the last N hours. macOS-only.",
    descriptionCompressed:
      "per-app focus mins macOS-native-tracker last-N-hours macOS-only",
    required: [],
    optional: ["windowHours"],
  },
  time_on_app: {
    description:
      "Focus time for one app (matched by app name or bundle id) over the last N hours. macOS-only.",
    descriptionCompressed:
      "focus time single-app name|bundle-id last-N-hours macOS-only",
    required: ["appNameOrBundleId"],
    optional: ["windowHours"],
  },
  time_on_site: {
    description:
      "Browser time on one specific domain from browser-extension activity reports.",
    descriptionCompressed: "browser time single-domain extension-reports",
    required: ["domain"],
    optional: ["windowHours"],
  },
  browser_activity: {
    description:
      "Per-domain focus seconds from the last snapshot pushed by the browser extension.",
    descriptionCompressed:
      "per-domain focus-seconds last-extension-snapshot deviceId?",
    required: [],
    optional: ["deviceId", "limit"],
  },
};

function localTodayKey(timeZone: string): string {
  return getLocalDateKey(getZonedDateParts(new Date(), timeZone));
}

function daysAgoIso(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatMinutes(totalMs: number): number {
  return Math.round(totalMs / 60_000);
}

function clampDays(value: number | undefined, fallback: number): number {
  const raw =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(31, Math.max(1, Math.floor(raw)));
}

function resolveWindowMs(windowHours: number | undefined): number {
  const raw =
    typeof windowHours === "number" && Number.isFinite(windowHours)
      ? windowHours
      : DEFAULT_WINDOW_HOURS;
  const clamped = Math.max(0.25, Math.min(MAX_WINDOW_HOURS, raw));
  return Math.round(clamped * 60 * 60 * 1000);
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.+$/, "");
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return trimmed;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    // error-policy:J3 untrusted domain input; an unparseable URL yields the
    // empty invalid signal rather than a fabricated hostname.
    return "";
  }
}

function buildReportSummary(
  apps: Array<{ appName: string; bundleId: string; totalMs: number }>,
): string {
  if (apps.length === 0) return "No app focus events recorded in that window.";
  return apps
    .map(
      (app) =>
        `- ${app.appName || app.bundleId}: ${formatMinutes(app.totalMs)}m`,
    )
    .join("\n");
}

export function buildScreenTimeRecapRules(runtime?: IAgentRuntime): string[] {
  const instructions = runtime
    ? resolveOptimizedPromptForRuntime(
        runtime,
        "screentime_recap",
        SCREENTIME_RECAP_INSTRUCTIONS,
      )
    : SCREENTIME_RECAP_INSTRUCTIONS;

  return [
    "For screen-time recap replies, follow this optimizable policy:",
    instructions,
    "Use only the provided screen-time context and canonical fallback facts.",
  ];
}

type RespondPayload<T extends NonNullable<ActionResult["data"]> | undefined> = {
  success: boolean;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
  data?: T;
};

export const SCREEN_TIME_SIMILES: readonly string[] = [
  "SCREENTIME",
  "ACTIVITY_REPORT",
  "TIME_TRACKING",
  "WHAT_DID_I_WORK_ON",
  "TIME_ON_APP",
  "TIME_ON_SITE",
  "DWELL_TIME",
];

export const SCREEN_TIME_PARAMETERS: readonly ActionParameter[] = [
  {
    name: "subaction",
    description:
      "One of: summary, today, weekly, weekly_average_by_app, by_app, by_website, activity_report, time_on_app, time_on_site, browser_activity.",
    descriptionCompressed:
      "screen-time summary|today|weekly|avg_app|by_app|by_website|activity|time_app|time_site",
    required: false,
    schema: {
      type: "string" as const,
      enum: [
        "summary",
        "today",
        "weekly",
        "weekly_average_by_app",
        "by_app",
        "by_website",
        "activity_report",
        "time_on_app",
        "time_on_site",
        "browser_activity",
      ],
    },
    examples: ["today", "weekly", "time_on_app"],
  },
  {
    name: "source",
    description: "Restrict screen-time subactions to 'app' or 'website'.",
    descriptionCompressed: "source filter: app|website",
    required: false,
    schema: { type: "string" as const, enum: ["app", "website"] },
  },
  {
    name: "identifier",
    description:
      "Specific app bundle id or website domain when filtering screen-time to one source.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "date",
    description: "YYYY-MM-DD for the today subaction.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "days",
    description:
      "Number of days back from now for weekly / weekly_average_by_app windows.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "limit",
    description:
      "Optional caller-requested Top-N pagination for by_app / by_website / browser_activity. Omit for complete results.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "windowDays",
    description: "Window in days for by_app / by_website summary queries.",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "windowHours",
    description:
      "Window in hours for activity_report / time_on_app / time_on_site (default 24, max 720).",
    required: false,
    schema: { type: "number" as const },
  },
  {
    name: "appNameOrBundleId",
    description:
      "App name (e.g. 'Safari') or bundle id (e.g. 'com.apple.Safari') for time_on_app.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "domain",
    description: "Hostname (e.g. 'github.com') for time_on_site.",
    required: false,
    schema: { type: "string" as const },
  },
  {
    name: "deviceId",
    description:
      "Filter browser_activity to one registered device id; omit for default.",
    required: false,
    schema: { type: "string" as const },
  },
];

export const OWNER_SCREEN_TIME_ACTIONS = [
  "summary",
  "today",
  "weekly",
  "weekly_average_by_app",
  "by_app",
  "by_website",
  "activity_report",
  "time_on_app",
  "time_on_site",
  "browser_activity",
] as const;

export interface CreateOwnerScreenTimeActionOptions {
  validate: Action["validate"];
  handler: Action["handler"];
}

export function createOwnerScreenTimeAction({
  validate,
  handler,
}: CreateOwnerScreenTimeActionOptions): Action {
  return {
    name: "OWNER_SCREENTIME",
    similes: [
      "SCREENTIME",
      "SCREEN_TIME",
      "ACTIVITY_REPORT",
      ...SCREEN_TIME_SIMILES,
    ],
    description:
      "Owner screen-time/activity analytics: local activity, app usage, browser.",
    descriptionCompressed:
      "owner screentime summary|today|weekly|by_app|by_website|activity|time_on_app|time_on_site",
    parameters: [
      {
        name: "action",
        description: "Owner screentime op.",
        required: false,
        schema: {
          type: "string" as const,
          enum: [...OWNER_SCREEN_TIME_ACTIONS],
        },
      },
      ...SCREEN_TIME_PARAMETERS.filter(
        (parameter) => parameter.name !== "subaction",
      ),
    ],
    validate,
    handler,
  };
}

export function createScreenTimeActionRunner(
  adapters: CreateScreenTimeActionRunnerOptions,
): (
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  options: HandlerOptions | undefined,
  callback?: HandlerCallback,
) => Promise<ActionResult> {
  return async function runScreenTimeHandler(
    runtime,
    message,
    state,
    options,
    callback,
  ) {
    if (!(await adapters.hasAccess(runtime, message))) {
      const text = "Screen time data is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const intent = adapters.messageText(message).trim();
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(
      payload: RespondPayload<T>,
    ): Promise<ActionResult> => {
      const reply = await runWithTrajectoryPurpose("screentime_recap", () =>
        adapters.renderReply({
          runtime,
          message,
          state,
          intent,
          scenario: payload.scenario,
          fallback: payload.fallback,
          context: payload.context,
          additionalRules: buildScreenTimeRecapRules(runtime),
        }),
      );
      if (reply.kind === "model") {
        await callback?.({
          text: reply.text,
          source: "action",
          action: ACTION_NAME,
        });
      }
      return applyGroundedActionReply(
        {
          success: payload.success,
          ...(payload.data ? { data: payload.data } : {}),
        },
        reply,
      );
    };

    const resolved = await adapters.resolveActionArgs<
      Subaction,
      OwnerScreenTimeParams
    >({
      runtime,
      message,
      state,
      options,
      actionName: ACTION_NAME,
      subactions: SUBACTIONS,
      defaultSubaction: "summary",
    });

    if (!resolved.ok) {
      await callback?.({ text: resolved.clarification });
      return {
        text: resolved.clarification,
        success: false,
        data: { error: "INVALID_SUBACTION", missing: resolved.missing },
      };
    }

    const { subaction, params } = resolved;

    switch (subaction) {
      case "today": {
        const service = adapters.createService(runtime);
        const date =
          params.date ??
          localTodayKey(
            normalizeTimeZone(await adapters.resolveTimeZone(runtime)),
          );
        const daily = await service.getScreenTimeDaily({
          date,
          source: params.source,
          identifier: params.identifier,
        });
        const total = daily.reduce((acc, row) => acc + row.totalSeconds, 0);
        const fallback =
          daily.length === 0
            ? `No screen time recorded for ${date}.`
            : `Screen time for ${date} (total ${formatSeconds(total)}):\n${daily
                .map(
                  (row) =>
                    `- ${row.source}: ${row.identifier} — ${formatSeconds(row.totalSeconds)} (${row.sessionCount} session${row.sessionCount === 1 ? "" : "s"})`,
                )
                .join("\n")}`;
        return respond({
          success: true,
          scenario: "screen_time_daily",
          fallback,
          context: { date, totalSeconds: total, daily },
          data: { subaction, date, daily },
        });
      }

      case "weekly": {
        const service = adapters.createService(runtime);
        const days = clampDays(params.days, 7);
        const until = new Date().toISOString();
        const since = daysAgoIso(days);
        const summary = await service.getScreenTimeSummary({
          since,
          until,
          source: params.source,
          identifier: params.identifier,
        });
        const fallback =
          summary.items.length === 0
            ? `No screen time recorded in the last ${days} days.`
            : `Top screen time over the last ${days} days (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
                .map(
                  (item) =>
                    `- ${item.source}: ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
                )
                .join("\n")}`;
        return respond({
          success: true,
          scenario: "screen_time_weekly",
          fallback,
          context: {
            windowDays: days,
            totalSeconds: summary.totalSeconds,
            items: summary.items,
          },
          data: { subaction, since, until, summary },
        });
      }

      case "weekly_average_by_app": {
        const service = adapters.createService(runtime);
        const daysInWindow = clampDays(params.days, 7);
        const until = new Date().toISOString();
        const since = daysAgoIso(daysInWindow);
        const weeklyAverage = await service.getScreenTimeWeeklyAverageByApp({
          since,
          until,
          daysInWindow,
          identifier: params.identifier,
        });
        const fallback =
          weeklyAverage.items.length === 0
            ? `No app screen time recorded in the last ${daysInWindow} days.`
            : `Weekly average per app over the last ${daysInWindow} days (total ${formatSeconds(weeklyAverage.totalSeconds)}):\n${weeklyAverage.items
                .map(
                  (item) =>
                    `- ${item.displayName} — ${formatSeconds(item.averageSecondsPerDay)}/day average (${formatSeconds(item.totalSeconds)} total)`,
                )
                .join("\n")}`;
        return respond({
          success: true,
          scenario: "screen_time_weekly_average_by_app",
          fallback,
          context: {
            daysInWindow,
            totalSeconds: weeklyAverage.totalSeconds,
            items: weeklyAverage.items,
          },
          data: { subaction, source: "app", since, until, weeklyAverage },
        });
      }

      case "by_app":
      case "by_website": {
        const service = adapters.createService(runtime);
        const source = subaction === "by_app" ? "app" : "website";
        const windowDays = clampDays(params.windowDays, 1);
        const until = new Date().toISOString();
        const since = daysAgoIso(windowDays);
        const topN =
          typeof params.limit === "number" && params.limit > 0
            ? Math.floor(params.limit)
            : undefined;
        const summary = await service.getScreenTimeSummary({
          since,
          until,
          source,
          identifier: params.identifier,
          ...(topN === undefined ? {} : { topN }),
        });
        const label = source === "app" ? "apps" : "websites";
        const fallback =
          summary.items.length === 0
            ? `No ${label} recorded in that window.`
            : `Top ${label} (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
                .map(
                  (item) =>
                    `- ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
                )
                .join("\n")}`;
        return respond({
          success: true,
          scenario:
            source === "app" ? "screen_time_by_app" : "screen_time_by_website",
          fallback,
          context: {
            source,
            totalSeconds: summary.totalSeconds,
            items: summary.items,
          },
          data: { subaction, source, since, until, summary },
        });
      }

      case "activity_report": {
        const windowMs = resolveWindowMs(params.windowHours);
        if (!adapters.isDarwin()) {
          return respond({
            success: true,
            scenario: "activity_report_unsupported_platform",
            fallback:
              "Activity tracking is macOS-only. No data available on this platform.",
            context: { windowMs },
            data: {
              apps: [],
              totalMs: 0,
              windowMs,
              noDataReason: "macos-only",
            },
          });
        }
        const agentId = String(runtime.agentId);
        const report = await adapters.getActivityReport(runtime, agentId, {
          windowMs,
        });
        const fallback = `Activity report (${formatMinutes(report.totalMs)}m total):\n${buildReportSummary(report.apps)}`;
        return respond({
          success: true,
          scenario: "activity_report_summary",
          fallback,
          context: {
            totalMs: report.totalMs,
            appCount: report.apps.length,
            apps: report.apps,
          },
          data: {
            sinceMs: report.sinceMs,
            untilMs: report.untilMs,
            totalMs: report.totalMs,
            apps: report.apps,
          },
        });
      }

      case "time_on_app": {
        const target = (params.appNameOrBundleId ?? "").trim();
        if (!target) {
          return respond({
            success: false,
            scenario: "time_on_app_missing_app",
            fallback: "Specify an app name or bundle id.",
            data: { error: "MISSING_APP" },
          });
        }
        const windowMs = resolveWindowMs(params.windowHours);
        if (!adapters.isDarwin()) {
          return respond({
            success: true,
            scenario: "time_on_app_unsupported_platform",
            fallback: `Activity tracking is macOS-only; no time-on-app data for ${target}.`,
            context: { app: target, windowMs },
            data: {
              minutes: 0,
              totalMs: 0,
              windowMs,
              app: target,
              noDataReason: "macos-only",
            },
          });
        }
        const agentId = String(runtime.agentId);
        const result = await adapters.getTimeOnApp(runtime, agentId, target, {
          windowMs,
        });
        const minutes = formatMinutes(result.totalMs);
        const fallback =
          result.matchedBy === "none"
            ? `No focus events recorded for ${target} in that window.`
            : `${target}: ${minutes}m (matched by ${result.matchedBy}).`;
        return respond({
          success: true,
          scenario: "time_on_app",
          fallback,
          context: { app: target, minutes, matchedBy: result.matchedBy },
          data: {
            app: target,
            minutes,
            totalMs: result.totalMs,
            matchedBy: result.matchedBy,
            windowMs,
          },
        });
      }

      case "time_on_site": {
        const rawDomain = (params.domain ?? "").trim();
        const domain = rawDomain ? normalizeDomain(rawDomain) : "";
        if (!domain) {
          return respond({
            success: false,
            scenario: "time_on_site_missing_domain",
            fallback: "Specify a site domain.",
            data: { error: "MISSING_DOMAIN" },
          });
        }
        const windowMs = resolveWindowMs(params.windowHours);
        const untilMs = Date.now();
        const sinceMs = untilMs - windowMs;
        const result = await adapters.getBrowserDomainActivity(runtime, {
          domain,
          sinceMs,
          untilMs,
        });
        const minutes = formatMinutes(result.totalMs);
        if (result.reportCount === 0) {
          runtime.logger.debug(
            { domain, windowMs },
            "[SCREEN_TIME] time_on_site invoked before any browser activity reports were recorded.",
          );
          return respond({
            success: true,
            scenario: "time_on_site_no_browser_activity",
            fallback:
              "No browser activity reports have been received yet. Connect the LifeOps browser activity source and try again.",
            context: { domain, windowMs },
            data: {
              domain,
              minutes: 0,
              totalMs: 0,
              windowMs,
              noDataReason: "no-browser-activity-yet",
            },
          });
        }
        const fallback =
          result.totalMs > 0
            ? `${domain}: ${minutes}m.`
            : `No browser activity recorded for ${domain} in that window.`;
        return respond({
          success: true,
          scenario: "time_on_site",
          fallback,
          context: { domain, minutes, totalMs: result.totalMs },
          data: {
            domain,
            minutes,
            totalMs: result.totalMs,
            windowMs,
            ...(result.totalMs === 0
              ? { noDataReason: "no-domain-activity" }
              : {}),
          },
        });
      }

      case "browser_activity": {
        const limit =
          typeof params.limit === "number" && params.limit > 0
            ? Math.floor(params.limit)
            : undefined;
        const snapshot = await adapters.getBrowserActivitySnapshot(runtime, {
          deviceId: params.deviceId?.trim(),
          ...(limit === undefined ? {} : { limit }),
        });
        if (snapshot.domains.length === 0) {
          return respond({
            success: true,
            scenario: "browser_activity_empty",
            fallback: "No browser activity has been reported yet.",
            data: { snapshot },
          });
        }
        const lines = snapshot.domains.map(
          (d) =>
            `- ${d.domain}: ${Math.round(d.focusMs / 1000)}s (${d.sessionCount} session${d.sessionCount === 1 ? "" : "s"})`,
        );
        const fallback = `Browser activity (device ${snapshot.deviceId ?? "any"}, window ending ${snapshot.windowEnd}):\n${lines.join("\n")}`;
        return respond({
          success: true,
          scenario: "browser_activity",
          fallback,
          context: {
            deviceId: snapshot.deviceId,
            domainCount: snapshot.domains.length,
          },
          data: { snapshot },
        });
      }
      default: {
        const service = adapters.createService(runtime);
        const windowDays = clampDays(params.windowDays, 1);
        const until = new Date().toISOString();
        const since = daysAgoIso(windowDays);
        const summary = await service.getScreenTimeSummary({
          since,
          until,
          source: params.source,
          identifier: params.identifier,
        });
        const fallback =
          summary.items.length === 0
            ? "No screen time recorded in that window."
            : `Screen time summary (total ${formatSeconds(summary.totalSeconds)}):\n${summary.items
                .map(
                  (item) =>
                    `- ${item.source}: ${item.displayName} — ${formatSeconds(item.totalSeconds)}`,
                )
                .join("\n")}`;
        return respond({
          success: true,
          scenario: "screen_time_summary",
          fallback,
          context: {
            totalSeconds: summary.totalSeconds,
            items: summary.items,
          },
          data: { subaction: "summary", since, until, summary },
        });
      }
    }
  };
}
