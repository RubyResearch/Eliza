/**
 * Core shared types for the app-state layer: the AppContext value shape, agent
 * status, and the many request/response DTOs threaded through the shell.
 * Imported broadly, so keep it type-only.
 */
import type {
  WalletChainKind,
  WalletEntry,
  WalletPrimaryMap,
  WalletSource,
} from "@elizaos/shared";
import type { Dispatch, SetStateAction } from "react";
import type {
  AgentStatus,
  AppRunSummary,
  AppSessionState,
  AppViewerAuthMessage,
  BscTradeExecuteRequest,
  BscTradeExecuteResponse,
  BscTradePreflightResponse,
  BscTradeQuoteRequest,
  BscTradeQuoteResponse,
  BscTradeTxStatusResponse,
  BscTransferExecuteRequest,
  BscTransferExecuteResponse,
  CharacterData,
  ChatTokenUsage,
  CodingAgentSession,
  Conversation,
  ConversationChannelType,
  ConversationMessage,
  CreateTriggerRequest,
  DropStatus,
  ExtensionStatus,
  FirstRunOptions,
  ImageAttachment,
  LogEntry,
  McpMarketplaceResult,
  McpRegistryServerDetail,
  McpServerConfig,
  McpServerStatus,
  MintResult,
  PluginInfo,
  RegistryPlugin,
  RegistryStatus,
  ReleaseChannel,
  SkillInfo,
  SkillScanReportSummary,
  StewardApprovalActionResponse,
  StewardBalanceResponse,
  StewardHistoryResponse,
  StewardPendingResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
  StreamEventEnvelope,
  TriggerHealthSnapshot,
  TriggerRunRecord,
  TriggerSummary,
  UpdateStatus,
  UpdateTriggerRequest,
  WalletAddresses,
  WalletBalancesResponse,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletExportResult,
  WalletNftsResponse,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
  WhitelistStatus,
  WorkbenchOverview,
} from "../api/client";
import type { FirstRunRuntimeTarget } from "../first-run/runtime-target";
import type { UiLanguage } from "../i18n";
import type { Tab } from "../navigation";
import type { AgentProfile } from "./agent-profile-types";
import type {
  BackgroundConfig,
  UiShellMode,
  UiTheme,
  UiThemeMode,
} from "./ui-preferences";

export type { UiShellMode } from "./ui-preferences";

export type ShellView = "character" | "desktop";

/**
 * Controls which cloud-auth authority a login caller needs. Most settings
 * surfaces only require the connected server session; onboarding additionally
 * needs a renderer-held token for direct agent discovery and provisioning.
 */
export interface CloudLoginOptions {
  requireClientAuth?: boolean;
  /**
   * Discard the renderer's current Cloud credential and require a new sign-in.
   * Use only after that credential has been rejected by Cloud; this bypasses
   * cached connected-state and stored-token short-circuits.
   */
  forceReauth?: boolean;
}

/** Deferred work scheduling for multi-step navigation. */
export interface NavigationEventsApi {
  /**
   * Run `fn` after the next layout commit where `tab` has been applied.
   * Use to chain `switchShellView` → `setTab` without the second call losing
   * to batched `setTab(lastNativeTab)`.
   */
  scheduleAfterTabCommit: (fn: () => void) => void;
}

import type { ActionNotice, ActionTone } from "./action-notice";

export type { ActionNotice, ActionTone };

export type LifecycleAction = "start" | "stop" | "restart" | "reset";

export const LIFECYCLE_MESSAGES: Record<
  LifecycleAction,
  {
    inProgress: string;
    progress: string;
    success: string;
    verb: string;
  }
> = {
  start: {
    inProgress: "starting",
    progress: "Starting agent...",
    success: "Agent started.",
    verb: "start",
  },
  stop: {
    inProgress: "stopping",
    progress: "Stopping agent...",
    success: "Agent stopped.",
    verb: "stop",
  },

  restart: {
    inProgress: "restarting",
    progress: "Restarting agent...",
    success: "Agent restarted.",
    verb: "restart",
  },
  reset: {
    inProgress: "resetting",
    progress:
      "Resetting agent (server wipe + restart). This can take 1–2 minutes — keep the app open.",
    success: "Agent reset. Returning to first-run.",
    verb: "reset",
  },
};

