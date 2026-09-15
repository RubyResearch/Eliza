/**
 * Cloud-domain client DTOs: Cloud*, App*, Trajectory*, Registry*, Whitelist*,
 * Verification*, wallet display types, CodingAgent*, Pty*. One slice of the
 * ElizaClient type surface, re-exported through client-types.ts.
 */

import type {
  TrajectoryExportOptions as CoreTrajectoryExportOptions,
  TrajectoryListOptions as CoreTrajectoryListOptions,
  TrajectoryListResult as CoreTrajectoryListResult,
  TrajectoryLlmCallRecord as CoreTrajectoryLlmCallRecord,
  TrajectoryProviderAccessRecord as CoreTrajectoryProviderAccessRecord,
  TrajectorySummaryRecord as CoreTrajectorySummaryRecord,
  TrajectorySemanticStageRecord,
} from "@elizaos/core";
import type {
  AppLaunchDiagnostic,
  AppLaunchDiagnosticSeverity,
  AppLaunchResult,
  AppRunActionResult,
  AppRunAwaySummary,
  AppRunCapabilityAvailability,
  AppRunEvent,
  AppRunEventKind,
  AppRunEventSeverity,
  AppRunHealth,
  AppRunHealthDetails,
  AppRunHealthFacet,
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionActionResult,
  AppSessionActivityItem,
  AppSessionConfig,
  AppSessionControlAction,
  AppSessionFeature,
  AppSessionJsonValue,
  AppSessionMode,
  AppSessionRecommendation,
  AppSessionState,
  AppStopResult,
  AppUiExtensionConfig,
  AppViewerAuthMessage,
  AppViewerConfig,
  RegistryAppInfo,
} from "@elizaos/shared";
import type { TrajectoryExportFormat } from "./client-types-core";

export type {
  AppLaunchDiagnostic,
  AppLaunchDiagnosticSeverity,
  AppLaunchResult,
  AppRunActionResult,
  AppRunAwaySummary,
  AppRunCapabilityAvailability,
  AppRunEvent,
  AppRunEventKind,
  AppRunEventSeverity,
  AppRunHealth,
  AppRunHealthDetails,
  AppRunHealthFacet,
  AppRunHealthState,
  AppRunSummary,
  AppRunViewerAttachment,
  AppSessionActionResult,
  AppSessionActivityItem,
  AppSessionConfig,
  AppSessionControlAction,
  AppSessionFeature,
  AppSessionJsonValue,
  AppSessionMode,
  AppSessionRecommendation,
  AppSessionState,
  AppStopResult,
  AppUiExtensionConfig,
  AppViewerAuthMessage,
  AppViewerConfig,
  RegistryAppInfo,
};

// Cloud
export interface CloudStatus {
  connected: boolean;
  enabled?: boolean;
  cloudVoiceProxyAvailable?: boolean;
  hasApiKey?: boolean;
  userId?: string;
  organizationId?: string;
  topUpUrl?: string;
  reason?: string;
}

export interface CloudCredits {
  connected: boolean;
  balance: number | null;
  /** True when the cloud API rejected the stored API key (same as chat 401). */
  authRejected?: boolean;
  error?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
}

export interface CloudApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string | null;
  createdAt: string | null;
}

/**
 * Result of listing the org's Eliza Cloud API keys. `keys` is null — not an
 * empty array — whenever the list could not be retrieved (signed out,
 * session-only route rejected the credential, or no direct-cloud transport),
 * so consumers can render a designed "manage in console" state instead of a
 * false healthy-empty (`GET /api/v1/api-keys` requires a user session; an
 * `eliza_` API key cannot list keys).
 */
export interface CloudApiKeys {
  keys: CloudApiKeySummary[] | null;
  manageUrl: string;
  reason?: "not-connected" | "session-required";
}

export interface LocalAgentBackupMetadata {
  fileName: string;
  path: string;
  createdAt: string;
  agentId: string;
  stateSha256: string;
  sizeBytes: number;
}

export interface CloudBillingPaymentMethod {
  id: string;
  type: string;
  label?: string;
  brand?: string;
  last4?: string;
  expiryMonth?: number;
  expiryYear?: number;
  isDefault?: boolean;
  walletAddress?: string;
  network?: string;
}

export interface CloudBillingHistoryItem {
  id: string;
  kind?: string;
  provider?: string;
  status: string;
  amount: number;
  currency: string;
  description?: string;
  receiptUrl?: string;
  createdAt: string;
}

export interface CloudBillingSummary {
  balance: number | null;
  currency?: string;
  low?: boolean;
  critical?: boolean;
  topUpUrl?: string;
  embeddedCheckoutEnabled?: boolean;
  hostedCheckoutEnabled?: boolean;
  cryptoEnabled?: boolean;
  minimumTopUp?: number;
  hasPaymentMethod?: boolean;
  paymentMethods?: CloudBillingPaymentMethod[];
  history?: CloudBillingHistoryItem[];
  [key: string]: unknown;
}

