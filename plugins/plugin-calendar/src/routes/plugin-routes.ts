/**
 * Runtime adapter binding the calendar HTTP routes to the agent runtime:
 * resolves `CalendarService` at the request boundary, applies rate limiting, and
 * delegates to the path→service dispatcher (`handleCalendarRoutes`), translating
 * service-resolution and domain failures into structured error responses.
 */
import type http from "node:http";
import {
  ElizaError,
  type IAgentRuntime,
  type LegacyRouteHandler,
  logger,
  type Route,
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import {
  GOOGLE_CALENDAR_WEBHOOK_PATH,
  type GoogleCalendarNotificationHeaders,
  type GoogleCalendarWebhookResult,
  isGoogleCalendarWebhookEnabled,
} from "../google-watch/index.js";
import { CalendarServiceError } from "../internal/errors.js";
import {
  type CalendarRouteRateLimitKey,
  type CalendarRouteService,
  handleCalendarRoutes,
} from "./calendar-routes.js";
import {
  CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
  type CalendarOwnerMutationGateway,
} from "./mutation-gateway.js";

type CalendarRateLimitKey = CalendarRouteRateLimitKey | "google_webhook";

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

const CALENDAR_SERVICE_TYPE = "calendar";

const CONNECTOR_MODES = [
  "local",
  "remote",
  "cloud_managed",
] as const satisfies readonly LifeOpsConnectorMode[];
const CONNECTOR_SIDES = [
  "owner",
  "agent",
] as const satisfies readonly LifeOpsConnectorSide[];

const CALENDAR_RATE_LIMITS: Record<CalendarRateLimitKey, RateLimitConfig> = {
  google_webhook: { maxRequests: 60, windowMs: 60_000 },
  google_api_read: { maxRequests: 120, windowMs: 60_000 },
  google_api_write: { maxRequests: 30, windowMs: 60_000 },
  calendar_create: { maxRequests: 20, windowMs: 60_000 },
  calendar_update: { maxRequests: 30, windowMs: 60_000 },
  calendar_delete: { maxRequests: 20, windowMs: 60_000 },
  calendar_source_read: { maxRequests: 120, windowMs: 60_000 },
  calendar_source_write: { maxRequests: 20, windowMs: 60_000 },
  calendar_source_sync: { maxRequests: 30, windowMs: 60_000 },
  calendar_imported_data_purge: { maxRequests: 10, windowMs: 60_000 },
  calendar_link_read: { maxRequests: 120, windowMs: 60_000 },
  calendar_link_write: { maxRequests: 20, windowMs: 60_000 },
};

const runtimeRateLimitBuckets = new WeakMap<
  IAgentRuntime,
  Map<string, number[]>
>();
const unavailableRuntimeRateLimitBuckets = new Map<string, number[]>();
const MAX_RATE_LIMIT_BUCKETS_PER_RUNTIME = 256;
const MAX_RATE_LIMIT_WINDOW_MS = Math.max(
  ...Object.values(CALENDAR_RATE_LIMITS).map((config) => config.windowMs),
);
const MAX_GOOGLE_WEBHOOK_BODY_BYTES = 1_024;

interface GoogleCalendarWebhookService {
  handleGoogleCalendarNotification(
    headers: GoogleCalendarNotificationHeaders,
  ): Promise<GoogleCalendarWebhookResult>;
}

function isGoogleCalendarWebhookService(
  service: unknown,
): service is GoogleCalendarWebhookService {
  return (
    Boolean(service) &&
    typeof service === "object" &&
    typeof (service as Partial<GoogleCalendarWebhookService>)
      .handleGoogleCalendarNotification === "function"
  );
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  const protocol = req.headers["x-forwarded-proto"];
  const normalizedProtocol = Array.isArray(protocol)
    ? protocol[0]
    : (protocol ?? "http");
  return `${normalizedProtocol}://${Array.isArray(host) ? host[0] : host}`;
}

function parseRequestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url ?? "/", requestBaseUrl(req));
}