export type GamePostMessageAuthPayload = AppViewerAuthMessage;

export const AGENT_STATES: ReadonlySet<AgentStatus["state"]> = new Set([
  "not_started",
  "starting",
  "running",
  "stopped",
  "restarting",
  "error",
]);

/**
 * Single source for "first-turn capability is online" — the agent can actually
 * answer, so the chat composer can go live and any queued sends can flush. This
 * is DISTINCT from the startup-coordinator phase (which gates full hydration):
 * the shell paints early (see `isShellPaintable`), and this flips when the
 * agent's response capability fades in behind it.
 *
 * Prefers the server-authoritative `canRespond` (`/api/health` + `/api/status`);
 * falls back to running+model for older agents/transports that don't report it.
 * A reported `canRespond: false` (running but no model provider) correctly keeps
 * the composer in its "set up a provider" state rather than going live.
 */
export function deriveAgentReady(agentStatus: AgentStatus | null): boolean {
  if (!agentStatus) {
    return false;
  }
  return (
    agentStatus.canRespond ??
    (agentStatus.state === "running" && Boolean(agentStatus.model))
  );
}

/**
 * Whether the chat lifecycle should keep polling agent status to clear the
 * "waking up" banner (#8777). Poll while the agent is NOT ready
 * ({@link deriveAgentReady}) and NOT in a terminal state — a null/early status
 * counts as not-ready-yet. The instant `canRespond` flips true (or a local model
 * resolves), `deriveAgentReady` returns true and polling stops, clearing the
 * banner. A cloud agent (no local `model`, `canRespond` still absent) keeps
 * polling until the broadcast carries `canRespond`.
 */
export function shouldAwaitAgentReadiness(
  agentStatus: AgentStatus | null,
): boolean {
  const state = agentStatus?.state;
  return (
    !deriveAgentReady(agentStatus) &&
    state !== "error" &&
    state !== "stopped" &&
    state !== "not_started"
  );
}

export type SlashCommandInput = {
  name: string;
  argsRaw: string;
};

export type StartupPhase = "starting-backend" | "initializing-agent" | "ready";

export type StartupErrorReason =
  | "backend-timeout"
  | "backend-unreachable"
  | "agent-timeout"
  | "agent-error"
  | "agent-stopped"
  | "asset-missing"
  | "unknown";

export interface StartupErrorState {
  reason: StartupErrorReason;
  phase: StartupPhase;
  message: string;
  detail?: string;
  status?: number;
  path?: string;
  /** Trusted Cloud management destination for an explicitly stopped agent. */
  cloudManagementUrl?: string;
  cloudAgentId?: string;
}

export interface StartupCoordinatorView {
  state: {
    phase:
      | "restoring-session"
      | "resolving-target"
      | "polling-backend"
      | "pairing-required"
      | "first-run-required"
      | "starting-runtime"
      | "hydrating"
      | "ready"
      | "error";
    [key: string]: unknown;
  };
  dispatch: (event: { type: string; [key: string]: unknown }) => void;
  retry: () => void;
  reset: () => void;
  pairingSuccess: () => void;
  firstRunComplete: () => void;
  policy: {
    supportsLocalRuntime: boolean;
    backendTimeoutMs: number;
    agentReadyTimeoutMs: number;
    probeForExistingInstall: boolean;
    defaultTarget: "embedded-local" | "remote-backend" | "cloud-managed" | null;
  };
  loading: boolean;
  terminal: boolean;
  isShellPaintable: boolean;
  isInteractive: boolean;
  statusMessageKey:
    | "startupshell.Starting"
    | "startupshell.InitializingAgent"
    | "startupshell.Loading";
  error: {
    reason: StartupErrorReason;
    message: string;
    timedOut: boolean;
  } | null;
  target: "embedded-local" | "remote-backend" | "cloud-managed" | null;
  phase: StartupCoordinatorView["state"]["phase"];
}

export interface ApiLikeError {
  kind?: string;
  code?: string;
  status?: number;
  path?: string;
  message?: string;
  data?: unknown;
}

export interface ChatTurnUsage extends ChatTokenUsage {
  updatedAt: number;
}

// ── Context value type ─────────────────────────────────────────────────

