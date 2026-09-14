/**
 * Shared cloud-audit fixtures + Playwright helpers (extracted from
 * cloud-surfaces-aesthetic-audit.spec.ts so the focused Applications
 * dropdown contrast spec (#14232) reuses the SAME auth seeding + API stub
 * surface — a thinner stub set leaves ApplicationDetailPage stuck on its
 * session-not-ready loading spinner instead of the real analytics/earnings
 * tab. Keeping one source of truth avoids drift between the two specs.
 */
import { isDeepStrictEqual } from "node:util";
import {
  STEWARD_ACTIVE_SCOPE_KEY,
  STEWARD_TOKEN_KEY,
  STEWARD_TOKEN_SCOPE_KEY,
} from "@elizaos/shared/steward-session-client";
import type { Page, Request, Route } from "@playwright/test";

function requestBodyMatches(request: Request, expected: object): boolean {
  try {
    const body: unknown = request.postDataJSON();
    return isDeepStrictEqual(body, expected);
  } catch {
    // error-policy:J3 Malformed request JSON is an explicit fixture rejection.
    return false;
  }
}

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.sig`;
}

export async function seedStewardToken(
  page: Page,
  agentId = "6f9619ff-8b86-4d01-b42d-00c04fc964ff",
): Promise<void> {
  const token = makeJwt({
    sub: "cloud-audit-smoke-user",
    email: "cloud-audit-smoke@agent.local",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  await page.addInitScript(
    ({ activeScopeKey, key, tokenScopeKey, value, agentId }) => {
      const scope = "eliza-cloud:production";
      localStorage.setItem(key, value);
      localStorage.setItem(tokenScopeKey, scope);
      localStorage.setItem(activeScopeKey, scope);
      localStorage.setItem("eliza:first-run-complete", "1");
      localStorage.setItem("eliza:first-run-complete:cloud-only:v1", "1");
      localStorage.setItem("eliza:setup:step", "activate");
      localStorage.setItem(
        "elizaos:active-server",
        JSON.stringify({
          id: `cloud:${agentId}`,
          kind: "cloud",
          label: "Eliza Cloud",
          accessToken: "ui-smoke-agent-access-token",
        }),
      );
    },
    {
      activeScopeKey: STEWARD_ACTIVE_SCOPE_KEY,
      key: STEWARD_TOKEN_KEY,
      tokenScopeKey: STEWARD_TOKEN_SCOPE_KEY,
      value: token,
      agentId,
    },
  );
}

// ── Cloud API stubs ──────────────────────────────────────────────────────────
// Installed per page; shapes traced from packages/ui/src/cloud/** data hooks
// (each rule cites its consumer). The goal is a real zero/populated render per
// page, not a mocked component: the page code, routing, auth gates, and design
// system all run for real. Anything unmatched falls through to the
// deterministic stub backend (501), and the page's rendered failure state is
// itself part of the audit.

const NOW_ISO = new Date().toISOString();
const FUTURE_ISO = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const BILLING_CONTAINER_NEXT_ISO = "2026-08-22T11:20:30.000Z";
const BILLING_SANDBOX_LAST_ISO = "2026-08-20T08:07:06.000Z";
const BILLING_SANDBOX_ESTIMATED_NEXT_ISO = "2026-08-23T12:34:56.000Z";

/**
 * Exact, per-resource assertions for the production-shaped billing audit.
 *
 * These values are deliberately counterfactual: the container is hourly and
 * the sandbox is daily, and each card has a different mix of reported and
 * null cursors. This prevents the visual gate from passing if the client
 * infers billing authority from resource type or swaps cursor fields.
 */
export const BILLING_AUDIT_RESOURCE_EXPECTATIONS = [
  {
    name: "Smoke API container",
    identity: "Container · container-smoke-api",
    fields: [
      { label: "Billing period", value: "Hourly" },
      { label: "Last billed", value: "Not reported" },
      { label: "Next billing", value: "2026-08-22 11:20:30 UTC" },
      { label: "Estimated next billing", value: "Not estimated" },
    ],
  },
  {
    name: "Smoke research agent",
    identity: "Agent sandbox · sandbox-smoke-research",
    fields: [
      { label: "Billing period", value: "Daily" },
      { label: "Last billed", value: "2026-08-20 08:07:06 UTC" },
      { label: "Next billing", value: "Not scheduled" },
      {
        label: "Estimated next billing",
        value: "2026-08-23 12:34:56 UTC",
      },
    ],
  },
] as const;
/** ApplicationDetailPage requires a valid UUID id (redirects otherwise). */
export const SMOKE_APP_UUID = "6f9619ff-8b86-4d01-b42d-00c04fc964ff";

const SMOKE_APP = {
  id: SMOKE_APP_UUID,
  name: "Smoke App",
  slug: "smoke-app",
  description: "Deterministic ui-smoke application fixture",
  app_url: "https://smoke-app.example.com",
  logo_url: null,
  allowed_origins: ["https://smoke-app.example.com"],
  is_active: true,
  deployment_status: "READY",
  monetization_enabled: false,
  purchase_share_percent: null,
  metadata: {},
  total_users: 3,
  total_requests: 128,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
};

const SMOKE_USER = {
  id: "cloud-audit-smoke-user",
  email: "cloud-audit-smoke@agent.local",
  name: "Smoke Reviewer",
  role: "owner",
  organization_id: "org-smoke-1",
  wallet_address: null,
  work_function: null,
  preferences: {},
  email_notifications: true,
  response_notifications: false,
  is_active: true,
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  organization: {
    id: "org-smoke-1",
    name: "Smoke Org",
    slug: "smoke-org",
    billing_email: "billing@agent.local",
    credit_balance: "42.00",
    is_active: true,
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  },
};

const ANALYTICS_TIME_SERIES_POINT = {
  timestamp: NOW_ISO,
  totalRequests: 12,
  totalCost: 0.42,
  inputTokens: 5200,
  outputTokens: 1800,
  successRate: 1,
  successRatePercent: 100,
};

/** EnhancedAnalyticsDataDto (packages/cloud/shared/src/lib/types/cloud-api.ts). */
const ANALYTICS_BREAKDOWN = {
  filters: {
    startDate: NOW_ISO,
    endDate: NOW_ISO,
    granularity: "day",
    timeRange: "weekly",
  },
  overallStats: {
    totalRequests: 12,
    totalInputTokens: 5200,
    totalOutputTokens: 1800,
    totalCost: 0.42,
    // Fraction in [0, 1] — the stat card multiplies by 100 for display.
    successRate: 1,
  },
  timeSeriesData: [ANALYTICS_TIME_SERIES_POINT],
  userBreakdown: [],
  costTrending: {
    currentDailyBurn: 0.06,
    previousDailyBurn: 0.05,
    burnChangePercent: 20,
    projectedMonthlyBurn: 1.8,
    daysUntilBalanceZero: 700,
    monthlyBurnPercent: 4.3,
    monthlyBurnPercentClamped: 4.3,
    burnAlertThresholdExceeded: false,
  },
  organization: { creditBalance: "42.00" },
  providerBreakdown: [],
  modelBreakdown: [],
  trends: {
    requestsChange: 0,
    costChange: 0,
    tokensChange: 0,
    successRateChange: 0,
    period: "weekly",
  },
};

interface StubRule {
  /** Method to match (default GET). */
  method?: string;
  /** Pathname test, run against `new URL(request.url()).pathname`. */
  match: (pathname: string, search: URLSearchParams) => boolean;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

export type CloudAuditAgentState = "shared" | "provisioning" | "dedicated";

export interface CloudAuditFixtureOptions {
  initialAgentState?: CloudAuditAgentState;
  creditBalance?: number;
  quoteCanActivate?: boolean;
}

export interface CloudAuditRequestReceipt {
  method: string;
  url: string;
  pathname: string;
  status: number;
  body: string | null;
  responseBody: string;
}

export interface CloudAuditFixtureController {
  readonly agentState: CloudAuditAgentState;
  readonly requests: readonly CloudAuditRequestReceipt[];
  readonly unhandledRequests: readonly string[];
  completeProvisioning(): void;
}

const PERSONAL_AGENT_ID = "personal:00000000-0000-5000-8000-000000000001";
export const CLOUD_AUDIT_DEDICATED_AGENT_ID =
  "00000000-0000-4000-8000-000000000002";
const DEDICATED_API_BASE = `https://${CLOUD_AUDIT_DEDICATED_AGENT_ID}.cloud.eliza.app`;
const DEDICATED_QUOTE_ID =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEDICATED_JOB_ID = "00000000-0000-4000-8000-000000000003";
const INSUFFICIENT_UPGRADE_CREDITS =
  "Insufficient credits to upgrade. A dedicated agent costs $3.00/day of hosting, and upgrading requires a balance above $9.00 (3 days of hosting). Please add at least $9.00 to your account at /cloud/billing.";

