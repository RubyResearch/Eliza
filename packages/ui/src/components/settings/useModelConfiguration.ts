/**
 * State + save logic for the per-role model configuration panel (Settings →
 * Models & Providers): the small/large chat brains and the coding sub-agent.
 *
 * Loads the validated provider→model→efforts catalog (`GET /api/models`) and
 * the effective config (`GET /api/models/config`) together, exposes one
 * draft-state group per target, and persists each group through
 * `POST /api/models/config`. Chat-target writes restart the agent server-side
 * (RuntimeOperationManager), so the save flow arms an explicit confirm step
 * first and then only *polls* runtime status until it is back — it must never
 * call `restartAgent()` itself, which would double-restart. Coding-target
 * writes are restart-free by contract (spawns re-read config env per spawn).
 *
 * Two wire quirks this hook owns so the view stays declarative: the in-house
 * coding backend is spelled `eliza-code` on the wire (persisted as
 * `ELIZA_DEFAULT_AGENT_TYPE=elizaos`), and codex efforts are clamped to the
 * pinned codex-acp adapter's parseable set even though the catalog lists
 * `max`/`ultra` for some models — offering those would be a guaranteed 400.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ModelsConfigCodingBackend,
  ModelsConfigEffectiveValue,
  ModelsConfigResponse,
  ModelsConfigSource,
  ModelsConfigWriteRequest,
} from "../../api/client-types-core";

export type ChatTarget = "small" | "large";

/** Chat providers the write route accepts, in prefill-resolution order. */
const CHAT_PROVIDERS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "cerebras", label: "Cerebras" },
  { id: "elizacloud", label: "Eliza Cloud" },
  { id: "claude-chat", label: "Claude" },
];

/**
 * Chat provider → the env-key family its model plugin actually reads.
 * Mirrors CHAT_PROVIDER_KEY_FAMILY in packages/agent/src/api/
 * model-config-routes.ts: cerebras persists through OPENAI_* (plugin-openai's
 * Cerebras mode), elizacloud through ELIZAOS_CLOUD_* (plugin-elizacloud), and
 * claude-chat through ANTHROPIC_*.
 */
type ChatKeyFamily = "OPENAI" | "ANTHROPIC" | "ELIZAOS_CLOUD";
const CHAT_PROVIDER_KEY_FAMILY: Record<string, ChatKeyFamily> = {
  cerebras: "OPENAI",
  elizacloud: "ELIZAOS_CLOUD",
  "claude-chat": "ANTHROPIC",
};

/** Families whose effort key is one shared knob across small+large. */
function hasSharedEffortKnob(provider: string): boolean {
  return CHAT_PROVIDER_KEY_FAMILY[provider] !== "ANTHROPIC";
}

export const CODING_BACKEND_OPTIONS: ReadonlyArray<{
  value: ModelsConfigCodingBackend;
  label: string;
}> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude" },
  { value: "eliza-code", label: "elizaOS" },
];

// Mirrors CODEX_ACP_EFFORTS in packages/agent/src/api/model-config-routes.ts:
// the pinned codex-acp adapter cannot parse max/ultra, so the route 400s them.
// Widen together with the server set when the acp pin is bumped.
const CODEX_PINNED_EFFORTS: ReadonlySet<string> = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
]);

const CODING_MODEL_KEYS: Record<ModelsConfigCodingBackend, string> = {
  codex: "ELIZA_CODEX_MODEL_POWERFUL",
  claude: "ELIZA_CLAUDE_MODEL_POWERFUL",
  "eliza-code": "ELIZA_ELIZAOS_MODEL_POWERFUL",
};

const CODING_EFFORT_KEYS: Partial<Record<ModelsConfigCodingBackend, string>> = {
  codex: "ELIZA_CODEX_EFFORT",
  claude: "ELIZA_CLAUDE_EFFORT",
};

const CODING_CATALOG_PROVIDERS: Partial<
  Record<ModelsConfigCodingBackend, string>