/** One toggle per primary chain in the wallet inventory filter strip. */
export type InventoryChainFilters = {
  ethereum: boolean;
  base: boolean;
  bsc: boolean;
  avax: boolean;
  solana: boolean;
};

/** Independent lifecycle for a wallet feed; optional feeds can be unsupported without poisoning core balances. */
export type WalletResourceStatus =
  | "idle"
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

export interface AppState {
  // Core
  tab: Tab;
  uiShellMode: UiShellMode;
  uiLanguage: UiLanguage;
  uiTheme: UiTheme;
  uiThemeMode: UiThemeMode;
  /** The unified home/app background, shared across the home and every view. */
  backgroundConfig: BackgroundConfig;
  /** True when there is a previous background config to undo to. */
  canUndoBackground: boolean;
  canRedoBackground: boolean;
  /** When true, the home time/date tile is hidden (user pref, #10706). */
  homeTimeWidgetHidden: boolean;
  /** User-chosen accent preset id; `default` keeps the brand accent. */
  uiAccentId: string;
  ownerName: string | null;
  connected: boolean;
  agentStatus: AgentStatus | null;
  firstRunComplete: boolean;
  /** Incremented on agent reset so first-run UI shows immediately (not stuck behind VRM reveal). */
  firstRunUiRevealNonce: number;
  firstRunLoading: boolean;
  startupError: StartupErrorState | null;
  /** StartupCoordinator handle — the sole startup authority. */
  startupCoordinator: StartupCoordinatorView;
  authRequired: boolean;
  actionNotice: ActionNotice | null;
  lifecycleBusy: boolean;
  lifecycleAction: LifecycleAction | null;

  // Deferred restart
  pendingRestart: boolean;
  pendingRestartReasons: string[];
  restartBannerDismissed: boolean;

  // Backend connection state (for crash handling)
  backendConnection: {
    state: "connected" | "disconnected" | "reconnecting" | "failed";
    reconnectAttempt: number;
    maxReconnectAttempts: number;
    showDisconnectedUI: boolean;
  };
  // System warnings
  systemWarnings: string[];

  // Pairing
  pairingEnabled: boolean;
  pairingExpiresAt: number | null;
  pairingCodeInput: string;
  pairingError: string | null;
  pairingBusy: boolean;

  // Chat
  chatInput: string;
  chatSending: boolean;
  chatFirstTokenReceived: boolean;
  chatLastUsage: ChatTurnUsage | null;
  chatAvatarVisible: boolean;
  chatAgentVoiceMuted: boolean;
  chatAvatarSpeaking: boolean;
  conversations: Conversation[];
  activeConversationId: string | null;
  companionMessageCutoffTs: number;
  conversationMessages: ConversationMessage[];
  autonomousEvents: StreamEventEnvelope[];
  autonomousLatestEventId: string | null;
  autonomousRunHealthByRunId: import("./autonomy").AutonomyRunHealthMap;
  /** Active PTY coding agent sessions from the SwarmCoordinator. */
  ptySessions: CodingAgentSession[];
  /** Conversation IDs with unread proactive messages from the agent. */
  unreadConversations: Set<string>;

  // Triggers
  triggers: TriggerSummary[];
  triggersLoaded: boolean;
  triggersLoading: boolean;
  triggersSaving: boolean;
  triggerRunsById: Record<string, TriggerRunRecord[]>;
  triggerHealth: TriggerHealthSnapshot | null;
  triggerError: string | null;

  // Plugins
  plugins: PluginInfo[];
  pluginFilter: "all" | "ai-provider" | "connector" | "feature" | "streaming";
  pluginStatusFilter: "all" | "enabled" | "disabled";
  pluginSearch: string;
  pluginSettingsOpen: Set<string>;
  pluginAdvancedOpen: Set<string>;
  pluginSaving: Set<string>;
  pluginSaveSuccess: Set<string>;
  isLoadingPlugins: boolean;
  pluginsLoadError: string | null;
  pluginsLoaded: boolean;

  // Skills
  skills: SkillInfo[];
  skillsSubTab: "my" | "browse";
  skillCreateFormOpen: boolean;
  skillCreateName: string;
  skillCreateDescription: string;
  skillCreating: boolean;
  skillReviewReport: SkillScanReportSummary | null;
  skillReviewId: string;
  skillReviewLoading: boolean;
  skillToggleAction: string;
  skillInstallError: string;
  skillInstallAction: string;
  skillInstallGithubUrl: string;

