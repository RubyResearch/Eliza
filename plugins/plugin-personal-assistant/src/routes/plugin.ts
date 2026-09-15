/**
 * Personal-assistant HTTP route plugin — registers the raw `/api/lifeops/*`,
 * entity/relationship, scheduled-task, sleep, and website-blocker route
 * handlers on the agent's server and enforces access before dispatch.
 *
 * This is the auth/authorization boundary for the LifeOps REST surface: it runs
 * the framework token check, resolves the session, and applies OWNER/ADMIN role
 * gating (loosened for trusted-local requests) so downstream handlers such as
 * `lifeops-routes.ts` can trust the caller. Also exports
 * `requireLifeOpsRouteOwnerAdminAccess` for reuse by sibling route modules.
 */

import type http from "node:http";
import { TLSSocket } from "node:tls";
import { handleConnectorAccountRoutes } from "@elizaos/agent/api/connector-account-routes";
import { decodePathComponent } from "@elizaos/agent/api/server-helpers";
import {
  ensureRouteAuthorized,
  ensureSessionForRequest,
  getCompatApiToken,
  getProvidedApiToken,
  tokenMatches,
} from "@elizaos/app-core/api/auth";
import { isTrustedLocalRequest } from "@elizaos/app-core/api/compat-route-shared";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import type {
  AgentRuntime,
  LegacyRouteHandler,
  Plugin,
  Route,
  UUID,
} from "@elizaos/core";
import {
  sendJson as httpSendJson,
  sendJsonError as httpSendJsonError,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import {
  readJsonBody as httpReadJsonBody,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import {
  AGREEMENT_UPLOAD_CHUNK_BYTES,
  AGREEMENT_UPLOAD_METADATA_BYTES,
} from "../lifeops/household/agreement-upload-limits.js";
import { getScheduledTaskRunner } from "../lifeops/scheduled-task/service.js";
import { handleAgreementKnowledgeRoutes } from "./agreement-knowledge-routes.js";
import {
  type LifeOpsAuthenticatedPrincipal,
  resolveLifeOpsAuthenticatedPrincipal,
} from "./authenticated-entity-principal.js";
import { handleEntityRoutes } from "./entities.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleLifeOpsRoutes } from "./lifeops-routes.js";
import { handleRelationshipRoutes } from "./relationships.js";
import {
  DEV_REGISTRIES_ROUTE_PATHS,
  makeScheduledTasksRouteHandler,
} from "./scheduled-tasks.js";
import { handleSleepRoutes } from "./sleep-routes.js";
import type { WebsiteBlockerRouteContext } from "./website-blocker-routes.js";
import { handleWebsiteBlockerRoutes } from "./website-blocker-routes.js";

const requestPrincipals = new WeakMap<
  http.IncomingMessage,
  LifeOpsAuthenticatedPrincipal
>();

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  httpSendJson(res, data, status);
}

function error(res: http.ServerResponse, message: string, status = 400): void {
  httpSendJsonError(res, message, status);
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.split(",")[0]?.trim();
  return normalized ? normalized : null;
}

function requestBaseUrl(req: http.IncomingMessage): string {
  const headers = req.headers;
  const protocol =
    firstHeaderValue(headers["x-forwarded-proto"]) ??
    (req.socket instanceof TLSSocket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    firstHeaderValue(headers["x-forwarded-host"]) ??
    firstHeaderValue(headers.host) ??
    "localhost";
  return `${protocol}://${host}`;
}

function routeOwnerEntityId(runtime: AgentRuntime | null): UUID | null {
  if (!runtime) {
    return null;
  }
  // Same derivation as the chat write surface and LifeOps service scope.
  return resolveOwnerEntityIdOrDefault(runtime);
}

function runtimeAuthDb(runtime: AgentRuntime): unknown {
  return (runtime as { adapter?: { db?: unknown } | null }).adapter?.db;
}

function hasConfiguredOwnerToken(req: http.IncomingMessage): boolean {
  const expectedToken = getCompatApiToken();
  const providedToken = getProvidedApiToken(req);
  return Boolean(
    expectedToken &&
      providedToken &&
      tokenMatches(expectedToken, providedToken),
  );
}

async function requestHasOwnerRouteRole(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: AgentRuntime;
}): Promise<boolean> {
  const { req, res, runtime } = args;
  if (isTrustedLocalRequest(req)) {
    return true;
  }

  const db = runtimeAuthDb(runtime);
  if (!db) {
    return hasConfiguredOwnerToken(req);
  }

  if (
    process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1" &&
    hasConfiguredOwnerToken(req)
  ) {
    return true;
  }

  const store = new AuthStore(db as ConstructorParameters<typeof AuthStore>[0]);
  const context = await ensureSessionForRequest(req, res, {
    store,
    allowBootstrapBearer: false,
  });
  return context?.identity?.kind === "owner";
}

export async function requireLifeOpsRouteOwnerAdminAccess(args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: AgentRuntime | null;
}): Promise<boolean> {
  const { req, res, runtime } = args;
  if (!runtime) {
    error(res, "Agent runtime is not available", 503);
    return false;
  }

  try {
    const authorized = await ensureRouteAuthorized(req, res, {
      current: runtime,
    });
    if (!authorized) {
      return false;
    }
    if (await requestHasOwnerRouteRole({ req, res, runtime })) {
      return true;
    }
  } catch {
    error(res, "LifeOps route access could not be verified", 403);
    return false;
  }

  error(res, "LifeOps routes require OWNER or ADMIN access", 403);
  return false;
}

function buildLifeOpsContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): LifeOpsRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: routeOwnerEntityId(runtime),
      requestEntityId:
        requestPrincipals.get(req)?.entityId ?? routeOwnerEntityId(runtime),
    },
    json,
    error,
    readJsonBody: httpReadJsonBody,
    decodePathComponent,
  };
}

function buildWebsiteBlockerContext(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: AgentRuntime | null,
): WebsiteBlockerRouteContext {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", requestBaseUrl(req));
  return {
    req,
    res,
    method,
    pathname: url.pathname,
    runtime: runtime ?? undefined,
    ownerEntityId: routeOwnerEntityId(runtime),
    readJsonBody: httpReadJsonBody,
    json,
    error,
  };
}

function runtimeSetting(
  runtime: AgentRuntime | null,
  key: string,
): string | undefined {
  const value = runtime?.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildCloudProxyConfig(
  runtime: AgentRuntime | null,
): CloudProxyConfigLike {
  if (resolveDevCloudEnvAuthority()) {
    const authorityValue = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = resolveDevCloudAuthorityEnvValue(key)?.trim();
        if (value) return value;
      }
      return undefined;
    };
    return {
      cloud: {
        apiKey: authorityValue(
          "ELIZAOS_CLOUD_API_KEY",
          "ELIZA_CLOUD_API_KEY",
          "ELIZACLOUD_API_KEY",
        ),
        baseUrl: authorityValue(
          "ELIZAOS_CLOUD_BASE_URL",
          "ELIZA_CLOUD_BASE_URL",
          "ELIZA_CLOUD_URL",
          "ELIZAOS_CLOUD_URL",
        ),
        serviceKey: authorityValue(
          "ELIZAOS_CLOUD_SERVICE_KEY",
          "ELIZA_CLOUD_SERVICE_KEY",
        ),
      },
    };
  }
  return {
    cloud: {
      apiKey:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_API_KEY") ??
        process.env.ELIZAOS_CLOUD_API_KEY,
      baseUrl:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_BASE_URL") ??
        process.env.ELIZAOS_CLOUD_BASE_URL,
      serviceKey:
        runtimeSetting(runtime, "ELIZAOS_CLOUD_SERVICE_KEY") ??
        process.env.ELIZAOS_CLOUD_SERVICE_KEY,
    },
  };
}

type HttpRouteType = Exclude<Route["type"], "STATIC">;

interface PrivateRouteSpec {
  type: HttpRouteType;
  path: string;
  public?: false;
  access?: "owner" | "authenticated_entity";
  maxBodyBytes?: number;
}

interface PublicRouteSpec {
  type: HttpRouteType;
  path: string;
  public: true;
  name: string;
  publicReason: string;
  /** Required for non-GET public routes: names the out-of-band auth. */
  publicWrite?: string;
  maxBodyBytes?: number;
}

type RouteSpec = PrivateRouteSpec | PublicRouteSpec;

