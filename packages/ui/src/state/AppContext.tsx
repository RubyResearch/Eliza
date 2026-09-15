/**
 * Global application state via React Context.
 *
 * Children access state and actions through the useApp() hook.
 */

import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ChatTurnStatus, client, type FirstRunOptions } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import { ConfirmDialog, PromptDialog } from "../components/ui/confirm-dialog";
import { useConfirm, usePrompt } from "../components/ui/confirm-dialog.hooks";
import { AppBootContext } from "../config/boot-config-react.hooks";
import { getBootConfig } from "../config/boot-config-store";
import { BrandingContext, DEFAULT_BRANDING } from "../config/branding";
import { tryHandleBootRecoveryAction } from "../first-run/boot-recovery-channel";
import {
  classifyActionMessage,
  getFirstRunCloudLoginFallbackPath,
  tryHandleFirstRunAction,
  tryHandleFirstRunText,
} from "../first-run/first-run-action-channel";
import {
  isMobileLocalAgentIpcBase,
  persistMobileRuntimeModeForServerTarget,
} from "../first-run/mobile-runtime-mode";
import { tryHandleModelAction } from "../first-run/model-action-channel";
import {
  activeServerKindToFirstRunRuntimeTarget,
  type FirstRunRuntimeTarget,
} from "../first-run/runtime-target";
import type { UiLanguage } from "../i18n";
import {
  getWindowNavigationPath,
  resolveDefaultLandingTab,
  resolveInitialTabForPath,
  type Tab,
} from "../navigation";
import { getFrontendPlatform } from "../platform/platform-guards";
import { applyThemeToDocument } from "../themes/apply-theme";
import {
  tryHandleTutorialAction,
  tryHandleTutorialText,
} from "../tutorial/tutorial-action-channel";
import { copyTextToClipboard } from "../utils";
import { applyAgentProfileConnection } from "./agent-profile-connection";
import {
  activeServerIdForAgentProfile,
  getActiveProfile,
  loadAgentProfileRegistry,
  persistAgentProfileSelection,
} from "./agent-profiles";
import { publishAppValue, seedAppValue } from "./app-store";
import {
  ChatComposerCtx,
  ChatInputRefCtx,
  clearAllChatDrafts,
  useChatComposerDraftPersistence,
} from "./ChatComposerContext.hooks";
import { ChatTurnStatusCtx } from "./ChatTurnStatusContext.hooks";
import { ConversationMessagesCtx } from "./ConversationMessagesContext.hooks";
import { AppContext, type AppContextValue, type AppState } from "./internal";
import { PtySessionsCtx } from "./PtySessionsContext.hooks";
import { createPersistedActiveServer } from "./persistence";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "./runtime-url-trust";
import { deriveUiShellModeForTab } from "./shell-routing";
import type { RuntimeTarget } from "./startup-coordinator";
import { useTranslation } from "./TranslationContext.hooks";
import { TranslationProvider } from "./TranslationProvider";
import { useAppLifecycleEvents } from "./useAppLifecycleEvents";
import {
  useAgentGreetingEffects,
  useBackendConnectionSync,
  useNavigationPathSync,
} from "./useAppProviderEffects";
import { useAppShellState } from "./useAppShellState";
import { useCharacterState } from "./useCharacterState";
import { useChatCallbacks } from "./useChatCallbacks";
import { useChatState } from "./useChatState";
import { useCloudState } from "./useCloudState";
import { useDataLoaders } from "./useDataLoaders";
import { useDisplayPreferences } from "./useDisplayPreferences";
import { useExportImportState } from "./useExportImportState";
import { useFirstRunCallbacks } from "./useFirstRunCallbacks";
import { useFirstRunState } from "./useFirstRunState";
import { useLifecycleState } from "./useLifecycleState";
import { useLogsState } from "./useLogsState";
import { useMiscUiState } from "./useMiscUiState";
import { useNavigationState } from "./useNavigationState";
import { usePairingState } from "./usePairingState";
import { usePluginsSkillsState } from "./usePluginsSkillsState";
import { useResyncReconcile } from "./useResyncReconcile";
import { useStartupCoordinator } from "./useStartupCoordinator";
import { useTabSync } from "./useTabSync";
import { useTriggersState } from "./useTriggersState";
import { useWalletState } from "./useWalletState";

/**
 * FirstRunShell and bare `completeFirstRun()` land on the discovered
 * main-tab app; callers can open the companion overlay separately.
 *
 * Resolved synchronously from the cached apps catalog at module load.
 * Falls back to chat when no installed app declares `elizaos.app.mainTab=true`.
 */
const DEFAULT_LANDING_TAB: Tab = resolveDefaultLandingTab();

// ── Provider ───────────────────────────────────────────────────────────

export function AppProvider({
  children,
  branding: brandingOverride,
}: {
  children: ReactNode;
  branding?: Partial<import("../config/branding").BrandingConfig>;
}) {
  const onLanguageSyncError = useCallback((_lang: UiLanguage) => {
    // Non-fatal: language change will be reflected on next mount.
  }, []);
  return (
    <TranslationProvider
      onLanguageSyncError={onLanguageSyncError}
      branding={brandingOverride}
    >
      <AppProviderInner branding={brandingOverride}>
        {children}
      </AppProviderInner>
    </TranslationProvider>
  );
}