  // Logs
  logs: LogEntry[];
  logSources: string[];
  logTags: string[];
  logTagFilter: string;
  logLevelFilter: string;
  logSourceFilter: string;
  logLoadError: string | null;

  // Capabilities (feature toggles)
  browserEnabled: boolean;
  computerUseEnabled: boolean;

  // Wallet / Inventory
  walletEnabled: boolean;
  walletAddresses: WalletAddresses | null;
  walletConfig: WalletConfigStatus | null;
  walletBalances: WalletBalancesResponse | null;
  walletNfts: WalletNftsResponse | null;
  walletLoading: boolean;
  walletNftsLoading: boolean;
  walletConfigStatus: WalletResourceStatus;
  walletConfigError: string | null;
  walletBalancesStatus: WalletResourceStatus;
  walletBalancesError: string | null;
  walletNftsStatus: WalletResourceStatus;
  walletNftsError: string | null;
  inventoryView: "tokens" | "nfts";
  walletExportData: WalletExportResult | null;
  walletExportVisible: boolean;
  walletApiKeySaving: boolean;
  inventorySort: "chain" | "symbol" | "value";
  /** Ascending vs descending for the active `inventorySort` key. */
  inventorySortDirection: "asc" | "desc";
  inventoryChainFilters: InventoryChainFilters;
  walletError: string | null;
  wallets: WalletEntry[];
  walletPrimary: WalletPrimaryMap | null;
  walletPrimaryRestarting: Partial<Record<WalletChainKind, boolean>>;
  walletPrimaryPending: Partial<Record<WalletChainKind, boolean>>;
  cloudRefreshing: boolean;

  // ERC-8004 Registry
  registryStatus: RegistryStatus | null;
  registryLoading: boolean;
  registryRegistering: boolean;
  registryError: string | null;

  // Drop / Mint
  dropStatus: DropStatus | null;
  dropLoading: boolean;
  mintInProgress: boolean;
  mintResult: MintResult | null;
  mintError: string | null;
  mintShiny: boolean;

  whitelistStatus: WhitelistStatus | null;
  whitelistLoading: boolean;

  // Character
  characterData: CharacterData | null;
  characterLoading: boolean;
  characterSaving: boolean;
  characterSaveSuccess: string | null;
  characterSaveError: string | null;
  characterDraft: CharacterData;
  selectedVrmIndex: number;
  customVrmUrl: string;
  customVrmPreviewUrl: string;
  customBackgroundUrl: string;
  /** Active content pack ID, or null if no pack is selected. */
  activePackId: string | null;
  /** Active content pack custom catchphrase for voice preview override. */
  customCatchphrase: string;
  /** Active content pack voice preset ID override. */
  customVoicePresetId: string;
  /** Custom companion world URL from content pack (overrides day/night default). */
  customWorldUrl: string;

  // Eliza Cloud
  elizaCloudEnabled: boolean;
  elizaCloudVoiceProxyAvailable: boolean;
  elizaCloudConnected: boolean;
  elizaCloudHasPersistedKey: boolean;
  elizaCloudCredits: number | null;
  elizaCloudCreditsLow: boolean;
  elizaCloudCreditsCritical: boolean;
  /** Eliza Cloud returned 401 on balance check — inference will fail until the key is fixed. */
  elizaCloudAuthRejected: boolean;
  /** Non-fatal credits/API message from Eliza Cloud (e.g. unexpected response, network). */
  elizaCloudCreditsError: string | null;
  elizaCloudTopUpUrl: string;
  elizaCloudUserId: string | null;
  /** Last `reason` from GET /api/cloud/status (e.g. API-key-only vs OAuth). */
  elizaCloudStatusReason: string | null;
  cloudDashboardView: "overview" | "billing";
  elizaCloudLoginBusy: boolean;
  elizaCloudLoginError: string | null;
  /**
   * Verification URL returned by `POST /api/cloud/login` while a device-code
   * sign-in is in flight. Always exposed (not just on error) so the renderer
   * can render a copyable "didn't open? visit this link" fallback panel
   * underneath the spinner. Cleared when polling stops.
   *
   * See useCloudState's interactive login entry point for the setter and the
   * rationale — some desktop environments (notably Tails routing xdg-open to
   * Tor Browser flatpak) open without crashing but never surface a usable
   * window, leaving the user stuck.
   */
  elizaCloudLoginFallbackUrl: string | null;
  elizaCloudDisconnecting: boolean;

