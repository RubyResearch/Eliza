/**
 * The `/api/lifeops/*` REST surface — the owner-facing HTTP handler backing the
 * LifeOps dashboard and connector cards.
 *
 * Dispatches reads and writes across the owner domains: occurrences, goals,
 * task/workflow definitions, reminders, money/finances (delegated to
 * `@elizaos/plugin-finances`), Gmail triage/search/reply/manage, the merged
 * inbox, screen-time/sleep, activity signals, schedule state, connector status,
 * and full-disk-access probing; calendar routes delegate to
 * `@elizaos/plugin-calendar`. Handlers run behind the `LifeOpsRouteContext`
 * exported here — `routes/plugin.ts` applies the auth token check and
 * OWNER/ADMIN role gate before delegating, so this layer trusts the request is
 * authorized and only re-checks that a runtime is present.
 */

import type http from "node:http";
import {
  checkRateLimit,
  createIntegrationTelemetrySpan,
  type RateLimitConfig,
} from "@elizaos/agent";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import {
  type AgentRuntime,
  logger,
  type Memory,
  readRequestBodyBuffer,
  requireConfirmation,
  type UUID,
} from "@elizaos/core";
import {
  CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
  type CalendarOwnerMutationGateway,
  CalendarService,
  CalendarServiceError,
} from "@elizaos/plugin-calendar";
import {
  type CalendarRouteService,
  handleCalendarRoutes,
} from "@elizaos/plugin-calendar/routes/calendar-routes";
import {
  LIFEOPS_SCHEDULE_STATE_SCOPES,
  type SyncLifeOpsScheduleObservationsRequest,
} from "@elizaos/plugin-elizacloud/cloud/lifeops-schedule-sync-contracts";
import { FinancesServiceError } from "@elizaos/plugin-finances/finance-normalize";
import {
  FinancesService,
  sanitizePaymentSourceForClient,
} from "@elizaos/plugin-finances/finances-service";
import type { AddPaymentSourceRequest } from "@elizaos/plugin-finances/payment-types";
import { PLAID_WEBHOOK_MAX_BODY_BYTES } from "@elizaos/plugin-finances/plaid-webhook";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import type {
  AcknowledgeLifeOpsReminderRequest,
  CaptureLifeOpsActivitySignalRequest,
  CaptureLifeOpsManualOverrideRequest,
  CaptureLifeOpsPhoneConsentRequest,
  CompleteLifeOpsOccurrenceRequest,
  CreateLifeOpsDefinitionRequest,
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  CreateLifeOpsGoalRequest,
  CreateLifeOpsWorkflowRequest,
  CreateLifeOpsXPostRequest,
  DisconnectLifeOpsGoogleConnectorRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  GetLifeOpsIMessageMessagesRequest,
  GetLifeOpsInboxRequest,
  IngestLifeOpsGmailEventRequest,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsHealthConnectorProvider,
  LifeOpsInboxChannel,
  ManageLifeOpsGmailMessagesRequest,
  ProcessLifeOpsRemindersRequest,
  PurgeLifeOpsGmailImportedDataRequest,
  RelockLifeOpsWebsiteAccessRequest,
  ResolveLifeOpsWebsiteAccessCallbackRequest,
  RunLifeOpsWorkflowRequest,
  SeedLifeOpsGmailRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  SetLifeOpsReminderPreferenceRequest,
  SnoozeLifeOpsOccurrenceRequest,
  StartLifeOpsGoogleConnectorRequest,
  UpdateLifeOpsDefinitionRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
  UpdateLifeOpsGoalRequest,
  UpdateLifeOpsWorkflowRequest,
  UpsertLifeOpsChannelPolicyRequest,
} from "../contracts/index.js";
import {
  LIFEOPS_ACTIVITY_SIGNAL_STATES,
  LIFEOPS_CONNECTOR_MODES,
  LIFEOPS_CONNECTOR_SIDES,
  LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES,
  LIFEOPS_HEALTH_CONNECTOR_PROVIDERS,
  LIFEOPS_INBOX_CACHE_MODES,
  LIFEOPS_INBOX_CHANNELS,
  LIFEOPS_SCREEN_TIME_RANGES,
  type LifeOpsGmailSpamReviewStatus,
  type VerifyLifeOpsTelegramConnectorRequest,
} from "../contracts/index.js";
import { areLifeOpsActivitySignalsActive } from "../lifeops/activity-signal-lifecycle.js";
import {
  loadLifeOpsAppState,
  saveLifeOpsAppState,
} from "../lifeops/app-state.js";
import { createApprovalQueue } from "../lifeops/approval-queue.js";
import {
  CalendarCardAccessError,
  CalendarCardAccessStore,
  calendarCardApprovalPayload,
  composeDailyCalendarCard,
  parseCalendarCardRequest,
  resolveCalendarCardOrigin,
} from "../lifeops/calendar-card.js";
import {
  CalendarCardSenderError,
  resolveCalendarCardSender,
} from "../lifeops/calendar-card-sender.js";
import { probeFullDiskAccess } from "../lifeops/fda-probe.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { handleAccountHandoffRoutes } from "./account-handoff.js";
import { entityHasVerifiedMachineAuthBinding } from "./authenticated-entity-principal.js";
import { handleFamilyWorkflowRoutes } from "./family-workflows.js";

export interface LifeOpsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: {
    runtime: AgentRuntime | null;
    adminEntityId: UUID | null;
    requestEntityId?: string | null;
  };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  decodePathComponent: (
    raw: string,
    res: http.ServerResponse,
    label: string,
  ) => string | null;
}

/**
 * Ensure the request has the runtime context required to act on behalf of
 * the configured owner entity. Returns `false` (and writes a 503) when the
 * agent runtime is not available — this is the per-request analogue of an
 * auth guard. The framework-level token check rejects unauthenticated
 * callers and `routes/plugin.ts` applies OWNER/ADMIN role gating to private
 * raw routes before they reach this handler; this helper confirms the route
 * can actually resolve a tenant.
 */
function requireAuthorizedRouteContext(ctx: LifeOpsRouteContext): boolean {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return false;
  }
  return true;
}

function requireActivitySignalsAvailable(ctx: LifeOpsRouteContext): boolean {
  if (!requireAuthorizedRouteContext(ctx)) {
    return false;
  }
  const runtime = ctx.state.runtime;
  if (!runtime || !areLifeOpsActivitySignalsActive(runtime)) {
    ctx.error(
      ctx.res,
      "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
      503,
    );
    return false;
  }
  return true;
}

function getService(ctx: LifeOpsRouteContext): LifeOpsService | null {
  if (!requireAuthorizedRouteContext(ctx)) {
    return null;
  }
  // `runtime` is non-null after the guard above. The service derives the
  // owner entity from `ctx.state.adminEntityId` when present, otherwise from
  // `defaultOwnerEntityId(runtime)` (configured canonical owner, else the
  // stable agent-id seed — the same precedence the chat write surface and the
  // scheduler use). That keeps tenant scoping intact even when the route
  // dispatcher does not surface an explicit admin entity.
  const runtime = ctx.state.runtime;
  if (!runtime) {
    return null;
  }
  return new LifeOpsService(runtime, {
    ownerEntityId: ctx.state.adminEntityId,
  });
}

function getFinancesService(ctx: LifeOpsRouteContext): FinancesService | null {
  if (!requireAuthorizedRouteContext(ctx)) {
    return null;
  }
  const runtime = ctx.state.runtime;
  if (!runtime) {
    return null;
  }
  return new FinancesService(runtime, {
    ownerEntityId: ctx.state.adminEntityId,
  });
}

// ---------------------------------------------------------------------------
// Rate limit configuration per operation.
//
// Conventions for new routes:
//   • Read GET endpoints: rely on `default` (60/min) unless they hit a paid
//     upstream — then use `google_api_read` / similar.
//   • State-changing POST/PUT/PATCH/DELETE: ALWAYS rate-limit. Pick the most
//     specific bucket from the list below; fall back to `connector_write` for
//     generic configuration writes or `default` only if nothing fits.
//   • Sensitive flows (sending email, OAuth init, token refresh, paid API
//     writes, irreversible deletes): use a dedicated tight bucket so a buggy
//     client cannot drain quota or fan out side-effects.
//
// Keys are logical operation names; the "default" entry applies to any
// operation not explicitly listed.
// ---------------------------------------------------------------------------
const LIFEOPS_RATE_LIMITS = {
  google_api_read: { maxRequests: 120, windowMs: 60_000 },
  google_api_write: { maxRequests: 30, windowMs: 60_000 },
  reminders_process: { maxRequests: 10, windowMs: 60_000 },
  task_create: { maxRequests: 30, windowMs: 60_000 },
  task_update: { maxRequests: 30, windowMs: 60_000 },
  gmail_draft: { maxRequests: 20, windowMs: 60_000 },
  // A range seed walks every provider page for up to 90 days of mail; keep
  // the burst small so a retry loop cannot hammer the Gmail quota.
  gmail_seed: { maxRequests: 4, windowMs: 60_000 },
  // Tightened from 5/min: composing and sending email is the most sensitive
  // outbound action LifeOps takes; cap the burst at 2/min so a bug or a
  // confused operator cannot machine-gun the user's contacts.
  gmail_send: { maxRequests: 2, windowMs: 60_000 },
  calendar_create: { maxRequests: 20, windowMs: 60_000 },
  calendar_update: { maxRequests: 20, windowMs: 60_000 },
  calendar_delete: { maxRequests: 10, windowMs: 60_000 },
  calendar_source_read: { maxRequests: 120, windowMs: 60_000 },
  calendar_source_write: { maxRequests: 20, windowMs: 60_000 },
  calendar_source_sync: { maxRequests: 30, windowMs: 60_000 },
  calendar_imported_data_purge: { maxRequests: 10, windowMs: 60_000 },
  calendar_link_read: { maxRequests: 120, windowMs: 60_000 },
  calendar_link_write: { maxRequests: 20, windowMs: 60_000 },
  calendar_card: { maxRequests: 10, windowMs: 60_000 },
  // OAuth + connector lifecycle: tight cap because these mutate stored
  // credentials or initiate consent flows.
  oauth_init: { maxRequests: 5, windowMs: 60_000 },
  connector_write: { maxRequests: 10, windowMs: 60_000 },
  // A saved account switch takes multiple revision-checked checkpoints; it
  // must not exhaust the budget for starting new connector consent flows.
  account_handoff_advance: { maxRequests: 30, windowMs: 60_000 },
  // Generic outbound messaging (X DMs, iMessage, Telegram). Tighter
  // than the default to limit blast radius.
  outbound_message: { maxRequests: 5, windowMs: 60_000 },
  // Unauthenticated provider webhook ingress (Plaid). A dedicated bucket so a
  // flood of forged deliveries cannot exhaust the shared default bucket and
  // 429 the owner's own routes; verification rejects forgeries afterwards.
  webhook_ingress: { maxRequests: 120, windowMs: 60_000 },
  default: { maxRequests: 60, windowMs: 60_000 },
} satisfies Record<string, RateLimitConfig>;

