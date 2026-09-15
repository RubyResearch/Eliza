/**
 * Restart-safe school-calendar ingestion from a stable district landing page.
 * Discovery and PDF retrieval are DNS-pinned and bounded; canonical bytes are
 * retained through the runtime file store, semantic changes become an immutable
 * approval plan, and only the existing owner calendar mutation gateway applies
 * approved operations.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  DocumentService,
  ElizaError,
  fetchRemoteMedia,
  fetchWithSsrfGuard,
  type IAgentRuntime,
  type IFileStorageService,
  type LookupFn,
  type PinnedLookupFetchLike,
  readResponseWithLimit,
  resolveOwnerEntityIdOrDefault,
  type Service,
  ServiceType,
  stringToUuid,
} from "@elizaos/core";
import { ELIZA_CALENDAR_GRANT_ID } from "@elizaos/plugin-calendar/internal/eliza-calendar";
import type { CalendarOwnerMutationGateway } from "@elizaos/plugin-calendar/routes/mutation-gateway";
import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import {
  beginFamilyWorkspaceOperation,
  settleFamilyWorkspaceOperation,
  withActiveFamilyWorkspaceTransaction,
} from "../family-workflows/workspace-operation-store.js";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonArray,
  parseJsonRecord,
  sqlQuote,
  toText,
} from "../sql.js";

export const CONCORD_SCHOOL_CALENDAR_SOURCE: SchoolCalendarSourceConfig = {
  sourceId: "concord-cps-school-year-calendar",
  packetVisibility: "guest_shareable",
  landingPageUrl:
    "https://www.concordps.org/district-resources/school-year-calendars",
  allowedHosts: ["www.concordps.org", "resources.finalsite.net"],
  pdfHrefPattern: "CPSCCRSD2026-2027SchoolCalendar\\.pdf(?:$|[?#])",
  timeZone: "America/New_York",
  targetGrantId: ELIZA_CALENDAR_GRANT_ID,
  targetCalendarId: "primary",
};

export const SCHOOL_CALENDAR_MONTHLY_CRON = {
  kind: "cron",
  expression: "0 9 1 * *",
  tz: "America/New_York",
} as const;

const MAX_LANDING_BYTES = 512 * 1024;
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const LEASE_MS = 5 * 60_000;
const SCHOOL_CALENDAR_CONTRACT_VERSION = 3;
const SCHOOL_CALENDAR_ALL_DAY_VERSION = 2;

const SCHEMA = [
  `CREATE SCHEMA IF NOT EXISTS app_lifeops`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_sources (
    agent_id TEXT NOT NULL, source_id TEXT NOT NULL, config_json TEXT NOT NULL,
    last_content_sha256 TEXT, last_media_url TEXT, lease_token TEXT,
    lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, source_id)
  )`,
  `ALTER TABLE app_lifeops.life_school_calendar_sources ADD COLUMN IF NOT EXISTS calendar_contract_version INTEGER NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_runs (
    agent_id TEXT NOT NULL, run_id TEXT NOT NULL, source_id TEXT NOT NULL,
    state TEXT NOT NULL, trigger_kind TEXT NOT NULL, discovered_pdf_url TEXT,
    content_sha256 TEXT, media_url TEXT, semantic_sha256 TEXT, plan_json TEXT,
    error_code TEXT, error_message TEXT, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, run_id)
  )`,
  `ALTER TABLE app_lifeops.life_school_calendar_runs ADD COLUMN IF NOT EXISTS apply_lease_token TEXT`,
  `ALTER TABLE app_lifeops.life_school_calendar_runs ADD COLUMN IF NOT EXISTS apply_lease_expires_at TEXT`,
  `CREATE INDEX IF NOT EXISTS life_school_calendar_runs_source_idx
    ON app_lifeops.life_school_calendar_runs (agent_id, source_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_events (
    agent_id TEXT NOT NULL, source_id TEXT NOT NULL, event_key TEXT NOT NULL,
    semantic_json TEXT NOT NULL, provider_event_id TEXT,
    provider_version TEXT, active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TEXT NOT NULL, PRIMARY KEY (agent_id, source_id, event_key)
  )`,
  `CREATE TABLE IF NOT EXISTS app_lifeops.life_school_calendar_apply_operations (
    agent_id TEXT NOT NULL, run_id TEXT NOT NULL, operation_index INTEGER NOT NULL,
    event_key TEXT NOT NULL, kind TEXT NOT NULL, change_json TEXT NOT NULL,
    state TEXT NOT NULL, lease_token TEXT, lease_expires_at TEXT,
    receipt_json TEXT, error_code TEXT, error_message TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, run_id, operation_index),
    UNIQUE (agent_id, run_id, event_key, kind)
  )`,
] as const;

export interface SchoolCalendarSourceConfig {
  /** Allows imported source facts in owner-reviewed family drafts; calendar edits remain private. */
  packetVisibility?: "owner_only" | "guest_shareable";
  sourceId: string;
  landingPageUrl: string;
  allowedHosts: string[];
  pdfHrefPattern: string;
  timeZone: string;
  targetGrantId: string;
  targetCalendarId: string;
  /** Omitted on legacy sources, which included all school levels. */
  schoolLevel?: "all" | "elementary";
  /** Automatic application is an explicit owner-configured standing policy. */
  updateMode?: "review" | "automatic";
}

export interface SchoolCalendarSemanticEvent {
  eventKey: string;
  title: string;
  startDate: string;
  endDateExclusive: string;
  citation?: SchoolCalendarCitation;
}

export interface SchoolCalendarImportedEvent {
  packetVisibility?: "owner_only" | "guest_shareable";
  sourceId: string;
  grantId: string;
  calendarId: string;
  providerEventId: string;
  event: SchoolCalendarSemanticEvent;
}