function AppProviderInner({
  children,
  branding: brandingOverride,
}: {
  children: ReactNode;
  branding?: Partial<import("../config/branding").BrandingConfig>;
}) {
  // --- Core state ---
  const [tab, _setTabRawInner] = useState<Tab>(() =>
    resolveInitialTabForPath(getWindowNavigationPath(), DEFAULT_LANDING_TAB),
  );
  const initialTabSetRef = useRef(false);
  const setTabRaw = useCallback((t: Tab) => {
    _setTabRawInner(t);
  }, []);
  // uiLanguage + t live in TranslationContext; consumed via useTranslation()
  const { t, uiLanguage, setUiLanguage } = useTranslation();
  // --- Display preferences (via useDisplayPreferences) ---
  const displayPrefs = useDisplayPreferences();
  const {
    state: {
      uiTheme,
      uiThemeMode,
      backgroundConfig,
      canUndoBackground,
      canRedoBackground,
      homeTimeWidgetHidden,
      uiAccentId,
    },
    setUiTheme,
    setUiThemeMode,
    setBackgroundConfig,
    undoBackgroundConfig,
    redoBackgroundConfig,
    setHomeTimeWidgetHidden,
    setUiAccent,
  } = displayPrefs;

  // Apply the host app's brand theme (set via BrandingConfig.theme).
  const brandTheme = brandingOverride?.theme;
  useEffect(() => {
    if (!brandTheme) return;
    return applyThemeToDocument(brandTheme, uiTheme);
  }, [brandTheme, uiTheme]);

  // ── Lifecycle state (consolidated from 20+ useState hooks) ──
  const lifecycle = useLifecycleState(brandingOverride?.cloudOnly);

  const {
    state: {
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupError,
      authRequired,
      actionNotice,
      lifecycleBusy,
      lifecycleAction,
      pendingRestart,
      pendingRestartReasons,
      restartBannerDismissed,
      backendConnection,
      systemWarnings,
    },
    setConnected,
    setAgentStatus,
    setAgentStatusIfChanged,
    setFirstRunComplete,
    incrementFirstRunRevealNonce: setFirstRunUiRevealNonce_increment,
    setFirstRunLoading,
    setStartupError,
    setAuthRequired,
    setActionNotice,
    beginLifecycleAction,
    finishLifecycleAction,
    setPendingRestart: setPendingRestartAction,
    dismissRestartBanner,
    showRestartBanner,
    setBackendConnection,
    resetBackendConnection,
    dismissSystemWarning,
    lifecycleBusyRef,
    lifecycleActionRef,
  } = lifecycle;

  // Compatibility wrappers — old code calls these separately; lifecycle hook combines them.
  const setPendingRestart = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.pendingRestart) : v;
      setPendingRestartAction(resolved);
    },
    [lifecycle.state.pendingRestart, setPendingRestartAction],
  );
  const setPendingRestartReasons = useCallback(
    (v: string[] | ((prev: string[]) => string[])) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.pendingRestartReasons) : v;
      setPendingRestartAction(lifecycle.state.pendingRestart, resolved);
    },
    [
      lifecycle.state.pendingRestart,
      lifecycle.state.pendingRestartReasons,
      setPendingRestartAction,
    ],
  );
  const setFirstRunUiRevealNonce = useCallback(
    (_fn: (n: number) => number) => setFirstRunUiRevealNonce_increment(),
    [setFirstRunUiRevealNonce_increment],
  );
  const setSystemWarnings = useCallback(
    (v: string[] | ((prev: string[]) => string[])) => {
      const resolved =
        typeof v === "function" ? v(lifecycle.state.systemWarnings) : v;
      lifecycle.setSystemWarnings(resolved);
    },
    [lifecycle.state.systemWarnings, lifecycle.setSystemWarnings],
  );
  const triggerRestartRef = useRef<() => Promise<void>>(async () => {});
  const triggerRestartProxy = useCallback(async () => {
    await triggerRestartRef.current();
  }, []);
  // retryStartup resets lifecycle state AND dispatches RETRY to the coordinator.
  // The coordinator's phase effects will re-run from restoring-session.
  // We store a ref to the coordinator's retry since it's created after this line.
  const coordinatorRetryRef = useRef<(() => void) | null>(null);
  const coordinatorResetRef = useRef<(() => void) | null>(null);
  const coordinatorFirstRunCompleteRef = useRef<(() => void) | null>(null);
  const retryStartup = useCallback(() => {
    lifecycle.retryStartup();
    coordinatorRetryRef.current?.();
  }, [lifecycle.retryStartup]);
  const uiShellMode = deriveUiShellModeForTab(tab);

  // --- Pairing ---
  // --- Pairing (via usePairingState) ---
  const pairingHook = usePairingState();
  const {
    state: {
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
    },
    setPairingEnabled,
    setPairingExpiresAt,
    setPairingCodeInput,
    handlePairingSubmit,
  } = pairingHook;

  // NOTE: StartupCoordinator hook moved below (after all dependency hooks).
  // Search for "── StartupCoordinator (sole startup authority) ──" below.

  // ── Chat state (consolidated from 18+ useState + 10 useEffect hooks) ──
  const chatState = useChatState();
  const {
    state: {
      chatInput,
      chatSending,
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
      chatAvatarSpeaking,
      conversations,
      activeConversationId,
      companionMessageCutoffTs,
      conversationMessages,
      ptySessions,
      unreadConversations,
      chatPendingImages,
      chatReplyTarget,
    },
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setChatLastUsage,
    setChatAvatarVisible,
    setChatAgentVoiceMuted,
    setChatAvatarSpeaking,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    prependConversationMessages,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    setPtySessions,
    setChatPendingImages,
    setChatReplyTarget,
    resetDraftState: resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    addUnread,
    removeUnread,
  } = chatState;
  // Live server-reported phase of the in-flight assistant turn (rich status
  // indicator, #8813). Held outside the giant AppContext value (in its own
  // ChatTurnStatusCtx, like conversationMessages) so the per-status-event
  // updates re-render only the chat surfaces, not all ~135 useApp() subscribers.
  const [serverTurnStatus, setServerTurnStatus] =
    useState<ChatTurnStatus | null>(null);
  const _chatComposerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // addUnread / removeUnread wrappers for old setUnreadConversations patterns.
  // Read current unreadConversations through a ref so this callback stays
  // stable across renders — otherwise it cascades into handleChatClear /
  // handleSelectConversation / handleDeleteConversation and busts the
  // AppContext value memo on every keystroke.
  const unreadConversationsRef = useRef(unreadConversations);
  unreadConversationsRef.current = unreadConversations;
  const setUnreadConversations = useCallback(
    (v: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      const prev = unreadConversationsRef.current;
      const nextVal = typeof v === "function" ? v(prev) : v;
      // Diff prev→next and dispatch BOTH directions. The old wrapper only
      // re-added ids in the result set and dropped every removal (the
      // functional `next.delete(id)` updaters callers use to clear a badge
      // were silent no-ops — REMOVE_UNREAD was unreachable, so badges never
      // cleared on delete/mark-read). Add newly-present ids, remove
      // newly-absent ones.
      for (const id of nextVal) {
        if (!prev.has(id)) addUnread(id);
      }
      for (const id of prev) {
        if (!nextVal.has(id)) removeUnread(id);
      }
    },
    [addUnread, removeUnread],
  );

  // --- Triggers (via useTriggersState) ---
  const triggersHook = useTriggersState();
  const {
    state: {
      triggers,
      triggersLoaded,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
    },
    loadTriggers,
    loadTriggerHealth,
    loadTriggerRuns,
    ensureTriggersLoaded,
    createTrigger,
    updateTrigger,
    deleteTrigger,
    runTriggerNow,
  } = triggersHook;

  // --- Plugins / Skills / Store / Catalog (via usePluginsSkillsState) ---
  const pluginsSkillsHook = usePluginsSkillsState({
    setActionNotice,
    setPendingRestart,
    setPendingRestartReasons,
    showRestartBanner,
    triggerRestart: triggerRestartProxy,
  });
  const {
    plugins,
    setPlugins,
    pluginFilter,
    setPluginFilter,
    pluginStatusFilter,
    setPluginStatusFilter,
    pluginSearch,
    setPluginSearch,
    pluginSettingsOpen,
    setPluginSettingsOpen,
    pluginAdvancedOpen,
    setPluginAdvancedOpen,
    pluginSaving,
    pluginSaveSuccess,
    isLoadingPlugins,
    pluginsLoadError,
    pluginsLoaded,
    loadPlugins,
    ensurePluginsLoaded,
    handlePluginToggle,
    handlePluginConfigSave,
    skills,
    setSkills,
    skillsSubTab,
    setSkillsSubTab,
    skillCreateFormOpen,
    setSkillCreateFormOpen,
    skillCreateName,
    setSkillCreateName,
    skillCreateDescription,
    setSkillCreateDescription,
    skillCreating,
    skillReviewReport,
    setSkillReviewReport,
    skillReviewId,
    setSkillReviewId,
    skillReviewLoading,
    skillToggleAction,
    skillInstallError,
    skillInstallAction,
    skillInstallGithubUrl,
    setSkillInstallGithubUrl,
    loadSkills,
    refreshSkills,
    handleSkillToggle,
    handleCreateSkill,
    handleOpenSkill,
    handleDeleteSkill,
    handleReviewSkill,
    handleAcknowledgeSkill,
    installSkillFromGithubUrl,
    storePlugins,
    setStorePlugins,
    storeSearch,
    setStoreSearch,
    storeFilter,
    setStoreFilter,
    storeLoading,
    setStoreLoading,
    storeInstalling,
    setStoreInstalling,
    storeUninstalling,
    setStoreUninstalling,
    storeError,
    setStoreError,
    storeDetailPlugin,
    setStoreDetailPlugin,
    storeSubTab,
    setStoreSubTab,
  } = pluginsSkillsHook;

  // --- Logs (via useLogsState) ---
  const logsHook = useLogsState();
  const {
    state: {
      logs,
      logSources,
      logTags,
      logTagFilter,
      logLevelFilter,
      logSourceFilter,
      logLoadError,
    },
    setLogs,
    setLogTagFilter,
    setLogLevelFilter,
    setLogSourceFilter,
    loadLogs,
  } = logsHook;

  // --- Character (via useCharacterState) ---
  const characterHook = useCharacterState({ agentStatus, setAgentStatus });
  const {
    state: {
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
    },
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomVrmPreviewUrl,
    setCustomBackgroundUrl,
    setCustomCatchphrase,
    setCustomVoicePresetId,
    setActivePackId,
    setCustomWorldUrl,
    loadCharacter,
    handleSaveCharacter,
    handleCharacterFieldInput,
    handleCharacterArrayInput,
    handleCharacterStyleInput,
    handleCharacterMessageExamplesInput,
  } = characterHook;

  // elizaCloud* state, refs, and callbacks are now provided by useCloudState (cloudHook above).
  const shellState = useAppShellState({
    syncServerFavorites: firstRunComplete,
  });
  const {
    state: {
      ownerName,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
    },
    setOwnerNameState,
    setAppsSubTab,
    setAgentSubTab,
    setPluginsSubTab,
    setDatabaseSubTab,
    setFavoriteApps,
    setRecentApps,
    setConfigRaw,
    setConfigText,
  } = shellState;

  // Updates, Extension, and Workbench state are now in useDataLoaders (dataLoaders).

  // --- Agent export/import (via useExportImportState) ---
  const exportImportHook = useExportImportState();
  const {
    state: {
      exportBusy,
      exportPassword,
      exportIncludeLogs,
      exportError,
      exportSuccess,
      importBusy,
      importPassword,
      importFile,
      importError,
      importSuccess,
    },
    setExportPassword,
    setExportIncludeLogs,
    setExportError,
    setExportSuccess,
    setImportPassword,
    setImportFile,
    setImportError,
    setImportSuccess,
    handleAgentExport,
    handleAgentImport,
  } = exportImportHook;

  // ── First-run state (surviving cross-surface fields; see useFirstRunState) ──
  const firstRun = useFirstRunState(brandingOverride?.cloudOnly);
  const {
    state: {
      deferredTasks: firstRunDeferredTasks,
      postChecklistDismissed: postFirstRunChecklistDismissed,
      options: firstRunOptions,
      name: firstRunName,
      style: firstRunStyle,
      serverTarget: firstRunRuntimeTarget,
      provider: firstRunProvider,
      remoteApiBase: firstRunRemoteApiBase,
      remoteToken: firstRunRemoteToken,
      cloudProvisionedContainer: firstRunCloudProvisionedContainer,
    },
    completionCommittedRef: firstRunCompletionCommittedRefFromHook,
  } = firstRun;

  const {
    firstRunRemoteConnecting,
    firstRunRemoteError,
    firstRunRemoteConnected,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunOptions,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunRemoteConnecting,
    setFirstRunRemoteError,
    setFirstRunRemoteConnected,
    setFirstRunCloudProvisionedContainer,
    setPostFirstRunChecklistDismissed,
    setFirstRunDeferredTasks,
  } = useMemo(() => {
    const { dispatch } = firstRun;
    const { remote } = firstRun.state;
    const bindField =
      (field: string) =>
      (value: unknown): void => {
        dispatch({ type: "SET_FIELD", field, value });
      };
    return {
      firstRunRemoteConnecting: remote.status === "connecting",
      firstRunRemoteError: remote.error,
      firstRunRemoteConnected: remote.status === "connected",
      setFirstRunName: bindField("name") as (value: string) => void,
      setFirstRunStyle: bindField("style") as (value: string) => void,
      setFirstRunRuntimeTarget: bindField("serverTarget") as (
        value: FirstRunRuntimeTarget,
      ) => void,
      setFirstRunProvider: bindField("provider") as (value: string) => void,
      setFirstRunOptions: (options: FirstRunOptions | null): void => {
        dispatch({ type: "SET_OPTIONS", options });
      },
      setFirstRunRemoteApiBase: (value: string): void => {
        dispatch({ type: "SET_REMOTE_API_BASE", value });
      },
      setFirstRunRemoteToken: (value: string): void => {
        dispatch({ type: "SET_REMOTE_TOKEN", value });
      },
      setFirstRunRemoteConnecting: (value: boolean): void => {
        if (value) {
          dispatch({ type: "SET_REMOTE_STATUS", status: "connecting" });
          return;
        }
        if (remote.status === "connecting") {
          dispatch({ type: "SET_REMOTE_STATUS", status: "idle" });
        }
      },
      setFirstRunRemoteError: (value: string | null): void => {
        if (value) {
          dispatch({
            type: "SET_REMOTE_STATUS",
            status: "error",
            error: value,
          });
          return;
        }
        if (remote.status === "error") {
          dispatch({ type: "SET_REMOTE_STATUS", status: "idle" });
        }
      },
      setFirstRunRemoteConnected: (value: boolean): void => {
        if (value) {
          dispatch({ type: "SET_REMOTE_STATUS", status: "connected" });
          return;
        }
        if (remote.status === "connected") {
          dispatch({ type: "SET_REMOTE_STATUS", status: "idle" });
        }
      },
      setFirstRunCloudProvisionedContainer: bindField(
        "cloudProvisionedContainer",
      ) as (value: boolean) => void,
      setPostFirstRunChecklistDismissed: (value: boolean): void => {
        dispatch({ type: "SET_POST_CHECKLIST_DISMISSED", value });
      },
      setFirstRunDeferredTasks: (tasks: string[]): void => {
        dispatch({ type: "SET_DEFERRED_TASKS", tasks });
      },
    };
  }, [firstRun]);

  // --- Command palette / emote picker / MCP / game / dropped files (via useMiscUiState) ---
  const miscUiHook = useMiscUiState();
  const {
    state: {
      analysisMode,
      commandPaletteOpen,
      commandQuery,
      commandActiveIndex,
      emotePickerOpen,
      mcpConfiguredServers,
      mcpServerStatuses,
      mcpMarketplaceQuery,
      mcpMarketplaceResults,
      mcpMarketplaceLoading,
      mcpAction,
      mcpAddingServer,
      mcpAddingResult,
      mcpEnvInputs,
      mcpHeaderInputs,
      droppedFiles,
      shareIngestNotice,
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGamePostMessagePayload,
      activeGameSession,
      gameOverlayEnabled,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
    },
    setActiveInboxChat,
    setActiveTerminalSessionId,
    setAnalysisMode,
    setCommandQuery,
    setCommandActiveIndex,
    setEmotePickerOpen,
    setMcpConfiguredServers,
    setMcpServerStatuses,
    setMcpMarketplaceQuery,
    setMcpMarketplaceResults,
    setMcpMarketplaceLoading,
    setMcpAction,
    setMcpAddingServer,
    setMcpAddingResult,
    setMcpEnvInputs,
    setMcpHeaderInputs,
    setDroppedFiles,
    setShareIngestNotice,
    setAppRuns,
    setActiveGameRunId,
    setGameOverlayEnabled,
    setActiveOverlayApp,
    closeCommandPalette,
    openEmotePicker,
    closeEmotePicker,
  } = miscUiHook;

  // --- Refs for timers ---
  const _restartNotificationSignatureRef = useRef<string | null>(null);
  const _heartbeatNotificationKeyRef = useRef<string | null>(null);
  const firstRunCompletionCommittedRef = firstRunCompletionCommittedRefFromHook;

  // --- Confirm Modal ---
  const { modalProps } = useConfirm();
  const { prompt: promptModal, modalProps: promptModalProps } = usePrompt();

  // --- Wallet / Inventory / Registry / Drop / Whitelist (via useWalletState) ---
  // Placed after characterHook (characterDraft) and promptModal — both are required params.
  const walletHook = useWalletState({
    setActionNotice,
    promptModal,
    agentName: agentStatus?.agentName,
    characterName: characterDraft?.name,
    hydrateServerConfig:
      firstRunComplete && supportsFullAppShellRoutes(client.getBaseUrl()),
  });
  const {
    state: {
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
      walletAddresses,
      walletConfig,
      walletBalances,
      walletNfts,
      walletLoading,
      walletNftsLoading,
      walletConfigStatus,
      walletConfigError,
      walletBalancesStatus,
      walletBalancesError,
      walletNftsStatus,
      walletNftsError,
      inventoryView,
      walletExportData,
      walletExportVisible,
      walletApiKeySaving,
      inventorySort,
      inventorySortDirection,
      inventoryChainFilters,
      walletError,
      registryStatus,
      registryLoading,
      registryRegistering,
      registryError,
      dropStatus,
      dropLoading,
      mintInProgress,
      mintResult,
      mintError,
      mintShiny,
      whitelistStatus,
      whitelistLoading,
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
    },
    setBrowserEnabled,
    setComputerUseEnabled,
    setWalletEnabled,
    setWalletAddresses,
    setInventoryView,
    setInventorySort,
    setInventorySortDirection,
    setInventoryChainFilters,
    loadWalletConfig,
    loadBalances,
    loadNfts,
    handleWalletApiKeySave,
    handleExportKeys,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    mintFromDrop,
    loadWhitelistStatus,
    setPrimary: setWalletPrimary,
    refreshCloud: refreshCloudWallets,
  } = walletHook;

  // setActionNotice is now provided by useLifecycleState

  // ── Cloud state (via useCloudState) ───────────────────────
  // Placed after walletHook so loadWalletConfig is available.
  const cloudHook = useCloudState({
    setActionNotice,
    loadWalletConfig,
    t,
    disconnectLocked: brandingOverride?.cloudOnly === true,
  });

  const {
    elizaCloudEnabled,
    setElizaCloudEnabled,
    elizaCloudVoiceProxyAvailable,
    setElizaCloudVoiceProxyAvailable,
    elizaCloudConnected,
    setElizaCloudConnected,
    elizaCloudHasPersistedKey,
    setElizaCloudHasPersistedKey,
    elizaCloudCredits,
    setElizaCloudCredits,
    elizaCloudCreditsLow,
    setElizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    setElizaCloudCreditsCritical,
    elizaCloudAuthRejected,
    setElizaCloudAuthRejected,
    elizaCloudCreditsError,
    setElizaCloudCreditsError,
    elizaCloudTopUpUrl,
    setElizaCloudTopUpUrl,
    elizaCloudUserId,
    setElizaCloudUserId,
    elizaCloudStatusReason,
    setElizaCloudStatusReason,
    cloudDashboardView,
    setCloudDashboardView,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    setElizaCloudLoginError,
    elizaCloudLoginFallbackUrl,
    elizaCloudDisconnecting,
    elizaCloudPollInterval,
    elizaCloudPreferDisconnectedUntilLoginRef,
    elizaCloudLoginPollTimer,
    pollCloudCredits,
    handleCloudLoginRecovery,
    handleInteractiveCloudLogin,
    handleCloudDisconnect,
    handleCloudSignOut,
  } = cloudHook;

  // ── Clipboard ──────────────────────────────────────────────────────

  const copyToClipboard = useCallback(async (text: string) => {
    await copyTextToClipboard(text);
  }, []);

  // Language is managed by TranslationProvider (see useTranslation() above)

  // ── Navigation (via useNavigationState) ──────────────────
  const navHook = useNavigationState({
    tab,
    setTabRaw,
    uiShellMode,
    hasActiveGameRun: activeGameRunId.trim().length > 0,
    setAppsSubTab,
  });
  const {
    setTab,
    setUiShellMode,
    switchUiShellMode,
    switchShellView,
    navigation,
  } = navHook;

  useNavigationPathSync({ tab, setTabRaw });

  // Harness wallet for zero-interaction SIWE e2e (#13377): installs only when
  // a test key is seeded (never on store builds) and may auto-complete the
  // cloud sign-in before onboarding asks. One-shot per app instance.
  useEffect(() => {
    void import("../platform/e2e-wallet").then(
      ({ installE2eWalletIfRequested }) => installE2eWalletIfRequested(),
    );
  }, []);

  // loadLogs is now in useLogsState (logsHook)

  // ── Data loading (via useDataLoaders) ────────────────────
  const dataLoaders = useDataLoaders({
    autonomousStoreRef,
    autonomousEventsRef,
    autonomousLatestEventIdRef,
    autonomousRunHealthByRunIdRef,
    autonomousReplayInFlightRef,
    setAutonomousEvents,
    setAutonomousLatestEventId,
    setAutonomousRunHealthByRunId,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    loadWalletConfig,
    agentStatus,
    characterData,
    characterDraft,
    loadCharacter,
    selectedVrmIndex,
    firstRunComplete,
    uiLanguage,
    setOwnerNameState,
  });
  const {
    fetchAutonomyReplay,
    appendAutonomousEvent,
    loadConversations,
    loadConversationMessages,
    loadConversationMessagesAround,
    prefetchConversationMessages,
    claimConversationMessagesOwnership,
    isConversationMessagesOwnershipCurrent,
    getConversationMessagesOwnershipGeneration,
    registerConversationMessageOverlay,
    getConversationMessagesSnapshot,
    applyConversationMessageStream,
    applyConversationMessageOverlayModification,
    removeConversationMessageStateMessages,
    discardConversationMessageState,
    loadedConversationIdRef,
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    getStewardStatus,
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    loadWalletTradingProfile,
    executeBscTrade,
    executeBscTransfer,
    loadInventory,
    workbenchLoading,
    workbench,
    workbenchTasksAvailable,
    workbenchTriggersAvailable,
    workbenchTodosAvailable,
    loadWorkbench,
    updateStatus,
    updateLoading,
    updateChannelSaving,
    loadUpdateStatus,
    handleChannelChange,
    extensionStatus,
    extensionChecking,
    checkExtensionStatus,
  } = dataLoaders;

  // pollCloudCredits is now provided by useCloudState (cloudHook — wired below)

  // ── Lifecycle actions ──────────────────────────────────────────────

  // beginLifecycleAction / finishLifecycleAction are now provided by useLifecycleState

  // ── Chat callbacks (via useChatCallbacks) ──────────────────
  const chatCallbacks = useChatCallbacks({
    t,
    uiLanguage,
    tab,
    agentStatus,
    chatInput,
    conversations,
    activeConversationId,
    companionMessageCutoffTs,
    conversationMessages,
    ptySessions,
    setChatInput,
    setChatSending,
    setChatFirstTokenReceived,
    setServerTurnStatus,
    setChatLastUsage,
    setChatPendingImages,
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs,
    setConversationMessages,
    setUnreadConversations,
    setChatReplyTarget,
    resetConversationDraftState,
    activeConversationIdRef,
    chatInputRef,
    chatPendingImagesRef,
    chatReplyTargetRef,
    conversationsRef,
    conversationMessagesRef,
    conversationHydrationEpochRef,
    chatAbortRef,
    chatSendBusyRef,
    chatSendNonceRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
    lifecycleAction,
    beginLifecycleAction,
    finishLifecycleAction,
    lifecycleBusyRef,
    lifecycleActionRef,
    setAgentStatus,
    setActionNotice,
    pendingRestart,
    pendingRestartReasons,
    setPendingRestart,
    setPendingRestartReasons,
    resetBackendConnection,
    loadConversations,
    loadConversationMessages,
    prefetchConversationMessages,
    claimConversationMessagesOwnership,
    isConversationMessagesOwnershipCurrent,
    getConversationMessagesOwnershipGeneration,
    registerConversationMessageOverlay,
    applyConversationMessageOverlayModification,
    removeConversationMessageStateMessages,
    discardConversationMessageState,
    loadedConversationIdRef,
    loadPlugins,
    elizaCloudEnabled,
    elizaCloudConnected,
    pollCloudCredits,
    elizaCloudPreferDisconnectedUntilLoginRef,
    setElizaCloudEnabled,
    setElizaCloudConnected,
    setElizaCloudVoiceProxyAvailable,
    setElizaCloudHasPersistedKey,
    setElizaCloudCredits,
    setElizaCloudCreditsLow,
    setElizaCloudCreditsCritical,
    setElizaCloudAuthRejected,
    setElizaCloudCreditsError,
    setElizaCloudTopUpUrl,
    setElizaCloudUserId,
    setElizaCloudStatusReason,
    setElizaCloudLoginError,
    firstRunComplete,
    firstRunCompletionCommittedRef,
    setFirstRunUiRevealNonce,
    setFirstRunLoading,
    setFirstRunComplete,
    setFirstRunDeferredTasks,
    setPostFirstRunChecklistDismissed,
    setFirstRunName,
    setFirstRunStyle,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunOptions,
    setSelectedVrmIndex,
    setCustomVrmUrl,
    setCustomBackgroundUrl,
    setPlugins: setPlugins as (v: never[]) => void,
    setSkills: setSkills as (v: never[]) => void,
    setLogs: setLogs as (v: never[]) => void,
    coordinatorResetRef,
  });
  const {
    fetchGreeting,
    requestGreetingWhenRunning,
    hydrateInitialConversationState,
    ensureActiveConversation,
    handleStartDraftConversation,
    handleStart,
    handleStop,
    handleRestart,
    triggerRestart,
    retryBackendConnection,
    restartBackend,
    relaunchDesktop,
    notifyHeartbeatEvent,
    handleResetAppliedFromMain,
    handleReset,
    handleNewConversation,
    sendChatText,
    handleChatSend,
    sendActionMessage: rawSendActionMessage,
    handleChatStop,
    interruptActiveChatPipeline,
    handleChatRetry,
    handleChatEdit,
    handleChatDelete,
    handleChatClear,
    handleSelectConversation,
    handleDeleteConversation,
    handleRenameConversation,
    suggestConversationTitle,
  } = chatCallbacks;

  // In-chat first-run interception: a first-run-scoped choice pick (reserved
  // `__first_run__:` prefix) is consumed by the active onboarding conductor and
  // MUST NOT reach the server. The prefix is reserved unconditionally: even
  // after onboarding completes (conductor unregistered), a tap on a leftover
  // onboarding widget in the transcript is dropped here instead of sending the
  // literal sentinel to the agent as a chat message. While onboarding is
  // ACTIVE (firstRunComplete false) free text is routed to the conductor's
  // in-chat reply persona (`tryHandleFirstRunText`) until a Cloud-provisioned
  // bootstrap bridge exists. That preserves the pre-choice "no server send"
  // invariant while letting the user's first real post-provisioning message
  // reach the dedicated agent instead of being swallowed by setup copy. Once
  // onboarding completes, every non-first-run value falls through to the real
  // send funnel unchanged. Widgets stay 100% display-only — both
  // InlineWidgetText and MessageContent route picks through this single
  // `sendActionMessage`, and so does the unlocked composer during onboarding.
  const sendActionMessage = useCallback(
    (text: string): Promise<void> => {
      // The in-chat model-status card's `__model__:` controls (cancel / switch
      // to cloud / retry / download) are consumed by the model-status conductor
      // and NEVER reach the server — regardless of onboarding state.
      if (tryHandleModelAction(text)) return Promise.resolve();
      // Tutorial choice picks (`__tutorial__:` prefix) are likewise consumed
      // unconditionally — a tap on a leftover tour widget in an old transcript
      // must never become a literal chat message to the agent.
      if (tryHandleTutorialAction(text)) return Promise.resolve();
      // Same contract for the in-chat boot-recovery card's `__boot_recovery__:`
      // controls (re-log in / try again / retry setup).
      if (tryHandleBootRecoveryAction(text)) return Promise.resolve();
      const firstRunIsComplete = firstRunComplete === true;
      switch (
        classifyActionMessage(text, firstRunIsComplete, {
          allowFirstRunTextSend:
            !firstRunIsComplete && firstRunCloudProvisionedContainer,
        })
      ) {
        case "first-run": {
          const handled = tryHandleFirstRunAction(text);
          const fallbackPath = handled
            ? null
            : getFirstRunCloudLoginFallbackPath(
                text,
                firstRunComplete === true,
              );
          if (fallbackPath && typeof window !== "undefined") {
            window.location.assign(fallbackPath);
          }
          return Promise.resolve();
        }
        case "conductor":
          tryHandleFirstRunText(text);
          return Promise.resolve();
        case "send":
          // Explicit "start/stop/restart tutorial" commands drive the tour
          // locally; every other message flows to the real send untouched.
          if (tryHandleTutorialText(text)) return Promise.resolve();
          return rawSendActionMessage(text);
      }
    },
    [firstRunCloudProvisionedContainer, firstRunComplete, rawSendActionMessage],
  );

  useEffect(() => {
    triggerRestartRef.current = triggerRestart;
  }, [triggerRestart]);

  // ── Cross-window sync + reconnect reconciliation ───────────────────
  // Track whether the last active-conversation change came from another window
  // so applying it doesn't echo straight back out and loop between tabs.
  const tabSyncActiveConvRef = useRef<string | null>(null);
  const tabSyncActiveConvPendingRef = useRef(false);
  const tabSyncMirrorInitializedRef = useRef(false);
  const tabSync = useTabSync({
    onActiveConversation: (id) => {
      tabSyncActiveConvRef.current = id;
      tabSyncActiveConvPendingRef.current = true;
      if (id === null) {
        // Use the canonical draft transition so remote null selection also
        // interrupts streaming/queued work and resets composer, reply, status,
        // ownership, and the server-side active conversation coherently.
        void handleStartDraftConversation();
        return;
      }
      // Apply the switch through the real selection handler so this window's
      // thread repaints with the target conversation's messages (and its
      // per-connection server state re-arms). A bare setActiveConversationId
      // changed the id but left the previous conversation's messages on
      // screen — exactly the split-brain UI the sync exists to prevent.
      void handleSelectConversation(id);
    },
    onPrefs: (prefs) => {
      if (prefs.language) {
        setUiLanguage(prefs.language as UiLanguage);
      }
    },
  });

  // Mirror this window's active conversation to the other windows. Suppress the
  // mirror when the change itself arrived via sync (no echo).
  useEffect(() => {
    // Mount begins at null before hydration. Publishing that transient value
    // would clear an already-active sibling window, so only mirror changes
    // after this effect has observed the initial state.
    if (!tabSyncMirrorInitializedRef.current) {
      tabSyncMirrorInitializedRef.current = true;
      return;
    }
    if (tabSyncActiveConvPendingRef.current) {
      tabSyncActiveConvPendingRef.current = false;
      if (tabSyncActiveConvRef.current === activeConversationId) return;
    }
    tabSync.publishActiveConversation(activeConversationId);
  }, [activeConversationId, tabSync]);

  // Mirror the UI language to the other windows.
  useEffect(() => {
    tabSync.publishPrefs({ language: uiLanguage });
  }, [uiLanguage, tabSync]);

  // Live consumer of canonical resync events. The ready-phase WebSocket bridge
  // emits connection recovery only after the restarted agent reports running,
  // so a half-booted server cannot replace a healthy transcript with an empty
  // response. Realtime voice uses the same reconciliation boundary.
  useResyncReconcile({ activeConversationIdRef, loadConversationMessages });

  // ── Pairing ────────────────────────────────────────────────────────

  // ── Plugin / Skill / Store / Catalog actions are provided by usePluginsSkillsState (pluginsSkillsHook) ──
  // ── Inventory / Registry / Drop / Whitelist actions are provided by useWalletState (walletHook) ──
  // ── Character actions are provided by useCharacterState (characterHook) ──

  // ── First-run callbacks (via useFirstRunCallbacks) ──────
  const firstRunCallbacks = useFirstRunCallbacks({
    firstRun,
    setPostFirstRunChecklistDismissed,
    setFirstRunComplete,
    coordinatorFirstRunCompleteRef,
    initialTabSetRef,
    setTab,
    defaultLandingTab: DEFAULT_LANDING_TAB,
    loadCharacter,
  });
  const { completeFirstRun } = firstRunCallbacks;

  // handleAgentExport and handleAgentImport are now in useExportImportState (exportImportHook)

  // closeCommandPalette, openEmotePicker, closeEmotePicker are now in useMiscUiState (miscUiHook)

  // ── Generic state setter ───────────────────────────────────────────

  // Ref-stable generic setter: the exposed `setState` callback never changes
  // identity (deps `[]`), so it does not bust the AppContext value memo. The
  // latest setter map is read through a ref on each call, so behavior is
  // identical to a callback that closed over every setter directly.
  const setStateImplRef = useRef<
    <K extends keyof AppState>(key: K, value: AppState[K]) => void
  >(() => {});
  setStateImplRef.current = <K extends keyof AppState>(
    key: K,
    value: AppState[K],
  ) => {
    {
      const setterMap: Partial<{
        [S in keyof AppState]: (v: AppState[S]) => void;
      }> = {
        tab: setTab,
        chatInput: setChatInput,
        chatAvatarVisible: setChatAvatarVisible,
        chatAgentVoiceMuted: setChatAgentVoiceMuted,
        chatLastUsage: setChatLastUsage,
        chatAvatarSpeaking: setChatAvatarSpeaking,
        companionMessageCutoffTs: setCompanionMessageCutoffTs,
        uiShellMode: setUiShellMode,
        uiLanguage: setUiLanguage as (v: AppState["uiLanguage"]) => void,
        autonomousRunHealthByRunId: setAutonomousRunHealthByRunId,
        startupError: setStartupError,
        actionNotice: (value) =>
          lifecycle.dispatch({ type: "SET_ACTION_NOTICE", value }),
        pairingEnabled: setPairingEnabled,
        pairingExpiresAt: setPairingExpiresAt,
        pairingCodeInput: setPairingCodeInput,
        pluginFilter: setPluginFilter,
        pluginStatusFilter: setPluginStatusFilter,
        pluginSearch: setPluginSearch,
        pluginSettingsOpen: setPluginSettingsOpen,
        pluginAdvancedOpen: setPluginAdvancedOpen,
        skillsSubTab: setSkillsSubTab,
        skillCreateFormOpen: setSkillCreateFormOpen,
        skillCreateName: setSkillCreateName,
        skillCreateDescription: setSkillCreateDescription,
        skillInstallGithubUrl: setSkillInstallGithubUrl,
        logTagFilter: setLogTagFilter,
        logLevelFilter: setLogLevelFilter,
        logSourceFilter: setLogSourceFilter,
        browserEnabled: setBrowserEnabled,
        computerUseEnabled: setComputerUseEnabled,
        walletEnabled: setWalletEnabled,
        inventoryView: setInventoryView,
        inventorySort: setInventorySort,
        inventorySortDirection: setInventorySortDirection,
        inventoryChainFilters: setInventoryChainFilters,
        exportPassword: setExportPassword,
        exportIncludeLogs: setExportIncludeLogs,
        exportError: setExportError,
        exportSuccess: setExportSuccess,
        importPassword: setImportPassword,
        importFile: setImportFile,
        importError: setImportError,
        importSuccess: setImportSuccess,
        firstRunName: setFirstRunName,
        firstRunStyle: setFirstRunStyle,
        firstRunRuntimeTarget: setFirstRunRuntimeTarget,
        firstRunProvider: setFirstRunProvider,
        firstRunRemoteApiBase: setFirstRunRemoteApiBase,
        firstRunRemoteToken: setFirstRunRemoteToken,
        firstRunRemoteConnecting: setFirstRunRemoteConnecting,
        firstRunRemoteError: setFirstRunRemoteError,
        firstRunRemoteConnected: setFirstRunRemoteConnected,
        elizaCloudEnabled: setElizaCloudEnabled,
        elizaCloudVoiceProxyAvailable: setElizaCloudVoiceProxyAvailable,
        cloudDashboardView: setCloudDashboardView,
        selectedVrmIndex: setSelectedVrmIndex,
        customVrmUrl: setCustomVrmUrl,
        customVrmPreviewUrl: setCustomVrmPreviewUrl,
        customBackgroundUrl: setCustomBackgroundUrl,
        customCatchphrase: setCustomCatchphrase,
        customVoicePresetId: setCustomVoicePresetId,
        activePackId: setActivePackId,
        customWorldUrl: setCustomWorldUrl,
        commandQuery: setCommandQuery,
        commandActiveIndex: setCommandActiveIndex,
        emotePickerOpen: setEmotePickerOpen,
        analysisMode: setAnalysisMode,
        storeSearch: setStoreSearch,
        storeFilter: setStoreFilter,
        storeSubTab: setStoreSubTab,
        skillReviewId: setSkillReviewId,
        skillReviewReport: setSkillReviewReport,
        appRuns: setAppRuns,
        activeGameRunId: setActiveGameRunId,
        gameOverlayEnabled: setGameOverlayEnabled,
        activeOverlayApp: setActiveOverlayApp,
        activeInboxChat: setActiveInboxChat,
        activeTerminalSessionId: setActiveTerminalSessionId,
        storePlugins: setStorePlugins,
        storeLoading: setStoreLoading,
        storeInstalling: setStoreInstalling,
        storeUninstalling: setStoreUninstalling,
        storeError: setStoreError,
        storeDetailPlugin: setStoreDetailPlugin,
        mcpConfiguredServers: setMcpConfiguredServers,
        mcpServerStatuses: setMcpServerStatuses,
        mcpMarketplaceQuery: setMcpMarketplaceQuery,
        mcpMarketplaceResults: setMcpMarketplaceResults,
        mcpMarketplaceLoading: setMcpMarketplaceLoading,
        mcpAction: setMcpAction,
        mcpAddingServer: setMcpAddingServer,
        mcpAddingResult: setMcpAddingResult,
        mcpEnvInputs: setMcpEnvInputs,
        mcpHeaderInputs: setMcpHeaderInputs,
        droppedFiles: setDroppedFiles,
        shareIngestNotice: setShareIngestNotice,
        appsSubTab: setAppsSubTab,
        agentSubTab: setAgentSubTab,
        pluginsSubTab: setPluginsSubTab,
        databaseSubTab: setDatabaseSubTab,
        favoriteApps: setFavoriteApps,
        recentApps: setRecentApps,
        configRaw: setConfigRaw,
        configText: setConfigText,
        firstRunComplete: setFirstRunComplete,
      };
      const setter = setterMap[key];
      if (setter) setter(value);
    }
  };
  const setState = useCallback(
    <K extends keyof AppState>(key: K, value: AppState[K]) =>
      setStateImplRef.current(key, value),
    [],
  );

  const requestGreetingWhenRunningRef = useRef(requestGreetingWhenRunning);
  useEffect(() => {
    requestGreetingWhenRunningRef.current = requestGreetingWhenRunning;
  }, [requestGreetingWhenRunning]);

  useBackendConnectionSync({ setBackendConnection });

  // Passed to the startup coordinator so the PTY poll interval can skip API
  // calls when no sessions are active.
  const hasPtySessionsRef = useRef(ptySessions.length > 0);
  hasPtySessionsRef.current = ptySessions.length > 0;
  // Lets the startup coordinator's PTY hydration gate the orchestrator/coding-agent
  // routes until the agent runtime is running, avoiding the 404/503 console burst
  // during the post-(re)start window before those services finish starting.
  const agentRunningRef = useRef(agentStatus?.state === "running");
  agentRunningRef.current = agentStatus?.state === "running";

  // ── StartupCoordinator (sole startup authority) ──────────────────────
  // Called after all dependency hooks so every setter/callback is available.
  const startupCoordinator = useStartupCoordinator({
    setConnected,
    setAgentStatus,
    setAgentStatusIfChanged,
    setActionNotice,
    setStartupError,
    setAuthRequired,
    setFirstRunComplete,
    setFirstRunLoading,
    setPendingRestart,
    setPendingRestartReasons,
    setSystemWarnings,
    showRestartBanner,
    setPairingEnabled,
    setPairingExpiresAt,
    setFirstRunOptions,
    setFirstRunRuntimeTarget,
    setFirstRunProvider,
    setFirstRunRemoteConnected,
    setFirstRunRemoteApiBase,
    setFirstRunRemoteToken,
    setFirstRunCloudProvisionedContainer,
    hydrateInitialConversationState,
    loadedConversationIdRef,
    loadConversationMessages,
    loadWorkbench,
    loadPlugins,
    loadSkills,
    loadCharacter,
    loadWalletConfig,
    loadInventory,
    loadUpdateStatus,
    checkExtensionStatus,
    pollCloudCredits,
    fetchAutonomyReplay,
    appendAutonomousEvent,
    notifyHeartbeatEvent,
    setSelectedVrmIndex,
    setWalletAddresses,
    setPtySessions,
    hasPtySessionsRef,
    agentRunningRef,
    setTab,
    setTabRaw,
    setConversationMessages,
    setUnreadConversations,
    setConversations,
    requestGreetingWhenRunningRef,
    firstRunCompletionCommittedRef,
    initialTabSetRef,
    activeConversationIdRef,
    elizaCloudPollInterval,
    elizaCloudLoginPollTimer,
    uiLanguage,
  });

  // useReducer dispatch is referentially stable across renders; bind it so
  // callbacks (e.g. switchAgentProfile) depend on the stable dispatch rather
  // than the whole coordinator handle (which is a fresh object each render).
  const startupCoordinatorDispatch = startupCoordinator.dispatch;

  // Wire coordinator refs so callbacks defined before the coordinator can reach it
  coordinatorRetryRef.current = startupCoordinator.retry;
  coordinatorResetRef.current = startupCoordinator.reset;
  coordinatorFirstRunCompleteRef.current = startupCoordinator.firstRunComplete;

  // Memoize the coordinator handle so that unrelated re-renders (e.g. chatInput
  // keystrokes) don't produce a new object reference and bust the value useMemo below.
  // The coordinator's computed fields derive from reducer state.
  // all derive from its reducer state, so state is the only dep we need.
  // biome-ignore lint/correctness/useExhaustiveDependencies: coordinator fields all derive from state
  const stableStartupCoordinator = useMemo(
    () => startupCoordinator as AppContextValue["startupCoordinator"],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startupCoordinator.state],
  );

  const switchAgentProfile = useCallback(
    (profileId: string) => {
      const profile = loadAgentProfileRegistry().profiles.find(
        (p) => p.id === profileId,
      );
      if (!profile) return;

      // The profile registry is persisted in localStorage, so a tampered/
      // attacker-written profile could point a "remote" agent at an untrusted
      // host. Refuse to switch to (and dial / send the bearer token to) such a
      // profile — same trust gate the boot-restore path uses.
      if (
        profile.kind === "remote" &&
        !isTrustedRestoreApiBaseUrl(profile.apiBase)
      ) {
        return;
      }
      if (
        profile.kind === "cloud" &&
        !isTrustedCloudApiBaseUrl(
          profile.apiBase,
          profile.cloudRuntimeAgentId ?? profile.cloudAgentId,
        )
      ) {
        return;
      }

      const server = createPersistedActiveServer({
        kind: profile.kind,
        id: activeServerIdForAgentProfile(profile),
        apiBase: profile.apiBase,
        accessToken: profile.accessToken,
        label: profile.label,
        cloudRuntimeAgentId: profile.cloudRuntimeAgentId,
        cloudRuntime: profile.cloudRuntime,
      });
      if (!persistAgentProfileSelection(profileId, server)) {
        setActionNotice(
          "Couldn't switch agents because browser storage is unavailable.",
          "error",
        );
        return;
      }

      // Conversation ids are authority-local. Purge both canonical snapshots
      // and optimistic overlays before the live client can repoint or hydrate
      // the same id from another profile/account.
      discardConversationMessageState();

      // Conversation ids are per-account, so saved drafts from the old
      // profile would re-attach to whatever conversation happens to land
      // on the same id after the switch. Wipe them only after the durable
      // selection succeeds.
      clearAllChatDrafts();

      // On mobile the boot-time reconcile (reconcileMobileRestoredActiveServer)
      // CLEARS the active server whenever the persisted runtime mode disagrees
      // with it (`mobileLocal && mode !== "local"` → null). So a profile switch
      // only survives a reboot if we ALSO persist the matching runtime mode —
      // otherwise switching to the on-device agent reverts to cloud next boot.
      // The on-device agent is a `remote` profile whose apiBase is the local IPC
      // base, so detect that and treat it as "local".
      const frontendPlatform = getFrontendPlatform();
      if (frontendPlatform === "android" || frontendPlatform === "ios") {
        const runtimeTarget: FirstRunRuntimeTarget =
          server.kind === "local" || isMobileLocalAgentIpcBase(server.apiBase)
            ? "local"
            : activeServerKindToFirstRunRuntimeTarget(server.kind);
        persistMobileRuntimeModeForServerTarget(runtimeTarget);
      }

      applyAgentProfileConnection(profile, client);

      const target =
        profile.kind === "cloud"
          ? "cloud-managed"
          : profile.kind === "remote"
            ? "remote-backend"
            : "embedded-local";
      startupCoordinatorDispatch({
        type: "SWITCH_AGENT",
        target: target as RuntimeTarget,
      });
    },
    [
      discardConversationMessageState,
      setActionNotice,
      startupCoordinatorDispatch,
    ],
  );

  useAgentGreetingEffects({
    agentState: agentStatus?.state,
    loadWorkbench,
    activeConversationId,
    conversationMessages,
    chatSending,
    fetchGreeting,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    greetingInFlightConversationRef,
  });

  // ── App lifecycle (APP_RESUME / APP_PAUSE) ───────────────────────────
  // Bridges lifecycle events into the chat pipeline on every surface
  // (native + installed web PWA): aborts in-flight streams before iOS
  // suspends the process and persists the active conversation id on
  // pause; on resume re-probes /api/health, forces a WS reconnect, and
  // refetches the active conversation tail so messages missed while
  // backgrounded appear (esp. dedicated-agent REST mode with no WS).
  useAppLifecycleEvents({
    activeConversationIdRef,
    conversationMessagesRef,
    chatAbortRef,
    setConversationMessages,
    loadConversationMessages,
    hydrateInitialConversationState,
  });

  // ── Chat composer draft persistence ────────────────────────────────
  // Restores the textarea content when the user revisits a conversation
  // (a common mobile pattern: open the app, start typing, switch apps,
  // come back later). Drafts are scoped per conversation id and are
  // cleared after a successful send or when the user switches accounts.
  useChatComposerDraftPersistence({
    activeConversationId,
    chatInput,
    setChatInput,
  });

  // ── Context value ──────────────────────────────────────────────────

  // t is provided by TranslationContext (useTranslation() above)

  // Cloud auth-rejected effect is now inside useCloudState.

  // chatInput/chatSending/chatPendingImages live in ChatComposerContext so that
  // keystrokes don't cascade through AppContext to all subscribers.
  const composerValue = useMemo(
    () => ({
      chatInput,
      chatSending,
      chatPendingImages,
      chatReplyTarget,
      setChatInput,
      setChatPendingImages,
      setChatReplyTarget,
    }),
    [
      chatInput,
      chatSending,
      chatPendingImages,
      chatReplyTarget,
      setChatInput,
      setChatPendingImages,
      setChatReplyTarget,
    ],
  );

  // ptySessions lives in PtySessionsContext so the 5-second poll doesn't
  // cascade through AppContext to all subscribers.
  const ptySessionsValue = useMemo(() => ({ ptySessions }), [ptySessions]);

  // conversationMessages lives in ConversationMessagesContext so per-token
  // streaming updates re-render only the chat surfaces (ChatView + the shell
  // controller behind ChatOverlay) instead of cascading through
  // AppContext to all ~135 useApp() subscribers.
  const removeConversationMessage = useCallback(
    (messageId: string) => {
      setConversationMessages((prev) =>
        prev.filter((message) => message.id !== messageId),
      );
    },
    [setConversationMessages],
  );
  const conversationMessagesValue = useMemo(
    () => ({
      conversationMessages,
      removeConversationMessage,
      setConversationMessages,
      prependConversationMessages,
      getConversationMessagesSnapshot,
      applyConversationMessageStream,
    }),
    [
      conversationMessages,
      removeConversationMessage,
      setConversationMessages,
      prependConversationMessages,
      getConversationMessagesSnapshot,
      applyConversationMessageStream,
    ],
  );

  // Live assistant-turn status (rich status indicator) lives in its own context
  // for the same isolation reason as conversationMessages above. setServerTurnStatus
  // is a stable useState setter, so the value identity only changes when the
  // status itself changes.
  const chatTurnStatusValue = useMemo(
    () => ({ serverTurnStatus, setServerTurnStatus }),
    [serverTurnStatus],
  );

  // High-write-frequency state is exposed through narrow fresh contexts below.
  // AppContext keeps stale compatibility copies for older consumers, but they
  // intentionally stay out of the dependency list so per-keystroke/per-token/
  // per-poll updates do not fan out to every AppContext subscriber.
  const appContextHotCompatibility = useRef<
    Pick<
      AppState,
      | "autonomousEvents"
      | "autonomousLatestEventId"
      | "autonomousRunHealthByRunId"
      | "chatInput"
      | "chatPendingImages"
      | "chatSending"
      | "conversationMessages"
      | "ptySessions"
    >
  >({
    autonomousEvents: [],
    autonomousLatestEventId: null,
    autonomousRunHealthByRunId: {},
    chatInput: "",
    chatPendingImages: [],
    chatSending: false,
    conversationMessages: [],
    ptySessions: [],
  }).current;

  const value: AppContextValue = useMemo(
    () => ({
      // Translations
      t,
      // State
      tab,
      uiShellMode,
      uiLanguage,
      uiTheme,
      uiThemeMode,
      backgroundConfig,
      canUndoBackground,
      canRedoBackground,
      homeTimeWidgetHidden,
      uiAccentId,
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupError,
      // StartupCoordinator — the sole startup authority
      startupCoordinator: stableStartupCoordinator,
      authRequired,
      actionNotice,
      lifecycleBusy,
      lifecycleAction,
      pendingRestart,
      pendingRestartReasons,
      restartBannerDismissed,
      backendConnection,
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
      chatAvatarSpeaking,
      conversations,
      activeConversationId,
      companionMessageCutoffTs,
      ...appContextHotCompatibility,
      unreadConversations,
      triggers,
      triggersLoaded,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
      plugins,
      pluginFilter,
      pluginStatusFilter,
      pluginSearch,
      pluginSettingsOpen,
      pluginAdvancedOpen,
      pluginSaving,
      pluginSaveSuccess,
      isLoadingPlugins,
      pluginsLoadError,
      pluginsLoaded,
      skills,
      skillsSubTab,
      skillCreateFormOpen,
      skillCreateName,
      skillCreateDescription,
      skillCreating,
      skillReviewReport,
      skillReviewId,
      skillReviewLoading,
      skillToggleAction,
      skillInstallError,
      skillInstallAction,
      skillInstallGithubUrl,
      logs,
      logSources,
      logTags,
      logTagFilter,
      logLevelFilter,
      logSourceFilter,
      logLoadError,
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
      walletAddresses,
      walletConfig,
      walletBalances,
      walletNfts,
      walletLoading,
      walletNftsLoading,
      walletConfigStatus,
      walletConfigError,
      walletBalancesStatus,
      walletBalancesError,
      walletNftsStatus,
      walletNftsError,
      inventoryView,
      walletExportData,
      walletExportVisible,
      walletApiKeySaving,
      inventorySort,
      inventorySortDirection,
      inventoryChainFilters,
      walletError,
      registryStatus,
      registryLoading,
      registryRegistering,
      registryError,
      dropStatus,
      dropLoading,
      mintInProgress,
      mintResult,
      mintError,
      mintShiny,
      whitelistStatus,
      whitelistLoading,
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
      setWalletPrimary,
      refreshCloudWallets,
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
      elizaCloudEnabled,
      elizaCloudVoiceProxyAvailable,
      elizaCloudConnected,
      elizaCloudHasPersistedKey,
      elizaCloudCredits,
      elizaCloudCreditsLow,
      elizaCloudCreditsCritical,
      elizaCloudAuthRejected,
      elizaCloudCreditsError,
      elizaCloudTopUpUrl,
      elizaCloudUserId,
      elizaCloudStatusReason,
      ownerName,
      cloudDashboardView,
      elizaCloudLoginBusy,
      elizaCloudLoginError,
      elizaCloudLoginFallbackUrl,
      elizaCloudDisconnecting,
      activeAgentProfile: getActiveProfile(),
      updateStatus,
      updateLoading,
      updateChannelSaving,
      extensionStatus,
      extensionChecking,
      storePlugins,
      storeSearch,
      storeFilter,
      storeLoading,
      storeInstalling,
      storeUninstalling,
      storeError,
      storeDetailPlugin,
      storeSubTab,
      workbenchLoading,
      workbench,
      workbenchTasksAvailable,
      workbenchTriggersAvailable,
      workbenchTodosAvailable,
      exportBusy,
      exportPassword,
      exportIncludeLogs,
      exportError,
      exportSuccess,
      importBusy,
      importPassword,
      importFile,
      importError,
      importSuccess,
      firstRunDeferredTasks,
      postFirstRunChecklistDismissed,
      firstRunOptions,
      firstRunName,
      firstRunStyle,
      firstRunRuntimeTarget,
      firstRunProvider,
      firstRunRemoteApiBase,
      firstRunRemoteToken,
      firstRunRemoteConnecting,
      firstRunRemoteError,
      firstRunRemoteConnected,
      firstRunCloudProvisionedContainer,
      commandPaletteOpen,
      commandQuery,
      commandActiveIndex,
      closeCommandPalette,
      emotePickerOpen,
      mcpConfiguredServers,
      mcpServerStatuses,
      mcpMarketplaceQuery,
      mcpMarketplaceResults,
      mcpMarketplaceLoading,
      mcpAction,
      mcpAddingServer,
      mcpAddingResult,
      mcpEnvInputs,
      mcpHeaderInputs,
      droppedFiles,
      shareIngestNotice,
      analysisMode,
      setAnalysisMode,
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGameSession,
      gameOverlayEnabled,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
      activeGamePostMessagePayload,

      // Actions
      setTab,
      setUiShellMode,
      switchUiShellMode,
      switchShellView,
      navigation,
      setUiLanguage,
      setUiTheme,
      setUiThemeMode,
      setBackgroundConfig,
      undoBackgroundConfig,
      redoBackgroundConfig,
      setHomeTimeWidgetHidden,
      setUiAccent,
      handleStart,
      handleStop,

      handleRestart,
      handleReset,
      handleResetAppliedFromMain,
      retryStartup,
      dismissRestartBanner,
      showRestartBanner,
      triggerRestart,
      relaunchDesktop,
      retryBackendConnection,
      restartBackend,
      systemWarnings,
      dismissSystemWarning,
      handleChatSend,
      handleChatStop,
      interruptActiveChatPipeline,
      handleChatRetry,
      handleChatEdit,
      handleChatDelete,
      handleChatClear,
      handleStartDraftConversation,
      handleNewConversation,
      ensureActiveConversation,
      setChatPendingImages,
      handleSelectConversation,
      loadConversationMessagesAround,
      handleDeleteConversation,
      handleRenameConversation,
      suggestConversationTitle,
      sendActionMessage,
      sendChatText,
      loadTriggers,
      ensureTriggersLoaded,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
      handlePairingSubmit,
      loadPlugins,
      ensurePluginsLoaded,
      handlePluginToggle,
      handlePluginConfigSave,
      loadSkills,
      refreshSkills,
      handleSkillToggle,
      handleCreateSkill,
      handleOpenSkill,
      handleDeleteSkill,
      handleReviewSkill,
      handleAcknowledgeSkill,
      installSkillFromGithubUrl,
      loadLogs,
      loadInventory,
      loadWalletConfig,
      loadBalances,
      loadNfts,
      executeBscTrade,
      executeBscTransfer,
      getBscTradePreflight,
      getBscTradeQuote,
      getBscTradeTxStatus,
      getStewardStatus,
      getStewardAddresses,
      getStewardBalance,
      getStewardTokens,
      getStewardWebhookEvents,
      getStewardHistory,
      getStewardPending,
      approveStewardTx,
      rejectStewardTx,
      loadWalletTradingProfile,
      handleWalletApiKeySave,
      handleExportKeys,
      loadRegistryStatus,
      registerOnChain,
      syncRegistryProfile,
      loadDropStatus,
      mintFromDrop,
      loadWhitelistStatus,
      loadCharacter,
      handleSaveCharacter,
      handleCharacterFieldInput,
      handleCharacterArrayInput,
      handleCharacterStyleInput,
      handleCharacterMessageExamplesInput,
      completeFirstRun,
      handleCloudLoginRecovery,
      handleInteractiveCloudLogin,
      handleCloudDisconnect,
      handleCloudSignOut,
      switchAgentProfile,
      loadUpdateStatus,
      handleChannelChange,
      checkExtensionStatus,
      openEmotePicker,
      closeEmotePicker,
      loadWorkbench,
      handleAgentExport,
      handleAgentImport,
      setActionNotice,
      setState,
      copyToClipboard,
    }),
    // prettier-ignore
    [
      t,
      tab,
      uiShellMode,
      uiLanguage,
      uiTheme,
      uiThemeMode,
      backgroundConfig,
      canUndoBackground,
      canRedoBackground,
      homeTimeWidgetHidden,
      uiAccentId,
      connected,
      agentStatus,
      firstRunComplete,
      firstRunUiRevealNonce,
      firstRunLoading,
      startupError,
      stableStartupCoordinator,
      authRequired,
      actionNotice,
      lifecycleBusy,
      lifecycleAction,
      pendingRestart,
      pendingRestartReasons,
      restartBannerDismissed,
      backendConnection,
      pairingEnabled,
      pairingExpiresAt,
      pairingCodeInput,
      pairingError,
      pairingBusy,
      chatFirstTokenReceived,
      chatLastUsage,
      chatAvatarVisible,
      chatAgentVoiceMuted,
      chatAvatarSpeaking,
      conversations,
      activeConversationId,
      companionMessageCutoffTs,
      appContextHotCompatibility,
      // NOTE: conversationMessages intentionally EXCLUDED — it gets a new array
      // reference on every streamed token. Provided fresh via
      // ConversationMessagesCtx (useConversationMessages()); the copy left in the
      // value object is stale and unread.
      // NOTE: autonomousEvents/autonomousLatestEventId/autonomousRunHealthByRunId
      // intentionally EXCLUDED — they update on every heartbeat/agent/proactive WS
      // event but no component reads them from useApp() (readers use the *Ref handles
      // off useChatState). A stale copy remains in the value object purely to satisfy
      // the AppContextValue type; excluding them from deps stops the heartbeat stream
      // from re-rendering all AppContext subscribers.
      // NOTE: ptySessions intentionally EXCLUDED — provided fresh via PtySessionsCtx.
      unreadConversations,
      triggers,
      triggersLoaded,
      triggersLoading,
      triggersSaving,
      triggerRunsById,
      triggerHealth,
      triggerError,
      plugins,
      pluginFilter,
      pluginStatusFilter,
      pluginSearch,
      pluginSettingsOpen,
      pluginAdvancedOpen,
      pluginSaving,
      pluginSaveSuccess,
      isLoadingPlugins,
      pluginsLoadError,
      pluginsLoaded,
      skills,
      skillsSubTab,
      skillCreateFormOpen,
      skillCreateName,
      skillCreateDescription,
      skillCreating,
      skillReviewReport,
      skillReviewId,
      skillReviewLoading,
      skillToggleAction,
      skillInstallError,
      skillInstallAction,
      skillInstallGithubUrl,
      logs,
      logSources,
      logTags,
      logTagFilter,
      logLevelFilter,
      logSourceFilter,
      logLoadError,
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
      walletAddresses,
      walletConfig,
      walletBalances,
      walletNfts,
      walletLoading,
      walletNftsLoading,
      walletConfigStatus,
      walletConfigError,
      walletBalancesStatus,
      walletBalancesError,
      walletNftsStatus,
      walletNftsError,
      inventoryView,
      walletExportData,
      walletExportVisible,
      walletApiKeySaving,
      inventorySort,
      inventorySortDirection,
      inventoryChainFilters,
      walletError,
      registryStatus,
      registryLoading,
      registryRegistering,
      registryError,
      dropStatus,
      dropLoading,
      mintInProgress,
      mintResult,
      mintError,
      mintShiny,
      whitelistStatus,
      whitelistLoading,
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
      setWalletPrimary,
      refreshCloudWallets,
      characterData,
      characterLoading,
      characterSaving,
      characterSaveSuccess,
      characterSaveError,
      characterDraft,
      selectedVrmIndex,
      customVrmUrl,
      customVrmPreviewUrl,
      customBackgroundUrl,
      customCatchphrase,
      customVoicePresetId,
      activePackId,
      customWorldUrl,
      elizaCloudEnabled,
      elizaCloudVoiceProxyAvailable,
      elizaCloudConnected,
      elizaCloudHasPersistedKey,
      elizaCloudCredits,
      elizaCloudCreditsLow,
      elizaCloudCreditsCritical,
      elizaCloudAuthRejected,
      elizaCloudCreditsError,
      elizaCloudTopUpUrl,
      elizaCloudUserId,
      elizaCloudStatusReason,
      ownerName,
      cloudDashboardView,
      elizaCloudLoginBusy,
      elizaCloudLoginError,
      elizaCloudLoginFallbackUrl,
      elizaCloudDisconnecting,
      updateStatus,
      updateLoading,
      updateChannelSaving,
      extensionStatus,
      extensionChecking,
      storePlugins,
      storeSearch,
      storeFilter,
      storeLoading,
      storeInstalling,
      storeUninstalling,
      storeError,
      storeDetailPlugin,
      storeSubTab,
      workbenchLoading,
      workbench,
      workbenchTasksAvailable,
      workbenchTriggersAvailable,
      workbenchTodosAvailable,
      exportBusy,
      exportPassword,
      exportIncludeLogs,
      exportError,
      exportSuccess,
      importBusy,
      importPassword,
      importFile,
      importError,
      importSuccess,
      firstRunDeferredTasks,
      postFirstRunChecklistDismissed,
      firstRunOptions,
      firstRunName,
      firstRunStyle,
      firstRunRuntimeTarget,
      firstRunProvider,
      firstRunRemoteApiBase,
      firstRunRemoteToken,
      firstRunRemoteConnecting,
      firstRunRemoteError,
      firstRunRemoteConnected,
      firstRunCloudProvisionedContainer,
      commandPaletteOpen,
      commandQuery,
      commandActiveIndex,
      closeCommandPalette,
      emotePickerOpen,
      mcpConfiguredServers,
      mcpServerStatuses,
      mcpMarketplaceQuery,
      mcpMarketplaceResults,
      mcpMarketplaceLoading,
      mcpAction,
      mcpAddingServer,
      mcpAddingResult,
      mcpEnvInputs,
      mcpHeaderInputs,
      droppedFiles,
      shareIngestNotice,
      appRuns,
      activeGameRunId,
      activeGameApp,
      activeGameDisplayName,
      activeGameViewerUrl,
      activeGameSandbox,
      activeGamePostMessageAuth,
      activeGameSession,
      gameOverlayEnabled,
      activeOverlayApp,
      activeInboxChat,
      activeTerminalSessionId,
      appsSubTab,
      agentSubTab,
      pluginsSubTab,
      databaseSubTab,
      favoriteApps,
      recentApps,
      configRaw,
      configText,
      activeGamePostMessagePayload,
      systemWarnings,
      setTab,
      setUiShellMode,
      switchUiShellMode,
      switchShellView,
      navigation,
      setUiLanguage,
      setUiTheme,
      setUiThemeMode,
      setBackgroundConfig,
      undoBackgroundConfig,
      redoBackgroundConfig,
      setHomeTimeWidgetHidden,
      setUiAccent,
      handleStart,
      handleStop,
      handleRestart,
      handleReset,
      handleResetAppliedFromMain,
      retryStartup,
      dismissRestartBanner,
      showRestartBanner,
      triggerRestart,
      relaunchDesktop,
      retryBackendConnection,
      restartBackend,
      dismissSystemWarning,
      handleChatSend,
      handleChatStop,
      interruptActiveChatPipeline,
      handleChatRetry,
      handleChatEdit,
      handleChatDelete,
      handleChatClear,
      handleStartDraftConversation,
      handleNewConversation,
      ensureActiveConversation,
      handleSelectConversation,
      loadConversationMessagesAround,
      handleDeleteConversation,
      handleRenameConversation,
      suggestConversationTitle,
      sendActionMessage,
      sendChatText,
      loadTriggers,
      ensureTriggersLoaded,
      createTrigger,
      updateTrigger,
      deleteTrigger,
      runTriggerNow,
      loadTriggerRuns,
      loadTriggerHealth,
      handlePairingSubmit,
      loadPlugins,
      ensurePluginsLoaded,
      handlePluginToggle,
      handlePluginConfigSave,
      loadSkills,
      refreshSkills,
      handleSkillToggle,
      handleCreateSkill,
      handleOpenSkill,
      handleDeleteSkill,
      handleReviewSkill,
      handleAcknowledgeSkill,
      installSkillFromGithubUrl,
      loadLogs,
      loadInventory,
      loadWalletConfig,
      loadBalances,
      loadNfts,
      executeBscTrade,
      executeBscTransfer,
      getBscTradePreflight,
      getBscTradeQuote,
      getBscTradeTxStatus,
      getStewardStatus,
      getStewardAddresses,
      getStewardBalance,
      getStewardTokens,
      getStewardWebhookEvents,
      getStewardHistory,
      getStewardPending,
      approveStewardTx,
      rejectStewardTx,
      loadWalletTradingProfile,
      handleWalletApiKeySave,
      handleExportKeys,
      loadRegistryStatus,
      registerOnChain,
      syncRegistryProfile,
      loadDropStatus,
      mintFromDrop,
      loadWhitelistStatus,
      loadCharacter,
      handleSaveCharacter,
      handleCharacterFieldInput,
      handleCharacterArrayInput,
      handleCharacterStyleInput,
      handleCharacterMessageExamplesInput,
      completeFirstRun,
      handleCloudLoginRecovery,
      handleInteractiveCloudLogin,
      handleCloudDisconnect,
      handleCloudSignOut,
      switchAgentProfile,
      loadUpdateStatus,
      handleChannelChange,
      checkExtensionStatus,
      openEmotePicker,
      closeEmotePicker,
      loadWorkbench,
      handleAgentExport,
      handleAgentImport,
      setActionNotice,
      setState,
      copyToClipboard,
      setChatPendingImages,
      analysisMode,
      setAnalysisMode,
    ],
  );

  // Mirror the context value into the external selector store so useAppSelector
  // consumers get field-level subscriptions (re-render only on the slice they
  // read) instead of re-rendering on every context change. seedAppValue keeps
  // the snapshot fresh during this render (the provider renders before its
  // children, so no null-window); publishAppValue notifies subscribers from a
  // commit-time effect (never a setState-during-render).
  seedAppValue(value);
  useEffect(() => {
    publishAppValue(value);
  }, [value]);

  const bootConfig = getBootConfig();
  const bootConfigValue = useMemo(
    () => ({
      ...bootConfig,
      branding: { ...bootConfig.branding, ...brandingOverride },
    }),
    [bootConfig, brandingOverride],
  );
  const mergedBranding = useMemo(
    () => ({ ...DEFAULT_BRANDING, ...bootConfigValue.branding }),
    [bootConfigValue],
  );

  return (
    <AppBootContext.Provider value={bootConfigValue}>
      <BrandingContext.Provider value={mergedBranding}>
        <PtySessionsCtx.Provider value={ptySessionsValue}>
          <ConversationMessagesCtx.Provider value={conversationMessagesValue}>
            <ChatTurnStatusCtx.Provider value={chatTurnStatusValue}>
              <ChatInputRefCtx.Provider value={chatInputRef}>
                <ChatComposerCtx.Provider value={composerValue}>
                  <AppContext.Provider value={value}>
                    {children}
                    <ConfirmDialog {...modalProps} />
                    <PromptDialog {...promptModalProps} />
                  </AppContext.Provider>
                </ChatComposerCtx.Provider>
              </ChatInputRefCtx.Provider>
            </ChatTurnStatusCtx.Provider>
          </ConversationMessagesCtx.Provider>
        </PtySessionsCtx.Provider>
      </BrandingContext.Provider>
    </AppBootContext.Provider>
  );
}