> = {
  codex: "codex",
  claude: "claude-coding",
};

const SAVED_STATE_TTL_MS = 2500;
const RESTART_POLL_INTERVAL_MS = 1000;
const RESTART_MAX_WAIT_MS = 60_000;

export interface ConfiguredValue {
  model: string;
  source: ModelsConfigSource;
}

export type ModelGroupSaveState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "saving" }
  | { phase: "restarting"; operationId?: string }
  | { phase: "saved"; conflictKeys?: string[] }
  | { phase: "error"; message: string; supported?: string[] };

export interface ModelConfigChatGroup {
  target: ChatTarget;
  providerOptions: Array<{ value: string; label: string }>;
  provider: string;
  /** True when the provider is pinned to the active intelligence selection —
   * the panel renders a static label instead of a free provider dropdown so
   * chat models can never be picked from an inactive provider. */
  providerLocked: boolean;
  modelOptions: ModelCatalogEntry[];
  model: string;
  effortOptions: string[];
  effort: string;
  selectedEntry: ModelCatalogEntry | null;
  configured: ConfiguredValue | null;
  /** True when this target's effort persists via the shared OPENAI_REASONING_EFFORT knob. */
  sharedEffortKnob: boolean;
  save: ModelGroupSaveState;
  setProvider: (provider: string) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  requestSave: () => void;
  confirmSave: () => void;
  cancelSave: () => void;
}

export interface ModelConfigCodingGroup {
  backend: ModelsConfigCodingBackend;
  backendOptions: ReadonlyArray<{
    value: ModelsConfigCodingBackend;
    label: string;
  }>;
  persistedDefaultBackend: ModelsConfigCodingBackend | null;
  makeDefault: boolean;
  /** eliza-code has no catalog slice; its model is a free-form string. */
  freeFormModel: boolean;
  modelOptions: ModelCatalogEntry[];
  model: string;
  effortOptions: string[];
  effort: string;
  selectedEntry: ModelCatalogEntry | null;
  configured: ConfiguredValue | null;
  save: ModelGroupSaveState;
  setBackend: (backend: ModelsConfigCodingBackend) => void;
  setModel: (model: string) => void;
  setEffort: (effort: string) => void;
  setMakeDefault: (makeDefault: boolean) => void;
  saveNow: () => void;
}

export type ModelConfigurationState =
  | { phase: "loading" }
  | { phase: "error"; message: string; retry: () => void }
  | { phase: "empty"; retry: () => void }
  | {
      phase: "ready";
      small: ModelConfigChatGroup;
      large: ModelConfigChatGroup;
      coding: ModelConfigCodingGroup;
    };

interface ChatDraft {
  provider: string;
  model: string;
  effort: string;
  configured: ConfiguredValue | null;
}

interface CodingDraft {
  model: string;
  effort: string;
  configured: ConfiguredValue | null;
}

interface ReadyData {
  catalog: ModelCatalog;
  config: ModelsConfigResponse;
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; data: ReadyData };

function entriesForRole(
  catalog: ModelCatalog,
  provider: string,
  role: "small" | "large" | "coding",
): ModelCatalogEntry[] {
  return (catalog.providers[provider] ?? []).filter((entry) =>
    entry.roles.includes(role),
  );
}

function effective(
  config: ModelsConfigResponse,
  target: keyof ModelsConfigResponse["targets"],
  key: string,
): ModelsConfigEffectiveValue | null {
  return config.targets[target]?.[key] ?? null;
}

function chatModelKey(target: ChatTarget, family: ChatKeyFamily) {
  return `${family}_${target.toUpperCase()}_MODEL`;
}

function chatEffortKey(target: ChatTarget, provider: string) {
  const family = CHAT_PROVIDER_KEY_FAMILY[provider];
  if (family === "ELIZAOS_CLOUD") return "ELIZAOS_CLOUD_REASONING_EFFORT";
  return family === "ANTHROPIC"
    ? `ANTHROPIC_EFFORT_${target.toUpperCase()}`
    : "OPENAI_REASONING_EFFORT";
}