type LifeOpsRateLimitOperation = keyof typeof LIFEOPS_RATE_LIMITS;

const ACTIVITY_SIGNALS_DEFAULT_LIMIT = 200;
const ACTIVITY_SIGNALS_MAX_LIMIT = 500;
const MS_PER_DAY = 86_400_000;
const MAX_SCREEN_TIME_WINDOW_DAYS = 31;
const MAX_SCREEN_TIME_WINDOW_MS = MAX_SCREEN_TIME_WINDOW_DAYS * MS_PER_DAY;
/** Maximum time an unauthenticated Plaid delivery may hold its body stream open. */
export const PLAID_WEBHOOK_BODY_READ_TIMEOUT_MS = 10_000;
const routeSchemaBootstraps = new WeakMap<AgentRuntime, Promise<void>>();

type PlaidWebhookBodyReadResult =
  | { kind: "body"; body: Buffer | null }
  | { kind: "timeout" };

/**
 * Reads the public webhook body under a clearable deadline. A stalled sender is
 * destroyed with an observable stream error; awaiting the shared reader after
 * destruction guarantees its listeners are removed before the route returns.
 */
async function readPlaidWebhookBody(
  req: http.IncomingMessage,
): Promise<PlaidWebhookBodyReadResult> {
  let deadlineElapsed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const bodyRead = readRequestBodyBuffer(req, {
    maxBytes: PLAID_WEBHOOK_MAX_BODY_BYTES,
    returnNullOnError: true,
    returnNullOnTooLarge: true,
    destroyOnTooLarge: true,
  });
  const timeout = new Promise<PlaidWebhookBodyReadResult>((resolve) => {
    deadline = setTimeout(() => {
      deadlineElapsed = true;
      req.destroy(new Error("Plaid webhook body read deadline exceeded"));
      resolve({ kind: "timeout" });
    }, PLAID_WEBHOOK_BODY_READ_TIMEOUT_MS);
    deadline.unref?.();
  });

  try {
    const result = await Promise.race([
      bodyRead.then((body) => ({ kind: "body", body }) as const),
      timeout,
    ]);
    if (deadlineElapsed || result.kind === "timeout") {
      // `returnNullOnError` makes the destroy-triggered read failure resolve;
      // awaiting it here proves the data/end/error listeners are cleaned up.
      await bodyRead;
      return { kind: "timeout" };
    }
    return result;
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

async function ensureRouteSchema(runtime: AgentRuntime | null): Promise<void> {
  if (!runtime) return;
  const adapter = runtime.adapter;
  if (!adapter || typeof adapter.runPluginMigrations !== "function") return;
  if (typeof adapter.isReady === "function" && !(await adapter.isReady())) {
    return;
  }
  let bootstrap = routeSchemaBootstraps.get(runtime);
  if (!bootstrap) {
    bootstrap = LifeOpsRepository.bootstrapSchema(runtime).catch((error) => {
      routeSchemaBootstraps.delete(runtime);
      throw error;
    });
    routeSchemaBootstraps.set(runtime, bootstrap);
  }
  await bootstrap;
}

/**
 * Check rate limit for a LifeOps operation. If the limit is exceeded,
 * sends a 429 response with Retry-After header and returns `true`.
 * Returns `false` when the request is allowed to proceed.
 */
function rateLimitRequest(
  ctx: LifeOpsRouteContext,
  operation: LifeOpsRateLimitOperation,
  discriminator?: string,
): boolean {
  const agentId = String(ctx.state.runtime?.agentId ?? "unknown");
  const limitKey = `${agentId}:${operation}${discriminator ? `:${discriminator}` : ""}`;
  const config = LIFEOPS_RATE_LIMITS[operation];
  const { allowed, retryAfterMs } = checkRateLimit(limitKey, config);
  if (!allowed) {
    ctx.res.writeHead(429, {
      "Retry-After": String(Math.ceil(retryAfterMs / 1_000)),
    });
    ctx.res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs }));
    return true;
  }
  return false;
}

function routeOperation(ctx: LifeOpsRouteContext): string {
  return `${ctx.method.toUpperCase()} ${ctx.pathname}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeMatchedPathComponent(
  ctx: LifeOpsRouteContext,
  match: RegExpMatchArray | null,
  index: number,
  res: http.ServerResponse,
  label: string,
): string | null {
  const raw = match?.[index];
  return raw ? ctx.decodePathComponent(raw, res, label) : null;
}

function parseRouteInput<T>(
  ctx: LifeOpsRouteContext,
  parser: () => T | null,
): T | null {
  try {
    return parser();
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      ctx.error(ctx.res, error.message, error.status);
      return null;
    }
    throw error;
  }
}

function parsePositiveIntegerQuery(
  value: string | null,
  field: string,
  options: { max?: number } = {},
): number | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (!/^\d+$/.test(normalized)) {
    throw new LifeOpsServiceError(400, `${field} must be a positive integer`);
  }
  const parsed = Number.parseInt(normalized, 10);
  if (parsed <= 0) {
    throw new LifeOpsServiceError(400, `${field} must be a positive integer`);
  }
  if (options.max !== undefined && parsed > options.max) {
    throw new LifeOpsServiceError(
      400,
      `${field} must be less than or equal to ${options.max}`,
    );
  }
  return parsed;
}

function isOneOf<T extends string>(
  value: string,
  values: readonly T[],
): value is T {
  return values.some((allowed) => allowed === value);
}

function parseConnectorModeQuery(
  value: string | null,
): LifeOpsConnectorMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!isOneOf(normalized, LIFEOPS_CONNECTOR_MODES)) {
    throw new LifeOpsServiceError(
      400,
      `mode must be one of: ${LIFEOPS_CONNECTOR_MODES.join(", ")}`,
    );
  }
  return normalized;
}

function parseConnectorModeInput(
  value: unknown,
): LifeOpsConnectorMode | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new LifeOpsServiceError(
      400,
      `mode must be one of: ${LIFEOPS_CONNECTOR_MODES.join(", ")}`,
    );
  }
  return parseConnectorModeQuery(value);
}

function parseConnectorSideQuery(
  value: string | null,
): LifeOpsConnectorSide | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!isOneOf(normalized, LIFEOPS_CONNECTOR_SIDES)) {
    throw new LifeOpsServiceError(
      400,
      `side must be one of: ${LIFEOPS_CONNECTOR_SIDES.join(", ")}`,
    );
  }
  return normalized;
}

function parseConnectorSideInput(
  value: unknown,
): LifeOpsConnectorSide | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new LifeOpsServiceError(
      400,
      `side must be one of: ${LIFEOPS_CONNECTOR_SIDES.join(", ")}`,
    );
  }
  return parseConnectorSideQuery(value);
}

function parseConnectorSideFromRequest(
  url: URL,
  body?: { side?: unknown } | null,
): LifeOpsConnectorSide | undefined {
  const querySide = parseConnectorSideQuery(url.searchParams.get("side"));
  const bodySide = parseConnectorSideInput(body?.side);
  if (querySide && bodySide && querySide !== bodySide) {
    throw new LifeOpsServiceError(
      400,
      "side must match between query string and request body",
    );
  }
  return bodySide ?? querySide;
}

function parseHealthConnectorProvider(
  value: string,
): LifeOpsHealthConnectorProvider {
  const normalized = value.trim().toLowerCase();
  if (!isOneOf(normalized, LIFEOPS_HEALTH_CONNECTOR_PROVIDERS)) {
    throw new LifeOpsServiceError(
      400,
      `provider must be one of: ${LIFEOPS_HEALTH_CONNECTOR_PROVIDERS.join(", ")}`,
    );
  }
  return normalized;
}

function parseOptionalHealthConnectorProvider(
  value: string | null,
): LifeOpsHealthConnectorProvider | null {
  const normalized = value?.trim();
  return normalized ? parseHealthConnectorProvider(normalized) : null;
}

function parseHealthConnectorProviderPath(
  ctx: LifeOpsRouteContext,
  match: RegExpMatchArray,
): LifeOpsHealthConnectorProvider | null {
  return parseRouteInput(ctx, () => {
    const provider = decodeMatchedPathComponent(
      ctx,
      match,
      1,
      ctx.res,
      "provider",
    );
    return provider ? parseHealthConnectorProvider(provider) : null;
  });
}

function parseDateOnlyQuery(
  value: string | null,
  field: string,
): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new LifeOpsServiceError(400, `${field} must be a YYYY-MM-DD date`);
  }
  return normalized;
}

function parseGmailSpamReviewStatusInput(
  value: unknown,
  field: string,
): LifeOpsGmailSpamReviewStatus | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new LifeOpsServiceError(
      400,
      `${field} must be one of: ${LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES.join(", ")}`,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!isOneOf(normalized, LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES)) {
    throw new LifeOpsServiceError(
      400,
      `${field} must be one of: ${LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES.join(", ")}`,
    );
  }
  return normalized;
}

function parseGmailSpamReviewStatusQuery(
  value: string | null,
): LifeOpsGmailSpamReviewStatus | undefined {
  return parseGmailSpamReviewStatusInput(value, "status");
}

function parseBooleanQuery(
  value: string | null,
  field: string,
): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new LifeOpsServiceError(400, `${field} must be a boolean`);
}

function requireBodyString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new LifeOpsServiceError(400, `${field} is required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new LifeOpsServiceError(400, `${field} is required`);
  }
  return trimmed;
}

