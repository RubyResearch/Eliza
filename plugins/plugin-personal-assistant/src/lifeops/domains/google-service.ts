/**
 * Google connector domain for LifeOps: start/disconnect the owner's Google
 * connector and project its status, scopes, and grants from the core connector
 * account manager into assistant DTOs. Shared root for the Gmail/Drive domains.
 */
import {
  type ConnectorAccount,
  DEFAULT_SERVER_ONLY_PORT,
  getConnectorAccountManager,
  isLoopbackBindHost,
  isWildcardBindHost,
} from "@elizaos/core";
import { assessGoogleOAuthCallbackConfig } from "@elizaos/plugin-google-workspace";
import type {
  DisconnectLifeOpsGoogleConnectorRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGoogleConnectorStatus,
  StartLifeOpsGoogleConnectorRequest,
  StartLifeOpsGoogleConnectorResponse,
} from "../../contracts/index.js";
import { INTERNAL_URL } from "../access.js";
import {
  disconnectedGoogleStatus,
  googleAccountIdFromGrantId,
  googleGrantFromAccount,
  googleGrantIdForAccount,
  googleScopesForAccount,
  googleSideForAccount,
  googleStatusFromAccount,
  listGoogleConnectorAccounts,
  resolveGoogleConnectorAccount,
} from "../google-plugin-delegates.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
} from "../service-normalize.js";
import {
  normalizeGoogleCapabilityRequest,
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "../service-normalize-connector.js";

/**
 * Resolve the externally served connector origin. HTTP requests carry it
 * directly. Chat and provider snapshots use the synthetic INTERNAL_URL, so
 * public callbacks rely on ELIZA_EXTERNAL_BASE_URL while loopback callbacks
 * infer the same API-port precedence as the agent host.
 */
function servedOriginFromRequestUrl(
  runtime: LifeOpsContext["runtime"],
  requestUrl: URL,
): string | undefined {
  if (requestUrl.href !== INTERNAL_URL.href) return requestUrl.origin;

  const externalBase = nonEmptySetting(runtime, "ELIZA_EXTERNAL_BASE_URL");
  if (externalBase) return externalBase;

  const redirect = nonEmptySetting(runtime, "GOOGLE_REDIRECT_URI");
  if (!redirect) return undefined;
  let callback: URL;
  try {
    callback = new URL(redirect);
  } catch {
    // error-policy:J3 callback assessment reports the malformed setting.
    return undefined;
  }
  if (!isLoopbackBindHost(callback.hostname)) return undefined;

  const configuredBind =
    nonEmptySetting(runtime, "ELIZA_API_BIND") ?? "127.0.0.1";
  const callbackHost = callback.hostname.replace(/^\[|\]$/g, "");
  const servedHost = isWildcardBindHost(configuredBind)
    ? callbackHost
    : configuredBind;
  const originHost = servedHost.includes(":")
    ? `[${servedHost.replace(/^\[|\]$/g, "")}]`
    : servedHost;
  const apiPort =
    positivePortSetting(runtime, "ELIZA_API_PORT") ??
    positivePortSetting(runtime, "ELIZA_PORT") ??
    positivePortSetting(runtime, "ELIZA_UI_PORT") ??
    DEFAULT_SERVER_ONLY_PORT;
  return `http://${originHost}:${apiPort}`;
}

function nonEmptySetting(
  runtime: LifeOpsContext["runtime"],
  key: string,
): string | undefined {
  const value = runtime.getSetting?.(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positivePortSetting(
  runtime: LifeOpsContext["runtime"],
  key: string,
): number | undefined {
  const value = nonEmptySetting(runtime, key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? port
    : undefined;
}

function roleForSide(side: LifeOpsConnectorSide): "OWNER" | "AGENT" {
  return side === "agent" ? "AGENT" : "OWNER";
}

function sideFromMetadata(value: unknown): LifeOpsConnectorSide {
  return value === "agent" ? "agent" : "owner";
}

function requestedScopesForCapabilities(
  capabilities: readonly string[] | undefined,
): string[] | undefined {
  if (!capabilities || capabilities.length === 0) {
    return undefined;
  }
  return googleScopesForAccount(
    {
      id: "requested",
      provider: "google",
      role: "OWNER",
      purpose: [],
      accessGate: "owner_binding",
      status: "pending",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { grantedCapabilities: [...capabilities] },
    } as ConnectorAccount,
    capabilities as never,
  );
}

function assertLocalMode(mode?: LifeOpsConnectorMode): void {
  if (mode && mode !== "local") {
    fail(
      410,
      "LifeOps no longer manages cloud or legacy Google modes. Use @elizaos/plugin-google-workspace connector accounts.",
    );
  }
}

function googleOAuthCallbackDegradations(
  assessment: ReturnType<typeof assessGoogleOAuthCallbackConfig>,
): NonNullable<LifeOpsGoogleConnectorStatus["degradations"]> {
  return assessment.issues.map((issue) => ({
    axis: "disconnected" as const,
    code: `google_oauth_callback_${issue.code}`,
    message: issue.message,
    retryable: true,
  }));
}

function googleOAuthCallbackMisconfigStatus(
  side: LifeOpsConnectorSide,
  assessment: ReturnType<typeof assessGoogleOAuthCallbackConfig>,
): LifeOpsGoogleConnectorStatus {
  return {
    provider: "google",
    side,
    mode: "local",
    defaultMode: "local",
    availableModes: ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: false,
    connected: false,
    reason: "config_missing",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    grant: null,
    degradations: googleOAuthCallbackDegradations(assessment),
  };
}

function googlePluginUnavailableStatus(
  side: LifeOpsConnectorSide,
): LifeOpsGoogleConnectorStatus {
  return {
    ...disconnectedGoogleStatus(side),
    configured: false,
    reason: "config_missing",
    degradations: [
      {
        axis: "disconnected",
        code: "google_plugin_unavailable",
        message:
          "@elizaos/plugin-google-workspace is required for Google accounts. LifeOps no longer stores Google OAuth tokens directly.",
        retryable: true,
      },
    ],
  };
}

/**
 * Google connector status, account listing, OAuth start/callback, and
 * disconnect logic. Extracted from the `withGoogle` mixin; the mixin now
 * delegates to this sub-service.
 */
export class GoogleDomain {
  constructor(private readonly ctx: LifeOpsContext) {}

  private googleConnectorManager() {
    try {
      return getConnectorAccountManager(this.ctx.runtime);
    } catch {
      // error-policy:J4 designed degrade; when no connector-account manager is
      // registered the Google domain reports "unavailable" (null), never a fake
      // manager. Callers render an explicit unavailable connector state.
      return null;
    }
  }

  private googleAccountStatus(
    account: ConnectorAccount,
  ): LifeOpsGoogleConnectorStatus {
    return googleStatusFromAccount({
      account,
      agentId: this.ctx.agentId(),
      defaultMode: "local",
      availableModes: ["local"],
    });
  }

  public async withGoogleGrantOperation<T>(
    _grant: LifeOpsConnectorGrant,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  public async runManagedGoogleOperation<T>(
    _grant: LifeOpsConnectorGrant,
    _operation: () => Promise<T>,
  ): Promise<T> {
    fail(
      410,
      "Cloud-managed Google operations were removed from LifeOps. Use @elizaos/plugin-google-workspace connector accounts.",
    );
  }

  public async clearGoogleConnectorData(
    side?: LifeOpsConnectorSide,
  ): Promise<void> {
    const calendarEvents = await this.ctx.repository.listCalendarEvents(
      this.ctx.agentId(),
      "google",
      undefined,
      undefined,
      side,
    );
    await this.deleteCalendarReminderPlansForEvents(
      calendarEvents.map((event) => event.id),
    );
    await this.ctx.repository.deleteCalendarEventsForProvider(
      this.ctx.agentId(),
      "google",
      undefined,
      side,
    );
    await this.ctx.repository.deleteCalendarSyncState(
      this.ctx.agentId(),
      "google",
      undefined,
      side,
    );
    await this.ctx.repository.deleteGmailMessagesForProvider(
      this.ctx.agentId(),
      "google",
      side,
    );
    await this.ctx.repository.deleteGmailSpamReviewItemsForProvider(
      this.ctx.agentId(),
      "google",
      side,
    );
    await this.ctx.repository.deleteGmailSyncState(
      this.ctx.agentId(),
      "google",
      undefined,
      side,
    );
  }

  public async clearGoogleGrantData(
    grant: LifeOpsConnectorGrant,
  ): Promise<void> {
    await this.deleteCalendarReminderPlansForEvents(
      (
        await this.ctx.repository.listCalendarEvents(
          this.ctx.agentId(),
          "google",
          undefined,
          undefined,
          grant.side,
        )
      )
        .filter((event) => event.grantId === grant.id)
        .map((event) => event.id),
    );
    await this.ctx.repository.deleteCalendarEventsForProvider(
      this.ctx.agentId(),
      "google",
      grant.id,
      grant.side,
    );
    await this.ctx.repository.deleteCalendarSyncState(
      this.ctx.agentId(),
      "google",
      undefined,
      grant.side,
      grant.id,
    );
    await this.ctx.repository.deleteGmailMessagesForProvider(
      this.ctx.agentId(),
      "google",
      grant.side,
      grant.id,
    );
    await this.ctx.repository.deleteGmailSpamReviewItemsForProvider(
      this.ctx.agentId(),
      "google",
      grant.side,
      grant.id,
    );
    await this.ctx.repository.deleteGmailSyncState(
      this.ctx.agentId(),
      "google",
      grant.id,
      grant.side,
    );
  }

  public async deleteCalendarReminderPlansForEvents(
    eventIds: string[],
  ): Promise<void> {
    if (eventIds.length === 0) return;
    const plans = await this.ctx.repository.listReminderPlansForOwners(
      this.ctx.agentId(),
      "calendar_event",
      eventIds,
    );
    for (const plan of plans) {
      await this.ctx.repository.deleteReminderPlan(this.ctx.agentId(), plan.id);
    }
  }

  public async requireGoogleCalendarGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    assertLocalMode(normalizeOptionalConnectorMode(requestedMode, "mode"));
    const status = await this.getGoogleConnectorStatus(
      requestUrl,
      "local",
      requestedSide,
      grantId,
    );
    const grant = status.grant;
    if (!status.connected || !grant) {
      fail(409, "Google Calendar is not connected.");
    }
    if (!grant.capabilities.includes("google.calendar.read")) {
      fail(403, "Google Calendar read access has not been granted.");
    }
    return grant;
  }

  public async requireGoogleCalendarWriteGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    const grant = await this.requireGoogleCalendarGrant(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
    if (!grant.capabilities.includes("google.calendar.write")) {
      fail(403, "Google Calendar write access has not been granted.");
    }
    return grant;
  }

  private async requireGoogleGmailConnection(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    assertLocalMode(normalizeOptionalConnectorMode(requestedMode, "mode"));
    const status = await this.getGoogleConnectorStatus(
      requestUrl,
      "local",
      requestedSide,
      grantId,
    );
    const grant = status.grant;
    if (!status.connected || !grant) {
      fail(409, "Google Gmail is not connected.");
    }
    return grant;
  }

  public async requireGoogleGmailGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    const grant = await this.requireGoogleGmailConnection(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
    if (!grant.capabilities.includes("google.gmail.triage")) {
      fail(403, "Google Gmail triage access has not been granted.");
    }
    return grant;
  }

  public async requireGoogleGmailSendGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant> {
    const grant = await this.requireGoogleGmailConnection(
      requestUrl,
      requestedMode,
      requestedSide,
      grantId,
    );
    if (!grant.capabilities.includes("google.gmail.send")) {
      fail(403, "Google Gmail send access has not been granted.");
    }
    return grant;
  }

  async getGoogleConnectorStatus(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const mode = normalizeOptionalConnectorMode(requestedMode, "mode");
    assertLocalMode(mode);
    const side =
      normalizeOptionalConnectorSide(requestedSide, "side") ?? "owner";
    const manager = this.googleConnectorManager();
    if (!manager?.getProvider?.("google")) {
      return googlePluginUnavailableStatus(side);
    }
    // Resolve the persisted account BEFORE assessing callback readiness: a
    // CONNECTED grant works through its stored/refresh tokens regardless of
    // the callback config, so a config mistake must not make it look
    // disconnected (#18455). Pending/error accounts need a fresh OAuth flow,
    // which the callback gates — those keep the callback diagnostics.
    const account = await resolveGoogleConnectorAccount({
      runtime: this.ctx.runtime,
      requestedSide: side,
      grantId,
    });
    if (account?.status === "connected") {
      return this.googleAccountStatus(account);
    }
    const servedOrigin = servedOriginFromRequestUrl(
      this.ctx.runtime,
      requestUrl,
    );
    const callbackAssessment = assessGoogleOAuthCallbackConfig(
      this.ctx.runtime,
      servedOrigin ? { servedOrigin } : undefined,
    );
    if (account) {
      const status = this.googleAccountStatus(account);
      return callbackAssessment.configured
        ? status
        : {
            ...status,
            degradations: [
              ...(status.degradations ?? []),
              ...googleOAuthCallbackDegradations(callbackAssessment),
            ],
          };
    }
    if (!callbackAssessment.configured) {
      return googleOAuthCallbackMisconfigStatus(side, callbackAssessment);
    }
    return disconnectedGoogleStatus(side);
  }

  async getGoogleConnectorAccounts(
    _requestUrl: URL,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]> {
    const side = normalizeOptionalConnectorSide(requestedSide, "side");
    const manager = this.googleConnectorManager();
    if (!manager?.getProvider?.("google")) {
      return side
        ? [googlePluginUnavailableStatus(side)]
        : [
            googlePluginUnavailableStatus("owner"),
            googlePluginUnavailableStatus("agent"),
          ];
    }
    const accounts = await listGoogleConnectorAccounts({
      runtime: this.ctx.runtime,
      requestedSide: side,
    });
    if (accounts.length === 0) {
      return side ? [disconnectedGoogleStatus(side)] : [];
    }
    return accounts.map((account) => this.googleAccountStatus(account));
  }

  async selectGoogleConnectorMode(
    requestUrl: URL,
    preferredModeInput: LifeOpsConnectorMode | undefined,
    requestedSide?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const preferredMode = normalizeOptionalConnectorMode(
      preferredModeInput,
      "mode",
    );
    assertLocalMode(preferredMode);
    return this.getGoogleConnectorStatus(requestUrl, "local", requestedSide);
  }

  async startGoogleConnector(
    request: StartLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<StartLifeOpsGoogleConnectorResponse> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    assertLocalMode(mode);
    const requestedSide =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const requestedCapabilities = normalizeGoogleCapabilityRequest(
      request.capabilities,
    );
    const manager = this.googleConnectorManager();
    if (!manager?.getProvider?.("google")) {
      fail(
        503,
        "@elizaos/plugin-google-workspace is required before starting Google OAuth.",
      );
    }
    // Fail closed before redirecting the user to Google: a callback that
    // cannot reach the origin serving this request would strand the grant.
    // Chat has no request URL (INTERNAL_URL sentinel), so it uses an explicit
    // external base when configured or infers the local agent API port.
    const servedOrigin = servedOriginFromRequestUrl(
      this.ctx.runtime,
      requestUrl,
    );
    const callbackAssessment = assessGoogleOAuthCallbackConfig(
      this.ctx.runtime,
      servedOrigin ? { servedOrigin } : undefined,
    );
    if (!callbackAssessment.configured) {
      fail(
        503,
        `Google OAuth callback is not usable: ${callbackAssessment.issues
          .map((issue) => issue.message)
          .join(" ")}`,
      );
    }
    const providerServedOrigin = servedOrigin
      ? new URL(servedOrigin).origin
      : undefined;

    const createNewGrant =
      normalizeOptionalBoolean(request.createNewGrant, "createNewGrant") ??
      false;
    if (createNewGrant && request.grantId) {
      fail(
        400,
        "createNewGrant cannot be combined with an existing Google grant id.",
      );
    }
    const requestedAccountId = createNewGrant
      ? null
      : googleAccountIdFromGrantId(request.grantId);
    const flow = await manager.startOAuth("google", {
      accountId: requestedAccountId ?? undefined,
      scopes: requestedScopesForCapabilities(requestedCapabilities),
      servedOrigin: providerServedOrigin,
      metadata: {
        lifeops: true,
        side: requestedSide,
        role: roleForSide(requestedSide),
        requestedRole: roleForSide(requestedSide),
        requestedCapabilities,
        privacy: "owner_only",
        redirectUrl: normalizeOptionalString(request.redirectUrl),
      },
    });
    return {
      provider: "google",
      side: requestedSide,
      mode: "local",
      requestedCapabilities: requestedCapabilities ?? [],
      redirectUri:
        flow.redirectUri ??
        fail(500, "Google OAuth provider did not select a callback URI."),
      authUrl: flow.authUrl ?? "",
    };
  }

  async completeGoogleConnectorCallback(
    callbackUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const manager = this.googleConnectorManager();
    if (!manager?.getProvider?.("google")) {
      fail(
        503,
        "@elizaos/plugin-google-workspace is required before completing Google OAuth.",
      );
    }
    const state = callbackUrl.searchParams.get("state") ?? "";
    const completed = await manager.completeOAuth("google", {
      state,
      code: callbackUrl.searchParams.get("code") ?? undefined,
      error: callbackUrl.searchParams.get("error") ?? undefined,
      errorDescription:
        callbackUrl.searchParams.get("error_description") ?? undefined,
      query: Object.fromEntries(callbackUrl.searchParams.entries()),
    });
    const side = sideFromMetadata(completed.flow.metadata?.side);
    const accountId =
      completed.account?.id ?? completed.flow.accountId ?? undefined;
    return this.getGoogleConnectorStatus(
      callbackUrl,
      "local",
      side,
      accountId ? googleGrantIdForAccount(accountId) : undefined,
    );
  }

  async disconnectGoogleConnector(
    request: DisconnectLifeOpsGoogleConnectorRequest,
    requestUrl: URL,
  ): Promise<LifeOpsGoogleConnectorStatus> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    assertLocalMode(mode);
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const manager = this.googleConnectorManager();
    if (!manager?.getProvider?.("google")) {
      fail(
        503,
        "@elizaos/plugin-google-workspace is required before disconnecting Google accounts.",
      );
    }
    const requestedGrantId = normalizeOptionalString(request.grantId);
    const account = await resolveGoogleConnectorAccount({
      runtime: this.ctx.runtime,
      requestedSide: side,
      grantId: requestedGrantId,
    });
    if (!account) {
      if (requestedGrantId) {
        fail(404, "Google connector account not found.");
      }
      return this.getGoogleConnectorStatus(requestUrl, "local", side);
    }
    const purgeImportedData =
      normalizeOptionalBoolean(
        request.purgeImportedData,
        "purgeImportedData",
      ) ?? false;
    const grant = googleGrantFromAccount({
      account,
      agentId: this.ctx.agentId(),
    });
    await manager.deleteAccount("google", account.id);
    if (purgeImportedData) {
      await this.clearGoogleGrantData(grant);
    }
    await this.ctx.recordConnectorAudit(
      "google:connector-account",
      "google connector account disconnected",
      {
        connectorAccountId: account.id,
        side: googleSideForAccount(account),
      },
      { disconnected: true, purgedImportedData: purgeImportedData },
    );
    return this.getGoogleConnectorStatus(
      requestUrl,
      "local",
      side ?? googleSideForAccount(account),
    );
  }
}
