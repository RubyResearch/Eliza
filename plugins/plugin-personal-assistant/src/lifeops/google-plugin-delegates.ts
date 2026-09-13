/**
 * Delegation seam from LifeOps to `@elizaos/plugin-google-workspace`: resolves the owner's
 * Google connector accounts and grants from the core connector-account manager
 * and adapts the google workspace service methods LifeOps' Gmail/Drive/Google
 * domains call. Keeps Google API specifics out of the LifeOps domains.
 */
import {
  type ConnectorAccount,
  getConnectorAccountManager,
  type IAgentRuntime,
  type Metadata,
} from "@elizaos/core";
import type {
  GoogleDriveFile,
  GoogleEmailAddress,
  GoogleGmailMessageSummary,
  GoogleMessageSummary,
  GoogleSendEmailInput,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google-workspace";
import type {
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailMessageSummary,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
} from "../contracts/index.js";
import { createLifeOpsConnectorGrant } from "./repository.js";
import { fail } from "./service-normalize.js";
import { normalizeGrantCapabilities } from "./service-normalize-connector.js";

export const GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX = "connector-account:";

type RuntimeWithService = Pick<IAgentRuntime, "getService">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function isoString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed)
      ? new Date(parsed).toISOString()
      : value.trim();
  }
  return null;
}

function metadata(account: ConnectorAccount): Record<string, unknown> {
  return isRecord(account.metadata) ? account.metadata : {};
}

function mapCapability(value: string): LifeOpsGoogleCapability | null {
  switch (value) {
    case "google.basic_identity":
    case "basic_identity":
      return "google.basic_identity";
    case "google.calendar.read":
    case "calendar.read":
      return "google.calendar.read";
    case "google.calendar.write":
    case "calendar.write":
      return "google.calendar.write";
    case "google.gmail.triage":
    case "gmail.read":
      return "google.gmail.triage";
    case "google.gmail.send":
    case "gmail.send":
      return "google.gmail.send";
    case "google.gmail.compose":
    case "gmail.compose":
      return "google.gmail.compose";
    case "google.gmail.manage":
    case "gmail.manage":
      return "google.gmail.manage";
    case "google.drive.read":
    case "drive.read":
      return "google.drive.read" as LifeOpsGoogleCapability;
    case "google.drive.write":
    case "drive.write":
      return "google.drive.write" as LifeOpsGoogleCapability;
    default:
      return null;
  }
}

export function googleAccountIdFromGrantId(
  grantId: string | undefined | null,
): string | null {
  const normalized = stringValue(grantId);
  if (!normalized) return null;
  return normalized.startsWith(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX)
    ? normalized.slice(GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX.length)
    : normalized;
}

export function googleGrantIdForAccount(accountId: string): string {
  return `${GOOGLE_CONNECTOR_ACCOUNT_GRANT_PREFIX}${accountId}`;
}

export function googleSideForAccount(
  account: Pick<ConnectorAccount, "role">,
): LifeOpsConnectorSide {
  return account.role === "AGENT" ? "agent" : "owner";
}

export function googleCapabilitiesForAccount(
  account: ConnectorAccount,
): LifeOpsGoogleCapability[] {
  const meta = metadata(account);
  const values = [
    ...stringArray(meta.grantedCapabilities),
    ...stringArray(meta.capabilities),
    ...stringArray(meta.googleCapabilities),
  ];
  const scopes = stringArray(meta.grantedScopes);
  if (scopes.some((scope) => scope.includes("calendar"))) {
    values.push("google.calendar.read");
  }
  if (scopes.some((scope) => scope.includes("calendar.events"))) {
    values.push("google.calendar.write");
  }
  if (scopes.some((scope) => scope.includes("gmail.readonly"))) {
    values.push("google.gmail.triage");
  }
  if (scopes.some((scope) => scope.includes("gmail.send"))) {
    values.push("google.gmail.send");
  }
  if (scopes.some((scope) => scope.includes("gmail.compose"))) {
    values.push("google.gmail.compose");
  }
  if (
    scopes.some(
      (scope) =>
        scope.includes("gmail.modify") || scope.includes("gmail.settings"),
    )
  ) {
    values.push("google.gmail.manage");
  }
  if (scopes.some((scope) => scope.includes("drive"))) {
    values.push("google.drive.read");
  }
  if (
    scopes.some(
      (scope) => scope.includes("drive.file") || scope.endsWith("/auth/drive"),
    )
  ) {
    values.push("google.drive.write");
  }
  const normalized = new Set<LifeOpsGoogleCapability>([
    "google.basic_identity",
  ]);
  for (const value of values) {
    const mapped = mapCapability(value);
    if (mapped) normalized.add(mapped);
  }
  if (normalized.has("google.calendar.write")) {
    normalized.add("google.calendar.read");
  }
  if (normalized.has("google.gmail.manage")) {
    normalized.add("google.gmail.triage");
  }
  if (normalized.has("google.drive.write" as LifeOpsGoogleCapability)) {
    normalized.add("google.drive.read" as LifeOpsGoogleCapability);
  }
  return normalizeGrantCapabilities([
    ...normalized,
  ]) as LifeOpsGoogleCapability[];
}