function parseOptionalBodyString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new LifeOpsServiceError(400, `${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalBodyBoolean(
  body: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new LifeOpsServiceError(400, `${field} must be a boolean`);
  }
  return value;
}

function parseOptionalBodyStringArray(
  body: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = body[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new LifeOpsServiceError(400, `${field} must be an array of strings`);
  }
  const parsed = value.map((entry) => {
    if (typeof entry !== "string") {
      throw new LifeOpsServiceError(
        400,
        `${field} must be an array of strings`,
      );
    }
    return entry.trim();
  });
  if (parsed.some((entry) => entry.length === 0)) {
    throw new LifeOpsServiceError(
      400,
      `${field} must be an array of non-empty strings`,
    );
  }
  return parsed;
}

function parseActivitySignalStates(
  url: URL,
): Array<(typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number]> | null {
  const rawValues = [
    ...url.searchParams.getAll("state"),
    ...url.searchParams.getAll("states").flatMap((value) => value.split(",")),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (rawValues.length === 0) {
    return null;
  }
  const states: Array<(typeof LIFEOPS_ACTIVITY_SIGNAL_STATES)[number]> = [];
  for (const value of rawValues) {
    if (!isOneOf(value, LIFEOPS_ACTIVITY_SIGNAL_STATES)) {
      throw new LifeOpsServiceError(
        400,
        `state must be one of: ${LIFEOPS_ACTIVITY_SIGNAL_STATES.join(", ")}`,
      );
    }
    states.push(value);
  }
  return states;
}

function parseScreenTimeSourceQuery(
  value: string | null,
): "app" | "website" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized !== "app" && normalized !== "website") {
    throw new LifeOpsServiceError(400, "source must be app or website");
  }
  return normalized;
}

function parseScreenTimeIdentifierQuery(
  value: string | null,
): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function parseScreenTimeRangeQuery(value: string | null) {
  const normalized = value?.trim().toLowerCase() || "today";
  if (!isOneOf(normalized, LIFEOPS_SCREEN_TIME_RANGES)) {
    throw new LifeOpsServiceError(
      400,
      `range must be one of: ${LIFEOPS_SCREEN_TIME_RANGES.join(", ")}`,
    );
  }
  return normalized;
}

const ISO_INSTANT_QUERY_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseRequiredIsoQuery(url: URL, field: string): string {
  const value = url.searchParams.get(field)?.trim();
  if (!value) {
    throw new LifeOpsServiceError(400, `${field} is required`);
  }
  if (
    !ISO_INSTANT_QUERY_RE.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new LifeOpsServiceError(400, `${field} must be a valid ISO string`);
  }
  return value;
}

function parseOptionalIsoQuery(
  value: string | null,
  field: string,
): string | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new LifeOpsServiceError(400, `${field} must be a valid ISO string`);
  }
  return normalized;
}

function parseBoundedIsoWindowQuery(url: URL): {
  since: string;
  until: string;
} {
  const since = parseRequiredIsoQuery(url, "since");
  const until = parseRequiredIsoQuery(url, "until");
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (untilMs <= sinceMs) {
    throw new LifeOpsServiceError(400, "until must be after since");
  }
  if (untilMs - sinceMs > MAX_SCREEN_TIME_WINDOW_MS) {
    throw new LifeOpsServiceError(
      400,
      `window must be ${MAX_SCREEN_TIME_WINDOW_DAYS} days or less`,
    );
  }
  return { since, until };
}

async function runRoute(
  ctx: LifeOpsRouteContext,
  fn: (service: LifeOpsService) => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
  });
  const service = getService(ctx);
  if (!service) {
    logger.info(
      {
        boundary: "lifeops",
        operation,
        statusCode: 503,
      },
      "[lifeops] Route rejected because agent runtime is unavailable",
    );
    span.failure({
      statusCode: 503,
      errorKind: "runtime_unavailable",
    });
    return true;
  }
  try {
    // Routes can be served before a startup hook migrates the LifeOps DB;
    // bootstrap the schema here (memoized per runtime) before any handler runs.
    await ensureRouteSchema(ctx.state.runtime);
    await fn(service);
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        {
          boundary: "lifeops",
          operation,
          statusCode: error.status,
        },
        `[lifeops] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind:
          error.status === 401
            ? "lifeops_auth_invalid"
            : "lifeops_service_error",
      });
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    logger.error(
      {
        boundary: "lifeops",
        operation,
      },
      `[lifeops] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({
      error,
      errorKind: "unhandled_error",
    });
    throw error;
  }
}

/**
 * Runs an owner-gated calendar route against the singleton calendar service.
 * Calendar owns its domain service; constructing a LifeOpsService here would
 * expose only the compatibility subset and silently omit source administration.
 */
async function runCalendarRoute(
  ctx: LifeOpsRouteContext,
  fn: (service: CalendarRouteService) => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
  });
  if (!requireAuthorizedRouteContext(ctx)) {
    span.failure({ statusCode: 503, errorKind: "runtime_unavailable" });
    return true;
  }
  const runtime = ctx.state.runtime;
  if (!runtime) {
    span.failure({ statusCode: 503, errorKind: "runtime_unavailable" });
    return true;
  }

  try {
    let loaded = runtime.getService(CalendarService.serviceType);
    if (!loaded) {
      try {
        loaded = await runtime.getServiceLoadPromise(
          CalendarService.serviceType,
        );
      } catch (error) {
        // error-policy:J2 context-adding rethrow — the owner route reports the
        // failed service boot and preserves its cause in a typed 503.
        runtime.reportError("CalendarRoutes.serviceLoad", error, {
          operation,
          serviceType: CalendarService.serviceType,
        });
        throw new CalendarServiceError(
          503,
          "Calendar service failed to load.",
          "CALENDAR_SERVICE_LOAD_FAILED",
          { cause: error },
        );
      }
    }
    if (!(loaded instanceof CalendarService)) {
      ctx.error(ctx.res, "Calendar service is not available", 503);
      span.failure({
        statusCode: 503,
        errorKind: "calendar_service_unavailable",
      });
      return true;
    }
    await fn(loaded);
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    // error-policy:J1 boundary translation — typed calendar/domain failures
    // become their explicit HTTP status; unexpected faults stay observable.
    if (
      error instanceof CalendarServiceError ||
      error instanceof LifeOpsServiceError
    ) {
      logger.warn(
        {
          boundary: "calendar",
          operation,
          statusCode: error.status,
        },
        `[calendar] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind: "calendar_service_error",
      });
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    runtime.reportError("CalendarRoutes.ownerBoundary", error, { operation });
    logger.error(
      { boundary: "calendar", operation },
      `[calendar] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({ error, errorKind: "unhandled_error" });
    throw error;
  }
}

/**
 * Variant of {@link runRoute} that injects a {@link FinancesService} (the
 * finance back-end in @elizaos/plugin-finances) instead of LifeOpsService, and
 * maps {@link FinancesServiceError} to the same HTTP shape. Used by the
 * /api/lifeops/money/* routes whose payments logic moved to plugin-finances.
 * URLs and response shapes are unchanged.
 */
async function runFinancesRoute(
  ctx: LifeOpsRouteContext,
  fn: (service: FinancesService) => Promise<void>,
): Promise<boolean> {
  const operation = routeOperation(ctx);
  const span = createIntegrationTelemetrySpan({
    boundary: "lifeops",
    operation,
  });
  const service = getFinancesService(ctx);
  if (!service) {
    logger.info(
      {
        boundary: "lifeops",
        operation,
        statusCode: 503,
      },
      "[lifeops] Route rejected because agent runtime is unavailable",
    );
    span.failure({
      statusCode: 503,
      errorKind: "runtime_unavailable",
    });
    return true;
  }
  try {
    await ensureRouteSchema(ctx.state.runtime);
    await fn(service);
    span.success({
      statusCode: ctx.res.statusCode >= 400 ? ctx.res.statusCode : 200,
    });
    return true;
  } catch (error) {
    if (error instanceof FinancesServiceError) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        {
          boundary: "lifeops",
          operation,
          statusCode: error.status,
        },
        `[lifeops] Route failed: ${error.message}`,
      );
      span.failure({
        statusCode: error.status,
        error,
        errorKind:
          error.status === 401
            ? "lifeops_auth_invalid"
            : "lifeops_service_error",
      });
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    logger.error(
      {
        boundary: "lifeops",
        operation,
      },
      `[lifeops] Route crashed: ${errorMessage(error)}`,
    );
    span.failure({
      error,
      errorKind: "unhandled_error",
    });
    throw error;
  }
}

function _parseConnectorRefreshDetailFromQuery(
  ctx: LifeOpsRouteContext,
  defaults: {
    side: LifeOpsConnectorSide;
    mode: LifeOpsConnectorMode;
  },
): {
  side: LifeOpsConnectorSide;
  mode: LifeOpsConnectorMode;
} | null {
  return parseRouteInput(ctx, () => ({
    side:
      parseConnectorSideQuery(ctx.url.searchParams.get("side")) ??
      defaults.side,
    mode:
      parseConnectorModeQuery(ctx.url.searchParams.get("mode")) ??
      defaults.mode,
  }));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeInlineScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function writeHtml(
  res: http.ServerResponse,
  status: number,
  title: string,
  message: string,
  refreshDetail?: {
    side?: LifeOpsConnectorSide;
    mode?: LifeOpsConnectorMode;
  },
): void {
  const refreshScript = refreshDetail
    ? `
    <script>
      (() => {
        const payload = ${serializeInlineScriptValue({
          type: "lifeops-google-connector-refresh",
          detail: {
            ...refreshDetail,
            source: "callback",
          },
        })};
        if (window.opener && typeof window.opener.postMessage === "function") {
          // LifeOps google-connector callback is served from the same agent host as the opener (same-origin popup).
          // Pin to window.location.origin (agent origin) — cross-origin openers will not receive this postMessage
          // and will rely on BroadcastChannel/localStorage fallback below. This is fail-closed, not a wildcard leak.
          window.opener.postMessage(payload, window.location.origin);
        }
        if (typeof BroadcastChannel === "function") {
          for (const channelName of [
            "elizaos:lifeops:google-connector",
            "eliza:lifeops:google-connector",
          ]) {
            const channel = new BroadcastChannel(channelName);
            channel.postMessage(payload);
            channel.close();
          }
        }
        if (typeof localStorage !== "undefined") {
          for (const storageKey of [
            "elizaos:lifeops:google-connector-refresh",
            "eliza:lifeops:google-connector-refresh",
          ]) {
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                ...payload,
                at: Date.now(),
              }),
            );
            localStorage.removeItem(storageKey);
          }
        }
      })();
    </script>`
    : "";
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #f5f1e8;
        color: #18120d;
        font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
      }
      main {
        width: min(32rem, calc(100vw - 2rem));
        padding: 2rem;
        border: 1px solid rgba(24, 18, 13, 0.12);
        border-radius: 1.25rem;
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 24px 80px rgba(24, 18, 13, 0.08);
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 1.25rem;
      }
      p {
        margin: 0;
        line-height: 1.5;
        color: rgba(24, 18, 13, 0.78);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    </main>
    ${refreshScript}
    <script>
      window.setTimeout(() => {
        if (typeof window.close === "function") {
          window.close();
        }
      }, 250);
    </script>
  </body>
</html>`);
}