  // Multi-agent profiles
  activeAgentProfile: AgentProfile | null;

  // Updates
  updateStatus: UpdateStatus | null;
  updateLoading: boolean;
  updateChannelSaving: boolean;

  // Extension
  extensionStatus: ExtensionStatus | null;
  extensionChecking: boolean;

  // Store
  storePlugins: RegistryPlugin[];
  storeSearch: string;
  storeFilter: "all" | "installed" | "ai-provider" | "connector" | "feature";
  storeLoading: boolean;
  storeInstalling: Set<string>;
  storeUninstalling: Set<string>;
  storeError: string | null;
  storeDetailPlugin: RegistryPlugin | null;
  storeSubTab: "plugins" | "skills";

  // Workbench
  workbenchLoading: boolean;
  workbench: WorkbenchOverview | null;
  workbenchTasksAvailable: boolean;
  workbenchTriggersAvailable: boolean;
  workbenchTodosAvailable: boolean;

  // Agent export/import
  exportBusy: boolean;
  exportPassword: string;
  exportIncludeLogs: boolean;
  exportError: string | null;
  exportSuccess: string | null;
  importBusy: boolean;
  importPassword: string;
  importFile: File | null;
  importError: string | null;
  importSuccess: string | null;

  // First-run (the in-chat conductor owns flow state; these are the surviving
  // cross-surface fields: finish-port + CONNECT_EVENT writes, content-pack and
  // character-editor reads, and the cloud-provisioned skip guard)
  firstRunDeferredTasks: string[];
  postFirstRunChecklistDismissed: boolean;
  firstRunOptions: FirstRunOptions | null;
  firstRunName: string;
  firstRunStyle: string;
  firstRunRuntimeTarget: FirstRunRuntimeTarget;
  firstRunProvider: string;
  firstRunRemoteApiBase: string;
  firstRunRemoteToken: string;
  firstRunRemoteConnecting: boolean;
  firstRunRemoteError: string | null;
  firstRunRemoteConnected: boolean;
  firstRunCloudProvisionedContainer: boolean;

  // Command palette
  commandPaletteOpen: boolean;
  commandQuery: string;
  commandActiveIndex: number;
  closeCommandPalette: () => void;

  // Analysis Mode
  analysisMode: boolean;

  // Emote picker
  emotePickerOpen: boolean;

  // MCP
  mcpConfiguredServers: Record<string, McpServerConfig>;
  mcpServerStatuses: McpServerStatus[];
  mcpMarketplaceQuery: string;
  mcpMarketplaceResults: McpMarketplaceResult[];
  mcpMarketplaceLoading: boolean;
  mcpAction: string;
  mcpAddingServer: McpRegistryServerDetail | null;
  mcpAddingResult: McpMarketplaceResult | null;
  mcpEnvInputs: Record<string, string>;
  mcpHeaderInputs: Record<string, string>;

  // Share ingest
  droppedFiles: string[];
  shareIngestNotice: string;

  // Chat image attachments queued for the next message
  chatPendingImages: ImageAttachment[];

  // Game
  appRuns: AppRunSummary[];
  activeGameRunId: string;
  activeGameApp: string;
  activeGameDisplayName: string;
  activeGameViewerUrl: string;
  activeGameSandbox: string;
  activeGamePostMessageAuth: boolean;
  activeGamePostMessagePayload: GamePostMessageAuthPayload | null;
  activeGameSession: AppSessionState | null;

  /** When true, the game iframe persists as a floating overlay across all tabs. */
  gameOverlayEnabled: boolean;

  /** Name of the active full-screen overlay app, or null if none. */
  activeOverlayApp: string | null;

  /**
   * Currently-selected connector chat in the messages sidebar.
   * When non-null, the Chat view swaps its main panel out for a
   * read-only view of that room's inbox messages. Mutually exclusive
   * with an active dashboard conversation.
   */
  activeInboxChat: {
    avatarUrl?: string;
    canSend?: boolean;
    id: string;
    source: string;
    transportSource?: string;
    title: string;
    worldId?: string;
    worldLabel?: string;
  } | null;