export function googleScopesForAccount(
  account: ConnectorAccount,
  capabilities = googleCapabilitiesForAccount(account),
): string[] {
  const scopes = stringArray(metadata(account).grantedScopes);
  if (scopes.length > 0) return scopes;
  const derived = new Set<string>([
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ]);
  if (capabilities.includes("google.calendar.read")) {
    derived.add("https://www.googleapis.com/auth/calendar.readonly");
  }
  if (capabilities.includes("google.calendar.write")) {
    derived.add("https://www.googleapis.com/auth/calendar.events");
  }
  if (capabilities.includes("google.gmail.triage")) {
    derived.add("https://www.googleapis.com/auth/gmail.readonly");
  }
  if (capabilities.includes("google.gmail.send")) {
    derived.add("https://www.googleapis.com/auth/gmail.send");
  }
  if (capabilities.includes("google.gmail.compose")) {
    derived.add("https://www.googleapis.com/auth/gmail.compose");
  }
  if (capabilities.includes("google.gmail.manage")) {
    derived.add("https://www.googleapis.com/auth/gmail.modify");
    derived.add("https://www.googleapis.com/auth/gmail.settings.basic");
  }
  if (capabilities.includes("google.drive.read" as LifeOpsGoogleCapability)) {
    derived.add("https://www.googleapis.com/auth/drive.readonly");
  }
  if (capabilities.includes("google.drive.write" as LifeOpsGoogleCapability)) {
    derived.add("https://www.googleapis.com/auth/drive.file");
  }
  return [...derived];
}

export function googleIdentityForAccount(
  account: ConnectorAccount,
): Record<string, unknown> | null {
  const meta = metadata(account);
  const identity = isRecord(meta.identity) ? { ...meta.identity } : {};
  const externalId = stringValue(account.externalId);
  const displayHandle = stringValue(account.displayHandle);
  if (externalId) identity.sub ??= externalId;
  if (displayHandle) identity.email ??= displayHandle;
  for (const key of ["email", "name", "picture", "locale"]) {
    const value = stringValue(meta[key]);
    if (value) identity[key] = value;
  }
  return Object.keys(identity).length > 0 ? identity : null;
}

export function googleAccountEmail(account: ConnectorAccount): string | null {
  const identity = googleIdentityForAccount(account);
  return (
    (
      stringValue(identity?.email) ??
      stringValue(account.displayHandle) ??
      null
    )?.toLowerCase() ?? null
  );
}

export function googleGrantFromAccount(args: {
  account: ConnectorAccount;
  agentId: string;
}): LifeOpsConnectorGrant {
  const { account, agentId } = args;
  const capabilities = googleCapabilitiesForAccount(account);
  const updatedAt = new Date(account.updatedAt).toISOString();
  const createdAt = new Date(account.createdAt).toISOString();
  const meta = metadata(account);
  return {
    ...createLifeOpsConnectorGrant({
      agentId,
      provider: "google",
      side: googleSideForAccount(account),
      identity: googleIdentityForAccount(account) ?? {},
      grantedScopes: googleScopesForAccount(account, capabilities),
      capabilities,
      tokenRef: null,
      mode: "local",
      executionTarget: "local",
      sourceOfTruth: "connector_account",
      preferredByAgent: booleanValue(meta.isDefault),
      cloudConnectionId: null,
      metadata: {
        ...meta,
        connectorAccountId: account.id,
        connectorAccountProvider: "google",
      },
      lastRefreshAt: updatedAt,
    }),
    id: googleGrantIdForAccount(account.id),
    connectorAccountId: account.id,
    identityEmail: googleAccountEmail(account),
    createdAt,
    updatedAt,
  } as LifeOpsConnectorGrant;
}