const LIFEOPS_STATIC_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/lifeops/app-state" },
  { type: "PUT", path: "/api/lifeops/app-state" },
  { type: "GET", path: "/api/lifeops/capabilities" },
  { type: "GET", path: "/api/lifeops/calendar/feed" },
  { type: "POST", path: "/api/lifeops/calendar/imported-data/purge" },
  { type: "POST", path: "/api/lifeops/calendar/seed" },
  { type: "GET", path: "/api/lifeops/calendar/sources" },
  { type: "POST", path: "/api/lifeops/calendar/sources" },
  { type: "GET", path: "/api/lifeops/calendar/meeting-auto-join" },
  { type: "PUT", path: "/api/lifeops/calendar/meeting-auto-join" },
  { type: "GET", path: "/api/lifeops/calendar/calendars" },
  { type: "PUT", path: "/api/lifeops/calendar/calendars/:id/include" },
  { type: "GET", path: "/api/lifeops/calendar/next-context" },
  { type: "GET", path: "/api/lifeops/calendar/sync-control" },
  { type: "POST", path: "/api/lifeops/calendar/sync-control" },
  { type: "GET", path: "/api/lifeops/calendar/links" },
  { type: "POST", path: "/api/lifeops/calendar/links" },
  { type: "POST", path: "/api/lifeops/calendar/cards" },
  { type: "GET", path: "/api/lifeops/gmail/triage" },
  { type: "GET", path: "/api/lifeops/gmail/sync-health" },
  { type: "POST", path: "/api/lifeops/gmail/seed" },
  { type: "POST", path: "/api/lifeops/gmail/imported-data/purge" },
  { type: "GET", path: "/api/lifeops/gmail/search" },
  { type: "GET", path: "/api/lifeops/gmail/needs-response" },
  { type: "GET", path: "/api/lifeops/gmail/recommendations" },
  { type: "GET", path: "/api/lifeops/gmail/spam-review" },
  { type: "GET", path: "/api/lifeops/gmail/unresponded" },
  { type: "POST", path: "/api/lifeops/calendar/events" },
  { type: "GET", path: "/api/lifeops/inbox" },
  { type: "POST", path: "/api/lifeops/gmail/reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-drafts" },
  { type: "POST", path: "/api/lifeops/gmail/reply-send" },
  { type: "POST", path: "/api/lifeops/gmail/message-send" },
  { type: "POST", path: "/api/lifeops/gmail/batch-reply-send" },
  { type: "POST", path: "/api/lifeops/gmail/manage" },
  { type: "POST", path: "/api/lifeops/gmail/events/ingest" },
  { type: "GET", path: "/api/lifeops/connectors/google/status" },
  { type: "POST", path: "/api/lifeops/connectors/google/connect" },
  { type: "POST", path: "/api/lifeops/connectors/google/disconnect" },
  { type: "GET", path: "/api/lifeops/connectors/x/status" },
  { type: "POST", path: "/api/lifeops/x/posts" },
  { type: "GET", path: "/api/lifeops/x/dms/digest" },
  { type: "POST", path: "/api/lifeops/x/dms/curate" },
  { type: "POST", path: "/api/lifeops/x/dms/send" },
  // iMessage
  { type: "GET", path: "/api/lifeops/connectors/imessage/status" },
  { type: "GET", path: "/api/lifeops/connectors/imessage/chats" },
  { type: "GET", path: "/api/lifeops/connectors/imessage/messages" },
  { type: "POST", path: "/api/lifeops/connectors/imessage/send" },
  // Telegram
  { type: "GET", path: "/api/lifeops/connectors/telegram/status" },
  { type: "POST", path: "/api/lifeops/connectors/telegram/verify" },
  // Discord
  { type: "GET", path: "/api/lifeops/connectors/discord/status" },
  { type: "POST", path: "/api/lifeops/connectors/discord/send" },
  { type: "POST", path: "/api/lifeops/connectors/discord/verify" },
  // WhatsApp
  { type: "GET", path: "/api/lifeops/connectors/whatsapp/status" },
  { type: "POST", path: "/api/lifeops/connectors/whatsapp/send" },
  { type: "GET", path: "/api/lifeops/connectors/whatsapp/messages" },
  { type: "GET", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channel-policies" },
  { type: "POST", path: "/api/lifeops/channels/phone-consent" },
  { type: "GET", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/activity-signals" },
  { type: "POST", path: "/api/lifeops/manual-override" },
  { type: "POST", path: "/api/lifeops/reminders/process" },
  { type: "GET", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminder-preferences" },
  { type: "POST", path: "/api/lifeops/reminders/acknowledge" },
  { type: "POST", path: "/api/lifeops/website-access/relock" },
  { type: "GET", path: "/api/lifeops/reminders/inspection" },
  { type: "GET", path: "/api/lifeops/workflows" },
  { type: "POST", path: "/api/lifeops/workflows" },
  // Browser companion + package routes moved to
  // `@elizaos/plugin-browser/plugin` (under `/api/browser-bridge/*`).
  { type: "POST", path: "/api/lifeops/schedule/observations" },
  { type: "GET", path: "/api/lifeops/schedule/merged-state" },
  { type: "GET", path: "/api/lifeops/schedule/inspection" },
  { type: "GET", path: "/api/lifeops/schedule/summary" },
  { type: "GET", path: "/api/lifeops/permissions/full-disk-access" },
  { type: "GET", path: "/api/lifeops/screen-time/summary" },
  { type: "GET", path: "/api/lifeops/screen-time/breakdown" },
  { type: "GET", path: "/api/lifeops/screen-time/history" },
  { type: "GET", path: "/api/lifeops/social/summary" },
  { type: "GET", path: "/api/lifeops/overview" },
  { type: "GET", path: "/api/lifeops/todos" },
  { type: "POST", path: "/api/lifeops/definitions/:id/complete" },
  { type: "POST", path: "/api/lifeops/definitions/:id/reopen" },
  { type: "GET", path: "/api/lifeops/connectors/health/status" },
  { type: "GET", path: "/api/lifeops/health/summary" },
  { type: "GET", path: "/api/lifeops/money/dashboard" },
  { type: "GET", path: "/api/lifeops/money/sources" },
  { type: "POST", path: "/api/lifeops/money/sources" },
  { type: "POST", path: "/api/lifeops/money/import-csv" },
  { type: "GET", path: "/api/lifeops/money/transactions" },
  { type: "GET", path: "/api/lifeops/money/recurring" },
  { type: "POST", path: "/api/lifeops/money/plaid/link-token" },
  { type: "POST", path: "/api/lifeops/money/plaid/complete" },
  { type: "POST", path: "/api/lifeops/money/plaid/update-link-token" },
  { type: "POST", path: "/api/lifeops/money/plaid/update-complete" },
  { type: "POST", path: "/api/lifeops/money/plaid/disconnect" },
  { type: "POST", path: "/api/lifeops/money/plaid/sync" },
  {
    type: "POST",
    name: "lifeops.money.plaid.webhook",
    publicReason:
      "Plaid delivers Item/transaction webhooks directly to the callback URL registered at link time; Plaid cannot hold the local gate token.",
    publicWrite:
      "Authenticated out-of-band by the Plaid-Verification ES256 JWT: signature against Plaid's JWK (kid lookup through Eliza Cloud), exact raw-body SHA-256 pinning, and a bounded iat freshness window — all verified before any lookup or state change.",
    // `path` sits directly above `public` so the public-route audit ledger
    // attributes this declaration to the webhook path, not a neighbouring route.
    path: "/api/lifeops/money/plaid/webhook",
    public: true,
  },
  { type: "POST", path: "/api/lifeops/money/paypal/authorize-url" },
  { type: "POST", path: "/api/lifeops/money/paypal/complete" },
  { type: "POST", path: "/api/lifeops/money/paypal/sync" },
  { type: "GET", path: "/api/lifeops/money/bills" },
  { type: "POST", path: "/api/lifeops/money/bills/mark-paid" },
  { type: "POST", path: "/api/lifeops/money/bills/snooze" },
  { type: "GET", path: "/api/lifeops/smart-features/settings" },
  { type: "POST", path: "/api/lifeops/smart-features/settings" },
  { type: "GET", path: "/api/lifeops/subscriptions/playbook-lookup" },
  { type: "GET", path: "/api/lifeops/subscriptions/playbooks" },
  { type: "POST", path: "/api/lifeops/subscriptions/cancel" },
  { type: "POST", path: "/api/lifeops/email-unsubscribe/scan" },
  { type: "POST", path: "/api/lifeops/email-unsubscribe/unsubscribe" },
  { type: "GET", path: "/api/lifeops/seed-templates" },
  { type: "POST", path: "/api/lifeops/seed" },
  { type: "GET", path: "/api/lifeops/definitions" },
  { type: "POST", path: "/api/lifeops/definitions" },
  { type: "GET", path: "/api/lifeops/goals" },
  { type: "POST", path: "/api/lifeops/goals" },
  { type: "POST", path: "/api/lifeops/features/toggle" },
  { type: "GET", path: "/api/lifeops/agreements" },
  { type: "GET", path: "/api/lifeops/agreements/pin-targets" },
  { type: "POST", path: "/api/lifeops/agreements" },
  {
    type: "POST",
    path: "/api/lifeops/agreement-uploads",
    maxBodyBytes: AGREEMENT_UPLOAD_METADATA_BYTES,
  },
  { type: "GET", path: "/api/lifeops/agreement-uploads/:id" },
  {
    type: "PUT",
    path: "/api/lifeops/agreement-uploads/:id/chunks/:index",
    maxBodyBytes: AGREEMENT_UPLOAD_CHUNK_BYTES,
  },
  {
    type: "POST",
    path: "/api/lifeops/agreement-uploads/:id/commit",
    maxBodyBytes: AGREEMENT_UPLOAD_METADATA_BYTES,
  },
  { type: "POST", path: "/api/lifeops/agreements/grants/preview" },
  { type: "POST", path: "/api/lifeops/agreements/grants" },
  { type: "POST", path: "/api/lifeops/account-handoffs" },
  { type: "GET", path: "/api/lifeops/account-handoffs/active" },
  { type: "GET", path: "/api/lifeops/account-handoffs/retirement-candidates" },
  { type: "GET", path: "/api/lifeops/account-handoffs/calendar-entries" },
  { type: "GET", path: "/api/lifeops/account-handoffs/:operationId" },
  { type: "POST", path: "/api/lifeops/account-handoffs/:operationId/cancel" },
  { type: "POST", path: "/api/lifeops/account-handoffs/:operationId/advance" },
  { type: "PUT", path: "/api/lifeops/family-workflows/school/source" },
  { type: "GET", path: "/api/lifeops/family-workflows/school/status" },
  { type: "POST", path: "/api/lifeops/family-workflows/school/run" },
  { type: "POST", path: "/api/lifeops/family-workflows/school/apply" },
  { type: "POST", path: "/api/lifeops/family-workflows/run-now" },
  { type: "POST", path: "/api/lifeops/family-workflows/export" },
  { type: "GET", path: "/api/lifeops/family-workflows/deletion/preview" },
  { type: "GET", path: "/api/lifeops/family-workflows/deletion" },
  { type: "POST", path: "/api/lifeops/family-workflows/deletion" },
  { type: "POST", path: "/api/lifeops/family-workflows/deletion/resume" },
  {
    type: "GET",
    path: "/api/lifeops/family-workflows/deletion/backups/preview",
  },
  { type: "POST", path: "/api/lifeops/family-workflows/deletion/backups" },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/deletion/backups/resume",
  },
  { type: "GET", path: "/api/lifeops/family-workflows/email-options" },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/email-recipients/confirm",
  },
  { type: "GET", path: "/api/lifeops/family-workflows/intake" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake/import" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake/interview" },
  { type: "GET", path: "/api/lifeops/family-workflows/packets" },
  { type: "POST", path: "/api/lifeops/family-workflows/packets" },
  // Knowledge-graph: entities + relationships.
  { type: "GET", path: "/api/lifeops/entities" },
  { type: "POST", path: "/api/lifeops/entities" },
  { type: "GET", path: "/api/lifeops/entities/resolve" },
  { type: "POST", path: "/api/lifeops/entities/merge" },
  { type: "GET", path: "/api/lifeops/relationships" },
  { type: "POST", path: "/api/lifeops/relationships" },
  { type: "POST", path: "/api/lifeops/relationships/observe" },
];