export interface SchoolCalendarCitation {
  page: number;
  sourceText: string;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface SchoolCalendarPositionedTextItem {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SchoolCalendarExtractedDocument {
  pageCount: number;
  items: SchoolCalendarPositionedTextItem[];
}

export type SchoolCalendarChange =
  | { kind: "add"; event: SchoolCalendarSemanticEvent }
  | {
      kind: "update";
      before: SchoolCalendarSemanticEvent;
      event: SchoolCalendarSemanticEvent;
      providerEventId: string;
      providerVersion: string;
    }
  | {
      kind: "cancel";
      event: SchoolCalendarSemanticEvent;
      providerEventId: string;
      providerVersion: string;
    }
  | { kind: "unchanged"; event: SchoolCalendarSemanticEvent };

export interface SchoolCalendarApprovalPlan {
  version: 1;
  calendarContractVersion: 3;
  sourceId: string;
  runId: string;
  contentSha256: string;
  mediaUrl: string;
  changes: SchoolCalendarChange[];
  sourceConfigSha256?: string;
}

export type SchoolCalendarRunResult =
  | { state: "applied"; runId: string; plan: SchoolCalendarApprovalPlan }
  | {
      state: "unchanged";
      runId: string;
      contentSha256: string;
      mediaUrl: string;
    }
  | {
      state: "awaiting_approval";
      runId: string;
      plan: SchoolCalendarApprovalPlan;
    }
  | { state: "already_running"; runId: null };

export function selectSchoolCalendarEvents(
  events: SchoolCalendarSemanticEvent[],
  level: SchoolCalendarSourceConfig["schoolLevel"],
): SchoolCalendarSemanticEvent[] {
  if (level !== "elementary") return events;
  return events.filter((event) => {
    const title = event.title.replace(/[‐–—]/gu, "-");
    const elementary =
      /\b(elementary|CPS|all schools|district[- ]wide|K\s*-\s*5|pre-?K\s*-\s*12)\b/iu.test(
        title,
      );
    const otherSchool =
      /\b(CCHS|CCRHS|CMS|high school|middle school|pre-?K|preschool|graduation|(?:[6-9]|1[0-2])(?:st|nd|rd|th)?\s+grade|grade\s+(?:[6-9]|1[0-2]))\b/iu.test(
        title,
      );
    return elementary || !otherSchool;
  });
}

export interface SchoolCalendarWorkflowStatus {
  sourceId: string;
  config: SchoolCalendarSourceConfig | null;
  lastRun: {
    runId: string;
    state: string;
    triggerKind: string;
    contentSha256: string | null;
    mediaUrl: string | null;
    updatedAt: string;
  } | null;
}

export interface SchoolCalendarRunReview {
  runId: string;
  state: string;
  triggerKind: string;
  plan: SchoolCalendarApprovalPlan | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SchoolCalendarWorkflowDeps {
  fetchImpl?: FetchLike;
  lookupFn?: LookupFn;
  pinnedFetchImpl?: PinnedLookupFetchLike;
  extractPdfText?: (
    bytes: Buffer,
  ) => Promise<string | SchoolCalendarExtractedDocument>;
  retainPdf?: (bytes: Buffer) => Promise<{ url: string; hash: string }>;
  now?: () => Date;
}

interface PersistedEvent extends SchoolCalendarSemanticEvent {
  providerEventId: string | null;
  providerVersion: string | null;
  active: boolean;
}

export class SchoolCalendarWorkflowError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SchoolCalendarWorkflowError";
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAllowedUrl(
  value: string,
  config: SchoolCalendarSourceConfig,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SchoolCalendarWorkflowError(
      `School calendar URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      "SCHOOL_CALENDAR_URL_INVALID",
    );
  }
  if (
    url.protocol !== "https:" ||
    !config.allowedHosts.includes(url.hostname.toLowerCase())
  ) {
    throw new SchoolCalendarWorkflowError(
      "School calendar URL is outside the configured HTTPS host allowlist.",
      "SCHOOL_CALENDAR_URL_NOT_ALLOWED",
    );
  }
  if (url.username || url.password) {
    throw new SchoolCalendarWorkflowError(
      "School calendar URLs cannot contain credentials.",
      "SCHOOL_CALENDAR_URL_NOT_ALLOWED",
    );
  }
  return url;
}

export function discoverSchoolCalendarPdf(
  html: string,
  finalLandingUrl: string,
  config: SchoolCalendarSourceConfig,
): string {
  const pattern = new RegExp(config.pdfHrefPattern, "i");
  const candidates = [...html.matchAll(/<a\b[^>]*>/giu)]
    .map((match) => match[0])
    .flatMap((anchor) => {
      const href = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(anchor)?.[1];
      const fileName = /\bdata-file-name\s*=\s*["']([^"']+)["']/iu.exec(
        anchor,
      )?.[1];
      if (!href || (!pattern.test(href) && !pattern.test(fileName ?? ""))) {
        return [];
      }
      return [
        assertAllowedUrl(
          new URL(href, finalLandingUrl).toString(),
          config,
        ).toString(),
      ];
    });
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    throw new SchoolCalendarWorkflowError(
      `School calendar landing page resolved ${unique.length} matching PDFs; exactly one is required.`,
      "SCHOOL_CALENDAR_DISCOVERY_AMBIGUOUS",
    );
  }
  return unique[0];
}

function nextDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    throw new SchoolCalendarWorkflowError(
      "School calendar date is invalid.",
      "SCHOOL_CALENDAR_PARSE_INVALID",
    );
  }
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function parseSchoolCalendarText(
  input: string | SchoolCalendarExtractedDocument,
): SchoolCalendarSemanticEvent[] {
  const text = typeof input === "string" ? input : "";
  const candidates: Array<{
    year?: number;
    month: number | null;
    startDay: number;
    endDay: number;
    title: string;
    citation: SchoolCalendarCitation;
  }> = [];
  const schoolYears = (
    typeof input === "string"
      ? input
      : input.items.map((item) => item.text).join(" ")
  ).match(/\b(20\d{2})\s*[-‐–—]\s*(20\d{2})\b/u);
  const firstYear = schoolYears ? Number(schoolYears[1]) : null;
  const secondYear = schoolYears ? Number(schoolYears[2]) : null;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/gu, " ").trim();
    if (!line) continue;
    const match =
      /^(?:(\d{4}-\d{2}-\d{2})\s*[|–—-]\s*(.+)|(.+?)\s*[|–—-]\s*(\d{4}-\d{2}-\d{2}))$/u.exec(
        line,
      );
    if (!match) continue;
    const startDate = match[1] ?? match[4];
    const title = (match[2] ?? match[3] ?? "").trim();
    if (!startDate || !title) continue;
    candidates.push({
      year: Number(startDate.slice(0, 4)),
      month: Number(startDate.slice(5, 7)),
      startDay: Number(startDate.slice(8, 10)),
      endDay: Number(startDate.slice(8, 10)),
      title,
      citation: { page: 1, sourceText: line },
    });
  }

  if (typeof input !== "string") {
    candidates.push(...parsePositionedSchoolCalendar(input.items));
  } else if (schoolYears) {
    candidates.push(...parseLayoutSchoolCalendar(text));
  }

  const events = candidates.map((candidate) => {
    const inferredYear =
      candidate.year ??
      (candidate.month && firstYear && secondYear
        ? candidate.month >= 7
          ? firstYear
          : secondYear
        : null);
    if (!candidate.month || !inferredYear)
      throw new SchoolCalendarWorkflowError(
        `School calendar entry has no unambiguous month/year: ${candidate.citation.sourceText}`,
        "SCHOOL_CALENDAR_PARSE_AMBIGUOUS",
      );
    const lastDay = new Date(
      Date.UTC(inferredYear, candidate.month, 0),
    ).getUTCDate();
    if (
      candidate.startDay < 1 ||
      candidate.startDay > lastDay ||
      candidate.endDay < candidate.startDay ||
      candidate.endDay > lastDay
    )
      throw new SchoolCalendarWorkflowError(
        `School calendar entry has an invalid date (${inferredYear}-${candidate.month}-${candidate.startDay}-${candidate.endDay}): ${candidate.citation.sourceText}`,
        "SCHOOL_CALENDAR_PARSE_AMBIGUOUS",
      );
    const startDate = formatCalendarDate(
      inferredYear,
      candidate.month,
      candidate.startDay,
    );
    const endDate = formatCalendarDate(
      inferredYear,
      candidate.month,
      candidate.endDay,
    );
    return {
      eventKey: "",
      title: candidate.title,
      startDate,
      endDateExclusive: nextDate(endDate),
      citation: candidate.citation,
    };
  });
  if (events.length === 0) {
    throw new SchoolCalendarWorkflowError(
      "School calendar PDF did not contain any recognized dated entries.",
      "SCHOOL_CALENDAR_PARSE_EMPTY",
    );
  }
  const dates = new Map<string, SchoolCalendarSemanticEvent[]>();
  for (const event of events) {
    const group = dates.get(event.startDate) ?? [];
    group.push(event);
    dates.set(event.startDate, group);
  }
  for (const [date, group] of dates) {
    const unique = new Set(group.map((event) => event.title.toLowerCase()));
    if (unique.size !== group.length)
      throw new SchoolCalendarWorkflowError(
        `School calendar repeats the same meaning for ${date}; owner review is required.`,
        "SCHOOL_CALENDAR_PARSE_AMBIGUOUS",
      );
    group.forEach((event, index) => {
      event.eventKey = `school-date:${date}${group.length > 1 ? `:${index + 1}` : ""}`;
    });
  }
  return events.sort((left, right) =>
    left.eventKey.localeCompare(right.eventKey),
  );
}

const MONTHS = new Map([
  ["JANUARY", 1],
  ["FEBRUARY", 2],
  ["MARCH", 3],
  ["APRIL", 4],
  ["MAY", 5],
  ["JUNE", 6],
  ["JULY", 7],
  ["AUGUST", 8],
  ["SEPTEMBER", 9],
  ["SEPT", 9],
  ["OCTOBER", 10],
  ["NOVEMBER", 11],
  ["DECEMBER", 12],
] as const);

function formatCalendarDate(year: number, month: number, day: number): string {
  const value = new Date(Date.UTC(year, month - 1, day));
  if (
    value.getUTCFullYear() !== year ||
    value.getUTCMonth() !== month - 1 ||
    value.getUTCDate() !== day
  )
    throw new SchoolCalendarWorkflowError(
      `School calendar date ${year}-${month}-${day} is invalid.`,
      "SCHOOL_CALENDAR_PARSE_INVALID",
    );
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDatedEntry(
  value: string,
  inheritedMonth: number | null,
  citation: SchoolCalendarCitation,
) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const match =
    /^(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+)?(\d{1,2})(?:\s*(?:-|‐|–|—|&)\s*(\d{1,2}))?\s+(.+)$/iu.exec(
      normalized,
    );
  if (!match) return null;
  const explicit = match[1]
    ? (MONTHS.get(match[1].toUpperCase().replace(/^SEP$/u, "SEPT") as never) ??
      monthFromPrefix(match[1]))
    : null;
  const title = match[4]?.trim() ?? "";
  if (!/[A-Za-z]/u.test(title) || /^includes\b/iu.test(title)) return null;
  return {
    month: explicit ?? inheritedMonth,
    startDay: Number(match[2]),
    endDay: Number(match[3] ?? match[2]),
    title,
    citation: { ...citation, sourceText: normalized },
  };
}

function monthFromPrefix(value: string): number | null {
  const prefix = value.slice(0, 3).toUpperCase();
  if (prefix.length < 3) return null;
  for (const [name, month] of MONTHS) if (name.startsWith(prefix)) return month;
  return null;
}

function parseLayoutSchoolCalendar(text: string) {
  const result: ReturnType<typeof parseDatedEntry>[] = [];
  let leftMonth: number | null = null;
  let rightMonth: number | null = null;
  let lastLeft: NonNullable<ReturnType<typeof parseDatedEntry>> | null = null;
  for (const [lineIndex, line] of text.split(/\r?\n/u).entries()) {
    const headings = [
      ...line.matchAll(
        /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST(?:\/SEPTEMBER)?|OCTOBER|NOVEMBER|DECEMBER)\b/gu,
      ),
    ];
    if (headings.length >= 2) {
      leftMonth = monthFromPrefix(headings[0]?.[1] ?? "");
      rightMonth = monthFromPrefix(headings.at(-1)?.[1] ?? "");
    }
    const left = line.slice(22, 58);
    const right = line.slice(80);
    const leftEntry = parseDatedEntry(left, leftMonth, {
      page: 1,
      sourceText: left,
      bounds: { x: 22, y: lineIndex, width: 39, height: 1 },
    });
    const rightEntry = parseDatedEntry(right, rightMonth, {
      page: 1,
      sourceText: right,
      bounds: { x: 80, y: lineIndex, width: right.length, height: 1 },
    });
    if (leftEntry) {
      result.push(leftEntry);
      lastLeft = leftEntry;
    }
    if (rightEntry) result.push(rightEntry);
    if (!leftEntry && lastLeft) {
      const continuation = left.trim();
      if (/^[A-Za-z][A-Za-z' /.-]*$/u.test(continuation))
        lastLeft.title += ` ${continuation}`;
    }
  }
  return result.filter((entry) => entry !== null);
}

function parsePositionedSchoolCalendar(
  items: readonly SchoolCalendarPositionedTextItem[],
) {
  const ordered = [...items].sort(
    (left, right) =>
      left.page - right.page || right.y - left.y || left.x - right.x,
  );
  const monthHeadings = ordered.flatMap((item) => {
    const month = monthFromPrefix(item.text.trim());
    return month && /^[A-Z]+(?:\/[A-Z]+)?$/u.test(item.text.trim())
      ? [{ ...item, month }]
      : [];
  });
  const eventHeadings = monthHeadings.filter((heading) => {
    const peers = monthHeadings
      .filter(
        (candidate) =>
          candidate.page === heading.page &&
          Math.abs(candidate.y - heading.y) < 1,
      )
      .sort((left, right) => left.x - right.x);
    return peers.indexOf(heading) % 2 === 1;
  });
  const result: NonNullable<ReturnType<typeof parseDatedEntry>>[] = [];
  const lastByColumn = new Map<
    string,
    NonNullable<ReturnType<typeof parseDatedEntry>>
  >();
  for (const item of ordered) {
    const heading = eventHeadings
      .filter(
        (candidate) =>
          candidate.page === item.page &&
          candidate.y >= item.y &&
          Math.abs(candidate.x - item.x) < 90,
      )
      .sort(
        (left, right) =>
          left.y - right.y ||
          Math.abs(left.x - item.x) - Math.abs(right.x - item.x),
      )[0];
    if (!heading) continue;
    const columnKey = `${heading.page}:${heading.x}:${heading.y}`;
    const parsed = parseDatedEntry(item.text, heading?.month ?? null, {
      page: item.page,
      sourceText: item.text,
      bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
    });
    if (parsed) {
      result.push(parsed);
      lastByColumn.set(columnKey, parsed);
      continue;
    }
    const previous = lastByColumn.get(columnKey);
    const previousBounds = previous?.citation.bounds;
    const continuation = item.text.replace(/\s+/gu, " ").trim();
    if (
      previous &&
      previousBounds &&
      previousBounds.y > item.y &&
      previousBounds.y - item.y <= 14 &&
      item.x >= previousBounds.x &&
      item.x - previousBounds.x < 80 &&
      /^[A-Za-z][A-Za-z' /.-]*$/u.test(continuation)
    ) {
      previous.title += ` ${continuation}`;
      previous.citation.sourceText += ` ${continuation}`;
    }
  }
  return result;
}

export function diffSchoolCalendarEvents(
  previous: readonly PersistedEvent[],
  current: readonly SchoolCalendarSemanticEvent[],
  options: { migrateToAllDay?: boolean } = {},
): SchoolCalendarChange[] {
  const oldByKey = new Map(
    previous
      .filter((event) => event.active)
      .map((event) => [event.eventKey, event]),
  );
  const newByKey = new Map(current.map((event) => [event.eventKey, event]));
  const keys = [...new Set([...oldByKey.keys(), ...newByKey.keys()])].sort();
  return keys.map((key) => {
    const before = oldByKey.get(key);
    const event = newByKey.get(key);
    if (!before && event) return { kind: "add", event };
    if (before && !event) {
      if (!before.providerEventId || !before.providerVersion) {
        throw new SchoolCalendarWorkflowError(
          `Cannot cancel ${key} without its provider identity and version.`,
          "SCHOOL_CALENDAR_PROVIDER_IDENTITY_MISSING",
        );
      }
      return {
        kind: "cancel",
        event: before,
        providerEventId: before.providerEventId,
        providerVersion: before.providerVersion,
      };
    }
    if (!before || !event)
      throw new Error("School calendar diff invariant failed");
    if (
      canonicalJson({
        title: before.title,
        startDate: before.startDate,
        endDateExclusive: before.endDateExclusive,
      }) ===
      canonicalJson({
        title: event.title,
        startDate: event.startDate,
        endDateExclusive: event.endDateExclusive,
      })
    ) {
      if (options.migrateToAllDay) {
        if (!before.providerEventId || !before.providerVersion) {
          throw new SchoolCalendarWorkflowError(
            `Cannot migrate ${key} to all-day without its provider identity and version.`,
            "SCHOOL_CALENDAR_PROVIDER_IDENTITY_MISSING",
          );
        }
        return {
          kind: "update",
          before,
          event,
          providerEventId: before.providerEventId,
          providerVersion: before.providerVersion,
        };
      }
      return { kind: "unchanged", event };
    }
    if (!before.providerEventId || !before.providerVersion) {
      throw new SchoolCalendarWorkflowError(
        `Cannot update ${key} without its provider identity and version.`,
        "SCHOOL_CALENDAR_PROVIDER_IDENTITY_MISSING",
      );
    }
    return {
      kind: "update",
      before,
      event,
      providerEventId: before.providerEventId,
      providerVersion: before.providerVersion,
    };
  });
}

export class SchoolCalendarWorkflow {
  private readonly now: () => Date;

  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly deps: SchoolCalendarWorkflowDeps = {},
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {
    for (const statement of SCHEMA)
      await executeRawSql(this.runtime, statement);
  }

  async configure(
    config: SchoolCalendarSourceConfig,
  ): Promise<SchoolCalendarWorkflowStatus> {
    await this.ensureSchema();
    assertAllowedUrl(config.landingPageUrl, config);
    const at = this.now().toISOString();
    const configured = await withActiveFamilyWorkspaceTransaction(
      this.runtime,
      [
        "app_lifeops.life_school_calendar_sources",
        "app_lifeops.life_school_calendar_runs",
      ],
      (tx) =>
        executeRawSqlTx(
          tx,
          `INSERT INTO app_lifeops.life_school_calendar_sources (agent_id, source_id, config_json, created_at, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(config.sourceId)}, ${sqlQuote(canonicalJson(config))}, ${sqlQuote(at)}, ${sqlQuote(at)}) ON CONFLICT (agent_id, source_id) DO UPDATE SET last_content_sha256 = CASE WHEN life_school_calendar_sources.config_json <> EXCLUDED.config_json THEN NULL ELSE life_school_calendar_sources.last_content_sha256 END, config_json = EXCLUDED.config_json, updated_at = EXCLUDED.updated_at
      WHERE (life_school_calendar_sources.lease_token IS NULL OR life_school_calendar_sources.lease_expires_at < ${sqlQuote(at)})
        AND NOT EXISTS (SELECT 1 FROM app_lifeops.life_school_calendar_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND source_id=${sqlQuote(config.sourceId)} AND state='applying' AND apply_lease_expires_at >= ${sqlQuote(at)})
      RETURNING source_id`,
        ),
    );
    if (!configured.length)
      throw new SchoolCalendarWorkflowError(
        "School calendar work is running. Wait for it to finish before changing settings.",
        "SCHOOL_CALENDAR_CONFIG_BUSY",
      );
    return this.status(config.sourceId);
  }

  async status(
    sourceId = CONCORD_SCHOOL_CALENDAR_SOURCE.sourceId,
  ): Promise<SchoolCalendarWorkflowStatus> {
    await this.ensureSchema();
    const sources = await executeRawSql(
      this.runtime,
      `SELECT config_json FROM app_lifeops.life_school_calendar_sources WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND source_id=${sqlQuote(sourceId)} LIMIT 1`,
    );
    const runs = await executeRawSql(
      this.runtime,
      `SELECT run_id,state,trigger_kind,content_sha256,media_url,updated_at FROM app_lifeops.life_school_calendar_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND source_id=${sqlQuote(sourceId)} ORDER BY created_at DESC LIMIT 1`,
    );
    const run = runs[0];
    return {
      sourceId,
      config: sources[0]
        ? (parseJsonRecord(
            sources[0].config_json,
          ) as unknown as SchoolCalendarSourceConfig)
        : null,
      lastRun: run
        ? {
            runId: toText(run.run_id),
            state: toText(run.state),
            triggerKind: toText(run.trigger_kind),
            contentSha256: run.content_sha256
              ? toText(run.content_sha256)
              : null,
            mediaUrl: run.media_url ? toText(run.media_url) : null,
            updatedAt: toText(run.updated_at),
          }
        : null,
    };
  }

  async listImportedEvents(): Promise<SchoolCalendarImportedEvent[]> {
    await this.ensureSchema();
    const sources = await executeRawSql(
      this.runtime,
      `SELECT source_id, config_json FROM app_lifeops.life_school_calendar_sources WHERE agent_id=${sqlQuote(this.runtime.agentId)}`,
    );
    const result: SchoolCalendarImportedEvent[] = [];
    for (const source of sources) {
      const sourceId = toText(source.source_id);
      const config = parseJsonRecord(
        source.config_json,
      ) as unknown as SchoolCalendarSourceConfig;
      for (const event of await this.events(sourceId)) {
        if (!event.active || !event.providerEventId) continue;
        result.push({
          sourceId,
          packetVisibility:
            config.packetVisibility === "guest_shareable"
              ? "guest_shareable"
              : "owner_only",
          grantId: config.targetGrantId,
          calendarId: config.targetCalendarId,
          providerEventId: event.providerEventId,
          event,
        });
      }
    }
    return result;
  }

  async review(runId: string): Promise<SchoolCalendarRunReview | null> {
    await this.ensureSchema();
    const rows = await executeRawSql(
      this.runtime,
      `SELECT run_id,state,trigger_kind,plan_json,error_code,error_message,updated_at FROM app_lifeops.life_school_calendar_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(runId)} LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      runId: toText(row.run_id),
      state: toText(row.state),
      triggerKind: toText(row.trigger_kind),
      plan: row.plan_json
        ? parseApprovalPlan(parseJsonRecord(row.plan_json))
        : null,
      errorCode: row.error_code ? toText(row.error_code) : null,
      errorMessage: row.error_message ? toText(row.error_message) : null,
      updatedAt: toText(row.updated_at),
    };
  }