export function googleStatusFromAccount(args: {
  account: ConnectorAccount;
  agentId: string;
  defaultMode?: LifeOpsConnectorMode;
  availableModes?: LifeOpsConnectorMode[];
}): LifeOpsGoogleConnectorStatus {
  const { account, agentId } = args;
  const grant = googleGrantFromAccount({ account, agentId });
  const meta = metadata(account);
  const connected = account.status === "connected";
  return {
    provider: "google",
    side: grant.side,
    mode: "local",
    defaultMode: args.defaultMode ?? "local",
    availableModes: args.availableModes ?? ["local"],
    executionTarget: "local",
    sourceOfTruth: "connector_account",
    configured: true,
    connected,
    reason:
      account.status === "error" || account.status === "revoked"
        ? "needs_reauth"
        : connected
          ? "connected"
          : "disconnected",
    preferredByAgent: grant.preferredByAgent,
    cloudConnectionId: null,
    identity: googleIdentityForAccount(account),
    grantedCapabilities: [...grant.capabilities] as LifeOpsGoogleCapability[],
    grantedScopes: [...grant.grantedScopes],
    expiresAt: isoString(meta.expiresAt),
    hasRefreshToken:
      booleanValue(meta.hasRefreshToken) ||
      Boolean(stringValue(meta.refreshTokenRef)),
    grant,
  };
}

export function disconnectedGoogleStatus(
  side: LifeOpsConnectorSide,
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
    reason: "disconnected",
    preferredByAgent: false,
    cloudConnectionId: null,
    identity: null,
    grantedCapabilities: [],
    grantedScopes: [],
    expiresAt: null,
    hasRefreshToken: false,
    grant: null,
    degradations: [
      {
        axis: "disconnected",
        code: "google_plugin_account_missing",
        message:
          "Connect a Google account through the Google connector account manager.",
        retryable: true,
      },
    ],
  };
}

export async function listGoogleConnectorAccounts(args: {
  runtime: IAgentRuntime;
  requestedSide?: LifeOpsConnectorSide;
}): Promise<ConnectorAccount[]> {
  const manager = getConnectorAccountManager(args.runtime);
  const accounts = await manager.listAccounts("google");
  return accounts
    .filter(
      (account) =>
        account.status !== "disabled" && account.status !== "revoked",
    )
    .filter((account) =>
      args.requestedSide
        ? googleSideForAccount(account) === args.requestedSide
        : true,
    );
}

export async function resolveGoogleConnectorAccount(args: {
  runtime: IAgentRuntime;
  requestedSide?: LifeOpsConnectorSide;
  grantId?: string | null;
}): Promise<ConnectorAccount | null> {
  const accountId = googleAccountIdFromGrantId(args.grantId);
  const accounts = await listGoogleConnectorAccounts({
    runtime: args.runtime,
    requestedSide: args.requestedSide,
  });
  if (accountId) {
    return (
      accounts.find(
        (account) =>
          account.id === accountId ||
          account.externalId === accountId ||
          account.displayHandle === accountId,
      ) ?? null
    );
  }
  return (
    accounts.find(
      (account) =>
        account.status === "connected" && metadata(account).isDefault === true,
    ) ??
    accounts.find((account) => account.status === "connected") ??
    accounts[0] ??
    null
  );
}

export function requireGoogleWorkspaceService(
  runtime: RuntimeWithService,
): IGoogleWorkspaceService {
  const service = runtime.getService("google");
  if (!service || typeof service !== "object") {
    fail(
      503,
      "Google Workspace service is not registered. Enable @elizaos/plugin-google-workspace before using LifeOps Google features.",
    );
  }
  return service as IGoogleWorkspaceService;
}

export function requireGoogleServiceMethod<
  K extends keyof IGoogleWorkspaceService,
>(runtime: RuntimeWithService, method: K): IGoogleWorkspaceService[K] {
  const service = requireGoogleWorkspaceService(runtime);
  const fn = service[method];
  if (typeof fn !== "function") {
    fail(
      501,
      `@elizaos/plugin-google-workspace does not expose ${String(method)} for account-scoped LifeOps access.`,
    );
  }
  return fn.bind(service) as IGoogleWorkspaceService[K];
}

export function requireCapability(args: {
  grant: LifeOpsConnectorGrant;
  capability: LifeOpsGoogleCapability | string;
  message: string;
}): void {
  if (
    !args.grant.capabilities.includes(
      args.capability as LifeOpsGoogleCapability,
    )
  ) {
    fail(403, args.message);
  }
}