const LIFEOPS_DYNAMIC_ROUTES: RouteSpec[] = [
  { type: "POST", path: "/api/lifeops/family-workflows/intake/:id/extract" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake/:id/review" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake/:id/withdraw" },
  { type: "POST", path: "/api/lifeops/family-workflows/intake/:id/reselect" },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/intake/:id/request-decision",
  },

  {
    type: "GET",
    path: "/api/lifeops/family-workflows/school/runs/:runId",
  },
  { type: "GET", path: "/api/lifeops/family-workflows/packets/:packetId" },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/packets/:packetId/drafts",
  },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/packets/:packetId/drafts/:draftVersion/approval",
  },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/packets/:packetId/drafts/:draftVersion/revision",
  },
  {
    type: "POST",
    path: "/api/lifeops/family-workflows/packets/:packetId/drafts/:draftVersion/decision",
  },
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/status",
  },
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/callback",
    public: true,
    name: "lifeops.health.callback",
    publicReason:
      "Health connector OAuth callbacks must accept provider redirects.",
  },
  {
    type: "GET",
    path: "/api/lifeops/connectors/health/:provider/success",
    public: true,
    name: "lifeops.health.success",
    publicReason:
      "Health connector OAuth success landing must render after provider redirects.",
  },
  // /api/lifeops/money/sources/:sourceId
  { type: "DELETE", path: "/api/lifeops/money/sources/:sourceId" },
  // /api/lifeops/calendar/events/:eventId
  { type: "PATCH", path: "/api/lifeops/calendar/events/:eventId" },
  { type: "DELETE", path: "/api/lifeops/calendar/events/:eventId" },
  // /api/lifeops/calendar/links/:id
  { type: "GET", path: "/api/lifeops/calendar/links/:id" },
  { type: "POST", path: "/api/lifeops/calendar/links/:id/reconcile" },
  { type: "POST", path: "/api/lifeops/calendar/links/:id/resolve" },
  { type: "POST", path: "/api/lifeops/calendar/links/:id/disconnect" },
  {
    type: "GET",
    path: "/api/lifeops/calendar/cards/:cardId",
    access: "authenticated_entity",
  },
  { type: "DELETE", path: "/api/lifeops/calendar/cards/:cardId" },
  // /api/lifeops/calendar/sources/:sourceId
  { type: "PATCH", path: "/api/lifeops/calendar/sources/:sourceId" },
  { type: "DELETE", path: "/api/lifeops/calendar/sources/:sourceId" },
  { type: "POST", path: "/api/lifeops/calendar/sources/:sourceId/sync" },
  // /api/lifeops/gmail/spam-review/:itemId
  { type: "PATCH", path: "/api/lifeops/gmail/spam-review/:itemId" },
  // /api/lifeops/definitions/:id
  { type: "GET", path: "/api/lifeops/definitions/:id" },
  { type: "PUT", path: "/api/lifeops/definitions/:id" },
  { type: "DELETE", path: "/api/lifeops/definitions/:id" },
  // /api/lifeops/goals/:id
  { type: "GET", path: "/api/lifeops/goals/:id" },
  { type: "PUT", path: "/api/lifeops/goals/:id" },
  { type: "DELETE", path: "/api/lifeops/goals/:id" },
  // /api/lifeops/goals/:id/review
  { type: "GET", path: "/api/lifeops/goals/:id/review" },
  // /api/lifeops/workflows/:id
  { type: "GET", path: "/api/lifeops/workflows/:id" },
  { type: "PUT", path: "/api/lifeops/workflows/:id" },
  // /api/lifeops/workflows/:id/run
  { type: "POST", path: "/api/lifeops/workflows/:id/run" },
  // Browser session + package dynamic routes moved to
  // `@elizaos/plugin-browser/plugin` (under `/api/browser-bridge/*`).
  // /api/lifeops/occurrences/:id/explanation
  { type: "GET", path: "/api/lifeops/occurrences/:id/explanation" },
  // /api/lifeops/occurrences/:id/complete
  { type: "POST", path: "/api/lifeops/occurrences/:id/complete" },
  // /api/lifeops/occurrences/:id/skip
  { type: "POST", path: "/api/lifeops/occurrences/:id/skip" },
  // /api/lifeops/occurrences/:id/snooze
  { type: "POST", path: "/api/lifeops/occurrences/:id/snooze" },
  // /api/lifeops/website-access/callbacks/:key/resolve
  { type: "POST", path: "/api/lifeops/website-access/callbacks/:key/resolve" },
  // Knowledge-graph dynamic routes.
  { type: "GET", path: "/api/lifeops/entities/:id" },
  { type: "PATCH", path: "/api/lifeops/entities/:id" },
  { type: "POST", path: "/api/lifeops/entities/:id/identities" },
  { type: "POST", path: "/api/lifeops/entities/:id/auth-bindings" },
  { type: "GET", path: "/api/lifeops/relationships/:id" },
  { type: "PATCH", path: "/api/lifeops/relationships/:id" },
  { type: "POST", path: "/api/lifeops/relationships/:id/retire" },
  { type: "GET", path: "/api/lifeops/agreements/:id" },
  { type: "GET", path: "/api/lifeops/agreements/:id/guest-options" },
  { type: "GET", path: "/api/lifeops/agreements/:id/review" },
  { type: "POST", path: "/api/lifeops/agreements/:id/review" },
  {
    type: "GET",
    path: "/api/lifeops/agreements/:id/shared",
    access: "authenticated_entity",
  },
  { type: "GET", path: "/api/lifeops/agreements/:id/download" },
  { type: "POST", path: "/api/lifeops/agreements/:id/export" },
  {
    type: "GET",
    path: "/api/lifeops/agreements/:id/guest-projection",
  },
  { type: "POST", path: "/api/lifeops/agreements/:id/obligations" },
  { type: "GET", path: "/api/lifeops/agreements/:id/pins" },
  { type: "POST", path: "/api/lifeops/agreements/:id/pins" },
  {
    type: "POST",
    path: "/api/lifeops/agreements/obligations/:id/decision",
  },
  { type: "DELETE", path: "/api/lifeops/agreements/pins/:id" },
  { type: "POST", path: "/api/lifeops/agreements/grants/:id/revoke" },
];