/**
 * Resolve the chat group prefill from the effective config: match each
 * provider's persisted model id (read from its OWN key family) against the
 * catalog. An unmatched or absent value keeps the provider guess but leaves
 * the model unselected so the UI never claims a configuration the catalog
 * cannot confirm.
 */
function resolveChatDraft(
  target: ChatTarget,
  catalog: ModelCatalog,
  config: ModelsConfigResponse,
): ChatDraft {
  const openaiModel = effective(config, target, chatModelKey(target, "OPENAI"));
  const cloudModel = effective(
    config,
    target,
    chatModelKey(target, "ELIZAOS_CLOUD"),
  );
  const anthropicModel = effective(
    config,
    target,
    chatModelKey(target, "ANTHROPIC"),
  );

  const candidates: Array<{
    provider: string;
    value: ModelsConfigEffectiveValue | null;
  }> = [
    { provider: "cerebras", value: openaiModel },
    { provider: "elizacloud", value: cloudModel },
    { provider: "claude-chat", value: anthropicModel },
  ];
  for (const candidate of candidates) {
    if (!candidate.value) continue;
    const entry = entriesForRole(catalog, candidate.provider, target).find(
      (item) => item.id === candidate.value?.value,
    );
    if (!entry) continue;
    const effortValue = effective(
      config,
      target,
      chatEffortKey(target, candidate.provider),
    )?.value;
    return {
      provider: candidate.provider,
      model: entry.id,
      effort:
        effortValue !== undefined && entry.efforts.includes(effortValue)
          ? effortValue
          : "",
      configured: {
        model: candidate.value.value,
        source: candidate.value.source,
      },
    };
  }

  const fallbackProvider =
    CHAT_PROVIDERS.find(
      (choice) => entriesForRole(catalog, choice.id, target).length > 0,
    )?.id ?? "";
  const unmatched = anthropicModel ?? cloudModel ?? openaiModel;
  return {
    provider: unmatched
      ? anthropicModel
        ? "claude-chat"
        : cloudModel
          ? "elizacloud"
          : fallbackProvider
      : fallbackProvider,
    model: "",
    effort: "",
    configured: unmatched
      ? { model: unmatched.value, source: unmatched.source }
      : null,
  };
}

function parsePersistedDefaultBackend(
  config: ModelsConfigResponse,
): ModelsConfigCodingBackend | null {
  const raw = effective(config, "coding", "ELIZA_DEFAULT_AGENT_TYPE")?.value;
  if (raw === undefined) return null;
  if (raw === "elizaos") return "eliza-code";
  return CODING_BACKEND_OPTIONS.some((option) => option.value === raw)
    ? (raw as ModelsConfigCodingBackend)
    : null;
}

function resolveCodingDraft(
  backend: ModelsConfigCodingBackend,
  catalog: ModelCatalog,
  config: ModelsConfigResponse,
): CodingDraft {
  const configured = effective(config, "coding", CODING_MODEL_KEYS[backend]);
  const effortKey = CODING_EFFORT_KEYS[backend];
  const effortValue = effortKey
    ? effective(config, "coding", effortKey)?.value
    : undefined;
  const model = configured?.value ?? "";
  const entry = codingModelOptions(backend, catalog, model).find(
    (item) => item.id === model,
  );
  const effortOptions = entry ? codingEffortOptions(backend, entry) : [];
  return {
    model,
    effort:
      effortValue !== undefined && effortOptions.includes(effortValue)
        ? effortValue
        : "",
    configured: configured
      ? { model: configured.value, source: configured.source }
      : null,
  };
}

function codingModelOptions(
  backend: ModelsConfigCodingBackend,
  catalog: ModelCatalog,
  _configuredModel: string,
): ModelCatalogEntry[] {
  const provider = CODING_CATALOG_PROVIDERS[backend];
  if (!provider) return [];
  // No role filter here: the write route validates coding models against the
  // whole provider slice.
  const options = catalog.providers[provider] ?? [];
  return options;
}