function isCalendarRouteService(
  service: unknown,
): service is CalendarRouteService {
  return (
    typeof service === "object" &&
    service !== null &&
    typeof (service as CalendarRouteService).getCalendarFeed === "function" &&
    typeof (service as CalendarRouteService).listCalendars === "function" &&
    typeof (service as CalendarRouteService).setCalendarIncluded ===
      "function" &&
    typeof (service as CalendarRouteService).getNextCalendarEventContext ===
      "function" &&
    typeof (service as CalendarRouteService).createCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).updateCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).deleteCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).respondToCalendarEvent ===
      "function" &&
    typeof (service as CalendarRouteService).listIcsCalendarSources ===
      "function" &&
    typeof (service as CalendarRouteService).createIcsCalendarSource ===
      "function" &&
    typeof (service as CalendarRouteService).updateIcsCalendarSource ===
      "function" &&
    typeof (service as CalendarRouteService).deleteIcsCalendarSource ===
      "function" &&
    typeof (service as CalendarRouteService).syncIcsCalendarSource ===
      "function" &&
    typeof (service as CalendarRouteService).purgeImportedCalendarData ===
      "function" &&
    typeof (service as CalendarRouteService).seedImportedCalendarData ===
      "function" &&
    typeof (service as CalendarRouteService).listLinkedCalendarEvents ===
      "function" &&
    typeof (service as CalendarRouteService).listLinkedCalendarEventViews ===
      "function" &&
    typeof (service as CalendarRouteService).getLinkedCalendarEvent ===
      "function"
  );
}

async function resolveCalendarService(
  runtime: IAgentRuntime | null,
): Promise<CalendarRouteService | null> {
  if (!runtime) return null;

  const existing = runtime.getService(CALENDAR_SERVICE_TYPE);
  if (isCalendarRouteService(existing)) {
    return existing;
  }

  try {
    const loaded = await runtime.getServiceLoadPromise(CALENDAR_SERVICE_TYPE);
    return isCalendarRouteService(loaded) ? loaded : null;
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a service-load failure is
    // reported and rethrown as a typed ElizaError with the cause preserved;
    // the route layer maps this to a 503 (distinct from a genuinely absent
    // service, which returns null above without loading).
    runtime.reportError?.("CalendarRoutes.serviceLoad", error, {
      serviceType: CALENDAR_SERVICE_TYPE,
    });
    throw new ElizaError("Calendar service failed to load.", {
      code: "CALENDAR_SERVICE_LOAD_FAILED",
      cause: error,
    });
  }
}

async function resolveGoogleCalendarWebhookService(
  runtime: IAgentRuntime | null,
): Promise<GoogleCalendarWebhookService | null> {
  if (!runtime) return null;
  const existing = runtime.getService(CALENDAR_SERVICE_TYPE);
  if (isGoogleCalendarWebhookService(existing)) return existing;
  try {
    const loaded = await runtime.getServiceLoadPromise(CALENDAR_SERVICE_TYPE);
    return isGoogleCalendarWebhookService(loaded) ? loaded : null;
  } catch (error) {
    // error-policy:J1 This public transport boundary reports service loading
    // and returns an explicit retryable 503 to Google's delivery worker.
    runtime.reportError("CalendarRoutes.googleWebhookServiceLoad", error);
    return null;
  }
}

function singleHeader(req: http.IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) {
    return value.length === 1 && value[0]?.trim() ? value[0].trim() : null;
  }
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type GoogleWebhookBodyInspection = "empty" | "invalid" | "too_large";

function inspectGoogleWebhookBody(
  req: http.IncomingMessage,
): GoogleWebhookBodyInspection {
  const rawBody = (req as http.IncomingMessage & { rawBody?: unknown }).rawBody;
  if (typeof rawBody === "string") {
    const length = Buffer.byteLength(rawBody);
    if (length > MAX_GOOGLE_WEBHOOK_BODY_BYTES) return "too_large";
    if (length > 0) return "invalid";
  } else if (Buffer.isBuffer(rawBody)) {
    if (rawBody.length > MAX_GOOGLE_WEBHOOK_BODY_BYTES) return "too_large";
    if (rawBody.length > 0) return "invalid";
  } else if (rawBody !== undefined && rawBody !== null) {
    return "invalid";
  }

  const parsedBody = (req as http.IncomingMessage & { body?: unknown }).body;
  if (typeof parsedBody === "string") {
    const length = Buffer.byteLength(parsedBody);
    if (length > MAX_GOOGLE_WEBHOOK_BODY_BYTES) return "too_large";
    if (length > 0) return "invalid";
  } else if (Buffer.isBuffer(parsedBody)) {
    if (parsedBody.length > MAX_GOOGLE_WEBHOOK_BODY_BYTES) return "too_large";
    if (parsedBody.length > 0) return "invalid";
  } else if (parsedBody !== undefined && parsedBody !== null) {
    return "invalid";
  }

  const transferEncoding = req.headers["transfer-encoding"];
  if (
    (typeof transferEncoding === "string" && transferEncoding.trim()) ||
    (Array.isArray(transferEncoding) && transferEncoding.length > 0)
  ) {
    return "invalid";
  }

  const contentLength = req.headers["content-length"];
  if (Array.isArray(contentLength)) return "invalid";
  if (typeof contentLength === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength.trim())) return "invalid";
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length)) return "too_large";
    if (length > MAX_GOOGLE_WEBHOOK_BODY_BYTES) return "too_large";
    if (length > 0) return "invalid";
  }
  return "empty";
}