export async function handleLifeOpsRoutes(
  ctx: LifeOpsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, url, json, readJsonBody } = ctx;
  const calendarCardMatch = pathname.match(
    /^\/api\/lifeops\/calendar\/cards\/([^/]+)$/,
  );
  if (calendarCardMatch && method === "GET") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    if (rateLimitRequest(ctx, "calendar_card")) return true;
    const cardId = ctx.decodePathComponent(
      calendarCardMatch[1],
      res,
      "card id",
    );
    if (!cardId) return true;
    const token = url.searchParams.get("token")?.trim() ?? "";
    try {
      const bytes = await new CalendarCardAccessStore(runtime).consume({
        cardId,
        token,
        principalEntityId: String(ctx.state.requestEntityId ?? ""),
      });
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Cache-Control": "private, no-store, max-age=0",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Frame-Options": "DENY",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      });
      res.end(bytes);
    } catch (error) {
      if (error instanceof CalendarCardAccessError) {
        json(res, { error: error.code }, error.status);
      } else {
        throw error;
      }
    }
    return true;
  }
  if (calendarCardMatch && method === "DELETE") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    if (rateLimitRequest(ctx, "calendar_card")) return true;
    const cardId = ctx.decodePathComponent(
      calendarCardMatch[1],
      res,
      "card id",
    );
    if (!cardId) return true;
    json(res, {
      revoked: await new CalendarCardAccessStore(runtime).revoke(cardId),
    });
    return true;
  }
  if (method === "POST" && pathname === "/api/lifeops/calendar/cards") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    if (rateLimitRequest(ctx, "calendar_card")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    const parsedRequest = parseCalendarCardRequest(body);
    if (!parsedRequest.ok) {
      json(res, { error: parsedRequest.error }, 400);
      return true;
    }
    const cardRequest = parsedRequest.request;
    const publicAddress = resolveCalendarCardOrigin(runtime);
    if (publicAddress.status !== "configured") {
      json(
        res,
        {
          error:
            "Configure the agent's public HTTPS address before creating a calendar card.",
          code: "CALENDAR_CARD_PUBLIC_ORIGIN_UNAVAILABLE",
        },
        503,
      );
      return true;
    }
    const authenticatedEntityId = String(
      ctx.state.requestEntityId ?? ctx.state.adminEntityId ?? SELF_ENTITY_ID,
    );
    const recipientEntityId =
      cardRequest.recipientEntityId ?? authenticatedEntityId;
    const recipientCanAuthenticate =
      recipientEntityId === authenticatedEntityId ||
      (await entityHasVerifiedMachineAuthBinding(runtime, recipientEntityId));
    if (!recipientCanAuthenticate) {
      json(res, { error: "Invalid calendar card request" }, 400);
      return true;
    }
    const cardService = getService(ctx);
    if (!cardService) return true;
    let sender: Awaited<ReturnType<typeof resolveCalendarCardSender>>;
    try {
      sender = await resolveCalendarCardSender(
        cardService,
        cardRequest.channel,
      );
    } catch (error) {
      // error-policy:J1 expose missing sending identity before storing a card or approval.
      if (!(error instanceof CalendarCardSenderError)) throw error;
      json(res, { error: error.message, code: error.code }, 503);
      return true;
    }
    const ttlMs = cardRequest.ttlMs ?? 24 * 60 * 60_000;
    const placeholder = composeDailyCalendarCard({
      date: cardRequest.date,
      timeZone: cardRequest.timeZone,
      privacyMode: cardRequest.privacyMode,
      events: cardRequest.events,
      accessUrl: "https://invalid.local/pending",
    });
    const store = new CalendarCardAccessStore(runtime);
    const issued = await store.issue({
      recipientEntityId,
      html: placeholder.html,
      ttlMs,
      baseUrl: publicAddress.origin,
    });
    const composition = composeDailyCalendarCard({
      date: cardRequest.date,
      timeZone: cardRequest.timeZone,
      privacyMode: cardRequest.privacyMode,
      events: cardRequest.events,
      accessUrl: issued.accessUrl,
    });
    if (composition.htmlSha256 !== issued.htmlSha256) {
      await store.revoke(issued.cardId);
      throw new Error(
        "Calendar card renderer changed between storage and approval",
      );
    }
    const payload = calendarCardApprovalPayload({
      ownerEntityId: authenticatedEntityId,
      sender,
      channel: cardRequest.channel,
      recipient: cardRequest.recipient,
      recipientEntityId,
      cardId: issued.cardId,
      composition,
    });
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    let approval: Awaited<ReturnType<typeof queue.enqueue>>;
    try {
      approval = await queue.enqueue({
        requestedBy: "OWNER_CALENDAR_CARD",
        subjectUserId: authenticatedEntityId,
        action: "send_message",
        payload,
        channel: cardRequest.channel,
        reason: `Send the private ${cardRequest.privacyMode} calendar card for ${cardRequest.date} from ${sender.displayName} (${sender.identityId}) using ${sender.transport}.`,
        idempotencyKey: `calendar-card:v4:${authenticatedEntityId}:${cardRequest.channel}:${composition.envelopeSha256}`,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      await queue.surfaceEnqueuedApproval(approval);
    } catch (error) {
      await store.revoke(issued.cardId);
      throw error;
    }
    json(
      res,
      {
        approvalId: approval.id,
        cardId: issued.cardId,
        state: approval.state,
        textSha256: composition.textSha256,
        htmlSha256: composition.htmlSha256,
        envelopeSha256: composition.envelopeSha256,
      },
      202,
    );
    return true;
  }
  const isMutationGateway = (
    value: unknown,
  ): value is CalendarOwnerMutationGateway =>
    typeof value === "object" &&
    value !== null &&
    "create" in value &&
    typeof value.create === "function" &&
    "update" in value &&
    typeof value.update === "function" &&
    "cancel" in value &&
    typeof value.cancel === "function" &&
    "linkCalendar" in value &&
    typeof value.linkCalendar === "function" &&
    "reconcileLinkedCalendar" in value &&
    typeof value.reconcileLinkedCalendar === "function" &&
    "resolveLinkedCalendarConflict" in value &&
    typeof value.resolveLinkedCalendarConflict === "function" &&
    "rebindLinkedCalendar" in value &&
    typeof value.rebindLinkedCalendar === "function" &&
    "disconnectLinkedCalendar" in value &&
    typeof value.disconnectLinkedCalendar === "function" &&
    "reconcileLinkedCalendarProviderChanges" in value &&
    typeof value.reconcileLinkedCalendarProviderChanges === "function";
  const mutationGateway = (): CalendarOwnerMutationGateway => {
    const gateway = ctx.state.runtime?.getService(
      CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
    );
    if (!isMutationGateway(gateway)) {
      throw new LifeOpsServiceError(
        503,
        "Calendar writes require the owner approval and durable mutation gateway.",
      );
    }
    return gateway;
  };

  if (
    ctx.pathname === "/api/lifeops/account-handoffs" ||
    ctx.pathname.startsWith("/api/lifeops/account-handoffs/")
  ) {
    if (
      rateLimitRequest(
        ctx,
        ctx.method === "GET"
          ? "default"
          : ctx.method === "POST" && ctx.pathname.endsWith("/advance")
            ? "account_handoff_advance"
            : "connector_write",
      )
    )
      return true;
    if (await handleAccountHandoffRoutes(ctx)) return true;
  }
  if (await handleFamilyWorkflowRoutes(ctx)) return true;

  // Calendar routes are owned by @elizaos/plugin-calendar; the path -> service
  // mapping lives there. We inject LifeOps' HTTP plumbing so the calendar plugin
  // never depends back on LifeOps.
  if (
    await handleCalendarRoutes({
      method,
      pathname,
      url,
      runRoute: (fn) => runCalendarRoute(ctx, fn),
      rateLimit: (key) => rateLimitRequest(ctx, key),
      json: (data, status) => json(res, data, status),
      readJsonBody: <T extends object>() => readJsonBody<T>(req, res),
      decodePathComponent: (raw, label) =>
        ctx.decodePathComponent(raw, res, label),
      parseConnectorMode: (value) => parseConnectorModeQuery(value),
      parseConnectorSide: (value) => parseConnectorSideQuery(value),
      parseBoolean: (value, field) => parseBooleanQuery(value, field),
      serviceError: (status, message) =>
        new LifeOpsServiceError(status, message),
      mutationGateway: {
        create: (requestUrl, request) =>
          mutationGateway().create(requestUrl, request),
        update: (requestUrl, request) =>
          mutationGateway().update(requestUrl, request),
        cancel: (requestUrl, request) =>
          mutationGateway().cancel(requestUrl, request),
        linkCalendar: (requestUrl, request) =>
          mutationGateway().linkCalendar(requestUrl, request),
        updateLinkedCalendarControl: (requestUrl, request) =>
          mutationGateway().updateLinkedCalendarControl(requestUrl, request),
        reconcileLinkedCalendar: (requestUrl, linkId, request) =>
          mutationGateway().reconcileLinkedCalendar(
            requestUrl,
            linkId,
            request,
          ),
        resolveLinkedCalendarConflict: (requestUrl, linkId, request) =>
          mutationGateway().resolveLinkedCalendarConflict(
            requestUrl,
            linkId,
            request,
          ),
        rebindLinkedCalendar: (requestUrl, linkId, request) =>
          mutationGateway().rebindLinkedCalendar(requestUrl, linkId, request),
        disconnectLinkedCalendar: (requestUrl, linkId, request) =>
          mutationGateway().disconnectLinkedCalendar(
            requestUrl,
            linkId,
            request,
          ),
        reconcileLinkedCalendarProviderChanges: (
          requestUrl,
          providerEventIds,
        ) =>
          mutationGateway().reconcileLinkedCalendarProviderChanges(
            requestUrl,
            providerEventIds,
          ),
      },
    })
  ) {
    return true;
  }

  if (method === "GET" && pathname === "/api/lifeops/app-state") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    json(res, await loadLifeOpsAppState(runtime));
    return true;
  }

  if (method === "POST" && pathname === "/api/lifeops/features/toggle") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    if (rateLimitRequest(ctx, "default")) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    const body = await readJsonBody<{
      featureKey?: unknown;
      enabled?: unknown;
    }>(req, res);
    if (!body) {
      return true;
    }
    const { getFeatureFlagRegistry } = await import(
      "../lifeops/registries/feature-flag-registry.js"
    );
    const featureFlagRegistry = getFeatureFlagRegistry(runtime);
    if (!featureFlagRegistry) {
      ctx.error(res, "feature flag registry not initialized", 503);
      return true;
    }
    if (
      typeof body.featureKey !== "string" ||
      !featureFlagRegistry.has(body.featureKey)
    ) {
      ctx.error(
        res,
        `featureKey must be a registered feature flag (one of: ${featureFlagRegistry
          .list()
          .map((c) => c.key)
          .join(", ")})`,
        400,
      );
      return true;
    }
    if (typeof body.enabled !== "boolean") {
      ctx.error(res, "enabled must be a boolean", 400);
      return true;
    }
    const { createFeatureFlagService } = await import(
      "../lifeops/feature-flags.js"
    );
    const service = createFeatureFlagService(runtime);
    const next = body.enabled
      ? await service.enable(body.featureKey, "local", null)
      : await service.disable(body.featureKey, "local", null);
    json(res, {
      feature: {
        featureKey: next.featureKey,
        enabled: next.enabled,
        source: next.source,
        label: next.label,
        description: next.description,
        costsMoney: next.costsMoney,
        enabledAt: next.enabledAt ? next.enabledAt.toISOString() : null,
        enabledBy: next.enabledBy,
        packageId:
          typeof next.metadata.packageId === "string"
            ? next.metadata.packageId
            : null,
      },
    });
    return true;
  }

  if (method === "PUT" && pathname === "/api/lifeops/app-state") {
    if (!requireAuthorizedRouteContext(ctx)) return true;
    if (rateLimitRequest(ctx, "default")) return true;
    const runtime = ctx.state.runtime;
    if (!runtime) return true;
    const body = await readJsonBody<{
      enabled?: unknown;
      priorityScoring?: unknown;
    }>(req, res);
    if (!body) {
      return true;
    }
    if (typeof body.enabled !== "boolean") {
      ctx.error(res, "enabled must be a boolean", 400);
      return true;
    }
    // Hydrate the previous priorityScoring config so partial PUTs do not
    // erase fields the caller did not send.
    const previous = await loadLifeOpsAppState(runtime);
    let priorityScoring = previous.priorityScoring;
    if (body.priorityScoring !== undefined) {
      if (
        !body.priorityScoring ||
        typeof body.priorityScoring !== "object" ||
        Array.isArray(body.priorityScoring)
      ) {
        ctx.error(res, "priorityScoring must be an object", 400);
        return true;
      }
      const ps = body.priorityScoring as {
        enabled?: unknown;
        model?: unknown;
      };
      const enabled =
        typeof ps.enabled === "boolean" ? ps.enabled : priorityScoring.enabled;
      let model: string | null = priorityScoring.model;
      if (ps.model === null) {
        model = null;
      } else if (typeof ps.model === "string") {
        const trimmed = ps.model.trim();
        model = trimmed.length > 0 ? trimmed : null;
      } else if (ps.model !== undefined) {
        ctx.error(res, "priorityScoring.model must be a string or null", 400);
        return true;
      }
      priorityScoring = { enabled, model };
    }
    try {
      const saved = await saveLifeOpsAppState(runtime, {
        enabled: body.enabled,
        priorityScoring,
      });
      json(res, saved);
    } catch (error) {
      ctx.error(
        res,
        `failed to persist LifeOps app state: ${
          error instanceof Error ? error.message : String(error)
        }`,
        500,
      );
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/triage") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const request: GetLifeOpsGmailTriageRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        forceSync: parseBooleanQuery(
          url.searchParams.get("forceSync"),
          "forceSync",
        ),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailTriage(url, request));
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/google/status"
  ) {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        accounts: await service.getGoogleConnectorAccounts(
          url,
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/google/connect"
  ) {
    if (rateLimitRequest(ctx, "connector_write")) return true;
    const body = await ctx.readJsonBody<StartLifeOpsGoogleConnectorRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.startGoogleConnector(body, url));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/google/disconnect"
  ) {
    if (rateLimitRequest(ctx, "connector_write")) return true;
    const body =
      await ctx.readJsonBody<DisconnectLifeOpsGoogleConnectorRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.disconnectGoogleConnector(body, url));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/sync-health") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const grantId = url.searchParams.get("grantId");
      if (!grantId?.trim()) {
        ctx.error(res, "grantId is required", 400);
        return;
      }
      json(
        res,
        await service.getGmailSyncHealth(url, {
          mode: parseConnectorModeQuery(url.searchParams.get("mode")),
          side: parseConnectorSideQuery(url.searchParams.get("side")),
          grantId,
        }),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/seed") {
    if (rateLimitRequest(ctx, "gmail_seed")) return true;
    const body = await ctx.readJsonBody<SeedLifeOpsGmailRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.seedGmailMessages(url, body));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/gmail/imported-data/purge"
  ) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await ctx.readJsonBody<PurgeLifeOpsGmailImportedDataRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.purgeGmailImportedData(url, body));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/search") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const query = url.searchParams.get("query");
      const request: GetLifeOpsGmailSearchRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        forceSync: parseBooleanQuery(
          url.searchParams.get("forceSync"),
          "forceSync",
        ),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
        query: query ?? "",
        replyNeededOnly: parseBooleanQuery(
          url.searchParams.get("replyNeededOnly"),
          "replyNeededOnly",
        ),
        includeSpamTrash: parseBooleanQuery(
          url.searchParams.get("includeSpamTrash"),
          "includeSpamTrash",
        ),
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailSearch(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/needs-response") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const request: GetLifeOpsGmailTriageRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        forceSync: parseBooleanQuery(
          url.searchParams.get("forceSync"),
          "forceSync",
        ),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailNeedsResponse(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/recommendations") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const query = url.searchParams.get("query");
      const request: GetLifeOpsGmailRecommendationsRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        forceSync: parseBooleanQuery(
          url.searchParams.get("forceSync"),
          "forceSync",
        ),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
        query: query ?? undefined,
        replyNeededOnly: parseBooleanQuery(
          url.searchParams.get("replyNeededOnly"),
          "replyNeededOnly",
        ),
        includeSpamTrash: parseBooleanQuery(
          url.searchParams.get("includeSpamTrash"),
          "includeSpamTrash",
        ),
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailRecommendations(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/spam-review") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const request: GetLifeOpsGmailSpamReviewRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        grantId: url.searchParams.get("grantId") ?? undefined,
        status: parseGmailSpamReviewStatusQuery(url.searchParams.get("status")),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
      };
      json(res, await service.getGmailSpamReviewItems(url, request));
    });
  }

  const gmailSpamReviewMatch = pathname.match(
    /^\/api\/lifeops\/gmail\/spam-review\/([^/]+)$/,
  );
  if (method === "PATCH" && gmailSpamReviewMatch) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const itemId = decodeMatchedPathComponent(
      ctx,
      gmailSpamReviewMatch,
      1,
      res,
      "itemId",
    );
    if (!itemId) return true;
    const body = await readJsonBody<UpdateLifeOpsGmailSpamReviewItemRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const status = parseGmailSpamReviewStatusInput(body.status, "status");
      if (!status) {
        throw new LifeOpsServiceError(400, "status is required");
      }
      json(
        res,
        await service.updateGmailSpamReviewItem(url, itemId, { status }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/gmail/unresponded") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const request: GetLifeOpsGmailUnrespondedRequest = {
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        maxResults:
          parsePositiveIntegerQuery(
            url.searchParams.get("maxResults"),
            "maxResults",
          ) ?? undefined,
        olderThanDays:
          parsePositiveIntegerQuery(
            url.searchParams.get("olderThanDays"),
            "olderThanDays",
          ) ?? undefined,
        grantId: url.searchParams.get("grantId") ?? undefined,
      };
      json(res, await service.getGmailUnresponded(url, request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/inbox") {
    return runRoute(ctx, async (service) => {
      const limit =
        parsePositiveIntegerQuery(url.searchParams.get("limit"), "limit") ??
        undefined;
      const rawChannels = url.searchParams.get("channels");
      let channels: LifeOpsInboxChannel[] | undefined;
      if (rawChannels !== null && rawChannels.trim().length > 0) {
        const parsed = rawChannels
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0);
        const parsedChannels: LifeOpsInboxChannel[] = [];
        for (const value of parsed) {
          if (!isOneOf(value, LIFEOPS_INBOX_CHANNELS)) {
            throw new LifeOpsServiceError(
              400,
              `channels must be a comma-separated subset of: ${LIFEOPS_INBOX_CHANNELS.join(", ")}`,
            );
          }
          parsedChannels.push(value);
        }
        channels = parsedChannels;
      }
      const groupByThread = parseBooleanQuery(
        url.searchParams.get("groupByThread"),
        "groupByThread",
      );
      const rawChatTypeFilter = url.searchParams.get("chatTypeFilter");
      let chatTypeFilter: Array<"dm" | "group" | "channel"> | undefined;
      if (rawChatTypeFilter !== null && rawChatTypeFilter.trim().length > 0) {
        const parsed = rawChatTypeFilter
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0);
        const allowed: Array<"dm" | "group" | "channel"> = [];
        for (const value of parsed) {
          if (value !== "dm" && value !== "group" && value !== "channel") {
            throw new LifeOpsServiceError(
              400,
              "chatTypeFilter must be a comma-separated subset of: dm, group, channel",
            );
          }
          allowed.push(value);
        }
        if (allowed.length > 0) chatTypeFilter = allowed;
      }
      const maxParticipants =
        parsePositiveIntegerQuery(
          url.searchParams.get("maxParticipants"),
          "maxParticipants",
        ) ?? undefined;
      const gmailAccountIdRaw = url.searchParams.get("gmailAccountId");
      const gmailAccountId =
        gmailAccountIdRaw !== null && gmailAccountIdRaw.trim().length > 0
          ? gmailAccountIdRaw.trim()
          : undefined;
      const phoneAccountIds = url.searchParams
        .get("phoneAccountIds")
        ?.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const missedOnly = parseBooleanQuery(
        url.searchParams.get("missedOnly"),
        "missedOnly",
      );
      const sortByPriority = parseBooleanQuery(
        url.searchParams.get("sortByPriority"),
        "sortByPriority",
      );
      const rawCacheMode = url.searchParams.get("cacheMode");
      let cacheMode: GetLifeOpsInboxRequest["cacheMode"];
      if (rawCacheMode !== null && rawCacheMode.trim().length > 0) {
        const parsedCacheMode = rawCacheMode.trim().toLowerCase();
        if (!isOneOf(parsedCacheMode, LIFEOPS_INBOX_CACHE_MODES)) {
          throw new LifeOpsServiceError(
            400,
            `cacheMode must be one of: ${LIFEOPS_INBOX_CACHE_MODES.join(", ")}`,
          );
        }
        cacheMode = parsedCacheMode;
      }
      const cacheLimit =
        parsePositiveIntegerQuery(
          url.searchParams.get("cacheLimit"),
          "cacheLimit",
        ) ?? undefined;
      const request: GetLifeOpsInboxRequest = {
        limit,
        channels,
        groupByThread: groupByThread || undefined,
        chatTypeFilter,
        maxParticipants,
        gmailAccountId,
        phoneAccountIds:
          phoneAccountIds && phoneAccountIds.length > 0
            ? phoneAccountIds
            : undefined,
        missedOnly: missedOnly || undefined,
        sortByPriority: sortByPriority || undefined,
        cacheMode,
        cacheLimit,
      };
      json(res, await service.getInbox(request));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/reply-drafts") {
    if (rateLimitRequest(ctx, "gmail_draft")) return true;
    const body = await readJsonBody<CreateLifeOpsGmailReplyDraftRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { draft: await service.createGmailReplyDraft(url, body) }, 201);
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/gmail/batch-reply-drafts"
  ) {
    if (rateLimitRequest(ctx, "gmail_draft")) return true;
    const body = await readJsonBody<CreateLifeOpsGmailBatchReplyDraftsRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        { batch: await service.createGmailBatchReplyDrafts(url, body) },
        201,
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/reply-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailReplyRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailReply(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/message-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailMessageRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailMessage(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/batch-reply-send") {
    if (rateLimitRequest(ctx, "gmail_send")) return true;
    const body = await readJsonBody<SendLifeOpsGmailBatchReplyRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.sendGmailReplies(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/manage") {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await readJsonBody<ManageLifeOpsGmailMessagesRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.manageGmailMessages(url, body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/gmail/events/ingest") {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await readJsonBody<IngestLifeOpsGmailEventRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.ingestGmailEvent(url, body), 202);
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/health/status"
  ) {
    if (rateLimitRequest(ctx, "default")) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getHealthDataConnectorStatuses(
          url,
          parseConnectorModeQuery(url.searchParams.get("mode")),
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      );
    });
  }

  const healthStatusMatch = pathname.match(
    /^\/api\/lifeops\/connectors\/health\/([^/]+)\/status$/,
  );
  if (method === "GET" && healthStatusMatch) {
    if (rateLimitRequest(ctx, "default")) return true;
    const provider = parseHealthConnectorProviderPath(ctx, healthStatusMatch);
    if (!provider) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getHealthDataConnectorStatus(
          provider,
          url,
          parseConnectorModeQuery(url.searchParams.get("mode")),
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      );
    });
  }

  const healthCallbackMatch = pathname.match(
    /^\/api\/lifeops\/connectors\/health\/([^/]+)\/callback$/,
  );
  if (method === "GET" && healthCallbackMatch) {
    const provider = parseHealthConnectorProviderPath(ctx, healthCallbackMatch);
    if (!provider) return true;
    const service = getService(ctx);
    if (!service) return true;
    try {
      await ensureRouteSchema(ctx.state.runtime);
      const status = await service.completeHealthConnectorCallback(url);
      if (status.provider !== provider) {
        throw new LifeOpsServiceError(
          409,
          "Health connector callback provider did not match the request path.",
        );
      }
      writeHtml(
        res,
        200,
        `${provider} Connected`,
        `${provider} health data is now available in Eliza. You can close this window.`,
      );
      return true;
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        writeHtml(res, error.status, "Health Connection Failed", error.message);
        return true;
      }
      throw error;
    }
  }

  const healthSuccessMatch = pathname.match(
    /^\/api\/lifeops\/connectors\/health\/([^/]+)\/success$/,
  );
  if (method === "GET" && healthSuccessMatch) {
    const provider = parseHealthConnectorProviderPath(ctx, healthSuccessMatch);
    if (!provider) return true;
    writeHtml(
      res,
      200,
      `${provider} Connected`,
      `${provider} health data is now available in Eliza. You can close this window.`,
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/lifeops/health/summary") {
    if (rateLimitRequest(ctx, "default")) return true;
    return runRoute(ctx, async (service) => {
      const request: GetLifeOpsHealthSummaryRequest = {
        provider: parseOptionalHealthConnectorProvider(
          url.searchParams.get("provider"),
        ),
        mode: parseConnectorModeQuery(url.searchParams.get("mode")),
        side: parseConnectorSideQuery(url.searchParams.get("side")),
        days:
          parsePositiveIntegerQuery(url.searchParams.get("days"), "days", {
            max: 31,
          }) ?? undefined,
        startDate: parseDateOnlyQuery(
          url.searchParams.get("startDate"),
          "startDate",
        ),
        endDate: parseDateOnlyQuery(url.searchParams.get("endDate"), "endDate"),
        forceSync: url.searchParams.get("forceSync") === "true",
      };
      json(res, await service.getHealthSummary(request));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/connectors/x/status") {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getXConnectorStatus(
          parseConnectorModeQuery(url.searchParams.get("mode")),
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/x/posts") {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<CreateLifeOpsXPostRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createXPost(body), 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/x/dms/digest") {
    return runRoute(ctx, async (service) => {
      const limit =
        parsePositiveIntegerQuery(url.searchParams.get("limit"), "limit", {
          max: 100,
        }) ?? undefined;
      const conversationId = url.searchParams.get("conversationId")?.trim();
      json(
        res,
        await service.getXDmDigest({
          limit,
          conversationId: conversationId?.length ? conversationId : undefined,
        }),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/x/dms/curate") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.curateXDms({
          messageIds: parseOptionalBodyStringArray(body, "messageIds"),
          conversationId: parseOptionalBodyString(body, "conversationId"),
          markRead: parseOptionalBodyBoolean(body, "markRead"),
          markReplied: parseOptionalBodyBoolean(body, "markReplied"),
        }),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/x/dms/send") {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.sendXDirectMessage({
          participantId: requireBodyString(body, "participantId"),
          text: requireBodyString(body, "text"),
          confirmSend: parseOptionalBodyBoolean(body, "confirmSend"),
          mode: parseConnectorModeInput(body.mode),
          side: parseConnectorSideInput(body.side),
        }),
        201,
      );
    });
  }

  // -----------------------------------------------------------------------
  // iMessage connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/imessage/status"
  ) {
    return runRoute(ctx, async (service) => {
      json(res, await service.getIMessageConnectorStatus());
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/imessage/chats"
  ) {
    return runRoute(ctx, async (service) => {
      const chats = await service.listIMessageChats();
      json(res, { chats, count: chats.length });
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/imessage/messages"
  ) {
    return runRoute(ctx, async (service) => {
      const query: GetLifeOpsIMessageMessagesRequest = {
        chatId: url.searchParams.get("chatId")?.trim() || undefined,
        since: url.searchParams.get("since")?.trim() || undefined,
        limit:
          parsePositiveIntegerQuery(url.searchParams.get("limit"), "limit", {
            max: 250,
          }) ?? undefined,
      };
      const messages = await service.readIMessages(query);
      json(res, { messages, count: messages.length });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/imessage/send"
  ) {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.sendIMessage({
          to: requireBodyString(body, "to"),
          text: requireBodyString(body, "text"),
          attachmentPaths: parseOptionalBodyStringArray(
            body,
            "attachmentPaths",
          ),
        }),
        201,
      );
    });
  }

  // -----------------------------------------------------------------------
  // Telegram connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/telegram/status"
  ) {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getTelegramConnectorStatus(
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      );
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/telegram/verify"
  ) {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<VerifyLifeOpsTelegramConnectorRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.verifyTelegramConnector(body));
    });
  }

  // -----------------------------------------------------------------------
  // Discord connector
  // -----------------------------------------------------------------------

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/discord/status"
  ) {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getDiscordConnectorStatus(
          parseConnectorSideQuery(url.searchParams.get("side")),
        ),
      );
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/discord/send"
  ) {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.sendDiscordMessage({
          side: parseConnectorSideFromRequest(url, body),
          channelId: parseOptionalBodyString(body, "channelId"),
          text: requireBodyString(body, "text"),
        }),
        201,
      );
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/discord/verify"
  ) {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.verifyDiscordConnector({
          side: parseConnectorSideFromRequest(url, body),
          channelId: parseOptionalBodyString(body, "channelId"),
          sendMessage: parseOptionalBodyString(body, "sendMessage"),
        }),
      );
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/whatsapp/status"
  ) {
    return runRoute(ctx, async (service) => {
      json(res, await service.getWhatsAppConnectorStatus());
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/connectors/whatsapp/send"
  ) {
    if (rateLimitRequest(ctx, "outbound_message")) return true;
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.sendWhatsAppMessage({
          to: requireBodyString(body, "to"),
          text: requireBodyString(body, "text"),
          replyToMessageId: parseOptionalBodyString(body, "replyToMessageId"),
        }),
        201,
      );
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/connectors/whatsapp/messages"
  ) {
    return runRoute(ctx, async (service) => {
      const limit =
        parsePositiveIntegerQuery(url.searchParams.get("limit"), "limit", {
          max: 500,
        }) ?? 25;
      json(res, await service.pullWhatsAppRecent(limit));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/channel-policies") {
    return runRoute(ctx, async (service) => {
      json(res, { policies: await service.listChannelPolicies() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/channel-policies") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<UpsertLifeOpsChannelPolicyRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { policy: await service.upsertChannelPolicy(body) }, 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/channels/phone-consent") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<CaptureLifeOpsPhoneConsentRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.capturePhoneConsent(body), 201);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/activity-signals") {
    if (!requireActivitySignalsAvailable(ctx)) return true;
    return runRoute(ctx, async (service) => {
      await ensureRouteSchema(ctx.state.runtime);
      json(res, {
        signals: await service.listActivitySignals({
          sinceAt: parseOptionalIsoQuery(
            url.searchParams.get("sinceAt"),
            "sinceAt",
          ),
          limit:
            parsePositiveIntegerQuery(url.searchParams.get("limit"), "limit", {
              max: ACTIVITY_SIGNALS_MAX_LIMIT,
            }) ?? ACTIVITY_SIGNALS_DEFAULT_LIMIT,
          states: parseActivitySignalStates(url),
        }),
      });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/activity-signals") {
    if (!requireActivitySignalsAvailable(ctx)) return true;
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<CaptureLifeOpsActivitySignalRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      await ensureRouteSchema(ctx.state.runtime);
      json(res, { signal: await service.captureActivitySignal(body) }, 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/manual-override") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<CaptureLifeOpsManualOverrideRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.captureManualOverride(body), 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminders/process") {
    if (rateLimitRequest(ctx, "reminders_process")) return true;
    const body = await readJsonBody<ProcessLifeOpsRemindersRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.processReminders(body));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/reminder-preferences") {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getReminderPreference(
          url.searchParams.get("definitionId") ?? undefined,
        ),
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminder-preferences") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<SetLifeOpsReminderPreferenceRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.setReminderPreference(body), 201);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/reminders/acknowledge") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<AcknowledgeLifeOpsReminderRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.acknowledgeReminder(body));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/website-access/relock") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<RelockLifeOpsWebsiteAccessRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.relockWebsiteAccessGroup(body.groupKey));
    });
  }

  const websiteAccessCallbackMatch = pathname.match(
    /^\/api\/lifeops\/website-access\/callbacks\/([^/]+)\/resolve$/,
  );
  if (method === "POST" && websiteAccessCallbackMatch) {
    if (rateLimitRequest(ctx, "default")) return true;
    const callbackKey = decodeMatchedPathComponent(
      ctx,
      websiteAccessCallbackMatch,
      1,
      res,
      "website access callback key",
    );
    if (!callbackKey) return true;
    const body = await readJsonBody<ResolveLifeOpsWebsiteAccessCallbackRequest>(
      req,
      res,
    );
    if (body === null) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.resolveWebsiteAccessCallback(
          body.callbackKey || callbackKey,
        ),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/reminders/inspection") {
    return runRoute(ctx, async (service) => {
      const ownerType = url.searchParams.get("ownerType");
      const ownerId = url.searchParams.get("ownerId");
      if (ownerType !== "occurrence" && ownerType !== "calendar_event") {
        throw new LifeOpsServiceError(
          400,
          "ownerType must be occurrence or calendar_event",
        );
      }
      if (!ownerId) {
        throw new LifeOpsServiceError(400, "ownerId is required");
      }
      json(res, await service.inspectReminder(ownerType, ownerId));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/workflows") {
    return runRoute(ctx, async (service) => {
      json(res, { workflows: await service.listWorkflows() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/workflows") {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const body = await readJsonBody<CreateLifeOpsWorkflowRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createWorkflow(body), 201);
    });
  }

  // Browser companion + package routes extracted to
  // `@elizaos/plugin-browser/routes` (mounted under
  // `/api/browser-bridge/*`).

  if (method === "POST" && pathname === "/api/lifeops/schedule/observations") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<SyncLifeOpsScheduleObservationsRequest>(
      req,
      res,
    );
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.ingestScheduleObservations(body));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/schedule/merged-state") {
    const scopeParam = url.searchParams.get("scope");
    const scope = scopeParam?.trim() ?? "";
    if (
      scope.length > 0 &&
      !LIFEOPS_SCHEDULE_STATE_SCOPES.includes(
        scope as (typeof LIFEOPS_SCHEDULE_STATE_SCOPES)[number],
      ) &&
      scope !== "effective"
    ) {
      ctx.error(res, "scope must be local, cloud, or effective", 400);
      return true;
    }
    const refreshParam = url.searchParams.get("refresh")?.trim().toLowerCase();
    if (
      refreshParam &&
      refreshParam !== "1" &&
      refreshParam !== "0" &&
      refreshParam !== "true" &&
      refreshParam !== "false"
    ) {
      ctx.error(res, "refresh must be true, false, 1, or 0", 400);
      return true;
    }
    const refresh = refreshParam === "1" || refreshParam === "true";
    return runRoute(ctx, async (service) => {
      json(res, {
        mergedState: await service.getScheduleMergedState({
          timezone: url.searchParams.get("timezone"),
          scope:
            scope.length > 0
              ? (scope as "local" | "cloud" | "effective")
              : undefined,
          refresh,
        }),
      });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/schedule/inspection") {
    const timezoneParam = url.searchParams.get("timezone")?.trim() || "UTC";
    return runRoute(ctx, async (service) => {
      json(res, await service.inspectSchedule({ timezone: timezoneParam }));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/schedule/summary") {
    const timezoneParam = url.searchParams.get("timezone")?.trim() || "UTC";
    return runRoute(ctx, async (service) => {
      json(res, await service.readScheduleSummary({ timezone: timezoneParam }));
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/permissions/full-disk-access"
  ) {
    return runRoute(ctx, async () => {
      json(res, await probeFullDiskAccess());
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/screen-time/summary") {
    return runRoute(ctx, async (service) => {
      const window = parseBoundedIsoWindowQuery(url);
      json(
        res,
        await service.getScreenTimeSummary({
          since: window.since,
          until: window.until,
          source: parseScreenTimeSourceQuery(url.searchParams.get("source")),
          identifier: parseScreenTimeIdentifierQuery(
            url.searchParams.get("identifier"),
          ),
          topN:
            parsePositiveIntegerQuery(url.searchParams.get("topN"), "topN", {
              max: 20,
            }) ?? undefined,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/screen-time/breakdown") {
    return runRoute(ctx, async (service) => {
      const window = parseBoundedIsoWindowQuery(url);
      json(
        res,
        await service.getScreenTimeBreakdown({
          since: window.since,
          until: window.until,
          source: parseScreenTimeSourceQuery(url.searchParams.get("source")),
          identifier: parseScreenTimeIdentifierQuery(
            url.searchParams.get("identifier"),
          ),
          topN:
            parsePositiveIntegerQuery(url.searchParams.get("topN"), "topN", {
              max: 50,
            }) ?? undefined,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/screen-time/history") {
    return runRoute(ctx, async (service) => {
      json(
        res,
        await service.getScreenTimeHistory({
          range: parseScreenTimeRangeQuery(url.searchParams.get("range")),
          topN:
            parsePositiveIntegerQuery(url.searchParams.get("topN"), "topN", {
              max: 50,
            }) ?? undefined,
          socialTopN:
            parsePositiveIntegerQuery(
              url.searchParams.get("socialTopN"),
              "socialTopN",
              { max: 50 },
            ) ?? undefined,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/social/summary") {
    return runRoute(ctx, async (service) => {
      const window = parseBoundedIsoWindowQuery(url);
      json(
        res,
        await service.getSocialHabitSummary({
          since: window.since,
          until: window.until,
          topN:
            parsePositiveIntegerQuery(url.searchParams.get("topN"), "topN", {
              max: 50,
            }) ?? undefined,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/capabilities") {
    return runRoute(ctx, async (service) => {
      json(res, await service.getCapabilityStatus());
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/overview") {
    return runRoute(ctx, async (service) => {
      json(res, await service.getOverview());
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/todos") {
    return runRoute(ctx, async (service) => {
      json(res, { todos: await service.getTodos() });
    });
  }

  const todoTransition = pathname.match(
    /^\/api\/lifeops\/definitions\/([^/]+)\/(complete|reopen)$/,
  );
  if (method === "POST" && todoTransition) {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const id = ctx.decodePathComponent(todoTransition[1], res, "definitionId");
    if (!id) return true;
    return runRoute(ctx, async (service) => {
      json(
        res,
        todoTransition[2] === "complete"
          ? await service.completeTodo(id)
          : await service.reopenTodo(id),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/money/dashboard") {
    return runFinancesRoute(ctx, async (service) => {
      const windowDaysRaw = url.searchParams.get("windowDays");
      const windowDays = windowDaysRaw ? Number(windowDaysRaw) : null;
      json(
        res,
        await service.getPaymentsDashboard({
          windowDays: Number.isFinite(windowDays) ? windowDays : null,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/money/sources") {
    return runFinancesRoute(ctx, async (service) => {
      json(res, { sources: await service.listPaymentSources() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/sources") {
    if (rateLimitRequest(ctx, "connector_write")) return true;
    const body = await readJsonBody<AddPaymentSourceRequest>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const source = await service.addPaymentSource(body);
      json(res, { source: sanitizePaymentSourceForClient(source) }, 201);
    });
  }

  if (
    method === "DELETE" &&
    pathname.startsWith("/api/lifeops/money/sources/")
  ) {
    if (rateLimitRequest(ctx, "connector_write")) return true;
    const sourceId = pathname.slice("/api/lifeops/money/sources/".length);
    if (!sourceId) {
      ctx.error(res, "sourceId required", 400);
      return true;
    }
    const decodedSourceId = ctx.decodePathComponent(sourceId, res, "sourceId");
    if (!decodedSourceId) return true;
    return runFinancesRoute(ctx, async (service) => {
      await service.deletePaymentSource(decodedSourceId);
      json(res, { ok: true });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/import-csv") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<{
      sourceId: string;
      csvText: string;
      dateColumn?: string;
      amountColumn?: string;
      merchantColumn?: string;
      descriptionColumn?: string;
      categoryColumn?: string;
    }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.importTransactionsCsv(body);
      json(res, result);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/money/transactions") {
    return runFinancesRoute(ctx, async (service) => {
      const sourceId = url.searchParams.get("sourceId");
      const limitRaw = url.searchParams.get("limit");
      const limit = limitRaw ? Number(limitRaw) : null;
      const merchantContains = url.searchParams.get("merchantContains");
      const onlyDebitsRaw = url.searchParams.get("onlyDebits");
      const transactions = await service.listTransactions({
        sourceId: sourceId ?? null,
        limit: Number.isFinite(limit) ? limit : null,
        merchantContains: merchantContains ?? null,
        onlyDebits: onlyDebitsRaw === "true" ? true : null,
      });
      json(res, { transactions });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/money/recurring") {
    return runFinancesRoute(ctx, async (service) => {
      const sourceId = url.searchParams.get("sourceId");
      const sinceDaysRaw = url.searchParams.get("sinceDays");
      const sinceDays = sinceDaysRaw ? Number(sinceDaysRaw) : null;
      const charges = await service.getRecurringCharges({
        sourceId: sourceId ?? null,
        sinceDays: Number.isFinite(sinceDays) ? sinceDays : null,
      });
      json(res, { charges });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/plaid/webhook") {
    // Public route: the only authentication is the Plaid-Verification ES256
    // JWT, checked by FinancesService.handlePlaidWebhook against the exact
    // raw bytes BEFORE any lookup or state change. The body read is bounded
    // and the stream destroyed on overflow so an unauthenticated sender
    // cannot make this receiver buffer arbitrary bytes.
    const verificationHeader = req.headers["plaid-verification"];
    const verificationJwt = Array.isArray(verificationHeader)
      ? verificationHeader[0]
      : verificationHeader;
    if (typeof verificationJwt !== "string" || verificationJwt.length === 0) {
      ctx.error(res, "Missing Plaid-Verification header.", 401);
      return true;
    }
    if (
      rateLimitRequest(
        ctx,
        "webhook_ingress",
        req.socket.remoteAddress ?? "unknown",
      )
    ) {
      return true;
    }
    const bodyRead = await readPlaidWebhookBody(req);
    if (bodyRead.kind === "timeout") {
      ctx.error(res, "Plaid webhook body read timed out.", 408);
      return true;
    }
    const rawBody = bodyRead.body;
    if (!rawBody || rawBody.length === 0) {
      ctx.error(
        res,
        `Plaid webhook body is missing, unreadable, or exceeds ${PLAID_WEBHOOK_MAX_BODY_BYTES} bytes.`,
        413,
      );
      return true;
    }
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.handlePlaidWebhook({
        rawBody,
        verificationJwt,
      });
      json(res, result);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/plaid/link-token") {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.createPlaidLinkToken();
      json(res, result);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/plaid/complete") {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<{
      publicToken: string;
      label?: string | null;
    }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const source = await service.completePlaidLink({
        publicToken: body.publicToken,
        label: body.label ?? null,
      });
      json(
        res,
        {
          source: sanitizePaymentSourceForClient(source),
        },
        201,
      );
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/money/plaid/update-link-token"
  ) {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<{ sourceId: string }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      json(res, await service.createPlaidUpdateLinkToken(body));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/money/plaid/update-complete"
  ) {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<{ sourceId: string }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const source = await service.completePlaidUpdate(body);
      json(res, { source: sanitizePaymentSourceForClient(source) });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/plaid/disconnect") {
    if (rateLimitRequest(ctx, "connector_write")) return true;
    const body = await readJsonBody<{ sourceId: string }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.disconnectPlaidSource(body);
      json(res, {
        ...result,
        source: sanitizePaymentSourceForClient(result.source),
      });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/plaid/sync") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<{ sourceId: string }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.syncPlaidTransactions({
        sourceId: body.sourceId,
      });
      json(res, result);
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/money/paypal/authorize-url"
  ) {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<{ state: string }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.createPaypalAuthorizeUrl({
        state: body.state,
      });
      json(res, result);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/paypal/complete") {
    if (rateLimitRequest(ctx, "oauth_init")) return true;
    const body = await readJsonBody<{
      code: string;
      label?: string | null;
    }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const { source, capability } = await service.completePaypalLink({
        code: body.code,
        label: body.label ?? null,
      });
      json(
        res,
        {
          source: sanitizePaymentSourceForClient(source),
          capability,
        },
        201,
      );
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/paypal/sync") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<{
      sourceId: string;
      windowDays?: number | null;
    }>(req, res);
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.syncPaypalTransactions({
        sourceId: body.sourceId,
        windowDays: body.windowDays ?? null,
      });
      json(res, result);
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/smart-features/settings") {
    return runRoute(ctx, async (service) => {
      const get = (key: string): string | null => {
        const value = service.runtime.getSetting(key);
        if (value === undefined || value === null) return null;
        return typeof value === "string" ? value : String(value);
      };
      json(res, {
        emailClassifierEnabled:
          (get("lifeops.emailClassifier.enabled") ?? "true") !== "false",
        emailClassifierModel:
          get("lifeops.emailClassifier.model") ?? "TEXT_SMALL",
        billsAutoExtract:
          (get("lifeops.bills.autoExtract") ?? "true") !== "false",
      });
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/smart-features/settings"
  ) {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<{
      emailClassifierEnabled?: boolean;
      emailClassifierModel?: string | null;
      billsAutoExtract?: boolean;
    }>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const setRuntime = service.runtime.setSetting.bind(service.runtime);
      if (typeof setRuntime !== "function") {
        ctx.error(res, "Runtime does not support setSetting", 501);
        return;
      }
      if (typeof body.emailClassifierEnabled === "boolean") {
        setRuntime(
          "lifeops.emailClassifier.enabled",
          body.emailClassifierEnabled ? "true" : "false",
          false,
        );
      }
      if (typeof body.emailClassifierModel === "string") {
        setRuntime(
          "lifeops.emailClassifier.model",
          body.emailClassifierModel.trim() || "TEXT_SMALL",
          false,
        );
      }
      if (typeof body.billsAutoExtract === "boolean") {
        setRuntime(
          "lifeops.bills.autoExtract",
          body.billsAutoExtract ? "true" : "false",
          false,
        );
      }
      json(res, { ok: true });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/money/bills") {
    return runFinancesRoute(ctx, async (service) => {
      const bills = await service.getUpcomingBills({});
      json(res, { bills });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/bills/mark-paid") {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const body = await readJsonBody<{ billId: string; paidAt?: string | null }>(
      req,
      res,
    );
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.markBillPaid({
        billId: body.billId,
        paidAt: body.paidAt ?? null,
      });
      json(res, result);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/money/bills/snooze") {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const body = await readJsonBody<{ billId: string; days?: number }>(
      req,
      res,
    );
    if (!body) return true;
    return runFinancesRoute(ctx, async (service) => {
      const result = await service.snoozeBill({
        billId: body.billId,
        days: body.days ?? 7,
      });
      json(res, result);
    });
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/subscriptions/playbook-lookup"
  ) {
    return runRoute(ctx, async (service) => {
      const merchant = url.searchParams.get("merchant") ?? "";
      const playbook = service.findSubscriptionPlaybookForMerchant(merchant);
      json(res, { playbook });
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/subscriptions/playbooks") {
    return runRoute(ctx, async (service) => {
      const playbooks = await service.listSubscriptionPlaybooks();
      // Trim to a UI-friendly summary; the full step machinery isn't useful
      // to the client and leaks fixture-only entries we don't want exposed.
      const summary = playbooks
        .filter((playbook) => !playbook.key.startsWith("fixture_"))
        .map((playbook) => ({
          key: playbook.key,
          serviceName: playbook.serviceName,
          aliases: playbook.aliases,
          managementUrl: playbook.managementUrl,
          executorPreference: playbook.executorPreference,
        }));
      json(res, { playbooks: summary });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/subscriptions/cancel") {
    if (rateLimitRequest(ctx, "default")) return true;
    const body = await readJsonBody<{
      serviceName?: string | null;
      serviceSlug?: string | null;
      candidateId?: string | null;
      executor?: "user_browser" | "agent_browser" | "desktop_native" | null;
      confirmed?: boolean;
    }>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const summary = await service.cancelSubscription({
        candidateId: body.candidateId ?? null,
        serviceName: body.serviceName ?? null,
        serviceSlug: body.serviceSlug ?? null,
        executor: body.executor ?? null,
        confirmed: body.confirmed ?? false,
      });
      json(res, summary);
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/email-unsubscribe/scan") {
    if (rateLimitRequest(ctx, "google_api_read")) return true;
    return runRoute(ctx, async (service) => {
      const requestUrl = ctx.url;
      const result = await service.scanEmailSubscriptions(requestUrl, {});
      json(res, result);
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/email-unsubscribe/unsubscribe"
  ) {
    if (rateLimitRequest(ctx, "google_api_write")) return true;
    const body = await readJsonBody<{
      senderEmail: string;
      blockAfter?: boolean;
      trashExisting?: boolean;
      /** User reply for two-phase confirmation (e.g. "yes"). */
      userConfirmationText?: string;
    }>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      const runtime = ctx.state.runtime;
      if (!runtime) {
        ctx.error(res, "Agent runtime is not available", 503);
        return;
      }
      const senderEmail = body.senderEmail?.trim();
      if (!senderEmail) {
        ctx.error(res, "senderEmail is required", 400);
        return;
      }
      // Owner identity must match the service's scope (one derivation:
      // configured canonical owner, else the agent-id seed) — never an ad-hoc
      // literal that forks the LifeOps `subject_id`.
      const entityId = service.ownerEntityId();
      const confirmMessage = {
        entityId,
        roomId: entityId,
        content: {
          text:
            typeof body.userConfirmationText === "string"
              ? body.userConfirmationText
              : "",
          source: "lifeops-api",
        },
        createdAt: Date.now(),
      } as Memory;
      const preview = `Unsubscribe from ${senderEmail}?`;
      const decision = await requireConfirmation({
        runtime,
        message: confirmMessage,
        actionName: "EMAIL_UNSUBSCRIBE",
        pendingKey: senderEmail.toLowerCase(),
        prompt: preview,
      });
      if (decision.status !== "confirmed") {
        json(
          res,
          {
            requiresConfirmation: decision.status === "pending",
            awaitingUserInput: decision.status === "pending",
            cancelled: decision.status === "cancelled",
            preview: `${preview} Reply yes to confirm or no to cancel.`,
          },
          decision.status === "pending" ? 409 : 200,
        );
        return;
      }
      const requestUrl = ctx.url;
      const result = await service.unsubscribeEmailSender(requestUrl, {
        senderEmail,
        blockAfter: body.blockAfter ?? false,
        trashExisting: body.trashExisting ?? false,
        userAuthorization: true,
      });
      json(res, result);
    });
  }

  // Routine seeding is handled via the FIRST_RUN customize path
  // (see `src/lifeops/first-run/service.ts`) and the migrator at
  // `src/lifeops/seed-routine-migration/migrator.ts`.

  if (method === "GET" && pathname === "/api/lifeops/definitions") {
    return runRoute(ctx, async (service) => {
      json(res, { definitions: await service.listDefinitions() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/definitions") {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const body = await readJsonBody<CreateLifeOpsDefinitionRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createDefinition(body), 201);
    });
  }

  const definitionMatch = pathname.match(
    /^\/api\/lifeops\/definitions\/([^/]+)$/,
  );
  if (definitionMatch) {
    const definitionId = decodeMatchedPathComponent(
      ctx,
      definitionMatch,
      1,
      res,
      "definition id",
    );
    if (!definitionId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getDefinition(definitionId));
      });
    }
    if (method === "PUT") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      const body = await readJsonBody<UpdateLifeOpsDefinitionRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateDefinition(definitionId, body));
      });
    }
    if (method === "DELETE") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      return runRoute(ctx, async (service) => {
        await service.deleteDefinition(definitionId);
        json(res, { deleted: true });
      });
    }
  }

  if (method === "GET" && pathname === "/api/lifeops/goals") {
    return runRoute(ctx, async (service) => {
      json(res, { goals: await service.listGoals() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/goals") {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const body = await readJsonBody<CreateLifeOpsGoalRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.createGoal(body), 201);
    });
  }

  const goalMatch = pathname.match(/^\/api\/lifeops\/goals\/([^/]+)$/);
  if (goalMatch) {
    const goalId = decodeMatchedPathComponent(
      ctx,
      goalMatch,
      1,
      res,
      "goal id",
    );
    if (!goalId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getGoal(goalId));
      });
    }
    if (method === "PUT") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      const body = await readJsonBody<UpdateLifeOpsGoalRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateGoal(goalId, body));
      });
    }
    if (method === "DELETE") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      return runRoute(ctx, async (service) => {
        await service.deleteGoal(goalId);
        json(res, { deleted: true });
      });
    }
  }

  const goalReviewMatch = pathname.match(
    /^\/api\/lifeops\/goals\/([^/]+)\/review$/,
  );
  if (goalReviewMatch && method === "GET") {
    const goalId = decodeMatchedPathComponent(
      ctx,
      goalReviewMatch,
      1,
      res,
      "goal id",
    );
    if (!goalId) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.reviewGoal(goalId));
    });
  }

  const workflowMatch = pathname.match(/^\/api\/lifeops\/workflows\/([^/]+)$/);
  if (workflowMatch) {
    const workflowId = decodeMatchedPathComponent(
      ctx,
      workflowMatch,
      1,
      res,
      "workflow id",
    );
    if (!workflowId) return true;
    if (method === "GET") {
      return runRoute(ctx, async (service) => {
        json(res, await service.getWorkflow(workflowId));
      });
    }
    if (method === "PUT") {
      if (rateLimitRequest(ctx, "task_update")) return true;
      const body = await readJsonBody<UpdateLifeOpsWorkflowRequest>(req, res);
      if (!body) return true;
      return runRoute(ctx, async (service) => {
        json(res, await service.updateWorkflow(workflowId, body));
      });
    }
  }

  const workflowRunMatch = pathname.match(
    /^\/api\/lifeops\/workflows\/([^/]+)\/run$/,
  );
  if (method === "POST" && workflowRunMatch) {
    if (rateLimitRequest(ctx, "task_create")) return true;
    const workflowId = decodeMatchedPathComponent(
      ctx,
      workflowRunMatch,
      1,
      res,
      "workflow id",
    );
    if (!workflowId) return true;
    const body = await readJsonBody<RunLifeOpsWorkflowRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, { run: await service.runWorkflow(workflowId, body) }, 201);
    });
  }

  // Browser session + companion progress/complete routes extracted to
  // `@elizaos/plugin-browser/routes` (mounted under
  // `/api/browser-bridge/*`).

  const occurrenceExplanationMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/explanation$/,
  );
  if (occurrenceExplanationMatch && method === "GET") {
    const occurrenceId = decodeMatchedPathComponent(
      ctx,
      occurrenceExplanationMatch,
      1,
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    return runRoute(ctx, async (service) => {
      json(res, await service.explainOccurrence(occurrenceId));
    });
  }

  const completeMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/complete$/,
  );
  if (method === "POST" && completeMatch) {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const occurrenceId = decodeMatchedPathComponent(
      ctx,
      completeMatch,
      1,
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<CompleteLifeOpsOccurrenceRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.completeOccurrence(occurrenceId, body),
      });
    });
  }

  const skipMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/skip$/,
  );
  if (method === "POST" && skipMatch) {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const occurrenceId = decodeMatchedPathComponent(
      ctx,
      skipMatch,
      1,
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<Record<string, never>>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.skipOccurrence(occurrenceId),
      });
    });
  }

  const snoozeMatch = pathname.match(
    /^\/api\/lifeops\/occurrences\/([^/]+)\/snooze$/,
  );
  if (method === "POST" && snoozeMatch) {
    if (rateLimitRequest(ctx, "task_update")) return true;
    const occurrenceId = decodeMatchedPathComponent(
      ctx,
      snoozeMatch,
      1,
      res,
      "occurrence id",
    );
    if (!occurrenceId) return true;
    const body = await readJsonBody<SnoozeLifeOpsOccurrenceRequest>(req, res);
    if (!body) return true;
    return runRoute(ctx, async (service) => {
      json(res, {
        occurrence: await service.snoozeOccurrence(occurrenceId, body),
      });
    });
  }

  return false;
}