  async run(
    config: SchoolCalendarSourceConfig = CONCORD_SCHOOL_CALENDAR_SOURCE,
    triggerKind: "manual" | "scheduled" = "manual",
  ): Promise<SchoolCalendarRunResult> {
    assertAllowedUrl(config.landingPageUrl, config);
    const runId = randomUUID();
    const operationId = await beginFamilyWorkspaceOperation(this.runtime, {
      kind: "school-calendar-work",
      sourceId: config.sourceId,
      runId,
      phase: "ingest",
    });
    const result = await this.runAdmitted(
      config,
      triggerKind,
      runId,
      operationId,
    );
    await settleFamilyWorkspaceOperation(this.runtime, operationId);
    return result;
  }

  private async runAdmitted(
    config: SchoolCalendarSourceConfig,
    triggerKind: "manual" | "scheduled",
    runId: string,
    operationId: string,
  ): Promise<SchoolCalendarRunResult> {
    await this.ensureSchema();
    assertAllowedUrl(config.landingPageUrl, config);
    const leaseToken = randomUUID();
    const now = this.now();
    const acquired = await this.acquire(config, leaseToken, now);
    if (!acquired) return { state: "already_running", runId: null };
    await this.insertRun(runId, config.sourceId, triggerKind, now);
    let retentionUncertain = false;
    try {
      if (!this.deps.retainPdf) await this.retainRecordedSources();
      const { pdfUrl, bytes } = await this.retrieve(config);
      const contentSha256 = sha256(bytes);
      // Persist the canonical identity before storage can lose its acknowledgement.
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_school_calendar_runs SET content_sha256=${sqlQuote(contentSha256)},media_url=${sqlQuote(`/api/media/${contentSha256}.pdf`)},discovered_pdf_url=${sqlQuote(pdfUrl)} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(runId)}`,
      );
      retentionUncertain = true;
      const retained = await this.retain(bytes);
      if (
        retained.hash !== contentSha256 ||
        retained.url !== `/api/media/${contentSha256}.pdf`
      ) {
        throw new SchoolCalendarWorkflowError(
          "Canonical media store returned a mismatched content hash.",
          "SCHOOL_CALENDAR_MEDIA_HASH_MISMATCH",
        );
      }
      retentionUncertain = false;
      const source = await this.source(config.sourceId);
      if (
        source.lastContentSha256 === contentSha256 &&
        source.calendarContractVersion >= SCHOOL_CALENDAR_CONTRACT_VERSION
      ) {
        await this.completeNoop(
          runId,
          config.sourceId,
          pdfUrl,
          contentSha256,
          retained.url,
          leaseToken,
        );
        return {
          state: "unchanged",
          runId,
          contentSha256,
          mediaUrl: retained.url,
        };
      }
      const text = await this.extract(bytes);
      const current = selectSchoolCalendarEvents(
        parseSchoolCalendarText(text),
        config.schoolLevel,
      );
      if (current.length === 0) {
        throw new SchoolCalendarWorkflowError(
          "No calendar entries match the configured school level; existing events were preserved.",
          "SCHOOL_CALENDAR_SELECTION_EMPTY",
        );
      }
      const previous = await this.events(config.sourceId);
      const changes = diffSchoolCalendarEvents(previous, current, {
        migrateToAllDay:
          source.calendarContractVersion < SCHOOL_CALENDAR_ALL_DAY_VERSION,
      });
      if (changes.every((change) => change.kind === "unchanged")) {
        await this.completeNoop(
          runId,
          config.sourceId,
          pdfUrl,
          contentSha256,
          retained.url,
          leaseToken,
        );
        return {
          state: "unchanged",
          runId,
          contentSha256,
          mediaUrl: retained.url,
        };
      }
      const plan: SchoolCalendarApprovalPlan = {
        version: 1,
        calendarContractVersion: SCHOOL_CALENDAR_CONTRACT_VERSION,
        sourceId: config.sourceId,
        runId,
        contentSha256,
        mediaUrl: retained.url,
        changes,
        sourceConfigSha256: sha256(Buffer.from(canonicalJson(config))),
      };
      await this.awaitApproval(
        runId,
        config.sourceId,
        pdfUrl,
        plan,
        leaseToken,
      );
      return { state: "awaiting_approval", runId, plan };
    } catch (error) {
      // error-policy:J2 Preserve the failure after its terminal run record is acknowledged.
      await this.failRun(runId, config.sourceId, leaseToken, error);
      if (!retentionUncertain)
        await settleFamilyWorkspaceOperation(this.runtime, operationId);
      throw error;
    }
  }

  async applyApprovedPlan(args: {
    runId: string;
    requestUrl: URL;
    gateway: CalendarOwnerMutationGateway;
    config?: SchoolCalendarSourceConfig;
  }): Promise<void> {
    const operationId = await beginFamilyWorkspaceOperation(this.runtime, {
      kind: "school-calendar-work",
      sourceId: (args.config ?? CONCORD_SCHOOL_CALENDAR_SOURCE).sourceId,
      runId: args.runId,
      phase: "apply",
    });
    await this.applyAdmitted(args, operationId);
    await settleFamilyWorkspaceOperation(this.runtime, operationId);
  }

  private async applyAdmitted(
    args: {
      runId: string;
      requestUrl: URL;
      gateway: CalendarOwnerMutationGateway;
      config?: SchoolCalendarSourceConfig;
    },
    operationId: string,
  ): Promise<void> {
    await this.ensureSchema();
    const config = args.config ?? CONCORD_SCHOOL_CALENDAR_SOURCE;
    const applyToken = randomUUID();
    const startedAt = this.now();
    const at = startedAt.toISOString();
    const expiresAt = new Date(startedAt.getTime() + LEASE_MS).toISOString();
    const claimed = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs
       SET state='applying', apply_lease_token=${sqlQuote(applyToken)},
           apply_lease_expires_at=${sqlQuote(expiresAt)}, updated_at=${sqlQuote(at)}
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)}
         AND (state='awaiting_approval' OR
              (state='applying' AND apply_lease_expires_at < ${sqlQuote(at)}))
       RETURNING *`,
    );
    const row = claimed[0];
    if (!row) {
      const existing = await executeRawSql(
        this.runtime,
        `SELECT state FROM app_lifeops.life_school_calendar_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)} LIMIT 1`,
      );
      const state = toText(existing[0]?.state);
      if (state === "applied") return;
      await settleFamilyWorkspaceOperation(this.runtime, operationId);
      throw new SchoolCalendarWorkflowError(
        state === "applying"
          ? "School calendar plan is already being applied."
          : "School calendar run is not awaiting approval.",
        state === "applying"
          ? "SCHOOL_CALENDAR_APPLY_IN_PROGRESS"
          : "SCHOOL_CALENDAR_RUN_NOT_APPLICABLE",
      );
    }
    let effectUncertain = false;
    try {
      const plan = parseApprovalPlan(parseJsonRecord(row.plan_json));
      const configured = (await this.status(config.sourceId)).config;
      if (
        plan.sourceId !== config.sourceId ||
        !configured ||
        canonicalJson(configured) !== canonicalJson(config) ||
        (plan.sourceConfigSha256 &&
          plan.sourceConfigSha256 !==
            sha256(Buffer.from(canonicalJson(config))))
      ) {
        throw new SchoolCalendarWorkflowError(
          "School source settings changed after this plan was prepared. Run the workflow again.",
          "SCHOOL_CALENDAR_CONFIG_CHANGED",
        );
      }
      const actionable = plan.changes.filter(
        (change) => change.kind !== "unchanged",
      );
      for (const [index, change] of actionable.entries()) {
        await executeRawSql(
          this.runtime,
          `INSERT INTO app_lifeops.life_school_calendar_apply_operations
         (agent_id,run_id,operation_index,event_key,kind,change_json,state,created_at,updated_at)
         VALUES (${sqlQuote(this.runtime.agentId)},${sqlQuote(args.runId)},${index},
           ${sqlQuote(change.event.eventKey)},${sqlQuote(change.kind)},${sqlQuote(canonicalJson(change))},
           'pending',${sqlQuote(at)},${sqlQuote(at)})
         ON CONFLICT (agent_id,run_id,operation_index) DO NOTHING`,
        );
      }
      for (const [index, change] of actionable.entries()) {
        const operationNow = this.now();
        const operationAt = operationNow.toISOString();
        const operationExpiresAt = new Date(
          operationNow.getTime() + LEASE_MS,
        ).toISOString();
        await executeRawSql(
          this.runtime,
          `UPDATE app_lifeops.life_school_calendar_runs SET
         apply_lease_expires_at=${sqlQuote(operationExpiresAt)},updated_at=${sqlQuote(operationAt)}
         WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)}
           AND state='applying' AND apply_lease_token=${sqlQuote(applyToken)}`,
        );
        const operation = await executeRawSql(
          this.runtime,
          `UPDATE app_lifeops.life_school_calendar_apply_operations SET
         state='executing',lease_token=${sqlQuote(applyToken)},
         lease_expires_at=${sqlQuote(operationExpiresAt)},updated_at=${sqlQuote(operationAt)}
         WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)}
           AND operation_index=${index}
           AND (state='pending' OR (state='executing' AND lease_expires_at < ${sqlQuote(operationAt)}))
         RETURNING operation_index`,
        );
        if (operation.length === 0) {
          const persisted = await executeRawSql(
            this.runtime,
            `SELECT state FROM app_lifeops.life_school_calendar_apply_operations
           WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)}
             AND operation_index=${index} LIMIT 1`,
          );
          if (toText(persisted[0]?.state) === "applied") continue;
          throw new SchoolCalendarWorkflowError(
            "A school calendar operation is already executing.",
            "SCHOOL_CALENDAR_APPLY_IN_PROGRESS",
          );
        }
        effectUncertain = true;
        if (change.kind === "add") {
          const result = await args.gateway.create(args.requestUrl, {
            grantId: config.targetGrantId,
            calendarId: config.targetCalendarId,
            title: change.event.title,
            allDay: {
              startDate: change.event.startDate,
              endDateExclusive: change.event.endDateExclusive,
            },
            timeZone: config.timeZone,
            notifyAttendees: false,
            idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
          });
          if (result.outcome !== "event" || !result.event) {
            throw new SchoolCalendarWorkflowError(
              "School event create did not return a readable event.",
              "SCHOOL_CALENDAR_CREATE_READBACK_REQUIRED",
            );
          }
          await this.upsertEvent(config.sourceId, change.event, result.event);
          await this.completeApplyOperation(
            args.runId,
            index,
            applyToken,
            result,
          );
        } else if (change.kind === "update") {
          const event = await args.gateway.update(args.requestUrl, {
            grantId: config.targetGrantId,
            calendarId: config.targetCalendarId,
            eventId: change.providerEventId,
            title: change.event.title,
            allDay: {
              startDate: change.event.startDate,
              endDateExclusive: change.event.endDateExclusive,
            },
            timeZone: config.timeZone,
            expectedProviderVersion: change.providerVersion,
            idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
          });
          await this.upsertEvent(config.sourceId, change.event, event);
          await this.completeApplyOperation(
            args.runId,
            index,
            applyToken,
            event,
          );
        } else {
          const result = await args.gateway.cancel(args.requestUrl, {
            grantId: config.targetGrantId,
            calendarId: config.targetCalendarId,
            eventId: change.providerEventId,
            notifyAttendees: false,
            expectedProviderVersion: change.providerVersion,
            cancellationMode: "organizer_cancel",
            idempotencyKey: `${config.sourceId}:${change.event.eventKey}:${plan.contentSha256}`,
          });
          await executeRawSql(
            this.runtime,
            `UPDATE app_lifeops.life_school_calendar_events SET active = FALSE, updated_at = ${sqlQuote(this.now().toISOString())} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(config.sourceId)} AND event_key = ${sqlQuote(change.event.eventKey)}`,
          );
          await this.completeApplyOperation(
            args.runId,
            index,
            applyToken,
            result,
          );
        }
        effectUncertain = false;
      }
      const completedAt = this.now().toISOString();
      const completed = await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_school_calendar_runs SET state='applied',
       apply_lease_token=NULL,apply_lease_expires_at=NULL,
       error_code=NULL,error_message=NULL,updated_at=${sqlQuote(completedAt)}
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(args.runId)}
         AND state='applying' AND apply_lease_token=${sqlQuote(applyToken)}
         AND NOT EXISTS (
           SELECT 1 FROM app_lifeops.life_school_calendar_apply_operations op
           WHERE op.agent_id=${sqlQuote(this.runtime.agentId)} AND op.run_id=${sqlQuote(args.runId)}
             AND op.state <> 'applied'
         ) RETURNING run_id`,
      );
      if (completed.length !== 1)
        throw new SchoolCalendarWorkflowError(
          "School calendar apply ownership was lost before completion.",
          "SCHOOL_CALENDAR_APPLY_LEASE_LOST",
        );
      await executeRawSql(
        this.runtime,
        `UPDATE app_lifeops.life_school_calendar_sources SET last_content_sha256=${sqlQuote(plan.contentSha256)},last_media_url=${sqlQuote(plan.mediaUrl)},calendar_contract_version=${SCHOOL_CALENDAR_CONTRACT_VERSION},updated_at=${sqlQuote(completedAt)} WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND source_id=${sqlQuote(config.sourceId)}`,
      );
    } catch (error) {
      // error-policy:J2 Restore the exact owned apply leases, then rethrow a
      // typed failure with the provider or persistence error preserved.
      await this.releaseApplyForRetry(args.runId, applyToken, error);
      if (!effectUncertain)
        await settleFamilyWorkspaceOperation(this.runtime, operationId);
      const code =
        error instanceof SchoolCalendarWorkflowError
          ? error.code
          : "SCHOOL_CALENDAR_APPLY_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      throw new SchoolCalendarWorkflowError(
        `School calendar apply failed: ${message}`,
        code,
        { cause: error },
      );
    }
  }

  private async releaseApplyForRetry(
    runId: string,
    applyToken: string,
    error: unknown,
  ): Promise<void> {
    const at = this.now().toISOString();
    const code =
      error instanceof SchoolCalendarWorkflowError ||
      error instanceof ElizaError
        ? error.code
        : "SCHOOL_CALENDAR_APPLY_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    await executeRawSql(
      this.runtime,
      `WITH reset_operations AS (
       UPDATE app_lifeops.life_school_calendar_apply_operations SET
         state='pending',lease_token=NULL,lease_expires_at=NULL,
         error_code=${sqlQuote(code)},error_message=${sqlQuote(message)},updated_at=${sqlQuote(at)}
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(runId)}
         AND state='executing' AND lease_token=${sqlQuote(applyToken)}
       RETURNING operation_index
       )
       UPDATE app_lifeops.life_school_calendar_runs SET
       state='awaiting_approval',apply_lease_token=NULL,apply_lease_expires_at=NULL,
       error_code=${sqlQuote(code)},error_message=${sqlQuote(message)},updated_at=${sqlQuote(at)}
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(runId)}
         AND state='applying' AND apply_lease_token=${sqlQuote(applyToken)}`,
    );
  }

  private async completeApplyOperation(
    runId: string,
    operationIndex: number,
    applyToken: string,
    receipt: unknown,
  ): Promise<void> {
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_apply_operations SET
       state='applied',receipt_json=${sqlQuote(canonicalJson(receipt))},
       lease_token=NULL,lease_expires_at=NULL,error_code=NULL,error_message=NULL,
       updated_at=${sqlQuote(this.now().toISOString())}
       WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND run_id=${sqlQuote(runId)}
         AND operation_index=${operationIndex} AND state='executing'
         AND lease_token=${sqlQuote(applyToken)} RETURNING operation_index`,
    );
    if (rows.length !== 1)
      throw new SchoolCalendarWorkflowError(
        "School calendar operation ownership was lost before receipt persistence.",
        "SCHOOL_CALENDAR_APPLY_LEASE_LOST",
      );
  }

  private async retrieve(
    config: SchoolCalendarSourceConfig,
  ): Promise<{ pdfUrl: string; bytes: Buffer }> {
    const guarded = await fetchWithSsrfGuard({
      url: config.landingPageUrl,
      fetchImpl: this.deps.fetchImpl,
      lookupFn: this.deps.lookupFn,
      pinnedFetchImpl: this.deps.pinnedFetchImpl,
      maxRedirects: 3,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    try {
      assertAllowedUrl(guarded.finalUrl, config);
      if (
        !guarded.response.ok ||
        !guarded.response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("text/html")
      ) {
        throw new SchoolCalendarWorkflowError(
          "School calendar landing page did not return HTML.",
          "SCHOOL_CALENDAR_LANDING_INVALID",
        );
      }
      const html = (
        await readResponseWithLimit(guarded.response, MAX_LANDING_BYTES)
      ).toString("utf8");
      const pdfUrl = discoverSchoolCalendarPdf(html, guarded.finalUrl, config);
      const pdf = await fetchRemoteMedia({
        url: pdfUrl,
        fetchImpl: this.deps.fetchImpl,
        lookupFn: this.deps.lookupFn,
        pinnedFetchImpl: this.deps.pinnedFetchImpl,
        maxBytes: MAX_PDF_BYTES,
        maxRedirects: 3,
        timeoutMs: FETCH_TIMEOUT_MS,
        requiredContentTypePrefix: "application/pdf",
        rejectContentEncoding: true,
      });
      if (!pdf.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new SchoolCalendarWorkflowError(
          "School calendar response has no PDF signature.",
          "SCHOOL_CALENDAR_PDF_SIGNATURE_INVALID",
        );
      }
      return { pdfUrl, bytes: pdf.buffer };
    } finally {
      await guarded.release();
    }
  }

  private async retain(bytes: Buffer): Promise<{ url: string; hash: string }> {
    if (this.deps.retainPdf) return this.deps.retainPdf(bytes);
    const files = this.runtime.getService<IFileStorageService>(
      ServiceType.REMOTE_FILES,
    );
    if (!files)
      throw new SchoolCalendarWorkflowError(
        "Canonical file storage service is unavailable.",
        "SCHOOL_CALENDAR_FILE_STORE_UNAVAILABLE",
      );
    const stored = await files.store(bytes, "application/pdf");
    if (
      stored.hash !== sha256(bytes) ||
      stored.url !== `/api/media/${stored.hash}.pdf`
    )
      throw new ElizaError(
        "Canonical media storage returned an invalid school PDF reference.",
        { code: "SCHOOL_CALENDAR_MEDIA_HASH_MISMATCH" },
      );
    await this.retainSourceReference(stored.url, stored.hash);
    return { url: stored.url, hash: stored.hash };
  }

  /** Preserve historical source references in the canonical document store. */
  async retainRecordedSources(): Promise<void> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT DISTINCT content_sha256,media_url FROM app_lifeops.life_school_calendar_runs WHERE agent_id=${sqlQuote(this.runtime.agentId)} AND content_sha256 IS NOT NULL`,
    );
    for (const row of rows) {
      const digest = toText(row.content_sha256);
      const url = toText(row.media_url);
      if (!/^[a-f0-9]{64}$/.test(digest) || url !== `/api/media/${digest}.pdf`)
        throw new ElizaError(
          "A retained school source has an invalid hash or media reference.",
          { code: "SCHOOL_CALENDAR_SOURCE_INTEGRITY" },
        );
      const files = this.runtime.getService<IFileStorageService>(
        ServiceType.REMOTE_FILES,
      );
      if (!files)
        throw new ElizaError(
          "Canonical file storage is unavailable; restore it before checking school sources.",
          { code: "SCHOOL_CALENDAR_FILE_STORE_UNAVAILABLE" },
        );
      const bytes = await files.read(`${digest}.pdf`);
      if (!bytes || sha256(bytes) !== digest)
        throw new ElizaError(
          "A historical school PDF is missing or changed; recover its original bytes before continuing.",
          { code: "SCHOOL_CALENDAR_SOURCE_INTEGRITY" },
        );
      await this.retainSourceReference(url, digest);
    }
  }

  private async retainSourceReference(
    url: string,
    digest: string,
  ): Promise<void> {
    const documents = this.runtime.getService<DocumentService>(
      DocumentService.serviceType,
    );
    if (!documents)
      throw new ElizaError(
        "The document service is unavailable; school source retention could not be recorded.",
        { code: "SCHOOL_CALENDAR_DOCUMENT_STORE_UNAVAILABLE" },
      );
    const owner = resolveOwnerEntityIdOrDefault(this.runtime);
    // This is an explicit source-link record, not a replacement transcription.
    // Original PDF bytes remain in the canonical media store; metadata.mediaUrl
    // makes their durable document reference visible to its existing collector.
    await documents.addDocument({
      agentId: this.runtime.agentId,
      worldId: this.runtime.agentId,
      roomId: this.runtime.agentId,
      entityId: this.runtime.agentId,
      clientDocumentId: stringToUuid(
        `school-source:${this.runtime.agentId}:${digest}`,
      ),
      contentType: "text/plain",
      originalFilename: "School calendar source.txt",
      content: `Original school calendar PDF reference\n${url}\nSHA-256: ${digest}`,
      metadata: {
        title: "School calendar source",
        source: "school-calendar",
        mediaUrl: url,
        contentSha256: digest,
      },
      scope: "owner-private",
      scopedToEntityId: owner,
      addedBy: owner,
      addedByRole: "OWNER",
      addedFrom: "lifeops",
    });
  }

  private async extract(
    bytes: Buffer,
  ): Promise<string | SchoolCalendarExtractedDocument> {
    if (this.deps.extractPdfText) return this.deps.extractPdfText(bytes);
    const pdf = this.runtime.getService<
      Service & {
        convertPdfToPositionedText?(
          input: Buffer,
        ): Promise<SchoolCalendarExtractedDocument>;
        convertPdfToText(input: Buffer): Promise<string>;
      }
    >(ServiceType.PDF);
    if (!pdf)
      throw new SchoolCalendarWorkflowError(
        "PDF extraction service is unavailable.",
        "SCHOOL_CALENDAR_PDF_SERVICE_UNAVAILABLE",
      );
    if (pdf.convertPdfToPositionedText)
      return pdf.convertPdfToPositionedText(bytes);
    return pdf.convertPdfToText(bytes);
  }

  private async acquire(
    config: SchoolCalendarSourceConfig,
    token: string,
    now: Date,
  ): Promise<boolean> {
    const at = now.toISOString();
    const expires = new Date(now.getTime() + LEASE_MS).toISOString();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_sources (agent_id, source_id, config_json, created_at, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(config.sourceId)}, ${sqlQuote(canonicalJson(config))}, ${sqlQuote(at)}, ${sqlQuote(at)}) ON CONFLICT (agent_id, source_id) DO NOTHING`,
    );
    const rows = await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET lease_token = ${sqlQuote(token)}, lease_expires_at = ${sqlQuote(expires)}, last_content_sha256 = CASE WHEN config_json <> ${sqlQuote(canonicalJson(config))} THEN NULL ELSE last_content_sha256 END, config_json = ${sqlQuote(canonicalJson(config))}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(config.sourceId)} AND (lease_token IS NULL OR lease_expires_at < ${sqlQuote(at)}) RETURNING source_id`,
    );
    return rows.length === 1;
  }

  private async insertRun(
    runId: string,
    sourceId: string,
    triggerKind: string,
    now: Date,
  ): Promise<void> {
    const at = now.toISOString();
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_runs (agent_id, run_id, source_id, state, trigger_kind, created_at, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(runId)}, ${sqlQuote(sourceId)}, 'running', ${sqlQuote(triggerKind)}, ${sqlQuote(at)}, ${sqlQuote(at)})`,
    );
  }

  private async source(sourceId: string): Promise<{
    lastContentSha256: string | null;
    calendarContractVersion: number;
  }> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT last_content_sha256, calendar_contract_version FROM app_lifeops.life_school_calendar_sources WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)} LIMIT 1`,
    );
    return {
      lastContentSha256: rows[0]?.last_content_sha256
        ? toText(rows[0].last_content_sha256)
        : null,
      calendarContractVersion: Number(rows[0]?.calendar_contract_version ?? 1),
    };
  }

  private async events(sourceId: string): Promise<PersistedEvent[]> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_school_calendar_events WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)}`,
    );
    return rows.map((row) => ({
      ...(parseJsonRecord(
        row.semantic_json,
      ) as unknown as SchoolCalendarSemanticEvent),
      providerEventId: row.provider_event_id
        ? toText(row.provider_event_id)
        : null,
      providerVersion: row.provider_version
        ? toText(row.provider_version)
        : null,
      active: row.active === true || row.active === 1 || row.active === "true",
    }));
  }

  private async completeNoop(
    runId: string,
    sourceId: string,
    pdfUrl: string,
    hash: string,
    mediaUrl: string,
    lease: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'unchanged', discovered_pdf_url = ${sqlQuote(pdfUrl)}, content_sha256 = ${sqlQuote(hash)}, media_url = ${sqlQuote(mediaUrl)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET last_content_sha256 = ${sqlQuote(hash)}, last_media_url = ${sqlQuote(mediaUrl)}, calendar_contract_version = ${SCHOOL_CALENDAR_CONTRACT_VERSION}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async awaitApproval(
    runId: string,
    sourceId: string,
    pdfUrl: string,
    plan: SchoolCalendarApprovalPlan,
    lease: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    const semanticSha = sha256(canonicalJson(plan.changes));
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'awaiting_approval', discovered_pdf_url = ${sqlQuote(pdfUrl)}, content_sha256 = ${sqlQuote(plan.contentSha256)}, media_url = ${sqlQuote(plan.mediaUrl)}, semantic_sha256 = ${sqlQuote(semanticSha)}, plan_json = ${sqlQuote(canonicalJson(plan))}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async failRun(
    runId: string,
    sourceId: string,
    lease: string,
    error: unknown,
  ): Promise<void> {
    const at = this.now().toISOString();
    const code =
      error instanceof SchoolCalendarWorkflowError
        ? error.code
        : "SCHOOL_CALENDAR_RUN_FAILED";
    const message = error instanceof Error ? error.message : String(error);
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_runs SET state = 'failed', error_code = ${sqlQuote(code)}, error_message = ${sqlQuote(message)}, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND run_id = ${sqlQuote(runId)}`,
    );
    await this.release(sourceId, lease, at);
  }

  private async release(
    sourceId: string,
    lease: string,
    at: string,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_school_calendar_sources SET lease_token = NULL, lease_expires_at = NULL, updated_at = ${sqlQuote(at)} WHERE agent_id = ${sqlQuote(this.runtime.agentId)} AND source_id = ${sqlQuote(sourceId)} AND lease_token = ${sqlQuote(lease)}`,
    );
  }

  private async upsertEvent(
    sourceId: string,
    semantic: SchoolCalendarSemanticEvent,
    provider: LifeOpsCalendarEvent,
  ): Promise<void> {
    const version =
      typeof provider.metadata.etag === "string"
        ? provider.metadata.etag
        : null;
    if (!version)
      throw new SchoolCalendarWorkflowError(
        "Calendar provider omitted the event version.",
        "SCHOOL_CALENDAR_PROVIDER_VERSION_MISSING",
      );
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_school_calendar_events (agent_id, source_id, event_key, semantic_json, provider_event_id, provider_version, active, updated_at) VALUES (${sqlQuote(this.runtime.agentId)}, ${sqlQuote(sourceId)}, ${sqlQuote(semantic.eventKey)}, ${sqlQuote(canonicalJson(semantic))}, ${sqlQuote(provider.externalId)}, ${sqlQuote(version)}, TRUE, ${sqlQuote(this.now().toISOString())}) ON CONFLICT (agent_id, source_id, event_key) DO UPDATE SET semantic_json = EXCLUDED.semantic_json, provider_event_id = EXCLUDED.provider_event_id, provider_version = EXCLUDED.provider_version, active = TRUE, updated_at = EXCLUDED.updated_at`,
    );
  }
}

function parseApprovalPlan(
  value: Record<string, unknown>,
): SchoolCalendarApprovalPlan {
  if (
    value.version !== 1 ||
    (value.sourceConfigSha256 !== undefined &&
      (typeof value.sourceConfigSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.sourceConfigSha256))) ||
    (value.calendarContractVersion !== undefined &&
      value.calendarContractVersion !== SCHOOL_CALENDAR_CONTRACT_VERSION) ||
    typeof value.sourceId !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.contentSha256 !== "string" ||
    typeof value.mediaUrl !== "string"
  ) {
    throw new SchoolCalendarWorkflowError(
      "Persisted school calendar approval plan is invalid.",
      "SCHOOL_CALENDAR_PLAN_INVALID",
    );
  }
  return {
    version: 1,
    calendarContractVersion: SCHOOL_CALENDAR_CONTRACT_VERSION,
    sourceId: value.sourceId,
    runId: value.runId,
    contentSha256: value.contentSha256,
    mediaUrl: value.mediaUrl,
    changes: parseJsonArray(value.changes) as SchoolCalendarChange[],
    ...(typeof value.sourceConfigSha256 === "string"
      ? { sourceConfigSha256: value.sourceConfigSha256 }
      : {}),
  };
}