async function handleGoogleCalendarWebhook(args: {
  runtime: IAgentRuntime | null;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}): Promise<void> {
  const { runtime, req, res } = args;
  if (!isGoogleCalendarWebhookEnabled(runtime)) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (
    rateLimitRequest({
      runtime,
      res,
      key: "google_webhook",
      requestIdentity: req.socket?.remoteAddress ?? "unknown",
    })
  ) {
    return;
  }
  const body = inspectGoogleWebhookBody(req);
  if (body === "too_large") {
    res.writeHead(413);
    res.end();
    return;
  }
  if (body === "invalid") {
    res.writeHead(400);
    res.end();
    return;
  }
  // error-policy:J3 Missing or duplicate provider headers become explicit
  // invalid notification fields; lifecycle validation rejects them before I/O.
  const headers: GoogleCalendarNotificationHeaders = {
    channelId: singleHeader(req, "x-goog-channel-id") ?? "",
    channelToken: singleHeader(req, "x-goog-channel-token") ?? "",
    resourceId: singleHeader(req, "x-goog-resource-id") ?? "",
    resourceUri: singleHeader(req, "x-goog-resource-uri") ?? "",
    resourceState: singleHeader(req, "x-goog-resource-state") ?? "",
    messageNumber: singleHeader(req, "x-goog-message-number") ?? "",
  };
  const service = await resolveGoogleCalendarWebhookService(runtime);
  if (!service) {
    res.writeHead(503, { "Retry-After": "60" });
    res.end();
    return;
  }
  try {
    const result = await service.handleGoogleCalendarNotification(headers);
    res.writeHead(
      result.status,
      result.retryAfterSeconds
        ? { "Retry-After": String(result.retryAfterSeconds) }
        : undefined,
    );
    res.end();
  } catch (error) {
    // error-policy:J1 Unexpected storage/runtime failures stay observable and
    // ask Google to retry; the callback never fabricates a successful receipt.
    runtime?.reportError("CalendarRoutes.googleWebhook", error);
    res.writeHead(503, { "Retry-After": "60" });
    res.end();
  }
}

function isCalendarOwnerMutationGateway(
  value: unknown,
): value is CalendarOwnerMutationGateway {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CalendarOwnerMutationGateway)
      .updateLinkedCalendarControl === "function" &&
    typeof (value as CalendarOwnerMutationGateway).create === "function" &&
    typeof (value as CalendarOwnerMutationGateway).update === "function" &&
    typeof (value as CalendarOwnerMutationGateway).cancel === "function" &&
    typeof (value as CalendarOwnerMutationGateway).linkCalendar ===
      "function" &&
    typeof (value as CalendarOwnerMutationGateway).reconcileLinkedCalendar ===
      "function" &&
    typeof (value as CalendarOwnerMutationGateway)
      .resolveLinkedCalendarConflict === "function" &&
    "rebindLinkedCalendar" in value &&
    typeof value.rebindLinkedCalendar === "function" &&
    typeof (value as CalendarOwnerMutationGateway).disconnectLinkedCalendar ===
      "function" &&
    typeof (value as CalendarOwnerMutationGateway)
      .reconcileLinkedCalendarProviderChanges === "function"
  );
}

async function requireCalendarOwnerMutationGateway(
  runtime: IAgentRuntime | null,
): Promise<CalendarOwnerMutationGateway> {
  if (!runtime) {
    throw new CalendarServiceError(
      503,
      "Calendar owner mutation gateway is unavailable.",
      "CALENDAR_OWNER_MUTATION_GATEWAY_UNAVAILABLE",
    );
  }
  const existing = runtime.getService(CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE);
  if (isCalendarOwnerMutationGateway(existing)) return existing;
  try {
    const loaded = await runtime.getServiceLoadPromise(
      CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
    );
    if (isCalendarOwnerMutationGateway(loaded)) return loaded;
  } catch (error) {
    runtime.reportError?.("CalendarRoutes.mutationGatewayLoad", error, {
      serviceType: CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE,
    });
  }
  throw new CalendarServiceError(
    503,
    "Calendar writes require the host approval and durable mutation gateway.",
    "CALENDAR_OWNER_MUTATION_GATEWAY_UNAVAILABLE",
  );
}