// ---------------------------------------------------------------------------
// Sleep routes (history / regularity / baseline)
// ---------------------------------------------------------------------------

const LIFEOPS_SLEEP_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/lifeops/sleep/history" },
  { type: "GET", path: "/api/lifeops/sleep/regularity" },
  { type: "GET", path: "/api/lifeops/sleep/baseline" },
];

// ---------------------------------------------------------------------------
// Website-blocker routes
// ---------------------------------------------------------------------------

const WEBSITE_BLOCKER_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/website-blocker" },
  { type: "GET", path: "/api/website-blocker/status" },
  { type: "POST", path: "/api/website-blocker" },
  { type: "PUT", path: "/api/website-blocker" },
  { type: "DELETE", path: "/api/website-blocker" },
];

const CLOUD_FEATURE_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/cloud/features" },
  { type: "POST", path: "/api/cloud/features/sync" },
];

const TRAVEL_PROVIDER_RELAY_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/cloud/travel-providers/:provider/:providerPath*" },
  {
    type: "POST",
    path: "/api/cloud/travel-providers/:provider/:providerPath*",
  },
];

const GOOGLE_CONNECTOR_ACCOUNT_ROUTES: RouteSpec[] = [
  { type: "GET", path: "/api/connectors/google/accounts" },
  { type: "POST", path: "/api/connectors/google/accounts" },
  { type: "GET", path: "/api/connectors/google/accounts/:accountId" },
  { type: "PATCH", path: "/api/connectors/google/accounts/:accountId" },
  { type: "DELETE", path: "/api/connectors/google/accounts/:accountId" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/test" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/refresh" },
  { type: "POST", path: "/api/connectors/google/accounts/:accountId/default" },
  { type: "POST", path: "/api/connectors/google/oauth/start" },
  { type: "GET", path: "/api/connectors/google/oauth/status" },
  {
    type: "GET",
    path: "/api/connectors/google/oauth/callback",
    public: true,
    name: "connectors.google.oauth.callback",
    publicReason: "Google OAuth callback must accept provider redirects.",
  },
  {
    type: "POST",
    path: "/api/connectors/google/oauth/callback",
    public: true,
    name: "connectors.google.oauth.callback.post",
    publicReason:
      "Google OAuth callback POST must accept provider redirect exchanges.",
    publicWrite:
      "Provider redirect exchange POST authenticated by the OAuth state/code, not the local gate.",
  },
  { type: "GET", path: "/api/connectors/google/audit/events" },
];