function codingEffortOptions(
  backend: ModelsConfigCodingBackend,
  entry: ModelCatalogEntry,
): string[] {
  if (backend === "codex") {
    return entry.efforts.filter((effort) => CODEX_PINNED_EFFORTS.has(effort));
  }
  if (backend === "claude") return entry.efforts;
  return [];
}

function catalogIsEmpty(catalog: ModelCatalog): boolean {
  return Object.values(catalog.providers).every(
    (entries) => entries.length === 0,
  );
}

/**
 * Boundary guards for the two GET responses. The typed client casts JSON
 * blindly, and a runtime predating the model-config API (or a test stub)
 * answers with a shapeless body — that must surface as the panel's designed
 * error state with a readable message, not a TypeError from deep inside
 * draft resolution.
 */
function parseCatalogResponse(response: unknown): ModelCatalog {
  if (response && typeof response === "object") {
    const catalog = (response as { catalog?: unknown }).catalog;
    if (catalog && typeof catalog === "object") {
      const providers = (catalog as { providers?: unknown }).providers;
      if (
        providers &&
        typeof providers === "object" &&
        !Array.isArray(providers) &&
        Object.values(providers).every((entries) => Array.isArray(entries))
      ) {
        return catalog as ModelCatalog;
      }
    }
  }
  throw new Error(
    "the runtime did not return a model catalog (/api/models) — it may predate the model configuration API",
  );
}

function parseConfigResponse(response: unknown): ModelsConfigResponse {
  if (response && typeof response === "object") {
    const targets = (response as { targets?: unknown }).targets;
    if (targets && typeof targets === "object" && !Array.isArray(targets)) {
      return response as ModelsConfigResponse;
    }
  }
  throw new Error(
    "the runtime did not return a model configuration (/api/models/config) — it may predate the model configuration API",
  );
}

function failureMessage(err: unknown): string {
  return err instanceof Error && err.message.trim()
    ? err.message
    : "Request failed";
}

export interface UseModelConfigurationOptions {
  /** Catalog chat provider implied by the ACTIVE intelligence selection
   * ("elizacloud" | "cerebras" | "claude-chat"). When set, the small/large
   * groups are pinned to it; when undefined (no unambiguous active provider)
   * the free per-target provider choice remains. */
  activeChatProvider?: string;
}