function rateLimitRequest(args: {
  runtime: IAgentRuntime | null;
  res: http.ServerResponse;
  key: CalendarRateLimitKey;
  requestIdentity?: string;
}): boolean {
  const { runtime, res, key, requestIdentity = "runtime" } = args;
  const config = CALENDAR_RATE_LIMITS[key];
  let buckets = unavailableRuntimeRateLimitBuckets;
  if (runtime) {
    buckets = runtimeRateLimitBuckets.get(runtime) ?? new Map();
    runtimeRateLimitBuckets.set(runtime, buckets);
  }
  const bucketKey = `${key}:${requestIdentity}`;
  const now = Date.now();
  if (
    !buckets.has(bucketKey) &&
    buckets.size >= MAX_RATE_LIMIT_BUCKETS_PER_RUNTIME
  ) {
    const expiredBefore = now - MAX_RATE_LIMIT_WINDOW_MS;
    for (const [candidateKey, candidateTimestamps] of buckets) {
      if (
        candidateTimestamps.length === 0 ||
        candidateTimestamps.every((timestamp) => timestamp <= expiredBefore)
      ) {
        buckets.delete(candidateKey);
      }
    }
    while (buckets.size >= MAX_RATE_LIMIT_BUCKETS_PER_RUNTIME) {
      const oldestKey = buckets.keys().next().value;
      if (typeof oldestKey !== "string") break;
      buckets.delete(oldestKey);
    }
  }
  const cutoff = now - config.windowMs;
  const timestamps = (buckets.get(bucketKey) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );

  if (timestamps.length >= config.maxRequests) {
    const retryAfterMs = Math.max(
      (timestamps[0] ?? now) + config.windowMs - now,
      0,
    );
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": String(Math.ceil(retryAfterMs / 1_000)),
    });
    res.end(JSON.stringify({ error: "Rate limit exceeded", retryAfterMs }));
    buckets.delete(bucketKey);
    buckets.set(bucketKey, timestamps);
    return true;
  }

  timestamps.push(now);
  buckets.delete(bucketKey);
  buckets.set(bucketKey, timestamps);
  return false;
}

export function __calendarRouteRateLimitBucketCountForTests(
  runtime: IAgentRuntime | null,
): number {
  return runtime
    ? (runtimeRateLimitBuckets.get(runtime)?.size ?? 0)
    : unavailableRuntimeRateLimitBuckets.size;
}

function parseConnectorMode(
  value: string | null,
): LifeOpsConnectorMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!CONNECTOR_MODES.includes(normalized as LifeOpsConnectorMode)) {
    throw new CalendarServiceError(
      400,
      `mode must be one of: ${CONNECTOR_MODES.join(", ")}`,
    );
  }
  return normalized as LifeOpsConnectorMode;
}

function parseConnectorSide(
  value: string | null,
): LifeOpsConnectorSide | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!CONNECTOR_SIDES.includes(normalized as LifeOpsConnectorSide)) {
    throw new CalendarServiceError(
      400,
      `side must be one of: ${CONNECTOR_SIDES.join(", ")}`,
    );
  }
  return normalized as LifeOpsConnectorSide;
}

function parseBoolean(
  value: string | null,
  field: string,
): boolean | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  throw new CalendarServiceError(400, `${field} must be a boolean`);
}

async function readCalendarJsonBody<T extends object>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<T | null> {
  const parsedBody = (req as http.IncomingMessage & { body?: unknown }).body;
  if (parsedBody !== undefined) {
    if (
      parsedBody !== null &&
      typeof parsedBody === "object" &&
      !Array.isArray(parsedBody)
    ) {
      return parsedBody as T;
    }
    sendJsonError(res, "Request body must be a JSON object", 400);
    return null;
  }

  const rawBody = (req as http.IncomingMessage & { rawBody?: unknown }).rawBody;
  if (typeof rawBody === "string") {
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        return parsed as T;
      }
    } catch {
      sendJsonError(res, "Invalid JSON in request body", 400);
      return null;
    }
    sendJsonError(res, "Request body must be a JSON object", 400);
    return null;
  }

  return readJsonBody<T>(req, res);
}