// ---------------------------------------------------------------------------
// Build Plugin Route arrays
// ---------------------------------------------------------------------------

interface CloudProxyConfigLike {
  cloud?: {
    apiKey?: string;
    baseUrl?: string;
    serviceKey?: string;
  };
}

function withOwnerAdminGate(handler: LegacyRouteHandler): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: httpReq,
      res: httpRes,
      runtime: agentRuntime,
    });
    if (!allowed) {
      return;
    }
    requestPrincipals.set(httpReq, {
      kind: "owner",
      entityId: String(routeOwnerEntityId(agentRuntime) ?? SELF_ENTITY_ID),
      authIdentityId: null,
    });
    try {
      await handler(req as never, res as never, runtime as never);
    } finally {
      requestPrincipals.delete(httpReq);
    }
  };
}

function withAuthenticatedEntityGate(
  handler: LegacyRouteHandler,
): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    if (!agentRuntime) {
      error(httpRes, "Agent runtime is not available", 503);
      return;
    }
    const resolved = await resolveLifeOpsAuthenticatedPrincipal({
      req: httpReq,
      runtime: agentRuntime,
    });
    if (!resolved.ok) {
      error(httpRes, resolved.reason, resolved.status);
      return;
    }
    const principal =
      resolved.principal.kind === "owner"
        ? {
            ...resolved.principal,
            entityId: String(
              routeOwnerEntityId(agentRuntime) ?? SELF_ENTITY_ID,
            ),
          }
        : resolved.principal;
    requestPrincipals.set(httpReq, principal);
    try {
      await handler(req as never, res as never, runtime as never);
    } finally {
      requestPrincipals.delete(httpReq);
    }
  };
}