const path_ = (p: string) => (pathname: string) => pathname === p;
const prefix = (p: string) => (pathname: string) => pathname.startsWith(p);

// NOTE: table order matters — first match wins.
const STUB_RULES: StubRule[] = [
  {
    match: (pathname) =>
      pathname === "/auth/providers" || pathname === "/steward/auth/providers",
    body: {
      passkey: false,
      email: true,
      sms: true,
      siwe: false,
      siws: false,
      google: true,
      discord: true,
      github: false,
      twitter: false,
      oauth: ["google", "discord"],
    },
  },
  // StewardProviderRuntime mirrors the seeded browser token into the server's
  // HttpOnly session cookie before protected Cloud routes render.
  {
    method: "POST",
    match: path_("/api/auth/steward-session"),
    body: { success: true },
  },
  {
    // Startup probes the selected managed agent directly. Keep that probe
    // authenticated so the shell reaches the Cloud route instead of waiting
    // on a synthetic external origin that cannot answer the audit fixture.
    match: path_("/api/auth/status"),
    body: {
      required: false,
      authenticated: true,
      loginRequired: false,
      bootstrapRequired: false,
      localAccess: false,
      passwordConfigured: true,
      pairingEnabled: false,
      expiresAt: null,
    },
  },
  {
    // Canonical AuthMeResult consumed by useAuthStatus during cold startup.
    match: path_("/api/auth/me"),
    body: {
      identity: {
        id: "cloud-audit-smoke-user",
        displayName: "Smoke Reviewer",
        kind: "owner",
      },
      session: {
        id: "cloud-audit-smoke-session",
        kind: "browser",
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
      access: {
        mode: "session",
        passwordConfigured: true,
        ownerConfigured: true,
        role: "OWNER",
      },
    },
  },
  {
    // The notification store hydrates as soon as AuthMe confirms authority.
    // An explicit empty inbox is a ready state, not a transport fallback.
    match: path_("/api/notifications"),
    body: { notifications: [], unreadCount: 0 },
  },
  {
    // Startup re-checks first-run state against the selected managed agent's
    // dedicated origin. The local smoke server only covers its own origin, so
    // make the managed-agent probe deterministic as well.
    match: path_("/api/first-run/status"),
    body: { complete: true, cloudProvisioned: true },
  },
  {
    // The shell records best-effort activity during startup. Keep that write
    // inside the deterministic audit backend so CORS noise cannot turn an
    // otherwise healthy Cloud surface into a broken visual finding.
    method: "POST",
    match: path_("/api/lifeops/activity-signals"),
    status: 201,
    body: { signal: null },
  },
  // Normal app-shell hydration follows the selected managed agent's dedicated
  // origin. Keep that real request path deterministic while Cloud management
  // pages mount inside the shell.
  { match: path_("/api/conversations"), body: { conversations: [] } },
  {
    method: "POST",
    match: path_("/api/conversations"),
    body: {
      conversation: {
        id: "cloud-management-smoke-conversation",
        roomId: "cloud-management-smoke-room",
        title: "New Conversation",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      },
    },
  },
  {
    method: "POST",
    match: prefix(
      "/api/conversations/cloud-management-smoke-conversation/greeting",
    ),
    body: { text: "Hello from Eliza" },
  },
  {
    // Chat history hydration/pagination for the conversation created above —
    // the shell requests /messages (optionally with ?before=) once the
    // conversation mounts; an unmatched fall-through 404s and trips the
    // zero-diagnostics guard in specs that assert a clean console.
    match: prefix(
      "/api/conversations/cloud-management-smoke-conversation/messages",
    ),
    body: { messages: [], hasMore: false },
  },
  {
    match: path_("/api/agent/events"),
    body: {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    },
  },
  {
    match: path_("/api/character"),
    body: {
      character: {
        name: "Eliza",
        bio: ["Cloud management smoke agent"],
        system: "You are Eliza",
        adjectives: ["helpful"],
        style: { all: [], chat: [], post: [] },
        postExamples: [],
        messageExamples: [],
      },
    },
  },
  {
    match: path_("/api/stream/settings"),
    body: { ok: true, settings: { theme: "dark", avatarIndex: 1 } },
  },
  {
    method: "POST",
    match: path_("/api/stream/settings"),
    body: { ok: true, settings: { theme: "dark", avatarIndex: 1 } },
  },
  {
    method: "POST",
    match: path_("/api/apps/overlay-presence"),
    body: { ok: true, app: null, present: false },
  },
  // The managed-agent shell boots these agent-scoped resources in parallel
  // with Cloud routes. Stub their empty canonical states so aesthetic audits
  // never escape to the synthetic *.cloud.eliza.app origin and fail on CORS.
  { match: path_("/api/apps"), body: [] },
  { match: path_("/api/catalog/apps"), body: [] },
  { match: path_("/api/views"), body: { views: [] } },
  {
    match: path_("/api/browser-workspace"),
    body: { mode: "web", tabs: [] },
  },
  {
    match: path_("/api/status"),
    body: { status: "running", canRespond: true },
  },
  {
    match: path_(
      `/api/v1/eliza/agents/${CLOUD_AUDIT_DEDICATED_AGENT_ID}/backups`,
    ),
    body: { success: true, data: [] },
  },
  {
    match: path_(`/api/compat/agents/${CLOUD_AUDIT_DEDICATED_AGENT_ID}/logs`),
    body: { success: true, data: "" },
  },
  {
    method: "POST",
    match: path_("/api/views/cloud/elements"),
    body: { success: true },
  },
  // my-agents characters/saved lists.
  {
    match: path_("/api/my-agents/characters"),
    body: { success: true, data: { characters: [] } },
  },
  {
    match: path_("/api/my-agents/saved"),
    body: { success: true, data: { agents: [] } },
  },
  // account-security/ — user profile, sessions, MFA, audit, plugin grants.
  { match: path_("/api/v1/user"), body: { success: true, data: SMOKE_USER } },
  { match: path_("/api/v1/sessions"), body: { sessions: [] } },
  { match: path_("/api/v1/me/mfa"), body: { enrolled: false } },
  { match: path_("/api/v1/me/plugin-grants"), body: { grants: [] } },
  {
    match: path_("/api/v1/me/account-deletion"),
    body: {
      state: "lifecycle_unavailable",
      request: null,
      code: "LIFECYCLE_RESERVATION_REQUIRED",
      message: "Lifecycle reservation required",
    },
  },
  { match: prefix("/api/v1/security/audit"), body: { events: [] } },
  // organization/ — members/invites/credentials (owner role).
  {
    match: prefix("/api/organizations/"),
    body: { success: true, data: [] },
  },
  // analytics/ — envelopes are { success, data } (analytics-data.ts).
  {
    match: path_("/api/analytics/breakdown"),
    body: { success: true, data: ANALYTICS_BREAKDOWN },
  },
  {
    match: path_("/api/analytics/projections"),
    body: {
      success: true,
      data: {
        historicalData: [ANALYTICS_TIME_SERIES_POINT],
        projections: [],
        alerts: [],
        alertEvents: [],
        creditBalance: 42,
      },
    },
  },
  // billing/ — credits, settings, invoices, crypto (fail-soft), checkout.
  {
    match: path_("/api/v1/billing/limits"),
    body: {
      success: true,
      data: {
        observedAt: NOW_ISO,
        schemaVersion: 2,
        v2: {
          snapshotStartedAt: NOW_ISO,
          snapshotCompletedAt: NOW_ISO,
          balance: {
            status: "available",
            source: "credit-ledger",
            observedAt: NOW_ISO,
            value: {
              balance: { value: "42.000000", unit: "usd", currency: "USD" },
              revision: "42",
            },
          },
          activeCompute: {
            resources: {
              status: "available",
              source: "account-billing-primary",
              observedAt: NOW_ISO,
              value: [
                {
                  resourceType: "container",
                  resourceId: "container-smoke-api",
                  name: "Smoke API container",
                  status: "running",
                  billingStatus: "active",
                  billingInterval: "hour",
                  lastBilledAt: null,
                  nextBillingAt: BILLING_CONTAINER_NEXT_ISO,
                  estimatedNextBillingAt: null,
                  cancellationControl: {
                    displayAction: "stop",
                    method: "POST",
                    mode: "stop",
                    endpoint:
                      "/api/v1/billing/resources/container-smoke-api/cancel?resourceType=container",
                    expectedLifecycleRevision: 1,
                    eligible: true,
                    blockers: [],
                  },
                  ratePerHour: {
                    status: "available",
                    source: "compute-billing-rate-segments",
                    observedAt: NOW_ISO,
                    value: {
                      value: "0.125000",
                      unit: "usd_per_hour",
                      currency: "USD",
                    },
                  },
                  estimatedRecurringComputeCostPerDay: {
                    status: "available",
                    source: "compute-billing-rate-segments",
                    observedAt: NOW_ISO,
                    value: {
                      value: "3.000000",
                      unit: "usd_per_day",
                      currency: "USD",
                    },
                  },
                },
                {
                  resourceType: "agent_sandbox",
                  resourceId: "sandbox-smoke-research",
                  name: "Smoke research agent",
                  status: "running",
                  billingStatus: "active",
                  billingInterval: "day",
                  lastBilledAt: BILLING_SANDBOX_LAST_ISO,
                  nextBillingAt: null,
                  estimatedNextBillingAt: BILLING_SANDBOX_ESTIMATED_NEXT_ISO,
                  cancellationControl: {
                    displayAction: "stop_compute",
                    method: "POST",
                    mode: "stop",
                    endpoint:
                      "/api/v1/billing/resources/sandbox-smoke-research/cancel?resourceType=agent_sandbox",
                    expectedLifecycleRevision: 2,
                    eligible: true,
                    blockers: [],
                  },
                  ratePerHour: {
                    status: "available",
                    source: "compute-billing-rate-segments",
                    observedAt: NOW_ISO,
                    value: {
                      value: "0.050000",
                      unit: "usd_per_hour",
                      currency: "USD",
                    },
                  },
                  estimatedRecurringComputeCostPerDay: {
                    status: "available",
                    source: "compute-billing-rate-segments",
                    observedAt: NOW_ISO,
                    value: {
                      value: "1.200000",
                      unit: "usd_per_day",
                      currency: "USD",
                    },
                  },
                },
              ],
            },
            estimatedRecurringComputeCostPerDay: {
              status: "available",
              source: "compute-billing-rate-segments",
              observedAt: NOW_ISO,
              value: {
                value: "4.200000",
                unit: "usd_per_day",
                currency: "USD",
              },
            },
          },
        },
        cloudCharacters: {
          source: "cloud-character-quota",
          state: "available",
          used: 2,
          limit: 5,
        },
        agentSandboxes: {
          source: "agent-sandbox-quota",
          used: 3,
          nonEagerCreate: { state: "available", limit: 5 },
          eagerManagedCreate: { state: "available", limit: 100 },
          state: "available",
        },
        containers: {
          source: "container-quota",
          state: "available",
          used: 1,
          limit: 5,
        },
        apps: {
          source: "apps-service",
          state: "available",
          used: 4,
          limit: 25,
        },
        storage: {
          source: "org-storage-quota",
          state: "available",
          bytesUsed: "1073741824",
          bytesLimit: "5368709120",
        },
        inferenceRateLimits: {
          source: "org-rate-limits",
          state: "available",
          completionsRpm: 120,
          embeddingsRpm: 200,
        },
      },
    },
  },
  {
    // auto-top-up-card.tsx reads settings.autoTopUp.* + settings.limits.*;
    match: path_("/api/v1/billing/settings"),
    body: {
      settings: {
        autoTopUp: {
          enabled: false,
          amount: 10,
          threshold: 5,
          hasPaymentMethod: false,
        },
        limits: {
          minAmount: 5,
          maxAmount: 500,
          minThreshold: 1,
          maxThreshold: 100,
        },
        payAsYouGoFromEarnings: false,
      },
    },
  },
  { match: path_("/api/invoices/list"), body: { invoices: [] } },
  {
    // InvoiceDetailPage: GET /api/invoices/:id → camelCase InvoiceApiPayload
    // (billing/types.ts), adapted to the snake_case InvoiceDto by the hook.
    match: path_("/api/invoices/invoice-smoke-1"),
    body: {
      invoice: {
        id: "invoice-smoke-1",
        stripeInvoiceId: "in_smoke_1",
        stripeCustomerId: "cus_smoke_1",
        stripePaymentIntentId: null,
        amountDue: 1000,
        amountPaid: 1000,
        currency: "usd",
        status: "paid",
        invoiceType: "topup",
        invoiceNumber: "INV-0001",
        invoicePdf: null,
        hostedInvoiceUrl: null,
        creditsAdded: 10,
        metadata: {},
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        dueDate: null,
        paidAt: NOW_ISO,
      },
    },
  },
  { match: path_("/api/crypto/status"), body: { enabled: false } },
  // monetization/ — earnings balance/redemptions/status + affiliates.
  {
    match: path_("/api/v1/redemptions/balance"),
    body: {
      success: true,
      balance: {
        totalEarned: 12.5,
        availableBalance: 10,
        pendingBalance: 2.5,
        totalRedeemed: 0,
        totalPending: 0,
        totalConvertedToCredits: 0,
      },
      bySource: [{ source: "miniapp", totalEarned: 12.5, count: 3 }],
      recentEarnings: [
        {
          id: "earning-smoke-1",
          source: "miniapp",
          sourceId: SMOKE_APP_UUID,
          amount: 4.25,
          description: "Smoke App purchase share",
          createdAt: NOW_ISO,
        },
      ],
      limits: {
        minRedemptionUsd: 5,
        maxSingleRedemptionUsd: 500,
        userDailyLimitUsd: 1000,
        userHourlyLimitUsd: 250,
      },
      eligibility: { canRedeem: true, dailyLimitRemaining: 1_000 },
    },
  },
  {
    match: path_("/api/v1/redemptions/status"),
    body: {
      success: true,
      operational: true,
      canRedeem: true,
      message: "All payout networks are operational.",
      availableNetworks: ["base"],
      unavailableNetworks: [],
      networks: [
        {
          network: "base",
          available: true,
          status: "operational",
          balance: 100,
          balanceAvailable: true,
        },
      ],
      wallets: {
        evm: { configured: false },
        solana: { configured: false },
      },
      warnings: [],
      lastChecked: NOW_ISO,
    },
  },
  {
    match: path_("/api/v1/redemptions"),
    body: { success: true, redemptions: [], paused: false },
  },
  {
    match: path_("/api/v1/affiliates"),
    body: {
      code: {
        id: "aff-smoke-1",
        code: "SMOKE20",
        markup_percent: "20.00",
        is_active: true,
        created_at: NOW_ISO,
      },
    },
  },
  {
    match: path_("/api/v1/referrals"),
    body: { code: "SMOKE20", total_referrals: 0, is_active: true },
  },
  // api-explorer/
  { match: path_("/api/v1/api-keys/explorer"), body: { apiKey: null } },
  { match: path_("/api/v1/pricing/summary"), body: { pricing: {} } },
  // applications/
  { match: path_("/api/v1/apps"), body: { apps: [SMOKE_APP] } },
  {
    match: path_(`/api/v1/apps/${SMOKE_APP_UUID}`),
    body: { app: SMOKE_APP },
  },
  {
    // AuthorizeContent (app-auth/authorize) verifies the app via /public.
    match: path_("/api/v1/apps/app-smoke-1/public"),
    body: { app: { id: "app-smoke-1", name: "Smoke App", logo_url: null } },
  },
  {
    // Public payment page for an app charge (AppChargeDetails shape —
    // app-charge-page.tsx formats expiresAt/paidAt with Intl, so they must
    // be valid dates, and reads amountUsd/providers/paymentUrl).
    match: path_("/api/v1/apps/app-smoke-1/charges/charge-smoke-1"),
    body: {
      charge: {
        id: "charge-smoke-1",
        appId: "app-smoke-1",
        amountUsd: 5,
        description: "Smoke charge",
        providers: ["stripe"],
        paymentUrl: "https://example.com/pay/charge-smoke-1",
        status: "pending",
        paidAt: null,
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
      },
      app: {
        id: "app-smoke-1",
        name: "Smoke App",
        description: "Deterministic ui-smoke application fixture",
        logo_url: null,
        website_url: null,
      },
    },
  },
  // approvals/ dashboard list + public approve/:id page.
  {
    match: path_("/api/v1/approval-requests/approval-smoke-1"),
    body: {
      success: true,
      approvalRequest: {
        id: "approval-smoke-1",
        organizationId: "org-smoke-1",
        agentId: CLOUD_AUDIT_DEDICATED_AGENT_ID,
        userId: null,
        challengeKind: "signature",
        challengePayload: {
          message: "Approve the smoke-test sensitive action",
          signerKind: "wallet",
          walletAddress: "0x000000000000000000000000000000000000dEaD",
        },
        expectedSignerIdentityId: null,
        status: "pending",
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        metadata: null,
      },
    },
  },
  {
    match: prefix("/api/v1/approval-requests"),
    body: { success: true, approvalRequests: [] },
  },
  {
    match: prefix("/api/v1/ballots/ballot-smoke-1"),
    body: {
      success: true,
      ballot: {
        id: "ballot-smoke-1",
        organizationId: "org-smoke-1",
        purpose: "Rotate the smoke-test treasury key",
        threshold: 2,
        status: "open",
        participants: [
          { identityId: "identity-1", label: "Owner" },
          { identityId: "identity-2", label: "Operator" },
        ],
        expiresAt: FUTURE_ISO,
        createdAt: NOW_ISO,
      },
    },
  },
  { match: prefix("/api/v1/ballots"), body: { success: true, ballots: [] } },
  {
    match: path_("/api/v1/sensitive-requests/sensitive-smoke-1"),
    body: {
      id: "sensitive-smoke-1",
      kind: "secret",
      status: "pending",
      reason: "The agent needs an API key to finish connector setup.",
      expiresAt: FUTURE_ISO,
      form: {
        fields: [
          {
            name: "apiKey",
            label: "API key",
            input: "secret",
            required: true,
          },
        ],
        submitLabel: "Submit securely",
      },
    },
  },
  {
    match: path_("/api/v1/payment-requests/payreq-smoke-1"),
    body: {
      success: true,
      paymentRequest: {
        id: "payreq-smoke-1",
        provider: "stripe",
        amountCents: 500,
        currency: "usd",
        status: "pending",
        reason: "Smoke-test payment request",
        expiresAt: FUTURE_ISO,
        hostedUrl: "https://example.com/checkout/smoke",
      },
    },
  },
  // public-pages/ — character chat + invite validation.
  {
    match: path_("/api/characters/smoke-character/public"),
    body: {
      success: true,
      data: { id: "char-smoke-1", name: "Eliza Smoke", ref: "smoke-character" },
    },
  },
  {
    match: path_("/api/invites/validate"),
    body: {
      success: true,
      data: {
        organization_name: "Smoke Org",
        invited_email: "invitee@agent.local",
        role: "member",
        expires_at: FUTURE_ISO,
        inviter_name: "Smoke Owner",
      },
    },
  },
  // admin/ — HEAD gate + moderation views + redemptions + rpc status.
  {
    method: "HEAD",
    match: prefix("/api/v1/admin/moderation"),
    status: 204,
    headers: { "x-admin-role": "super_admin", "x-is-admin": "true" },
    body: "",
  },
  {
    match: prefix("/api/v1/admin/moderation"),
    body: {
      admins: { admins: [] },
      overview: {
        adminCount: 1,
        bannedUsers: 0,
        flaggedUsers: 0,
        totalViolations: 0,
      },
      users: { bannedUsers: [], flaggedUsers: [] },
      violations: { violations: [] },
    },
  },
  {
    match: prefix("/api/admin/redemptions"),
    body: { redemptions: [], stats: null },
  },
  {
    match: path_("/admin/rpc-status"),
    body: {
      success: true,
      data: {
        evm: [],
        solana: { rpcUrl: "", configured: false },
        allReachable: true,
        hotWalletAddress: null,
        checkedAt: NOW_ISO,
      },
    },
  },
  // mcps/
  { match: path_("/api/v1/mcps"), body: { mcps: [] } },
  {
    match: path_("/api/mcp/list"),
    body: { mcps: [], total: 0, categories: [] },
  },
  // connectors/ (dashboard/settings/connections) — hosted connector statuses.
  { match: path_("/api/v1/dashboard"), body: { agents: [] } },
  {
    match: prefix("/api/v1/oauth/connections"),
    body: { connections: [] },
  },
  { match: path_("/api/v1/discord/connections"), body: { connections: [] } },
  { match: path_("/api/v1/twilio/status"), body: { connected: false } },
  { match: path_("/api/v1/telegram/status"), body: { connected: false } },
  { match: path_("/api/v1/whatsapp/status"), body: { connected: false } },
  { match: path_("/api/v1/blooio/status"), body: { connected: false } },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function billingLimitsBody(creditBalance: number): unknown {
  const rule = STUB_RULES.find((candidate) =>
    candidate.match("/api/v1/billing/limits", new URLSearchParams()),
  );
  const body = structuredClone(rule?.body);
  if (
    !isRecord(body) ||
    !isRecord(body.data) ||
    !isRecord(body.data.v2) ||
    !isRecord(body.data.v2.balance) ||
    !isRecord(body.data.v2.balance.value)
  ) {
    throw new Error("Cloud audit billing fixture has an invalid balance shape");
  }
  body.data.v2.balance.value.balance = {
    value: creditBalance.toFixed(6),
    unit: "usd",
    currency: "USD",
  };
  body.data.v2.balance.value.revision = String(creditBalance);
  return body;
}

export async function installCloudApiStubs(
  page: Page,
  options: CloudAuditFixtureOptions = {},
): Promise<CloudAuditFixtureController> {
  let agentState = options.initialAgentState ?? "dedicated";
  let provisioningComplete = false;
  const creditBalance = options.creditBalance ?? 42;
  const quoteCanActivate = options.quoteCanActivate ?? true;
  const requests: CloudAuditRequestReceipt[] = [];
  const unhandledRequests: string[] = [];
  const upgradePath = `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_AGENT_ID)}/upgrade-tier`;
  const cutoverPath = `${upgradePath}/cutover`;

  const dedicatedAgent = () => ({
    id: CLOUD_AUDIT_DEDICATED_AGENT_ID,
    agentName: "Eliza",
    status: agentState === "provisioning" ? "provisioning" : "running",
    databaseStatus: agentState === "provisioning" ? "provisioning" : "ready",
    lastBackupAt: null,
    lastHeartbeatAt: NOW_ISO,
    errorMessage: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    token_address: null,
    token_chain: null,
    token_name: null,
    token_ticker: null,
    dockerImage: null,
    executionTier: "dedicated-always",
    webUiUrl: agentState === "provisioning" ? null : DEDICATED_API_BASE,
    activeJob:
      agentState === "provisioning"
        ? {
            id: DEDICATED_JOB_ID,
            type: "provision",
            status: "in_progress",
            attempts: 1,
            maxAttempts: 3,
            estimatedCompletionAt: FUTURE_ISO,
            scheduledFor: NOW_ISO,
            startedAt: NOW_ISO,
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }
        : null,
  });

  const fulfill = async (
    route: Route,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<void> => {
    const request = route.request();
    const responseBody = typeof body === "string" ? body : JSON.stringify(body);
    await route.fulfill({
      status,
      contentType: "application/json",
      headers,
      body: responseBody,
    });
    requests.push({
      method: request.method(),
      url: request.url(),
      pathname: new URL(request.url()).pathname,
      status,
      body: request.postData(),
      responseBody,
    });
  };

  const handleAgentFixture = async (route: Route): Promise<boolean> => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();

    if (method === "GET" && pathname === "/api/v1/eliza/personal") {
      await fulfill(route, 200, {
        success: true,
        data: {
          identity:
            agentState === "dedicated"
              ? {
                  id: PERSONAL_AGENT_ID,
                  displayName: "Eliza",
                  runtime: "dedicated",
                  activeAgentId: CLOUD_AUDIT_DEDICATED_AGENT_ID,
                  apiBase: DEDICATED_API_BASE,
                }
              : {
                  id: PERSONAL_AGENT_ID,
                  displayName: "Eliza",
                  runtime: "shared",
                },
        },
      });
      return true;
    }

    if (method === "GET" && pathname === "/api/v1/eliza/agents") {
      await fulfill(route, 200, {
        success: true,
        data: agentState === "shared" ? [] : [dedicatedAgent()],
      });
      return true;
    }

    if (
      method === "GET" &&
      pathname === `/api/v1/eliza/agents/${CLOUD_AUDIT_DEDICATED_AGENT_ID}`
    ) {
      await fulfill(route, 200, {
        success: true,
        data: {
          ...dedicatedAgent(),
          errorCount: 0,
          meshAddressPresent: true,
          walletAddress: null,
          walletProvider: null,
          walletStatus: "none",
          adminDetails: null,
        },
      });
      return true;
    }

    if (
      method === "GET" &&
      (pathname === "/api/v1/credits/balance" ||
        pathname === "/api/credits/balance")
    ) {
      await fulfill(route, 200, { balance: creditBalance });
      return true;
    }

    if (method === "GET" && pathname === "/api/v1/user") {
      await fulfill(route, 200, {
        success: true,
        data: {
          ...SMOKE_USER,
          organization: {
            ...SMOKE_USER.organization,
            credit_balance: creditBalance.toFixed(2),
          },
        },
      });
      return true;
    }

    if (method === "POST" && pathname === "/api/views/cloud/navigate") {
      await fulfill(route, 200, { success: true });
      return true;
    }

    if (method === "GET" && pathname === "/api/v1/billing/limits") {
      await fulfill(route, 200, billingLimitsBody(creditBalance));
      return true;
    }

    if (method === "GET" && pathname === upgradePath) {
      await fulfill(route, 200, {
        success: true,
        data: {
          quoteId: DEDICATED_QUOTE_ID,
          sourceAgentId: PERSONAL_AGENT_ID,
          hourlyRateUsd: 0.125,
          dailyRateUsd: 3,
          minimumBalanceUsd: 9,
          minimumRunwayDays: 3,
          balanceUsd: creditBalance,
          deficitUsd: quoteCanActivate ? 0 : 9 - creditBalance,
          canActivate: quoteCanActivate,
          requiresConfirmation: true,
          action: "activate_dedicated",
          ...(quoteCanActivate
            ? {}
            : {
                unavailableReason: INSUFFICIENT_UPGRADE_CREDITS,
              }),
          activation: { state: "available" },
        },
      });
      return true;
    }

    if (method === "POST" && pathname === upgradePath) {
      const expectedBody = {
        action: "activate_dedicated",
        quoteId: DEDICATED_QUOTE_ID,
      };
      if (!requestBodyMatches(request, expectedBody)) {
        await fulfill(route, 400, {
          success: false,
          error: "Activation request did not match the quoted action.",
        });
        return true;
      }
      if (!quoteCanActivate) {
        await fulfill(route, 402, {
          success: false,
          error: "Add funds before activating Dedicated.",
        });
        return true;
      }
      agentState = "provisioning";
      await fulfill(route, 202, {
        success: true,
        data: {
          dedicatedAgentId: CLOUD_AUDIT_DEDICATED_AGENT_ID,
          jobId: DEDICATED_JOB_ID,
        },
      });
      return true;
    }

    if (method === "GET" && pathname === `/api/v1/jobs/${DEDICATED_JOB_ID}`) {
      await fulfill(route, 200, {
        success: true,
        data: {
          status: provisioningComplete ? "completed" : "in_progress",
          error: null,
          attempts: 1,
          maxAttempts: 3,
          estimatedCompletionAt: provisioningComplete ? null : FUTURE_ISO,
        },
      });
      return true;
    }

    if (method === "POST" && pathname === cutoverPath) {
      const expectedBody = {
        dedicatedAgentId: CLOUD_AUDIT_DEDICATED_AGENT_ID,
      };
      if (!requestBodyMatches(request, expectedBody)) {
        await fulfill(route, 400, {
          success: false,
          error: "Cutover request did not name the Dedicated target.",
        });
        return true;
      }
      if (!provisioningComplete) {
        await fulfill(route, 409, {
          success: false,
          code: "dedicated_not_healthy",
          error: "Dedicated is not healthy yet.",
        });
        return true;
      }
      await fulfill(route, 200, {
        success: true,
        data: {
          personalElizaId: PERSONAL_AGENT_ID,
          activeAgentId: CLOUD_AUDIT_DEDICATED_AGENT_ID,
          runtime: "dedicated",
          apiBase: DEDICATED_API_BASE,
          importedMessages: 4,
          importedScheduledTasks: 1,
          importedTodos: 2,
          importedTodoMutations: 0,
        },
      });
      agentState = "dedicated";
      return true;
    }

    return false;
  };

  const handle = async (route: Route) => {
    if (await handleAgentFixture(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    const rule = STUB_RULES.find(
      (r) =>
        (r.method ?? "GET") === request.method() &&
        r.match(url.pathname, url.searchParams),
    );
    if (!rule) {
      unhandledRequests.push(`${request.method()} ${request.url()}`);
      await route.fallback();
      return;
    }
    await fulfill(route, rule.status ?? 200, rule.body, rule.headers);
  };
  // Covers /api/v1/*, /api/analytics/*, /api/invoices/*, /api/credits/*,
  // /api/crypto/*, /api/mcp/*, /api/characters/*, /api/invites/*,
  // /api/admin/*, /api/my-agents/*, /api/organizations/* …
  await page.route("**/api/**", handle);
  // Steward provider discovery is rooted at /auth rather than /api.
  await page.route("**/auth/**", handle);
  await page.route("**/steward/**", handle);
  // The admin RPC-status probe has no /api prefix (worker route /admin/rpc-status).
  await page.route("**/admin/rpc-status*", handle);
  await page.route("**/build-info.json", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ generatedAt: NOW_ISO, branch: "cloud-audit" }),
    });
  });
  return {
    get agentState() {
      return agentState;
    },
    requests,
    unhandledRequests,
    completeProvisioning() {
      provisioningComplete = true;
    },
  };
}