async function runCalendarRoute(
  runtime: IAgentRuntime | null,
  res: http.ServerResponse,
  operation: string,
  fn: (service: CalendarRouteService) => Promise<void>,
): Promise<boolean> {
  const service = await resolveCalendarService(runtime);
  if (!service) {
    logger.warn(
      { boundary: "calendar", operation, statusCode: 503 },
      "[calendar] Route rejected because CalendarService is unavailable",
    );
    sendJsonError(res, "Calendar service is not available.", 503);
    return true;
  }

  try {
    await fn(service);
    return true;
  } catch (error) {
    // error-policy:J1 boundary translation — typed CalendarServiceError maps to
    // its carried status; any other error is logged and rethrown to the outer
    // server handler as a 5xx rather than being masked as a route success.
    if (error instanceof CalendarServiceError) {
      const logFn =
        error.status === 401
          ? logger.debug.bind(logger)
          : logger.warn.bind(logger);
      logFn(
        { boundary: "calendar", operation, statusCode: error.status },
        `[calendar] Route failed: ${error.message}`,
      );
      sendJsonError(res, error.message, error.status);
      return true;
    }
    logger.error(
      { boundary: "calendar", operation },
      `[calendar] Route crashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

export function calendarRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as IAgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = parseRequestUrl(httpReq);
    const operation = `${method} ${url.pathname}`;

    if (method === "POST" && url.pathname === GOOGLE_CALENDAR_WEBHOOK_PATH) {
      await handleGoogleCalendarWebhook({
        runtime: agentRuntime,
        req: httpReq,
        res: httpRes,
      });
      return;
    }

    const handled = await handleCalendarRoutes({
      method,
      pathname: url.pathname,
      url,
      runRoute: (fn) => runCalendarRoute(agentRuntime, httpRes, operation, fn),
      rateLimit: (key) =>
        rateLimitRequest({
          runtime: agentRuntime,
          res: httpRes,
          key,
        }),
      json: (data, status) => sendJson(httpRes, data, status),
      readJsonBody: <T extends object>() =>
        readCalendarJsonBody<T>(httpReq, httpRes),
      decodePathComponent: (raw, label) => {
        try {
          return decodeURIComponent(raw);
        } catch {
          sendJsonError(
            httpRes,
            `Invalid ${label}: malformed URL encoding`,
            400,
          );
          return null;
        }
      },
      parseConnectorMode,
      parseConnectorSide,
      parseBoolean,
      serviceError: (status, message) =>
        new CalendarServiceError(status, message),
      mutationGateway: {
        async updateLinkedCalendarControl(requestUrl, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.updateLinkedCalendarControl(requestUrl, request);
        },
        async create(requestUrl, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.create(requestUrl, request);
        },
        async update(requestUrl, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.update(requestUrl, request);
        },
        async cancel(requestUrl, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.cancel(requestUrl, request);
        },
        async linkCalendar(requestUrl, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.linkCalendar(requestUrl, request);
        },
        async reconcileLinkedCalendar(requestUrl, linkId, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.reconcileLinkedCalendar(requestUrl, linkId, request);
        },
        async resolveLinkedCalendarConflict(requestUrl, linkId, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.resolveLinkedCalendarConflict(
            requestUrl,
            linkId,
            request,
          );
        },
        async rebindLinkedCalendar(requestUrl, linkId, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.rebindLinkedCalendar(requestUrl, linkId, request);
        },
        async disconnectLinkedCalendar(requestUrl, linkId, request) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.disconnectLinkedCalendar(requestUrl, linkId, request);
        },
        async reconcileLinkedCalendarProviderChanges(
          requestUrl,
          providerEventIds,
        ) {
          const gateway =
            await requireCalendarOwnerMutationGateway(agentRuntime);
          return gateway.reconcileLinkedCalendarProviderChanges(
            requestUrl,
            providerEventIds,
          );
        },
      },
    });

    if (!handled && !httpRes.headersSent) {
      sendJsonError(httpRes, "Not found", 404);
    }
  };
}

const handler = calendarRouteHandler();

export const calendarHttpRoutes: Route[] = [
  // Owner calendar data, preferences, and mutations are mounted by the
  // personal-assistant host after its OWNER/ADMIN role gate. The only route
  // this provider plugin can authenticate independently is its webhook.
  {
    type: "POST",
    path: "/api/lifeops/calendar/google/webhook",
    rawPath: true,
    public: true,
    name: "google-calendar-push-notification",
    publicReason:
      "Google Calendar must deliver provider-originated change notifications without a user session.",
    publicWrite:
      "An explicit runtime setting enables the route; bounded body checks and rate limiting precede service access, then an unguessable per-channel capability token plus durable resource bindings authorize a refetch.",
    handler,
  },
];