  /**
   * Currently-selected PTY session in the Terminal channel. When
   * non-null, ChatView renders a full-window terminal bound to this
   * session id. Mutually exclusive with `activeInboxChat` and a live
   * dashboard conversation.
   */
  activeTerminalSessionId: string | null;

  // Sub-tabs
  appsSubTab: "browse" | "running" | "games";
  agentSubTab: "character" | "inventory" | "documents";
  pluginsSubTab: "features" | "connectors" | "plugins";
  databaseSubTab: "tables" | "media" | "vectors";

  // Favorite apps
  favoriteApps: string[];

  // Recently launched apps, most recent first (capped)
  recentApps: string[];

  // Config text
  configRaw: Record<string, unknown>;
  configText: string;
}

export type LoadConversationMessagesResult =
  | { ok: true }
  | { ok: false; status?: number; message: string };

export const AGENT_TRANSFER_MIN_PASSWORD_LENGTH = 12;
export const AGENT_READY_TIMEOUT_MS = 120_000;

export interface SetTabOptions {
  /** Preserve an exact route already owned by the caller instead of pushing the tab's canonical path. */
  history?: "push" | "preserve";
}

export interface AppActions {
  // Navigation
  setTab: (tab: Tab, options?: SetTabOptions) => void;
  setUiShellMode: (mode: UiShellMode) => void;
  switchUiShellMode: (mode: UiShellMode) => void;
  switchShellView: (view: ShellView) => void;
  navigation: NavigationEventsApi;
  setUiLanguage: (language: UiLanguage) => void;
  setUiTheme: (theme: UiTheme) => void;
  setUiThemeMode: (mode: UiThemeMode) => void;
  setBackgroundConfig: (config: BackgroundConfig) => void;
  /** Restore the most recent previous background config (no-op when empty). */
  undoBackgroundConfig: () => void;
  redoBackgroundConfig: () => void;
  /** Show/hide the home time/date tile (#10706). */
  setHomeTimeWidgetHidden: (hidden: boolean) => void;
  /** Choose the app accent color by preset id (applies live + persists). */
  setUiAccent: (id: string) => void;

  // Lifecycle
  handleStart: () => Promise<void>;
  handleStop: () => Promise<void>;

  handleRestart: () => Promise<void>;
  handleReset: () => Promise<void>;
  /** After main-process app-menu reset (Electrobun): sync local React state + client. */
  handleResetAppliedFromMain: (payload: unknown) => Promise<void>;
  retryStartup: () => void;
  dismissRestartBanner: () => void;
  showRestartBanner: () => void;
  relaunchDesktop: () => Promise<void>;
  triggerRestart: () => Promise<void>;
  retryBackendConnection: () => void;
  restartBackend: () => Promise<void>;
  dismissSystemWarning: (message: string) => void;

  // Chat
  handleChatSend: (
    channelType?: ConversationChannelType,
    options?: { metadata?: Record<string, unknown> },
  ) => Promise<void>;
  handleChatStop: () => void;
  /**
   * Narrow interrupt of the active chat turn: aborts the in-flight server
   * generation (relay `POST /api/turns/:roomId/abort`) + local stream, and
   * resets sending state. Unlike `handleChatStop` this does NOT tear down
   * coding-agent PTY sessions, so it is safe to fire on a voice barge-in.
   */
  interruptActiveChatPipeline: () => void;
  handleChatRetry: (assistantMsgId: string) => Promise<void>;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  /** Persistently delete a single message (#13533): server DELETE + optimistic
   *  UI removal with rollback on failure. Resolves false when the delete failed
   *  (message kept) or there is no active conversation. */
  handleChatDelete: (messageId: string) => Promise<boolean>;
  handleChatClear: () => Promise<void>;
  handleStartDraftConversation: () => Promise<void>;
  handleNewConversation: (title?: string) => Promise<void>;
  /** Restore the active personal conversation; null means recovery is unavailable. */
  ensureActiveConversation: () => Promise<string | null>;
  setChatPendingImages: Dispatch<SetStateAction<ImageAttachment[]>>;
  handleSelectConversation: (id: string) => Promise<void>;
  /**
   * Replace the active thread with a window CENTERED on `messageId` so a
   * keyword-search jump can scroll to a hit older than the most-recent window
   * (#9955). Resolves `true` once the centered window has been committed to the
   * active conversation, `false` if the load failed or the user navigated away.
   */
  loadConversationMessagesAround: (
    conversationId: string,
    messageId: string,
  ) => Promise<boolean>;
  handleDeleteConversation: (id: string) => Promise<void>;
  handleRenameConversation: (id: string, title: string) => Promise<void>;
  /** LLM title from recent messages; persists on the server and updates local list. */
  suggestConversationTitle: (id: string) => Promise<string | null>;
  /** Send a programmatic message (e.g. from a UiSpec action) without touching chatInput. */
  sendActionMessage: (text: string) => Promise<void>;
  /** Send a chat message with optional metadata (e.g. task creation intent). */
  sendChatText: (
    rawInput: string,
    options?: {
      channelType?: ConversationChannelType;
      conversationId?: string | null;
      images?: ImageAttachment[];
      metadata?: Record<string, unknown>;
      /** Stable identity for a programmatically relayed logical turn. */
      clientMessageId?: string;
    },
  ) => Promise<void>;