export function useModelConfiguration(
  options: UseModelConfigurationOptions = {},
): ModelConfigurationState {
  const activeChatProvider = options.activeChatProvider;
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [chatDrafts, setChatDrafts] = useState<Record<ChatTarget, ChatDraft>>({
    small: { provider: "", model: "", effort: "", configured: null },
    large: { provider: "", model: "", effort: "", configured: null },
  });
  const [codingBackend, setCodingBackend] =
    useState<ModelsConfigCodingBackend>("codex");
  const [codingDrafts, setCodingDrafts] = useState<
    Record<ModelsConfigCodingBackend, CodingDraft>
  >({
    codex: { model: "", effort: "", configured: null },
    claude: { model: "", effort: "", configured: null },
    "eliza-code": { model: "", effort: "", configured: null },
  });
  const [persistedDefaultBackend, setPersistedDefaultBackend] =
    useState<ModelsConfigCodingBackend | null>(null);
  const [makeDefault, setMakeDefault] = useState(false);
  const [saveStates, setSaveStates] = useState<
    Record<"small" | "large" | "coding", ModelGroupSaveState>
  >({
    small: { phase: "idle" },
    large: { phase: "idle" },
    coding: { phase: "idle" },
  });

  const disposedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const activeLifecycleRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const activeLoadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    lifecycleGenerationRef.current += 1;
    const lifecycleGeneration = lifecycleGenerationRef.current;
    activeLifecycleRef.current = lifecycleGeneration;
    disposedRef.current = false;
    return () => {
      if (activeLifecycleRef.current !== lifecycleGeneration) return;
      activeLifecycleRef.current = 0;
      disposedRef.current = true;
    };
  }, []);
  // The catalog the drafts were resolved against, for post-save re-resolution
  // of `configured` markers without threading it through every callback.
  const catalogRef = useRef<ModelCatalog | null>(null);
  const configRef = useRef<ModelsConfigResponse | null>(null);

  const setSaveState = useCallback(
    (group: "small" | "large" | "coding", next: ModelGroupSaveState) => {
      if (disposedRef.current) return;
      setSaveStates((prev) => ({ ...prev, [group]: next }));
    },
    [],
  );

  const initializeDrafts = useCallback((data: ReadyData) => {
    setChatDrafts({
      small: resolveChatDraft("small", data.catalog, data.config),
      large: resolveChatDraft("large", data.catalog, data.config),
    });
    const defaultBackend = parsePersistedDefaultBackend(data.config);
    setPersistedDefaultBackend(defaultBackend);
    setCodingBackend(defaultBackend ?? "codex");
    setMakeDefault(defaultBackend !== null);
    setCodingDrafts({
      codex: resolveCodingDraft("codex", data.catalog, data.config),
      claude: resolveCodingDraft("claude", data.catalog, data.config),
      "eliza-code": resolveCodingDraft("eliza-code", data.catalog, data.config),
    });
  }, []);

  const loadAll = useCallback(async () => {
    const lifecycleGeneration = activeLifecycleRef.current;
    if (lifecycleGeneration === 0 || disposedRef.current) return;
    activeLoadAbortRef.current?.abort();
    const abortController = new AbortController();
    activeLoadAbortRef.current = abortController;
    loadGenerationRef.current += 1;
    const loadGeneration = loadGenerationRef.current;
    // A mounted boolean alone cannot distinguish StrictMode's replaced setup
    // or an older retry that settles after a newer load. Both owners must match
    // before any response, error, ref, or draft reaches the current panel.
    const ownsLoad = () =>
      lifecycleGeneration !== 0 &&
      activeLifecycleRef.current === lifecycleGeneration &&
      loadGenerationRef.current === loadGeneration &&
      activeLoadAbortRef.current === abortController &&
      !abortController.signal.aborted &&
      !disposedRef.current;
    if (!ownsLoad()) return;
    setLoad({ phase: "loading" });
    try {
      const [modelsResponse, configResponse] = await Promise.all([
        client.getModelsCatalog({ signal: abortController.signal }),
        client.getModelsConfig({ signal: abortController.signal }),
      ]);
      if (!ownsLoad()) return;
      const data: ReadyData = {
        catalog: parseCatalogResponse(modelsResponse),
        config: parseConfigResponse(configResponse),
      };
      catalogRef.current = data.catalog;
      configRef.current = data.config;
      initializeDrafts(data);
      setLoad({ phase: "ready", data });
    } catch (err) {
      // error-policy:J4 catalog/config fetch failure renders the panel's
      // designed error state (with retry) instead of a healthy-empty panel.
      if (!ownsLoad()) return;
      // Promise.all can reject while its sibling is still pending. Cancel it
      // before finally releases the controller needed by retry/unmount cleanup.
      abortController.abort();
      setLoad({ phase: "error", message: failureMessage(err) });
    } finally {
      if (activeLoadAbortRef.current === abortController) {
        activeLoadAbortRef.current = null;
      }
    }
  }, [initializeDrafts]);

  useEffect(() => {
    void loadAll();
    return () => {
      activeLoadAbortRef.current?.abort();
      activeLoadAbortRef.current = null;
    };
  }, [loadAll]);

  /**
   * Refresh the effective config after a successful write so source notes and
   * the persisted default backend reflect what the server actually stored.
   * Reconcile untouched effort selections with shared provider knobs while
   * preserving unsaved selections, including edits made during the request.
   */
  const refreshConfig = useCallback(async () => {
    let config: ModelsConfigResponse;
    try {
      config = parseConfigResponse(await client.getModelsConfig());
    } catch {
      // error-policy:J4 the write itself already succeeded; a failed
      // source-note refresh must not repaint a successful save as an error.
      // The markers simply stay as they were until the next full load.
      return;
    }
    if (disposedRef.current) return;
    const previousConfig = configRef.current;
    configRef.current = config;
    setLoad((prev) =>
      prev.phase === "ready"
        ? { phase: "ready", data: { ...prev.data, config } }
        : prev,
    );
    setPersistedDefaultBackend(parsePersistedDefaultBackend(config));
    const catalog = catalogRef.current;
    if (!catalog) return;
    setChatDrafts((prev) => {
      const reconcile = (target: ChatTarget): ChatDraft => {
        const draft = prev[target];
        const effective = resolveChatDraft(target, catalog, config);
        const previous = previousConfig
          ? resolveChatDraft(target, catalog, previousConfig)
          : null;
        const untouched =
          previous !== null &&
          draft.provider === previous.provider &&
          draft.model === previous.model &&
          draft.effort === previous.effort;
        return {
          ...draft,
          effort: untouched ? effective.effort : draft.effort,
          configured: effective.configured,
        };
      };
      return { small: reconcile("small"), large: reconcile("large") };
    });
    setCodingDrafts((prev) => ({
      codex: {
        ...prev.codex,
        configured: resolveCodingDraft("codex", catalog, config).configured,
      },
      claude: {
        ...prev.claude,
        configured: resolveCodingDraft("claude", catalog, config).configured,
      },
      "eliza-code": {
        ...prev["eliza-code"],
        configured: resolveCodingDraft("eliza-code", catalog, config)
          .configured,
      },
    }));
  }, []);

  const waitForRuntimeRunning = useCallback(
    async (previousStartedAt: number | null) => {
      let sawNotRunning = false;
      const isRunning = async (): Promise<boolean> => {
        try {
          const status = await client.getStatus();
          if (status.state !== "running") {
            sawNotRunning = true;
            return false;
          }
          return previousStartedAt !== null
            ? typeof status.startedAt === "number" &&
                status.startedAt !== previousStartedAt
            : sawNotRunning;
        } catch {
          // error-policy:J4 status is expected to fail while the agent is down
          // mid-restart; "unreachable" is the designed not-yet-running signal
          // the poll loop keeps waiting on.
          sawNotRunning = true;
          return false;
        }
      };
      const startedAt = Date.now();
      for (;;) {
        if (disposedRef.current) return;
        if (await isRunning()) return;
        if (Date.now() - startedAt >= RESTART_MAX_WAIT_MS) {
          throw new Error(
            "Settings were saved, but the replacement agent has not reported ready yet. Check runtime status before retrying.",
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, RESTART_POLL_INTERVAL_MS),
        );
      }
    },
    [],
  );

  const scheduleIdle = useCallback((group: "small" | "large" | "coding") => {
    setTimeout(() => {
      if (disposedRef.current) return;
      setSaveStates((prev) =>
        prev[group].phase === "saved"
          ? { ...prev, [group]: { phase: "idle" } }
          : prev,
      );
    }, SAVED_STATE_TTL_MS);
  }, []);

  const performSave = useCallback(
    async (
      group: "small" | "large" | "coding",
      request: ModelsConfigWriteRequest,
    ) => {
      setSaveState(group, { phase: "saving" });
      try {
        let previousStartedAt: number | null = null;
        if (group !== "coding") {
          try {
            const before = await client.getStatus();
            previousStartedAt =
              typeof before.startedAt === "number" ? before.startedAt : null;
          } catch {
            // error-policy:J4 an unavailable status leaves the old runtime
            // identity unknown; saving still proceeds, and restart confirmation
            // requires the existing post-save not-running-to-running transition.
            previousStartedAt = null;
          }
        }
        const result = await client.updateModelsConfig(request);
        if (disposedRef.current) return;
        if (result.kind === "invalid") {
          setSaveState(group, {
            phase: "error",
            message: result.error,
            ...(result.supported !== undefined
              ? { supported: result.supported }
              : {}),
          });
          return;
        }
        if (result.kind === "busy") {
          setSaveState(group, {
            phase: "error",
            message: `${result.error} (operation ${result.activeOperationId})`,
          });
          return;
        }
        if (result.restart) {
          setSaveState(group, {
            phase: "restarting",
            ...(result.operationId !== undefined
              ? { operationId: result.operationId }
              : {}),
          });
          await waitForRuntimeRunning(previousStartedAt);
          if (disposedRef.current) return;
        }
        await refreshConfig();
        if (disposedRef.current) return;
        setSaveState(group, {
          phase: "saved",
          ...(result.conflictingServiceEnvKeys !== undefined
            ? { conflictKeys: result.conflictingServiceEnvKeys }
            : {}),
        });
        scheduleIdle(group);
      } catch (err) {
        // error-policy:J4 transport/server failure renders the group's
        // designed inline error state; nothing is swallowed.
        if (disposedRef.current) return;
        setSaveState(group, { phase: "error", message: failureMessage(err) });
      }
    },
    [refreshConfig, scheduleIdle, setSaveState, waitForRuntimeRunning],
  );

  const buildChatGroup = useCallback(
    (target: ChatTarget, data: ReadyData): ModelConfigChatGroup => {
      const draft = chatDrafts[target];
      // An unambiguous active intelligence selection pins the provider: models
      // from an inactive provider would persist keys the runtime never reads.
      const providerLocked =
        activeChatProvider !== undefined &&
        CHAT_PROVIDERS.some((choice) => choice.id === activeChatProvider);
      const effectiveProvider = providerLocked
        ? (activeChatProvider as string)
        : draft.provider;
      const providerOptions = CHAT_PROVIDERS.filter(
        (choice) =>
          (!providerLocked || choice.id === activeChatProvider) &&
          entriesForRole(data.catalog, choice.id, target).length > 0,
      ).map((choice) => ({ value: choice.id, label: choice.label }));
      const modelOptions = effectiveProvider
        ? entriesForRole(data.catalog, effectiveProvider, target)
        : [];
      const selectedEntry =
        modelOptions.find((entry) => entry.id === draft.model) ?? null;
      const effortOptions = selectedEntry ? selectedEntry.efforts : [];
      const save = saveStates[target];

      const setProvider = (provider: string) => {
        setChatDrafts((prev) => ({
          ...prev,
          [target]: { ...prev[target], provider, model: "", effort: "" },
        }));
        setSaveState(target, { phase: "idle" });
      };
      const setModel = (model: string) => {
        setChatDrafts((prev) => {
          const entry = entriesForRole(
            data.catalog,
            providerLocked
              ? (activeChatProvider as string)
              : prev[target].provider,
            target,
          ).find((item) => item.id === model);
          const keepEffort =
            entry?.efforts.includes(prev[target].effort) ?? false;
          return {
            ...prev,
            [target]: {
              ...prev[target],
              model,
              effort: keepEffort
                ? prev[target].effort
                : (entry?.defaultEffort ?? ""),
            },
          };
        });
        setSaveState(target, { phase: "idle" });
      };
      const setEffort = (effort: string) => {
        setChatDrafts((prev) => ({
          ...prev,
          [target]: { ...prev[target], effort },
        }));
        setSaveState(target, { phase: "idle" });
      };
      const requestSave = () => {
        if (!draft.model) return;
        if (save.phase === "saving" || save.phase === "restarting") return;
        setSaveState(target, { phase: "confirm" });
      };
      const confirmSave = () => {
        if (save.phase !== "confirm") return;
        void performSave(target, {
          target,
          provider: effectiveProvider,
          model: draft.model,
          ...(draft.effort ? { effort: draft.effort } : {}),
        });
      };
      const cancelSave = () => {
        if (save.phase !== "confirm") return;
        setSaveState(target, { phase: "idle" });
      };

      return {
        target,
        providerOptions,
        provider: effectiveProvider,
        providerLocked,
        modelOptions,
        model: draft.model,
        effortOptions,
        effort: draft.effort,
        selectedEntry,
        configured: draft.configured,
        sharedEffortKnob: hasSharedEffortKnob(effectiveProvider),
        save,
        setProvider,
        setModel,
        setEffort,
        requestSave,
        confirmSave,
        cancelSave,
      };
    },
    [activeChatProvider, chatDrafts, performSave, saveStates, setSaveState],
  );

  const buildCodingGroup = useCallback(
    (data: ReadyData): ModelConfigCodingGroup => {
      const draft = codingDrafts[codingBackend];
      const freeFormModel = codingBackend === "eliza-code";
      const modelOptions = codingModelOptions(
        codingBackend,
        data.catalog,
        draft.configured?.model ?? "",
      );
      const selectedEntry =
        modelOptions.find((entry) => entry.id === draft.model) ?? null;
      const effortOptions = selectedEntry
        ? codingEffortOptions(codingBackend, selectedEntry)
        : [];
      const save = saveStates.coding;

      const setBackend = (backend: ModelsConfigCodingBackend) => {
        setCodingBackend(backend);
        setMakeDefault(backend === persistedDefaultBackend);
        setSaveState("coding", { phase: "idle" });
      };
      const setModel = (model: string) => {
        setCodingDrafts((prev) => {
          const entry = codingModelOptions(
            codingBackend,
            data.catalog,
            prev[codingBackend].configured?.model ?? "",
          ).find((item) => item.id === model);
          const nextEfforts = entry
            ? codingEffortOptions(codingBackend, entry)
            : [];
          const keepEffort = nextEfforts.includes(prev[codingBackend].effort);
          const defaultEffort =
            entry?.defaultEffort !== undefined &&
            nextEfforts.includes(entry.defaultEffort)
              ? entry.defaultEffort
              : "";
          return {
            ...prev,
            [codingBackend]: {
              ...prev[codingBackend],
              model,
              effort: keepEffort ? prev[codingBackend].effort : defaultEffort,
            },
          };
        });
        setSaveState("coding", { phase: "idle" });
      };
      const setEffort = (effort: string) => {
        setCodingDrafts((prev) => ({
          ...prev,
          [codingBackend]: { ...prev[codingBackend], effort },
        }));
        setSaveState("coding", { phase: "idle" });
      };
      const saveNow = () => {
        if (!draft.model.trim()) return;
        if (save.phase === "saving" || save.phase === "restarting") return;
        void performSave("coding", {
          target: "coding",
          backend: codingBackend,
          model: draft.model.trim(),
          ...(draft.effort && CODING_EFFORT_KEYS[codingBackend]
            ? { effort: draft.effort }
            : {}),
          ...(makeDefault ? { defaultBackend: codingBackend } : {}),
        });
      };

      return {
        backend: codingBackend,
        backendOptions: CODING_BACKEND_OPTIONS,
        persistedDefaultBackend,
        makeDefault,
        freeFormModel,
        modelOptions,
        model: draft.model,
        effortOptions,
        effort: draft.effort,
        selectedEntry,
        configured: draft.configured,
        save,
        setBackend,
        setModel,
        setEffort,
        setMakeDefault,
        saveNow,
      };
    },
    [
      codingBackend,
      codingDrafts,
      makeDefault,
      performSave,
      persistedDefaultBackend,
      saveStates.coding,
      setSaveState,
    ],
  );

  if (load.phase === "loading") return { phase: "loading" };
  if (load.phase === "error") {
    return {
      phase: "error",
      message: load.message,
      retry: () => void loadAll(),
    };
  }
  if (catalogIsEmpty(load.data.catalog)) {
    return { phase: "empty", retry: () => void loadAll() };
  }
  return {
    phase: "ready",
    small: buildChatGroup("small", load.data),
    large: buildChatGroup("large", load.data),
    coding: buildCodingGroup(load.data),
  };
}