export interface CloudBillingSettings {
  success?: boolean;
  message?: string;
  error?: string;
  settings?: {
    autoTopUp?: {
      enabled?: boolean;
      amount?: number | null;
      threshold?: number | null;
      hasPaymentMethod?: boolean;
    };
    limits?: {
      minAmount?: number;
      maxAmount?: number;
      minThreshold?: number;
      maxThreshold?: number;
    };
  };
  [key: string]: unknown;
}

export interface CloudBillingSettingsUpdateRequest {
  autoTopUp?: {
    enabled?: boolean;
    amount?: number;
    threshold?: number;
  };
}

export interface CloudBillingCheckoutRequest {
  amountUsd: number;
  mode?: "embedded" | "hosted";
}

export interface CloudBillingCheckoutResponse {
  success?: boolean;
  provider?: string;
  mode?: "embedded" | "hosted";
  checkoutUrl?: string;
  url?: string;
  publishableKey?: string;
  clientSecret?: string;
  sessionId?: string;
  message?: string;
  [key: string]: unknown;
}

export interface CloudBillingCryptoQuoteRequest {
  amountUsd: number;
  currency?: string;
  network?: string;
  walletAddress?: string;
}

export interface CloudBillingCryptoQuoteResponse {
  success?: boolean;
  provider?: string;
  invoiceId?: string;
  network?: string;
  currency?: string;
  amount?: string;
  amountUsd?: number;
  payToAddress?: string;
  tokenAddress?: string;
  paymentLinkUrl?: string;
  expiresAt?: string;
  memo?: string;
  [key: string]: unknown;
}

export interface CloudLoginResponse {
  ok: boolean;
  sessionId: string;
  browserUrl: string;
  error?: string;
}

export interface CloudLoginPollResponse {
  status: "pending" | "authenticated" | "expired" | "error";
  /**
   * Cloud API key, returned only on `status: "authenticated"`. The renderer
   * persists this through the steward-session store (the canonical cloud-token
   * channel) so the direct cloud path (`/api/v1/eliza/...`) can be used for
   * agent provisioning. Without it the renderer falls back to the proxy compat
   * path whose queue doesn't drain.
   */
  token?: string;
  keyPrefix?: string;
  organizationId?: string;
  userId?: string;
  error?: string;
}

export interface CloudLoginPersistResponse {
  ok: boolean;
  error?: string;
}

// Cloud Compat (Eliza Cloud v2 thin-client types)
export interface CloudCompatAgent {
  agent_id: string;
  agent_name: string;
  node_id: string | null;
  container_id: string | null;
  headscale_ip: string | null;
  bridge_url: string | null;
  web_ui_url: string | null;
  status: string;
  agent_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  containerUrl: string;
  webUiUrl: string | null;
  database_status: string;
  error_message: string | null;
  last_heartbeat_at: string | null;
  /** Authoritative Cloud execution tier ("shared" | "dedicated"); the
   * dedicated-mode agent picker filters shared bridges on it. */
  execution_tier?: string | null;
}

export interface CloudCompatAgentStatus {
  status: string;
  lastHeartbeat: string | null;
  bridgeUrl: string | null;
  webUiUrl: string | null;
  currentNode: string | null;
  suspendedReason: string | null;
  databaseStatus: string;
}

export interface CloudCompatAgentProvisionResponse {
  success: boolean;
  created?: boolean;
  alreadyInProgress?: boolean;
  message?: string;
  error?: string;
  requiredBalance?: number;
  currentBalance?: number;
  data?: {
    id?: string;
    agentId?: string;
    agentName?: string;
    status?: string;
    jobId?: string;
    bridgeUrl?: string | null;
    webUiUrl?: string | null;
    runtimeUrl?: string | null;
    containerUrl?: string | null;
    healthUrl?: string | null;
    estimatedCompletionAt?: string | null;
  };
  polling?: {
    endpoint?: string;
    intervalMs?: number;
    expectedDurationMs?: number;
  };
}

export interface CloudCompatManagedDiscordStatus {
  applicationId: string | null;
  configured: boolean;
  connected: boolean;
  developerPortalUrl: string;
  guildId: string | null;
  guildName: string | null;
  adminDiscordUserId: string | null;
  adminDiscordUsername: string | null;
  adminDiscordDisplayName: string | null;
  adminDiscordAvatarUrl: string | null;
  adminElizaUserId: string | null;
  botNickname: string | null;
  connectedAt: string | null;
  restarted?: boolean;
}