  // Triggers
  loadTriggers: (options?: { silent?: boolean }) => Promise<void>;
  ensureTriggersLoaded: () => Promise<void>;
  createTrigger: (
    request: CreateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  updateTrigger: (
    id: string,
    request: UpdateTriggerRequest,
  ) => Promise<TriggerSummary | null>;
  deleteTrigger: (id: string) => Promise<boolean>;
  runTriggerNow: (id: string) => Promise<boolean>;
  loadTriggerRuns: (id: string) => Promise<void>;
  loadTriggerHealth: () => Promise<void>;

  // Pairing
  handlePairingSubmit: () => Promise<void>;

  // Plugins
  loadPlugins: (options?: { silent?: boolean }) => Promise<void>;
  ensurePluginsLoaded: () => Promise<void>;
  handlePluginToggle: (pluginId: string, enabled: boolean) => Promise<void>;
  /** Resolves true only when the config actually persisted (false = save failed; the caller must keep the user's typed draft). */
  handlePluginConfigSave: (
    pluginId: string,
    config: Record<string, string>,
  ) => Promise<boolean>;

  // Skills
  loadSkills: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  handleSkillToggle: (skillId: string, enabled: boolean) => Promise<void>;
  handleCreateSkill: () => Promise<void>;
  handleOpenSkill: (skillId: string) => Promise<void>;
  handleDeleteSkill: (skillId: string, name: string) => Promise<void>;
  handleReviewSkill: (skillId: string) => Promise<void>;
  handleAcknowledgeSkill: (skillId: string) => Promise<void>;
  installSkillFromGithubUrl: () => Promise<void>;

  // Logs
  loadLogs: () => Promise<void>;

  // Inventory
  loadInventory: () => Promise<void>;
  loadWalletConfig: () => Promise<void>;
  loadBalances: () => Promise<void>;
  loadNfts: () => Promise<void>;
  executeBscTrade: (
    request: BscTradeExecuteRequest,
  ) => Promise<BscTradeExecuteResponse>;
  executeBscTransfer: (
    request: BscTransferExecuteRequest,
  ) => Promise<BscTransferExecuteResponse>;
  getBscTradePreflight: (
    tokenAddress?: string,
  ) => Promise<BscTradePreflightResponse>;
  getBscTradeQuote: (
    request: BscTradeQuoteRequest,
  ) => Promise<BscTradeQuoteResponse>;
  getBscTradeTxStatus: (hash: string) => Promise<BscTradeTxStatusResponse>;
  getStewardStatus: () => Promise<StewardStatusResponse>;
  getStewardAddresses: () => Promise<StewardWalletAddressesResponse>;
  getStewardBalance: (chainId?: number) => Promise<StewardBalanceResponse>;
  getStewardTokens: (chainId?: number) => Promise<StewardTokenBalancesResponse>;
  getStewardWebhookEvents: (opts?: {
    event?: StewardWebhookEventType;
    since?: number;
  }) => Promise<StewardWebhookEventsResponse>;
  getStewardHistory: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    records: StewardHistoryResponse;
    total: number;
    offset: number;
    limit: number;
  }>;
  getStewardPending: () => Promise<StewardPendingResponse>;
  approveStewardTx: (txId: string) => Promise<StewardApprovalActionResponse>;
  rejectStewardTx: (
    txId: string,
    reason?: string,
  ) => Promise<StewardApprovalActionResponse>;
  loadWalletTradingProfile: (
    window?: WalletTradingProfileWindow,
    source?: WalletTradingProfileSourceFilter,
  ) => Promise<WalletTradingProfileResponse>;
  handleWalletApiKeySave: (
    config: WalletConfigUpdateRequest,
  ) => Promise<boolean>;
  setWalletPrimary: (
    chain: WalletChainKind,
    source: WalletSource,
  ) => Promise<void>;
  refreshCloudWallets: () => Promise<void>;
  handleExportKeys: () => Promise<void>;