function buildRawRoutes(
  specs: readonly RouteSpec[],
  handler: LegacyRouteHandler,
): Route[] {
  return specs.map((spec): Route => {
    if (spec.public) {
      return {
        type: spec.type,
        path: spec.path,
        rawPath: true,
        public: true,
        name: spec.name,
        publicReason: spec.publicReason,
        ...(spec.publicWrite ? { publicWrite: spec.publicWrite } : {}),
        ...(spec.maxBodyBytes === undefined
          ? {}
          : { maxBodyBytes: spec.maxBodyBytes }),
        handler,
      };
    }
    return {
      type: spec.type,
      path: spec.path,
      rawPath: true,
      ...(spec.maxBodyBytes === undefined
        ? {}
        : { maxBodyBytes: spec.maxBodyBytes }),
      handler:
        spec.access === "authenticated_entity"
          ? withAuthenticatedEntityGate(handler)
          : withOwnerAdminGate(handler),
    };
  });
}

function lifeOpsRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildLifeOpsContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    if (await handleEntityRoutes(ctx)) return;
    if (await handleRelationshipRoutes(ctx)) return;
    if (await handleAgreementKnowledgeRoutes(ctx)) return;
    await handleLifeOpsRoutes(ctx);
  };
}

function scheduledTasksRouteHandler(): LegacyRouteHandler {
  // The runner is created per-request because it depends on the
  // runtime which is only available inside the route call. The runtime
  // wiring registers the built-in gates / completion-checks / ladders
  // and uses the LifeOpsRepository for storage.
  const handle = makeScheduledTasksRouteHandler({
    async resolveRunner(ctx) {
      const runtime = ctx.state.runtime;
      if (!runtime) {
        ctx.error(ctx.res, "Agent runtime is not available", 503);
        return null;
      }
      return getScheduledTaskRunner(runtime, {
        agentId: runtime.agentId,
      });
    },
  });
  return async (req, res, runtime): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    // Cast: the elizaOS LegacyRouteHandler passes RouteResponse (an abstract
    // wrapper), but the underlying value at runtime is a raw Node.js
    // ServerResponse. The shapes differ at the type level, so we cast through
    // unknown to access the raw response methods needed by buildLifeOpsContext.
    const httpRes = res as unknown as http.ServerResponse;
    const ctx = buildLifeOpsContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    const handled = await handle(ctx);
    if (!handled) {
      error(httpRes, "Scheduled-tasks route not found", 404);
    }
  };
}

function sleepRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildLifeOpsContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    await handleSleepRoutes(ctx);
  };
}

function websiteBlockerRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const ctx = buildWebsiteBlockerContext(
      httpReq,
      httpRes,
      (runtime as AgentRuntime) ?? null,
    );
    await handleWebsiteBlockerRoutes(ctx);
  };
}

function cloudFeaturesRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const { handleCloudFeaturesRoute } = await import(
      "./cloud-features-routes.js"
    );
    await handleCloudFeaturesRoute(httpReq, httpRes, url.pathname, method, {
      config: buildCloudProxyConfig(agentRuntime),
      runtime: agentRuntime,
    });
  };
}

function travelProviderRelayRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const agentRuntime = (runtime as AgentRuntime) ?? null;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const { handleTravelProviderRelayRoute } = await import(
      "@elizaos/plugin-elizacloud/routes/travel-provider-relay-routes"
    );
    await handleTravelProviderRelayRoute(
      httpReq,
      httpRes,
      url.pathname,
      method,
      {
        config: buildCloudProxyConfig(agentRuntime),
        runtime: agentRuntime,
      },
    );
  };
}

function googleConnectorAccountRouteHandler(): LegacyRouteHandler {
  return async (
    req: unknown,
    res: unknown,
    runtime: unknown,
  ): Promise<void> => {
    const httpReq = req as http.IncomingMessage;
    const httpRes = res as http.ServerResponse;
    const method = (httpReq.method ?? "GET").toUpperCase();
    const url = new URL(httpReq.url ?? "/", requestBaseUrl(httpReq));
    const handled = await handleConnectorAccountRoutes({
      req: httpReq,
      res: httpRes,
      method,
      pathname: url.pathname,
      state: {
        runtime: (runtime as AgentRuntime) ?? null,
      },
      json,
      error,
      readJsonBody: httpReadJsonBody,
      authorize: async () => true,
    });
    if (!handled) {
      error(httpRes, "Connector account route not found", 404);
    }
  };
}

const lifeOpsPluginRoutes: Route[] = [
  ...buildRawRoutes(CLOUD_FEATURE_ROUTES, cloudFeaturesRouteHandler()),
  ...buildRawRoutes(
    TRAVEL_PROVIDER_RELAY_ROUTES,
    travelProviderRelayRouteHandler(),
  ),
  ...buildRawRoutes(
    GOOGLE_CONNECTOR_ACCOUNT_ROUTES,
    googleConnectorAccountRouteHandler(),
  ),
  ...buildRawRoutes(LIFEOPS_STATIC_ROUTES, lifeOpsRouteHandler()),
  ...buildRawRoutes(LIFEOPS_DYNAMIC_ROUTES, lifeOpsRouteHandler()),
  // Only the PA-specific dev `/registries` composite stays here; the generic
  // scheduled-task CRUD + history + dev-log + spine-registry routes are served
  // by the always-loaded @elizaos/plugin-scheduling on every platform.
  ...buildRawRoutes(DEV_REGISTRIES_ROUTE_PATHS, scheduledTasksRouteHandler()),
  ...buildRawRoutes(LIFEOPS_SLEEP_ROUTES, sleepRouteHandler()),
  ...buildRawRoutes(WEBSITE_BLOCKER_ROUTES, websiteBlockerRouteHandler()),
];

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export const personalAssistantRoutesPlugin: Plugin = {
  name: "@elizaos/plugin-personal-assistant-routes",
  description:
    "LifeOps dashboard, Google Workspace, website blocker, and scheduling routes",
  dependencies: ["@elizaos/plugin-google-workspace"],
  routes: lifeOpsPluginRoutes,
};