export function accountIdForGrant(grant: LifeOpsConnectorGrant): string {
  return (
    stringValue(grant.connectorAccountId) ??
    googleAccountIdFromGrantId(grant.id) ??
    fail(
      409,
      "Google connector account id is missing. Reconnect Google through connector account management.",
    )
  );
}

export function mapGoogleEmailAddress(
  value: string | GoogleEmailAddress,
): GoogleEmailAddress {
  return typeof value === "string" ? { email: value } : value;
}

/** Stable Gmail projection identity scoped to the exact Google account. */
export function lifeOpsGmailMessageId(args: {
  agentId: string;
  grant: LifeOpsConnectorGrant;
  externalId: string;
}): string {
  return `${args.agentId}:google:${args.grant.side}:${accountIdForGrant(args.grant)}:gmail:${args.externalId}`;
}

export function lifeOpsGmailMessageFromGoogle(args: {
  message: GoogleMessageSummary | GoogleGmailMessageSummary;
  grant: LifeOpsConnectorGrant;
  agentId: string;
  syncedAt?: string;
}): LifeOpsGmailMessageSummary {
  const { message, grant, agentId } = args;
  const syncedAt = args.syncedAt ?? new Date().toISOString();
  const rich: GoogleGmailMessageSummary | undefined =
    "externalId" in message ? message : undefined;
  const legacy: GoogleMessageSummary | undefined =
    "id" in message ? message : undefined;
  const labels = rich?.labels ?? legacy?.labelIds ?? [];
  const fromName = rich?.from.trim() || legacy?.from?.name?.trim();
  const fromEmail = rich?.fromEmail ?? legacy?.from?.email?.trim() ?? null;
  const receivedAt = message.receivedAt ?? syncedAt;
  const externalId = "externalId" in message ? message.externalId : message.id;
  return {
    id: lifeOpsGmailMessageId({ agentId, grant, externalId }),
    externalId,
    agentId,
    provider: "google",
    side: grant.side,
    threadId: message.threadId || externalId,
    subject: message.subject ?? "(no subject)",
    from: fromName || fromEmail || "Unknown sender",
    fromEmail,
    replyTo: rich?.replyTo ?? legacy?.replyTo?.email ?? null,
    to: rich?.to ?? legacy?.to?.map((item) => item.email) ?? [],
    cc: rich?.cc ?? legacy?.cc?.map((item) => item.email) ?? [],
    snippet: rich?.snippet ?? legacy?.snippet ?? legacy?.bodyText ?? "",
    receivedAt,
    isUnread: rich?.isUnread ?? labels.includes("UNREAD"),
    isImportant: rich?.isImportant ?? labels.includes("IMPORTANT"),
    likelyReplyNeeded:
      rich?.likelyReplyNeeded ??
      (labels.includes("INBOX") && !labels.includes("SENT")),
    triageScore:
      rich?.triageScore ??
      (labels.includes("IMPORTANT") ? 90 : labels.includes("UNREAD") ? 70 : 40),
    triageReason:
      rich?.triageReason ??
      (labels.includes("IMPORTANT")
        ? "Marked important in Gmail."
        : labels.includes("UNREAD")
          ? "Unread inbox message."
          : "Recent Gmail message."),
    labels,
    htmlLink: rich?.htmlLink ?? null,
    metadata: {
      googlePlugin: true,
      ...(rich?.metadata ?? {}),
      ...(legacy
        ? { headers: legacy.headers ?? {}, bodyHtml: legacy.bodyHtml }
        : {}),
    },
    syncedAt,
    updatedAt: syncedAt,
    connectorAccountId: grant.connectorAccountId ?? undefined,
    grantId: grant.id,
    accountEmail: grant.identityEmail ?? undefined,
  };
}

function _dateTimeValue(value: string | undefined, fallback: string): string {
  return value?.trim() ? value : fallback;
}

export function googleSendEmailInput(args: {
  accountId: string;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  threadId?: string;
}): GoogleSendEmailInput {
  return {
    accountId: args.accountId,
    to: args.to.map(mapGoogleEmailAddress),
    cc: args.cc?.map(mapGoogleEmailAddress),
    bcc: args.bcc?.map(mapGoogleEmailAddress),
    subject: args.subject,
    text: args.bodyText,
    html: args.bodyHtml,
    threadId: args.threadId,
  };
}

export type { GoogleDriveFile, Metadata };