/** Discord plugin config shape exposed to cloud dashboard. */
export interface CloudCompatDiscordConfig {
  dm?: {
    enabled?: boolean;
    policy?: "open" | "pairing" | "allowlist";
    allowFrom?: Array<string | number>;
    groupEnabled?: boolean;
  };
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  actions?: {
    reactions?: boolean;
    stickers?: boolean;
    emojiUploads?: boolean;
    stickerUploads?: boolean;
    polls?: boolean;
    permissions?: boolean;
    messages?: boolean;
    threads?: boolean;
    pins?: boolean;
    search?: boolean;
    memberInfo?: boolean;
    roleInfo?: boolean;
    roles?: boolean;
    channelInfo?: boolean;
    voiceStatus?: boolean;
    events?: boolean;
    moderation?: boolean;
    channels?: boolean;
    presence?: boolean;
  };
  maxLinesPerMessage?: number;
  textChunkLimit?: number;
  intents?: {
    presence?: boolean;
    guildMembers?: boolean;
  };
  pluralkit?: {
    enabled?: boolean;
  };
  execApprovals?: {
    enabled?: boolean;
  };
}

export interface CloudCompatManagedGithubStatus {
  configured: boolean;
  connected: boolean;
  mode?: "cloud-managed" | "shared-owner" | null;
  connectionId: string | null;
  connectionRole?: CloudOAuthConnectionRole | null;
  githubUserId: string | null;
  githubUsername: string | null;
  githubDisplayName: string | null;
  githubAvatarUrl: string | null;
  githubEmail: string | null;
  scopes: string[];
  source?: CloudOAuthConnectionSource | null;
  adminElizaUserId: string | null;
  connectedAt: string | null;
  restarted?: boolean;
}

export type CloudOAuthConnectionRole = "owner" | "agent";
export type CloudOAuthConnectionStatus =
  | "pending"
  | "active"
  | "expired"
  | "revoked"
  | "error";
export type CloudOAuthConnectionSource = "platform_credentials" | "secrets";

export interface CloudOAuthConnection {
  id: string;
  userId?: string;
  connectionRole?: CloudOAuthConnectionRole;
  platform: string;
  platformUserId: string;
  email?: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  status: CloudOAuthConnectionStatus;
  scopes: string[];
  linkedAt: string;
  lastUsedAt?: string;
  tokenExpired: boolean;
  source: CloudOAuthConnectionSource;
}

export interface CloudOAuthInitiateResponse {
  authUrl: string;
  state?: string;
  provider?: {
    id: string;
    name: string;
  };
}

export interface CloudTwitterOAuthInitiateResponse
  extends CloudOAuthInitiateResponse {
  oauthToken?: string;
  flow?: "oauth1a" | "oauth2";
  connectionRole?: CloudOAuthConnectionRole;
}

export interface CloudCompatJob {
  jobId: string;
  type: string;
  status: "queued" | "processing" | "completed" | "failed" | "retrying";
  data: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  retryCount: number;
  id: string;
  name: string;
  state: string;
  created_on: string;
  completed_on: string | null;
}

export interface CloudCompatLaunchResult {
  agentId: string;
  agentName: string;
  appUrl: string;
  launchSessionId: string | null;
  issuedAt: string;
  connection: {
    apiBase: string;
    token: string;
  };
}

// App types — the App-run / App-session DTO contract is owned by
// @elizaos/shared/contracts/apps (re-exported from the shared root barrel and
// re-exported above). Only InstalledAppInfo is defined here: the client's
// installed-app view (installPath / isRunning) is a distinct shape from shared's
// registry-oriented InstalledAppInfo (pluginName), so it stays UI-local.
export interface InstalledAppInfo {
  name: string;
  displayName: string;
  version: string;
  installPath: string;
  installedAt: string;
  isRunning: boolean;
}

// Trajectories
export interface TrajectoryRecord extends CoreTrajectorySummaryRecord {
  roomId: string | null;
  entityId: string | null;
  conversationId: string | null;
  metadata: Record<string, TrajectoryJsonValue | undefined>;
  updatedAt: string;
}

export interface TrajectoryLlmCall extends CoreTrajectoryLlmCallRecord {
  id: string;
  trajectoryId: string;
  stepId: string;
  timestamp: number;
  model: string;
  systemPrompt?: string;
  userPrompt?: string;
  response?: string;
  temperature: number;
  maxTokens: number;
  purpose: string;
  actionType: string;
  latencyMs: number;
  createdAt: string;
}