  // Registry / Drop
  loadRegistryStatus: () => Promise<void>;
  registerOnChain: () => Promise<void>;
  syncRegistryProfile: () => Promise<void>;
  loadDropStatus: () => Promise<void>;
  mintFromDrop: (shiny: boolean) => Promise<void>;
  loadWhitelistStatus: () => Promise<void>;

  // Character
  loadCharacter: () => Promise<void>;
  handleSaveCharacter: () => Promise<void>;
  handleCharacterFieldInput: <K extends keyof CharacterData>(
    field: K,
    value: CharacterData[K],
  ) => void;
  handleCharacterArrayInput: (
    field: "adjectives" | "postExamples",
    value: string,
  ) => void;
  handleCharacterStyleInput: (
    subfield: "all" | "chat" | "post",
    value: string,
  ) => void;
  handleCharacterMessageExamplesInput: (value: string) => void;

  // First-run
  /**
   * Finalize first-run without running the chat handoff.
   * Used when first-run setup already persisted the server-side profile.
   * Dispatches FIRST_RUN_COMPLETE to the startup coordinator.
   *
   * The full first-run flow passes an explicit landing tab when needed.
   */
  completeFirstRun: (landingTab?: Tab) => void;

  // Cloud
  /**
   * Deliberate same-tab recovery entry point (boot-recovery conductor,
   * native re-auth). Non-interactive by construction: it never opens a popup
   * and never accepts a pre-popped window, so a missed interactive caller
   * cannot compile against it. Interactive call sites MUST use
   * `handleInteractiveCloudLogin`, which pre-opens the named popup itself —
   * the null-window defect #17129 is unrepresentable at the type level.
   */
  handleCloudLoginRecovery: (options?: CloudLoginOptions) => Promise<void>;
  /**
   * Interactive-only Cloud login entry point. Pre-opens the named popup
   * window itself, so interactive call sites cannot omit it (type-level
   * contract, #17129). Use this for user-facing login buttons; keep
   * `handleCloudLoginRecovery` for the deliberate same-tab boot-recovery
   * path.
   */
  handleInteractiveCloudLogin: (options?: CloudLoginOptions) => Promise<void>;
  handleCloudDisconnect: (opts?: {
    skipConfirmation?: boolean;
  }) => Promise<void>;
  handleCloudSignOut: () => Promise<void>;

  // Multi-agent
  switchAgentProfile: (profileId: string) => void;

  // Updates
  loadUpdateStatus: (force?: boolean) => Promise<void>;
  handleChannelChange: (channel: ReleaseChannel) => Promise<void>;

  // Extension
  checkExtensionStatus: () => Promise<void>;

  // Emote picker
  openEmotePicker: () => void;
  closeEmotePicker: () => void;

  // Workbench
  loadWorkbench: () => Promise<void>;

  // Agent export/import
  handleAgentExport: () => Promise<void>;
  handleAgentImport: () => Promise<void>;

  // Action notice
  setActionNotice: (
    text: string,
    tone?: ActionTone,
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;

  // Generic state setter
  setState: <K extends keyof AppState>(key: K, value: AppState[K]) => void;

  setAnalysisMode: (mode: boolean) => void;

  // Clipboard
  copyToClipboard: (text: string) => Promise<void>;

  // Translations
  t: (key: string, values?: Record<string, unknown>) => string;
}

export type AppContextValue = AppState & AppActions;