export interface TrajectoryProviderAccess
  extends CoreTrajectoryProviderAccessRecord {
  id: string;
  trajectoryId: string;
  stepId: string;
  providerName: string;
  purpose: string;
  data: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export type TrajectoryJsonValue =
  | string
  | number
  | boolean
  | null
  | TrajectoryJsonValue[]
  | { [key: string]: TrajectoryJsonValue };

export type ContextEventType =
  | "message"
  | "memory"
  | "provider"
  | "tool"
  | "instruction"
  | "segment"
  | "metadata"
  | (string & {});

export type ContextEventRole =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | (string & {});

export interface ContextEventBase {
  id: string;
  type: ContextEventType;
  createdAt?: number;
  source?: string;
  metadata?: Record<string, TrajectoryJsonValue | undefined>;
}

export interface ContextMessageEvent extends ContextEventBase {
  type: "message";
  message: {
    id?: string;
    role: ContextEventRole;
    content: string | TrajectoryJsonValue;
    name?: string;
    metadata?: Record<string, TrajectoryJsonValue | undefined>;
  };
}

export interface ContextMemoryEvent extends ContextEventBase {
  type: "memory";
  memory: Record<string, unknown>;
}

export interface ContextProviderEvent extends ContextEventBase {
  type: "provider";
  name: string;
  text?: string;
  values?: Record<string, TrajectoryJsonValue | undefined>;
  data?: Record<string, unknown>;
}

export interface ContextToolEvent extends ContextEventBase {
  type: "tool";
  tool: {
    id?: string;
    name: string;
    description?: string;
    parameters?: unknown;
    metadata?: Record<string, TrajectoryJsonValue | undefined>;
  };
}

export interface ContextInstructionEvent extends ContextEventBase {
  type: "instruction";
  content: string;
  role?: ContextEventRole;
  stable?: boolean;
}

export interface ContextSegmentEvent extends ContextEventBase {
  type: "segment";
  segment: Record<string, unknown> & {
    id?: string;
    label?: string;
    tokenCount?: number;
  };
}

export interface ContextMetadataEvent extends ContextEventBase {
  type: "metadata";
  key: string;
  value: TrajectoryJsonValue;
}

export type ContextEvent =
  | ContextMessageEvent
  | ContextMemoryEvent
  | ContextProviderEvent
  | ContextToolEvent
  | ContextInstructionEvent
  | ContextSegmentEvent
  | ContextMetadataEvent
  | (ContextEventBase & Record<string, unknown>);

export type NativeToolCallStatus =
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "failed";

export interface TrajectoryEventBase {
  id: string;
  trajectoryId?: string;
  stepId?: string;
  stage?: PipelineStageName;
  timestamp?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export type PipelineStageName =
  | "input"
  | "should_respond"
  | "message_handler"
  | "plan"
  | "planner"
  | "sub_planner"
  | "actions"
  | "evaluators"
  | "evaluator"
  | "context"
  | "cache"
  | (string & {});

export interface NativeToolCallEvent extends TrajectoryEventBase {
  type: "tool_call" | "tool_result" | "tool_error";
  callId?: string;
  toolCallId?: string;
  actionName?: string;
  toolName?: string;
  name?: string;
  args?: Record<string, unknown>;
  input?: Record<string, unknown>;
  result?: unknown;
  output?: unknown;
  status?: NativeToolCallStatus;
  success?: boolean;
  durationMs?: number;
  duration?: number;
  error?: string;
}

export interface TrajectoryEvaluationEvent extends TrajectoryEventBase {
  type: "evaluation" | "evaluator";
  evaluatorName?: string;
  name?: string;
  status?: NativeToolCallStatus;
  success?: boolean;
  decision?: string;
  thought?: string;
  result?: unknown;
  durationMs?: number;
  error?: string;
}

export interface TrajectoryCacheObservation extends TrajectoryEventBase {
  type: "cache_observation" | "cache";
  cacheName?: string;
  key?: string;
  scope?: string;
  hit: boolean;
  reason?: string;
  ttlMs?: number;
  ageMs?: number;
  sizeBytes?: number;
  tokenCount?: number;
}

export type ContextDiffChangeType =
  | "added"
  | "removed"
  | "changed"
  | "unchanged"
  | (string & {});

export interface TrajectoryContextDiffChange {
  type: ContextDiffChangeType;
  path?: string;
  before?: unknown;
  after?: unknown;
  summary?: string;
  tokenDelta?: number;
}

export interface TrajectoryContextDiff extends TrajectoryEventBase {
  type: "context_diff";
  label?: string;
  beforeContextId?: string;
  afterContextId?: string;
  added?: number;
  removed?: number;
  changed?: number;
  tokenDelta?: number;
  changes?: TrajectoryContextDiffChange[];
  before?: unknown;
  after?: unknown;
}

export type TrajectoryEvent =
  | NativeToolCallEvent
  | TrajectoryEvaluationEvent
  | TrajectoryCacheObservation
  | TrajectoryContextDiff
  | (TrajectoryEventBase & { type: string; [key: string]: unknown });

export interface TrajectoryCacheStatsData {
  hits: number;
  misses: number;
  total: number;
  hitRate: number;
  tokenCount?: number;
  sizeBytes?: number;
}

export type TrajectoryListOptions = CoreTrajectoryListOptions;

export interface TrajectoryListResult
  extends CoreTrajectoryListResult<TrajectoryRecord> {}

export interface TrajectoryDetailResult {
  /** False for lightweight inspection; full stored wire evidence remains available. */
  payloadsIncluded?: boolean;
  trajectory: TrajectoryRecord;
  llmCalls: TrajectoryLlmCall[];
  providerAccesses: TrajectoryProviderAccess[];
  semanticStages?: TrajectorySemanticStageRecord[];
  events?: TrajectoryEvent[];
  contextEvents?: ContextEvent[];
  toolEvents?: NativeToolCallEvent[];
  evaluationEvents?: TrajectoryEvaluationEvent[];
  cacheObservations?: TrajectoryCacheObservation[];
  cacheStats?: TrajectoryCacheStatsData;
  contextDiffs?: TrajectoryContextDiff[];
}

export interface TrajectoryStats {
  totalTrajectories: number;
  totalLlmCalls: number;
  totalProviderAccesses: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  averageDurationMs: number;
  bySource: Record<string, number>;
  byModel: Record<string, number>;
}

export interface TrajectoryConfig {
  enabled: boolean;
}

export type TrajectoryExportOptions = CoreTrajectoryExportOptions & {
  format: TrajectoryExportFormat | "jsonl";
};

// ERC-8004 Registry & Drop types
export interface RegistryStatus {
  registered: boolean;
  tokenId: number;
  agentName: string;
  agentEndpoint: string;
  capabilitiesHash: string;
  isActive: boolean;
  tokenURI: string;
  walletAddress: string;
  totalAgents: number;
  configured: boolean;
}

export interface RegistrationResult {
  tokenId: number;
  txHash: string;
}

export interface RegistryConfig {
  configured: boolean;
  chainId: number;
  registryAddress: string | null;
  collectionAddress: string | null;
  explorerUrl: string;
}

export interface WhitelistStatus {
  eligible: boolean;
  twitterVerified: boolean;
  ogCode: string | null;
  walletAddress: string;
}

export interface VerificationMessageResponse {
  message: string;
  walletAddress: string;
}

// Coding Agent Sessions
export interface CodingAgentSession {
  sessionId: string;
  agentType: string;
  label: string;
  originalTask: string;
  workdir: string;
  status:
    | "active"
    | "blocked"
    | "completed"
    | "stopped"
    | "error"
    | "tool_running";
  decisionCount: number;
  autoResolvedCount: number;
  /** Description of the active tool when status is "tool_running". */
  toolDescription?: string;
  /** Latest activity text for the agent activity box. */
  lastActivity?: string;
}

export interface CodingAgentScratchWorkspace {
  sessionId: string;
  label: string;
  path: string;
  status: "pending_decision" | "kept" | "promoted";
  createdAt: number;
  terminalAt: number;
  terminalEvent: "stopped" | "task_complete" | "error";
  expiresAt?: number;
}

export interface AgentPreflightResult {
  adapter?: string;
  installed?: boolean;
  installCommand?: string;
  docsUrl?: string;
  auth?: {
    status: "authenticated" | "unauthenticated" | "unknown";
    method?: string;
    detail?: string;
    loginHint?: string;
  };
}

/** Token/cost usage rolled up per provider+model. Mirrors the orchestrator
 * route's `TaskUsageSummary`. `state` lets the UI render measured / estimated /
 * unavailable distinctly instead of a misleading confident `0`. */
export interface CodingAgentTaskUsageProvider {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  state: "measured" | "estimated" | "unavailable";
}

export interface CodingAgentTaskUsageSummary {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  state: "measured" | "estimated" | "unavailable";
  byProvider: CodingAgentTaskUsageProvider[];
}

/** Provider/model/subscription policy applied to a task's sub-agents. */
export interface CodingAgentTaskProviderPolicy {
  preferredFramework?: string;
  providerSource?: string;
  model?: string;
}

/** A registered project the switcher lists + activates (#13776 item 5). Mirrors
 * the agent-side `ProjectSummaryDTO`. */
export interface ProjectSummary {
  id: string;
  name: string;
  localPath: string;
  repoUrl?: string;
  defaultBranch?: string;
  lastOpenedAt: string;
}

/** `GET /api/projects` payload: the registry list plus the active pointer. */
export interface ProjectListResponse {
  projects: ProjectSummary[];
  activeProjectId: string | null;
}

export interface CodingAgentTaskThread {
  id: string;
  title: string;
  kind: string;
  status:
    | "open"
    | "active"
    | "waiting_on_user"
    | "blocked"
    | "validating"
    | "done"
    | "failed"
    | "archived"
    | "interrupted";
  priority: "low" | "normal" | "high" | "urgent";
  paused: boolean;
  originalRequest: string;
  summary?: string;
  sessionCount: number;
  activeSessionCount: number;
  latestSessionId: string | null;
  latestSessionLabel: string | null;
  latestWorkdir: string | null;
  latestRepo: string | null;
  /** Registered project this task is bound to (null = unbound). Present on the
   * summary so the task list can group by project without fetching each task's
   * detail (#13776). */
  projectId: string | null;
  latestActivityAt: number | null;
  /** Model + account provenance of the latest session, surfaced on the summary
   * so widgets can show which model/account a task runs under without fetching
   * its detail (#16203). */
  latestSessionModel: string | null;
  latestAccountProviderId: string | null;
  latestAccountId: string | null;
  latestAccountLabel: string | null;
  /** Fork lineage: the task this one was forked from (null = root task). */
  parentTaskId: string | null;
  decisionCount: number;
  usage: CodingAgentTaskUsageSummary;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  archivedAt: string | null;
}

export interface CodingAgentTaskSessionRecord {
  id: string;
  threadId: string;
  sessionId: string;
  framework: string;
  providerSource: string | null;
  model: string | null;
  accountProviderId: string | null;
  accountId: string | null;
  accountLabel: string | null;
  label: string;
  originalTask: string;
  workdir: string;
  repo: string | null;
  status: string;
  activeTool: string | null;
  decisionCount: number;
  autoResolvedCount: number;
  registeredAt: number;
  lastActivityAt: number;
  idleCheckCount: number;
  taskDelivered: boolean;
  completionSummary: string | null;
  lastSeenDecisionIndex: number;
  lastInputSentAt: number | null;
  stoppedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cacheTokens: number;
  costUsd: number;
  usageState: "measured" | "estimated" | "unavailable";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * The real git change set a coding sub-agent produced, captured from git at
 * `task_complete` and surfaced on a session record's `metadata.lastChangeSet`
 * (`CodingAgentTaskSessionRecord.metadata`). Structurally mirrors the
 * orchestrator plugin's `WorkspaceChangeSet`; consumed read-only by
 * `DiffReviewPanel`.
 */
export interface ChangeSetData {
  changedFiles: string[];
  diffStat: string;
  diff: string;
  truncated: boolean;
  capturedAt: number;
}

export interface CodingAgentTaskDecisionRecord {
  id: string;
  threadId: string;
  sessionId: string;
  event: string;
  promptText: string;
  decision: string;
  response: string | null;
  reasoning: string;
  timestamp: number;
  createdAt: string;
}

export interface CodingAgentTaskEventRecord {
  id: string;
  threadId: string;
  sessionId: string | null;
  turnId: string | null;
  eventType: string;
  timestamp: number;
  summary: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CodingAgentTaskArtifactRecord {
  id: string;
  threadId: string;
  sessionId: string | null;
  artifactType: string;
  title: string;
  path: string | null;
  uri: string | null;
  mimeType: string | null;
  verificationStatus: "pending" | "passed" | "failed" | "unknown";
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** A room-message timeline entry: user prompts, orchestrator turns, and
 * sub-agent output, ordered for the `/orchestrator` conversation view. Mirrors
 * the route's `TaskMessageDto`. */
export interface CodingAgentTaskMessageRecord {
  id: string;
  threadId: string;
  sessionId: string | null;
  senderKind: "user" | "orchestrator" | "sub_agent" | "system";
  direction: "stdout" | "stderr" | "stdin" | "keys" | "system";
  content: string;
  timestamp: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type CodingAgentTaskTimelineItem =
  | {
      id: string;
      kind: "message";
      threadId: string;
      sessionId: string | null;
      timestamp: number;
      createdAt: string;
      message: CodingAgentTaskMessageRecord;
    }
  | {
      id: string;
      kind: "event";
      threadId: string;
      sessionId: string | null;
      timestamp: number;
      createdAt: string;
      event: CodingAgentTaskEventRecord;
    };

export interface CodingAgentTaskPlanRevisionRecord {
  id: string;
  threadId: string;
  plan: Record<string, unknown>;
  basePlanRevisionId: string | null;
  editSummary: string | null;
  createdBy: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  createdAt: string;
}

export interface CodingAgentTaskTranscriptRecord {
  id: string;
  threadId: string;
  sessionId: string;
  timestamp: number;
  direction: "stdout" | "stderr" | "stdin" | "keys" | "system";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CodingAgentPendingDecisionRecord {
  sessionId: string;
  threadId: string;
  promptText: string;
  recentOutput: string;
  llmDecision: Record<string, unknown>;
  taskContext: Record<string, unknown>;
  createdAt: number;
  updatedAt: string;
}

export interface CodingAgentTaskThreadDetail extends CodingAgentTaskThread {
  goal: string;
  roomId: string | null;
  taskRoomId: string | null;
  worldId: string | null;
  ownerUserId: string | null;
  parentTaskId: string | null;
  acceptanceCriteria: string[];
  currentPlan: Record<string, unknown> | null;
  providerPolicy: CodingAgentTaskProviderPolicy | null;
  lastUserTurnAt: string | null;
  lastCoordinatorTurnAt: string | null;
  metadata: Record<string, unknown>;
  sessions: CodingAgentTaskSessionRecord[];
  decisions: CodingAgentTaskDecisionRecord[];
  events: CodingAgentTaskEventRecord[];
  artifacts: CodingAgentTaskArtifactRecord[];
  messages: CodingAgentTaskMessageRecord[];
  transcripts: CodingAgentTaskTranscriptRecord[];
  planRevisions: CodingAgentTaskPlanRevisionRecord[];
  /** Client-only: legacy coordinator pending-decision queue. The
   * `/api/orchestrator` detail DTO does not carry this, so it is absent there;
   * the older coding-agent panel still reads it when present. */
  pendingDecisions?: CodingAgentPendingDecisionRecord[];
}

/** A cursor-paginated slice of a task's message or event history. Mirrors the
 * orchestrator route's `PageResult<T>`. */
export interface CodingAgentTaskPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Aggregate orchestrator state for the workbench header. Computed server-side
 * (route `GET /api/orchestrator/status`) so the client never re-derives counts
 * or token spend. Mirrors the route's `OrchestratorStatus`. */
export interface CodingAgentOrchestratorStatus {
  taskCount: number;
  activeTaskCount: number;
  pausedTaskCount: number;
  blockedTaskCount: number;
  validatingTaskCount: number;
  sessionCount: number;
  activeSessionCount: number;
  usage: CodingAgentTaskUsageSummary;
  byStatus: Record<CodingAgentTaskThread["status"], number>;
}

/** One coding sub-agent's binding to a pooled account, with its spend. */
export interface OrchestratorAccountAssignment {
  taskId: string;
  taskTitle: string;
  sessionId: string;
  label: string;
  framework: string;
  status: string;
  active: boolean;
  accountProviderId: string;
  accountId: string;
  accountLabel: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number;
  usageState: "measured" | "estimated" | "unavailable";
}

export interface OrchestratorAccountProviderAvailability {
  providerId: string;
  total: number;
  enabled: number;
  healthy: number;
}

/** Payload for `GET /api/orchestrator/accounts`: which pooled accounts can serve
 * each coding-agent type, the active selection strategy, and the live
 * sub-agent → account assignment map. */
export interface OrchestratorAccountOverview {
  strategy: string;
  availability: Record<string, OrchestratorAccountProviderAvailability[]>;
  assignments: OrchestratorAccountAssignment[];
}

/** Per-provider readiness verdict from `GET /api/orchestrator/accounts/readiness`. */
export interface OrchestratorProviderReadiness {
  agentType: string;
  total: number;
  enabled: number;
  healthy: number;
  required: number;
  ok: boolean;
}

/** Payload for `GET /api/orchestrator/accounts/readiness`: whether the pool has
 * enough healthy accounts (≥1 Codex AND ≥1 Claude; ≥2 each under rotation) to
 * run the multi-account orchestrator, with the human-readable problems when not. */
export interface OrchestratorAccountReadiness {
  ready: boolean;
  rotation: boolean;
  required: number;
  providers: OrchestratorProviderReadiness[];
  problems: string[];
}

export type OrchestratorRoomParticipantKind =
  | "orchestrator"
  | "user"
  | "sub_agent";

/** One participant in a task room. `sub_agent` rows carry their pooled account
 * + live spend; `orchestrator`/`user` rows identify the two human-facing ends. */
export interface OrchestratorRoomParticipant {
  kind: OrchestratorRoomParticipantKind;
  id: string;
  label: string;
  framework?: string;
  status?: string;
  active?: boolean;
  activeTool?: string;
  accountProviderId?: string;
  accountId?: string;
  accountLabel?: string;
  totalTokens?: number;
  usageState?: "measured" | "estimated" | "unavailable";
}

/** A single task room with its grouped participant roster — the orchestrator,
 * the owning user, and every sub-agent attached to THIS room. */
export interface OrchestratorRoomRoster {
  taskId: string;
  taskTitle: string;
  status: string;
  roomId?: string;
  taskRoomId?: string;
  activeAgentCount: number;
  multiParty: boolean;
  participants: OrchestratorRoomParticipant[];
}

/** Payload for `GET /api/orchestrator/rooms`: per-room participant rosters
 * (orchestrator + user + each sub-agent grouped by task room) — the room-scoped
 * counterpart to the flat `/accounts` assignment map. */
export interface OrchestratorRoomRosterOverview {
  rooms: OrchestratorRoomRoster[];
}

/** Structured payload for creating a task via `POST /api/orchestrator/tasks`. */
export interface CodingAgentCreateTaskInput {
  title: string;
  goal: string;
  originalRequest?: string;
  kind?: string;
  priority?: CodingAgentTaskThread["priority"];
  acceptanceCriteria?: string[];
  providerPolicy?: CodingAgentTaskProviderPolicy;
  /** Free-form task metadata forwarded to the orchestrator. Recognized keys
   * include `autoVerify` and `capabilityProfile` (e.g. `"economics"` to let the
   * spawned sub-agent drive the monetized-app Cloud commands). */
  metadata?: Record<string, unknown>;
}

/** Structured payload for forking a task via `POST /api/orchestrator/tasks/:id/fork`. */
export interface CodingAgentForkTaskInput {
  title?: string;
  goal?: string;
  priority?: CodingAgentTaskThread["priority"];
  acceptanceCriteria?: string[];
}

/** Structured payload for adding a sub-agent via
 * `POST /api/orchestrator/tasks/:id/agents`. */
export interface CodingAgentAddAgentInput {
  framework?: string;
  providerSource?: string;
  model?: string;
  workdir?: string;
  repo?: string;
  label?: string;
  task?: string;
}

export interface CodingAgentRetryTurnInput {
  messageId?: string;
  sessionId?: string;
  instruction?: string;
  planRevisionId?: string;
  mode?: "same-session" | "new-session";
  agent?: CodingAgentAddAgentInput;
}

export interface CodingAgentRerunFromEventInput {
  eventId: string;
  instruction?: string;
  planRevisionId?: string;
  stopActive?: boolean;
  preserveHistory?: boolean;
  agent?: CodingAgentAddAgentInput;
}

export interface CodingAgentRestartTaskInput {
  instruction?: string;
  planRevisionId?: string;
  stopActive?: boolean;
  agent?: CodingAgentAddAgentInput;
}

export interface CodingAgentCreatePlanRevisionInput {
  plan: Record<string, unknown>;
  basePlanRevisionId?: string;
  editSummary?: string;
  createdBy?: string;
  metadata?: Record<string, unknown>;
}

export interface CodingAgentRestartWithEditedPlanInput
  extends CodingAgentRestartTaskInput {
  plan: Record<string, unknown>;
  basePlanRevisionId?: string;
  editSummary?: string;
}

/** Structured payload for updating a task via `PATCH /api/orchestrator/tasks/:id`. */
export interface CodingAgentUpdateTaskInput {
  title?: string;
  goal?: string;
  summary?: string;
  acceptanceCriteria?: string[];
  priority?: CodingAgentTaskThread["priority"];
  providerPolicy?: CodingAgentTaskProviderPolicy;
}

/** Structured payload for submitting a validation verdict via
 * `POST /api/orchestrator/tasks/:id/validate`. */
export interface CodingAgentValidateTaskInput {
  passed: boolean;
  summary?: string;
  evidence?: string;
  verifier?: string;
  humanOverride?: boolean;
}

export interface CodingAgentFrameworkAvailability {
  id: string;
  label: string;
  adapter: string;
  installed: boolean;
  installCommand: string;
  docsUrl: string;
  authReady: boolean;
  available: boolean;
  score: number;
  reason: string;
  warnings: string[];
}

export interface CodingAgentStatus {
  supervisionLevel: string;
  taskCount: number;
  tasks: CodingAgentSession[];
  pendingConfirmations: number;
  taskThreadCount?: number;
  taskThreads?: CodingAgentTaskThread[];
  preferredAgentType?: string;
  preferredAgentReason?: string;
  frameworks?: CodingAgentFrameworkAvailability[];
}

/** Raw ACP session shape returned by /api/coding-agents. */
export interface RawAcpSession {
  id: string;
  name?: string;
  agentType?: string;
  workdir?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Maps raw ACP sessions from /api/coding-agents into CodingAgentSession[].
 * Extracted as a pure function so it can be unit-tested without instantiating
 * the full ElizaClient.
 */
export function mapAcpSessionsToCodingAgentSessions(
  acpSessions: RawAcpSession[],
): CodingAgentSession[] {
  return acpSessions.map((s) => ({
    sessionId: s.id,
    agentType: s.agentType ?? "claude",
    label: (s.metadata?.label as string) ?? s.name ?? s.agentType ?? "Agent",
    originalTask: "",
    workdir: s.workdir ?? "",
    status:
      s.status === "ready" || s.status === "busy"
        ? ("active" as const)
        : s.status === "error"
          ? ("error" as const)
          : s.status === "stopped" ||
              s.status === "done" ||
              s.status === "completed" ||
              s.status === "exited"
            ? ("stopped" as const)
            : ("active" as const),
    decisionCount: 0,
    autoResolvedCount: 0,
  }));
}

/** Maps persisted task threads into the existing CodingAgentSession UI shape. */
export function mapTaskThreadsToCodingAgentSessions(
  taskThreads: CodingAgentTaskThread[],
): CodingAgentSession[] {
  return taskThreads.map((thread) => ({
    sessionId: thread.latestSessionId ?? thread.id,
    agentType: "task-thread",
    label: thread.title || thread.latestSessionLabel || "Task",
    originalTask: thread.originalRequest,
    workdir: thread.latestWorkdir ?? thread.latestRepo ?? "",
    status:
      thread.status === "failed"
        ? ("error" as const)
        : thread.status === "done"
          ? ("completed" as const)
          : thread.status === "interrupted"
            ? ("stopped" as const)
            : thread.status === "validating"
              ? ("tool_running" as const)
              : thread.status === "blocked" ||
                  thread.status === "waiting_on_user"
                ? ("blocked" as const)
                : ("active" as const),
    decisionCount: thread.decisionCount,
    autoResolvedCount: 0,
    lastActivity:
      thread.status === "interrupted"
        ? "Interrupted - reopen or resume this task"
        : thread.summary || thread.latestSessionLabel || thread.status,
  }));
}
