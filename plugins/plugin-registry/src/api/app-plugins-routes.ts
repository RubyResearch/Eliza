/**
 * Compatibility routes that expose plugin configuration through the app-core
 * HTTP surface while keeping every persisted enablement model synchronized.
 */

import fs from "node:fs";
import type http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdvancedCapabilityPluginId,
  applyPluginRuntimeMutation,
  CONNECTOR_ENV_MAP,
  discoverPluginsFromManifest,
  findPrimaryEnvKey,
  isAdvancedCapabilityPluginId,
  isBlockedEnvKey,
  isVaultRef,
  loadElizaConfig,
  type PluginRuntimeApplyResult,
  parseVaultRef,
  readBundledPluginPackageMetadata,
  resolveAdvancedCapabilitiesEnabled,
  saveElizaConfig,
} from "@elizaos/agent";
import {
  ensureCompatSensitiveRouteAuthorized,
  ensureRouteAuthorized,
} from "@elizaos/app-core/api/auth";
import {
  type CompatRuntimeState,
  readCompatJsonBody,
  scheduleCompatRuntimeRestart,
} from "@elizaos/app-core/api/compat-route-shared";
import {
  sendJsonError as sendJsonErrorResponse,
  sendJson as sendJsonResponse,
} from "@elizaos/app-core/api/response";
import {
  _resetSharedVaultForTesting,
  mirrorPluginSensitiveToVault,
  sharedVault,
} from "@elizaos/app-core/services/vault-mirror";
import {
  type AgentRuntime,
  logger,
  resolveNativeRuntimeFeatureFromPluginName,
} from "@elizaos/core";
import {
  type ConfigField,
  loadRegistry,
  type RegistryEntry,
} from "@elizaos/registry/first-party";
import { asRecord, CONNECTOR_PLUGINS } from "@elizaos/shared";
import { VaultMissError } from "@elizaos/vault";
import {
  bridgePluginParamsToRuntime,
  clearPluginParamValues,
  collectAgentScopedPluginParamValues,
} from "./bridge-plugin-settings.ts";
import { devCloudPluginMutationRejection } from "./dev-cloud-plugin-authority.ts";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PluginCategory =
  | "ai-provider"
  | "connector"
  | "streaming"
  | "database"
  | "app"
  | "feature";

interface ManifestPluginParameter {
  type?: string;
  description?: string;
  required?: boolean;
  optional?: boolean;
  sensitive?: boolean;
  default?: string | number | boolean;
  options?: string[];
}

interface ManifestPluginEntry {
  id: string;
  dirName?: string;
  name?: string;
  npmName?: string;
  description?: string;
  tags?: string[];
  category?: string;
  envKey?: string;
  configKeys?: string[];
  version?: string;
  pluginDeps?: string[];
  pluginParameters?: Record<string, ManifestPluginParameter>;
  configUiHints?: Record<string, Record<string, unknown>>;
  icon?: string | null;
  logoUrl?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

interface PluginManifestFile {
  plugins?: ManifestPluginEntry[];
}

const FIELD_TYPE_TO_LEGACY: Record<ConfigField["type"], string> = {
  string: "string",
  secret: "string",
  url: "string",
  "file-path": "string",
  textarea: "string",
  json: "string",
  select: "string",
  multiselect: "string",
  boolean: "boolean",
  number: "number",
};

function pluginSubtypeToCategory(entry: RegistryEntry): string {
  if (entry.kind !== "plugin") return entry.kind;
  if (entry.subtype === "ai-provider") return "ai-provider";
  if (entry.subtype === "database") return "database";
  return "feature";
}

function connectorSubtypeToCategory(entry: RegistryEntry): string {
  if (entry.kind !== "connector") return "connector";
  if (entry.subtype === "streaming") return "streaming";
  return "connector";
}

function categoryForRegistryEntry(entry: RegistryEntry): string {
  if (entry.kind === "plugin") return pluginSubtypeToCategory(entry);
  if (entry.kind === "connector") return connectorSubtypeToCategory(entry);
  return entry.kind;
}

function envKeyForRegistryEntry(entry: RegistryEntry): string | undefined {
  if (entry.kind === "connector" && entry.auth) {
    const [first] = entry.auth.credentialKeys;
    if (first) return first;
  }
  for (const [key, field] of Object.entries(entry.config) as Array<
    [string, ConfigField]
  >) {
    if (field.required && (field.type === "secret" || field.sensitive)) {
      return key;
    }
  }
  return undefined;
}

function fieldToManifestParameter(field: ConfigField): ManifestPluginParameter {
  const param: ManifestPluginParameter = {
    type: FIELD_TYPE_TO_LEGACY[field.type],
    description: field.help ?? field.label ?? "",
    required: field.required,
    sensitive: field.sensitive ?? field.type === "secret",
  };
  if (field.default !== undefined && field.default !== null) {
    param.default = String(field.default);
  }
  if (field.options) {
    param.options = field.options.map((option) => option.value);
  }
  return param;
}

function registryEntryToManifest(entry: RegistryEntry): ManifestPluginEntry {
  const pluginParameters: Record<string, ManifestPluginParameter> = {};
  for (const [key, field] of Object.entries(entry.config)) {
    pluginParameters[key] = fieldToManifestParameter(field);
  }

  return {
    id: entry.id,
    dirName: entry.npmName?.replace(/^@[^/]+\//, ""),
    name: entry.name,
    npmName: entry.npmName,
    description: entry.description,
    tags: entry.tags,
    category: categoryForRegistryEntry(entry),
    envKey: envKeyForRegistryEntry(entry),
    configKeys: Object.keys(entry.config),
    version: entry.version,
    pluginParameters,
    icon: entry.render.icon ?? null,
    homepage: entry.resources.homepage,
    repository: entry.resources.repository,
    setupGuideUrl: entry.resources.setupGuideUrl,
  };
}

interface RuntimePluginLike {
  name?: string;
  description?: string;
}

interface CompatPluginParameter {
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}

interface CompatPluginRecord {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  envKey?: string | null;
  category?: PluginCategory;
  source?: string;
  parameters: CompatPluginParameter[];
  validationErrors: Array<{ field: string; message: string }>;
  validationWarnings?: Array<{ field?: string; message: string }>;
  npmName?: string;
  version?: string;
  isActive?: boolean;
  tags?: string[];
  configKeys?: string[];
  pluginDeps?: string[];
  configUiHints?: Record<string, unknown>;
  icon?: string | null;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  // Registry-sourced render hints. Replaces frontend lookups against
  // VISIBLE_CONNECTOR_IDS / DEFAULT_ICONS / FEATURE_SUBGROUP /
  // SUBGROUP_DISPLAY_ORDER. Optional during migration; required once the
  // frontend constants are deleted.
  iconName?: string;
  group?: string;
  groupOrder?: number;
  visible?: boolean;
}

type PluginDriftFlag =
  | "entries_vs_compat"
  | "entries_vs_allowlist"
  | "inactive_but_enabled"
  | "active_but_disabled";

interface PluginDriftDiagnostic {
  pluginId: string;
  npmName: string | null;
  category: PluginCategory;
  enabled_ui: boolean;
  enabled_allowlist: boolean | null;
  is_active: boolean;
  drift_flags: PluginDriftFlag[];
}

interface PluginDriftDiagnosticsSummary {
  total: number;
  withDrift: number;
  byFlag: Record<PluginDriftFlag, number>;
}

interface PluginDriftDiagnosticsReport {
  summary: PluginDriftDiagnosticsSummary;
  plugins: PluginDriftDiagnostic[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPABILITY_FEATURE_IDS = new Set([
  "vision",
  "browser",
  "computeruse",
  "coding-agent",
]);

const ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID: Partial<
  Record<AdvancedCapabilityPluginId, string>
> = {
  experience: "EXPERIENCE",
  personality: "CHARACTER_MANAGEMENT",
};

// Key prefixes that contain wallet private keys or other high-value secrets
// require the hardened sensitive-route auth (loopback + elevated checks).
const SENSITIVE_KEY_PREFIXES = ["SOLANA_", "ETHEREUM_", "EVM_", "WALLET_"];

const REVEALABLE_KEY_PREFIXES = [
  "OPENAI_",
  "ANTHROPIC_",
  "GOOGLE_",
  "GROQ_",
  "MISTRAL_",
  "PERPLEXITY_",
  "COHERE_",
  "TOGETHER_",
  "FIREWORKS_",
  "REPLICATE_",
  "HUGGINGFACE_",
  "ELEVENLABS_",
  "DISCORD_",
  "TELEGRAM_",
  "TWITTER_",
  "SLACK_",
  "GITHUB_",
  "REDIS_",
  "POSTGRES_",
  "DATABASE_",
  "SUPABASE_",
  "PINECONE_",
  "QDRANT_",
  "WEAVIATE_",
  "CHROMADB_",
  "AWS_",
  "AZURE_",
  "CLOUDFLARE_",
  "ELIZA_",
  "PLUGIN_",
  "XAI_",
  "DEEPSEEK_",
  "OLLAMA_",
  "FAL_",
  "LETZAI_",
  "GAIANET_",
  "LIVEPEER_",
  ...SENSITIVE_KEY_PREFIXES,
];

const DRIFT_LOG_THROTTLE_MS = 5 * 60 * 1000;
let _lastDriftWarningAt = 0;
let _lastDriftWarningFingerprint = "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-exported so existing call sites keep working. The implementations
// live in services/vault-mirror.ts so unit tests can import them
// without dragging in the @elizaos/agent runtime through this file.
export { _resetSharedVaultForTesting, mirrorPluginSensitiveToVault };

function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizePluginCategory(value: string | undefined): PluginCategory {
  switch (value) {
    case "ai-provider":
    case "connector":
    case "streaming":
    case "database":
    case "app":
      return value;
    default:
      return "feature";
  }
}

function normalizePluginId(rawName: string): string {
  const scopedPackage = rawName.match(/^@[^/]+\/(?:plugin|app)-(.+)$/);
  if (scopedPackage) {
    return scopedPackage[1] ?? rawName;
  }
  return rawName.replace(/^@[^/]+\//, "").replace(/^(plugin|app)-/, "");
}

function decodePluginPathSegment(rawSegment: string): string | null {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return null;
  }
}

function resolveCompatConfigKey(
  pluginId: string,
  npmName: string | undefined,
  pluginMap: Record<string, string>,
): string | null {
  const candidates = new Set<string>([pluginId, normalizePluginId(pluginId)]);
  if (typeof npmName === "string" && npmName.length > 0) {
    candidates.add(npmName);
    candidates.add(normalizePluginId(npmName));
  }

  for (const [configKey, packageName] of Object.entries(pluginMap)) {
    if (
      candidates.has(configKey) ||
      candidates.has(packageName) ||
      candidates.has(normalizePluginId(packageName))
    ) {
      return configKey;
    }
  }

  return null;
}

function readCompatSectionEnabled(
  section: unknown,
  configKey: string | null,
): boolean | undefined {
  if (!configKey) {
    return undefined;
  }

  const sectionRecord = asRecord(section);
  if (!sectionRecord) {
    return undefined;
  }

  const targetRecord = asRecord(sectionRecord[configKey]);
  if (!targetRecord || typeof targetRecord.enabled !== "boolean") {
    return undefined;
  }

  return targetRecord.enabled;
}

function writeCompatSectionEnabled(
  parent: Record<string, unknown>,
  sectionKey: string,
  configKey: string | null,
  enabled: boolean,
): void {
  if (!configKey) {
    return;
  }

  const section = asRecord(parent[sectionKey]) ?? {};
  const entry = asRecord(section[configKey]) ?? {};
  entry.enabled = enabled;
  section[configKey] = entry;
  parent[sectionKey] = section;
}

function syncCompatConnectorConfigValues(
  config: Record<string, unknown>,
  pluginId: string,
  npmName: string | undefined,
  values: Record<string, string>,
): void {
  const connectorKey = resolveCompatConfigKey(
    pluginId,
    npmName,
    CONNECTOR_PLUGINS,
  );
  if (!connectorKey) {
    return;
  }

  const envMap =
    CONNECTOR_ENV_MAP[connectorKey as keyof typeof CONNECTOR_ENV_MAP];
  if (!envMap) {
    return;
  }
  const typedEnvMap = envMap as Record<string, string>;

  const connectors = asRecord(config.connectors) ?? {};
  const connectorEntry = asRecord(connectors[connectorKey]) ?? {};
  const envToField = new Map<string, string>();

  for (const [field, envKey] of Object.entries(typedEnvMap)) {
    if (!envToField.has(envKey)) {
      envToField.set(envKey, field);
    }
  }

  let touched = false;
  for (const [envKey, field] of envToField.entries()) {
    if (!(envKey in values)) {
      continue;
    }

    touched = true;
    const value = values[envKey];
    if (value.trim()) {
      connectorEntry[field] = value;
    } else {
      delete connectorEntry[field];
    }
  }

  // Canonicalize Discord onto `connectors.discord.token`; keep the legacy
  // `botToken` alias cleared so the config does not drift between fields.
  if (connectorKey === "discord" && "DISCORD_API_TOKEN" in values) {
    touched = true;
    const tokenValue = values.DISCORD_API_TOKEN.trim();
    if (tokenValue) {
      connectorEntry.token = tokenValue;
    } else {
      delete connectorEntry.token;
    }
    delete connectorEntry.botToken;
  }

  if (!touched) {
    return;
  }

  connectors[connectorKey] = connectorEntry;
  config.connectors = connectors;
}

function resolvePersistedPluginEnabled(
  pluginId: string,
  category: PluginCategory,
  npmName: string | undefined,
  configEntries: Record<string, { enabled?: unknown }>,
  config: Record<string, unknown>,
): boolean | undefined {
  const pluginEnabled = readPluginEntryEnabled(
    pluginId,
    npmName,
    configEntries,
  );

  if (category === "connector") {
    const connectorEnabled = readCompatSectionEnabled(
      config.connectors,
      resolveCompatConfigKey(pluginId, npmName, CONNECTOR_PLUGINS),
    );
    return connectorEnabled ?? pluginEnabled;
  }

  return pluginEnabled;
}

export function resolveCompatPluginEnabledForList(
  active: boolean,
  persistedEnabled: boolean | undefined,
  advancedCapabilityEnabled?: boolean,
): boolean {
  return advancedCapabilityEnabled ?? persistedEnabled ?? active;
}

function shortPluginIdFromNpmName(npmName: string | null): string | null {
  if (!npmName || typeof npmName !== "string") {
    return null;
  }
  if (npmName.startsWith("@elizaos/app-")) {
    return npmName.slice("@elizaos/".length);
  }
  if (npmName.startsWith("@elizaos/plugin-")) {
    return npmName.slice("@elizaos/plugin-".length);
  }
  // First-party libraries can describe bundled features, but only plugin/app
  // packages are runtime identities; the registry id owns every other case.
  if (npmName.startsWith("@elizaos/")) {
    return null;
  }
  return normalizePluginId(npmName);
}

function canonicalPluginPackageName(
  pluginId: string,
  npmName: string | undefined,
): string {
  return shortPluginIdFromNpmName(npmName ?? null)
    ? (npmName ?? pluginId)
    : pluginId;
}

function canonicalPluginEntryId(
  pluginId: string,
  npmName: string | undefined,
): string {
  return shortPluginIdFromNpmName(npmName ?? null) ?? pluginId;
}

function readPluginEntryEnabled(
  pluginId: string,
  npmName: string | undefined,
  configEntries: Record<string, { enabled?: unknown }>,
): boolean | undefined {
  const canonicalId = canonicalPluginEntryId(pluginId, npmName);
  const canonicalEnabled = configEntries[canonicalId]?.enabled;
  if (typeof canonicalEnabled === "boolean") return canonicalEnabled;

  const compatibilityEnabled = configEntries[pluginId]?.enabled;
  return typeof compatibilityEnabled === "boolean"
    ? compatibilityEnabled
    : undefined;
}

function writePluginAllowListEnabled(
  config: ReturnType<typeof loadElizaConfig>,
  pluginId: string,
  npmName: string | undefined,
  enabled: boolean,
): void {
  config.plugins ??= {};
  config.plugins.allow ??= [];

  const shortNpmId = shortPluginIdFromNpmName(npmName ?? null);
  const canonicalPackageName = canonicalPluginPackageName(pluginId, npmName);
  const canonicalAliases = new Set(
    [canonicalPackageName, shortNpmId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  const staleAliases = new Set(
    [
      shortNpmId && pluginId !== shortNpmId ? pluginId : null,
      npmName && npmName !== canonicalPackageName ? npmName : null,
    ].filter((value): value is string => value !== null),
  );

  if (staleAliases.size > 0) {
    config.plugins.allow = config.plugins.allow.filter(
      (candidate) => !staleAliases.has(candidate),
    );
  }

  if (enabled) {
    if (
      !config.plugins.allow.some((candidate) => canonicalAliases.has(candidate))
    ) {
      config.plugins.allow.push(canonicalPackageName);
    }
    return;
  }

  config.plugins.allow = config.plugins.allow.filter(
    (candidate) => !canonicalAliases.has(candidate),
  );
}

export function analyzePluginStateDrift(
  pluginList: CompatPluginRecord[],
  configRecord: Record<string, unknown>,
  configEntries: Record<string, { enabled?: unknown }>,
  allowList: Set<string> | null,
): PluginDriftDiagnosticsReport {
  const diagnostics = pluginList.map((plugin): PluginDriftDiagnostic => {
    const pluginId = String(plugin.id);
    const category = normalizePluginCategory(plugin.category);
    const npmName =
      typeof plugin.npmName === "string" && plugin.npmName.length > 0
        ? plugin.npmName
        : null;
    const shortId = shortPluginIdFromNpmName(npmName) ?? pluginId;
    const canonicalPackageName = canonicalPluginPackageName(
      pluginId,
      npmName ?? undefined,
    );
    const uiEnabled = Boolean(plugin.enabled);
    const compatEnabled =
      category === "connector"
        ? readCompatSectionEnabled(
            configRecord.connectors,
            resolveCompatConfigKey(
              pluginId,
              npmName ?? undefined,
              CONNECTOR_PLUGINS,
            ),
          )
        : undefined;
    const entryEnabled = readPluginEntryEnabled(
      pluginId,
      npmName ?? undefined,
      configEntries,
    );
    const enabledAllowList =
      allowList === null || npmName == null
        ? null
        : allowList.has(canonicalPackageName) || allowList.has(shortId);
    const isActive = Boolean(plugin.isActive);
    const driftFlags: PluginDriftFlag[] = [];

    if (
      compatEnabled !== undefined &&
      entryEnabled !== undefined &&
      compatEnabled !== entryEnabled
    ) {
      driftFlags.push("entries_vs_compat");
    }
    if (enabledAllowList !== null && entryEnabled !== undefined) {
      if (enabledAllowList !== entryEnabled) {
        driftFlags.push("entries_vs_allowlist");
      }
    }
    if (uiEnabled && !isActive) {
      driftFlags.push("inactive_but_enabled");
    }
    if (!uiEnabled && isActive) {
      driftFlags.push("active_but_disabled");
    }

    return {
      pluginId,
      npmName,
      category,
      enabled_ui: uiEnabled,
      enabled_allowlist: enabledAllowList,
      is_active: isActive,
      drift_flags: driftFlags,
    };
  });

  const withDrift = diagnostics.filter(
    (plugin) => plugin.drift_flags.length > 0,
  );
  const byFlag: Record<PluginDriftFlag, number> = {
    entries_vs_compat: 0,
    entries_vs_allowlist: 0,
    inactive_but_enabled: 0,
    active_but_disabled: 0,
  };
  for (const plugin of withDrift) {
    for (const flag of plugin.drift_flags) {
      byFlag[flag] += 1;
    }
  }

  return {
    summary: {
      total: diagnostics.length,
      withDrift: withDrift.length,
      byFlag,
    },
    plugins: diagnostics,
  };
}

function buildPluginDriftDiagnostics(
  runtime: AgentRuntime | null,
): PluginDriftDiagnosticsReport {
  return buildPluginDriftDiagnosticsForList(
    buildPluginListResponse(runtime).plugins,
  );
}

function buildPluginDriftDiagnosticsForList(
  pluginList: CompatPluginRecord[],
): PluginDriftDiagnosticsReport {
  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const configEntries = config.plugins?.entries ?? {};
  const allowList = Array.isArray(config.plugins?.allow)
    ? new Set(config.plugins.allow)
    : null;

  return analyzePluginStateDrift(
    pluginList,
    configRecord,
    configEntries,
    allowList,
  );
}

function maybeLogPluginStateDrift(report: PluginDriftDiagnosticsReport): void {
  if (report.summary.withDrift === 0) {
    return;
  }
  const drifted = report.plugins
    .filter((plugin) => plugin.drift_flags.length > 0)
    .map((plugin) => `${plugin.pluginId}:${plugin.drift_flags.join("+")}`)
    .sort();
  const fingerprint = drifted.join("|");
  const now = Date.now();
  if (
    fingerprint === _lastDriftWarningFingerprint &&
    now - _lastDriftWarningAt < DRIFT_LOG_THROTTLE_MS
  ) {
    return;
  }
  _lastDriftWarningAt = now;
  _lastDriftWarningFingerprint = fingerprint;
  const hasPersistentConfigDrift = report.plugins.some((plugin) =>
    plugin.drift_flags.some(
      (flag) => flag === "entries_vs_compat" || flag === "entries_vs_allowlist",
    ),
  );
  const log = hasPersistentConfigDrift ? logger.warn : logger.info;
  log(
    {
      src: "api:plugins",
      driftCount: report.summary.withDrift,
      byFlag: report.summary.byFlag,
      plugins: drifted,
    },
    "Plugin enable-state drift detected between /api/plugins and /api/plugins/core models",
  );
}

// ── Enabled-state drift reconciliation ────────────────────────────────
//
// The write path keeps plugins.entries, plugins.allow, and any connector
// compatibility section aligned. External config edits can still split those
// models, so this pass restores the Settings-owned compatibility section from
// the canonical entries state.
//
// Runs once per process on the first buildPluginListResponse() call.

let _enabledStateReconciled = false;

function reconcilePluginEnabledStates(): void {
  if (_enabledStateReconciled) return;
  _enabledStateReconciled = true;

  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const entries = (config.plugins?.entries ?? {}) as Record<
    string,
    { enabled?: unknown }
  >;

  let dirty = false;

  for (const [pluginId, entry] of Object.entries(entries)) {
    if (typeof entry.enabled !== "boolean") continue;

    // Check connector section
    const connectorKey = resolveCompatConfigKey(
      pluginId,
      undefined,
      CONNECTOR_PLUGINS,
    );
    if (connectorKey) {
      const sectionEnabled = readCompatSectionEnabled(
        configRecord.connectors,
        connectorKey,
      );
      if (sectionEnabled !== undefined && sectionEnabled !== entry.enabled) {
        writeCompatSectionEnabled(
          configRecord,
          "connectors",
          connectorKey,
          entry.enabled,
        );
        dirty = true;
      }
    }
  }

  if (dirty) {
    saveElizaConfig(config);
    logger.info("[plugins] Reconciled drifted plugin enabled states in config");
  }
}

function compatMutationRequiresRestart(
  plugin: CompatPluginRecord,
  body: Record<string, unknown>,
): boolean {
  if (typeof body.enabled === "boolean") {
    return true;
  }

  if (
    body.config !== undefined &&
    (plugin.category === "connector" || plugin.category === "streaming")
  ) {
    return true;
  }

  return false;
}

function createCompatRuntimeApplyFallback(
  reason: string,
  requiresRestart: boolean,
): PluginRuntimeApplyResult {
  return {
    mode: requiresRestart ? "restart_required" : "none",
    requiresRestart,
    restartedRuntime: false,
    loadedPackages: [],
    unloadedPackages: [],
    reloadedPackages: [],
    appliedConfigPackage: null,
    reason,
  };
}

async function applyCompatRuntimeMutation(options: {
  state: CompatRuntimeState;
  pluginId: string;
  plugin: CompatPluginRecord;
  body: Record<string, unknown>;
  previousConfig: ReturnType<typeof loadElizaConfig>;
  nextConfig: ReturnType<typeof loadElizaConfig>;
}): Promise<PluginRuntimeApplyResult> {
  const { state, pluginId, plugin, body, previousConfig, nextConfig } = options;
  const reason =
    typeof body.enabled === "boolean"
      ? `Plugin toggle: ${pluginId}`
      : `Plugin config updated: ${pluginId}`;
  const requiresRestartFallback = compatMutationRequiresRestart(plugin, body);

  if (!state.current) {
    return createCompatRuntimeApplyFallback(reason, requiresRestartFallback);
  }

  try {
    return await applyPluginRuntimeMutation({
      runtime: state.current,
      previousConfig,
      nextConfig,
      changedPluginId: pluginId,
      changedPluginPackage: canonicalPluginPackageName(
        pluginId,
        plugin.npmName,
      ),
      config:
        body.config &&
        typeof body.config === "object" &&
        !Array.isArray(body.config)
          ? (body.config as Record<string, string>)
          : undefined,
      expectRuntimeGraphChange: typeof body.enabled === "boolean",
      reason,
    });
  } catch (error) {
    logger.warn(
      `[api/plugins] Live runtime apply failed for "${pluginId}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return createCompatRuntimeApplyFallback(reason, true);
  }
}

function titleCasePluginId(id: string): string {
  return id
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferSensitiveConfigKey(key: string): boolean {
  return /(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_SIGNING_|ENCRYPTION_)/i.test(
    key,
  );
}

/**
 * Reads a declared plugin param through the live runtime's `getSetting`
 * surface. Connectors resolve credentials via `runtime.getSetting()`, which
 * deliberately never falls through to `process.env`, so when this reader
 * exists it is the only source the catalog may report from — a live miss
 * stays a miss (#18713). Returning `undefined` here means "no live runtime";
 * only then may the catalog fall back to env/saved config.
 */
function createRuntimeSettingReader(
  runtime: AgentRuntime | null,
): ((key: string) => string | undefined) | undefined {
  if (!runtime || typeof runtime.getSetting !== "function") {
    return undefined;
  }
  return (key: string) => {
    const value = runtime.getSetting(key);
    return typeof value === "string" && value.trim() ? value : undefined;
  };
}

/**
 * Consults the plugin's registered runtime service health probe when one
 * exists. Returns `null` when the plugin exposes no health surface (loaded
 * state stays authoritative), otherwise the probe result. Discord's init
 * catches login failures, so a loaded plugin name alone cannot prove a live
 * gateway (#18713).
 */
function resolvePluginServiceHealth(
  runtime: AgentRuntime | null,
  pluginId: string,
): boolean | null {
  if (!runtime || typeof runtime.getService !== "function") {
    return null;
  }
  const service = runtime.getService(pluginId) as {
    isHealthy?: () => boolean;
  } | null;
  if (!service || typeof service.isHealthy !== "function") {
    return null;
  }
  return Boolean(service.isHealthy());
}

function buildPluginParamDefs(
  parameters: Record<string, ManifestPluginParameter> | undefined,
  savedValues?: Record<string, string>,
  getRuntimeSetting?: (key: string) => string | undefined,
): Array<{
  key: string;
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
  currentValue: string | null;
  isSet: boolean;
}> {
  if (!parameters) {
    return [];
  }

  // Drop generic fallback model keys (SMALL_MODEL, LARGE_MODEL, IMAGE_MODEL,
  // EMBEDDING_MODEL) when a provider-prefixed equivalent (e.g.
  // GOOGLE_SMALL_MODEL) is also declared. Plugins like @elizaos/plugin-google-genai
  // declare both — surfacing both creates confusing duplicate fields in the UI.
  const allKeys = Object.keys(parameters);
  const GENERIC_FALLBACK_SUFFIXES = [
    "SMALL_MODEL",
    "LARGE_MODEL",
    "IMAGE_MODEL",
    "EMBEDDING_MODEL",
  ];
  const filteredEntries = Object.entries(parameters).filter(([key]) => {
    if (!GENERIC_FALLBACK_SUFFIXES.includes(key)) return true;
    return !allKeys.some((other) => other !== key && other.endsWith(`_${key}`));
  });

  return filteredEntries.map(([key, definition]) => {
    // A live runtime's getSetting() is authoritative: connectors resolve
    // credentials only through it and it never falls through to host env, so
    // a live miss must not be papered over by stale process.env or saved
    // config (#18713). Env/saved fallbacks serve only runtime-null builds.
    const envValue = process.env[key]?.trim() || undefined;
    const savedValue = savedValues?.[key]?.trim() || undefined;
    const effectiveValue = getRuntimeSetting
      ? getRuntimeSetting(key)
      : (envValue ?? savedValue);
    const isSet = Boolean(effectiveValue);
    const sensitive =
      typeof definition.sensitive === "boolean"
        ? definition.sensitive
        : inferSensitiveConfigKey(key);
    const currentValue =
      !isSet || !effectiveValue
        ? null
        : sensitive
          ? maskValue(effectiveValue)
          : effectiveValue;

    return {
      key,
      type: definition.type ?? "string",
      description: definition.description ?? "",
      required:
        definition.required === true ||
        (definition.optional === false && definition.required !== false),
      sensitive,
      default:
        definition.default === undefined
          ? undefined
          : String(definition.default),
      options: Array.isArray(definition.options)
        ? definition.options
        : undefined,
      currentValue,
      isSet,
    };
  });
}

function findNearestFile(
  startDir: string,
  fileName: string,
  maxDepth = 12,
): string | null {
  let dir = path.resolve(startDir);

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return null;
}

export function resolvePluginManifestPath(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    moduleDir,
    path.dirname(process.execPath),
    path.join(path.dirname(process.execPath), "..", "Resources", "app"),
  ];

  for (const candidate of candidates) {
    const manifestPath = findNearestFile(candidate, "plugins.json");
    if (manifestPath) {
      return manifestPath;
    }
  }

  return null;
}

function resolveInstalledPackageVersion(
  packageName: string | undefined,
): string | null {
  if (!packageName) {
    return null;
  }

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function resolveLoadedPluginNames(runtime: AgentRuntime | null): Set<string> {
  const loadedNames = new Set<string>();

  for (const plugin of runtime?.plugins ?? []) {
    const name = (plugin as RuntimePluginLike).name;
    if (typeof name === "string" && name.length > 0) {
      loadedNames.add(name);
    }
  }

  return loadedNames;
}

function isPluginLoaded(
  pluginId: string,
  npmName: string | undefined,
  loadedNames: Set<string>,
): boolean {
  const expectedNames = new Set<string>([
    pluginId,
    `plugin-${pluginId}`,
    `app-${pluginId}`,
    npmName ?? "",
  ]);

  for (const loadedName of loadedNames) {
    // Native runtime features do not establish npm plugin ownership.
    if (npmName && resolveNativeRuntimeFeatureFromPluginName(loadedName))
      continue;
    if (expectedNames.has(loadedName)) {
      return true;
    }
    if (
      loadedName.endsWith(`/plugin-${pluginId}`) ||
      loadedName.endsWith(`/app-${pluginId}`)
    ) {
      return true;
    }
  }

  return false;
}

export function resolveAdvancedCapabilityCompatStatus(
  pluginId: string,
  config: ReturnType<typeof loadElizaConfig>,
  runtime: Pick<AgentRuntime, "getService"> | null,
): { enabled: boolean; isActive: boolean } | null {
  if (!isAdvancedCapabilityPluginId(pluginId)) {
    return null;
  }

  const enabled = resolveAdvancedCapabilitiesEnabled(config);
  if (!enabled) {
    return { enabled: false, isActive: false };
  }

  const serviceType = ADVANCED_CAPABILITY_SERVICE_BY_PLUGIN_ID[pluginId];
  return {
    enabled: true,
    isActive: serviceType
      ? Boolean(runtime?.getService(serviceType))
      : Boolean(runtime),
  };
}

export function buildPluginListResponse(runtime: AgentRuntime | null): {
  plugins: CompatPluginRecord[];
} {
  reconcilePluginEnabledStates();
  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  const loadedNames = resolveLoadedPluginNames(runtime);
  // Primary source: registry entries. Workspace plugin discovery fills gaps
  // for local first-party plugin packages that have not been registered yet.
  const registry = loadRegistry();
  const manifestRoot = resolvePluginManifestPath()
    ? path.dirname(resolvePluginManifestPath() ?? "")
    : process.cwd();
  const manifest: PluginManifestFile = {
    plugins: registry.all.map(registryEntryToManifest),
  };

  const configEntries = config.plugins?.entries ?? {};
  const installEntries = config.plugins?.installs ?? {};
  const readRuntimeSetting = createRuntimeSettingReader(runtime);
  const plugins = new Map<string, CompatPluginRecord>();

  for (const entry of manifest.plugins ?? []) {
    const pluginId = normalizePluginId(entry.id);
    const category = normalizePluginCategory(entry.category);
    const bundledMeta =
      entry.dirName && manifestRoot
        ? readBundledPluginPackageMetadata(
            manifestRoot,
            entry.dirName,
            entry.npmName,
          )
        : undefined;
    const configKeys =
      Array.isArray(entry.configKeys) && entry.configKeys.length > 0
        ? entry.configKeys
        : (bundledMeta?.configKeys ?? []);
    const envKey = entry.envKey ?? findPrimaryEnvKey(configKeys);
    const paramDefinitions =
      entry.pluginParameters ?? bundledMeta?.pluginParameters;
    const savedParamValues = paramDefinitions
      ? collectAgentScopedPluginParamValues(
          Object.keys(paramDefinitions).map((key) => ({ key })),
          {
            entryConfig: asRecord(asRecord(configEntries[pluginId])?.config),
            configEnv: asRecord(config.env),
          },
        )
      : undefined;
    const parameters = buildPluginParamDefs(
      paramDefinitions,
      savedParamValues,
      readRuntimeSetting,
    );
    const advancedCapabilityStatus = resolveAdvancedCapabilityCompatStatus(
      pluginId,
      config,
      runtime,
    );
    const active =
      advancedCapabilityStatus?.isActive ??
      isPluginLoaded(pluginId, entry.npmName, loadedNames);
    const persistedEnabled = resolvePersistedPluginEnabled(
      pluginId,
      category,
      entry.npmName,
      configEntries,
      configRecord,
    );
    const enabled = resolveCompatPluginEnabledForList(
      active,
      persistedEnabled,
      advancedCapabilityStatus?.enabled,
    );
    const validationErrors = parameters
      .filter((parameter) => parameter.required && !parameter.isSet)
      .map((parameter) => ({
        field: parameter.key,
        message: "Required value is not configured.",
      }));

    const registryEntry = registry.byId.get(pluginId);
    plugins.set(pluginId, {
      id: pluginId,
      name: entry.name ?? titleCasePluginId(pluginId),
      description: entry.description ?? bundledMeta?.description ?? "",
      tags: entry.tags ?? [],
      enabled,
      configured: validationErrors.length === 0,
      envKey,
      category,
      source: "bundled",
      configKeys,
      parameters,
      validationErrors,
      validationWarnings: [],
      npmName: entry.npmName,
      version:
        resolveInstalledPackageVersion(entry.npmName) ??
        entry.version ??
        undefined,
      pluginDeps: entry.pluginDeps,
      isActive: active,
      configUiHints: entry.configUiHints ?? bundledMeta?.configUiHints,
      icon: entry.logoUrl ?? bundledMeta?.icon ?? null,
      homepage: entry.homepage ?? bundledMeta?.homepage,
      repository: entry.repository ?? bundledMeta?.repository,
      setupGuideUrl: entry.setupGuideUrl,
      iconName: registryEntry?.render.icon,
      group: registryEntry?.render.group,
      groupOrder: registryEntry?.render.groupOrder,
      visible: registryEntry?.render.visible ?? true,
    });
  }

  for (const entry of discoverPluginsFromManifest()) {
    const pluginId = normalizePluginId(entry.id);
    const category = normalizePluginCategory(entry.category);
    if (category === "app" || plugins.has(pluginId)) {
      continue;
    }

    const active = isPluginLoaded(pluginId, entry.npmName, loadedNames);
    const persistedEnabled = resolvePersistedPluginEnabled(
      pluginId,
      category,
      entry.npmName,
      configEntries,
      configRecord,
    );

    plugins.set(pluginId, {
      id: pluginId,
      name: entry.name,
      description: entry.description,
      tags: entry.tags,
      enabled: resolveCompatPluginEnabledForList(active, persistedEnabled),
      configured: entry.configured,
      envKey: entry.envKey,
      category,
      source: entry.source,
      configKeys: entry.configKeys,
      parameters: entry.parameters,
      validationErrors: entry.validationErrors,
      validationWarnings: entry.validationWarnings,
      npmName: entry.npmName,
      version:
        resolveInstalledPackageVersion(entry.npmName) ??
        entry.version ??
        undefined,
      pluginDeps: entry.pluginDeps,
      isActive: active,
      configUiHints: entry.configUiHints,
      icon: entry.icon ?? null,
      homepage: entry.homepage,
      repository: entry.repository,
      setupGuideUrl: entry.setupGuideUrl,
      visible: true,
    });
  }

  for (const plugin of runtime?.plugins ?? []) {
    const pluginName =
      typeof (plugin as RuntimePluginLike).name === "string"
        ? (plugin as RuntimePluginLike).name
        : "";
    if (!pluginName) {
      continue;
    }

    const pluginId = normalizePluginId(pluginName);
    const existing = plugins.get(pluginId);
    if (existing) {
      if (
        existing.npmName &&
        resolveNativeRuntimeFeatureFromPluginName(pluginName)
      )
        continue;
      existing.isActive = true;
      const persistedEnabled = readPluginEntryEnabled(
        pluginId,
        existing.npmName ?? pluginName,
        configEntries,
      );
      if (existing.enabled !== true && persistedEnabled === undefined) {
        existing.enabled = true;
      }
      if (!existing.version) {
        existing.version =
          resolveInstalledPackageVersion(pluginName) ?? undefined;
      }
      continue;
    }

    plugins.set(pluginId, {
      id: pluginId,
      name: titleCasePluginId(pluginId),
      description:
        (plugin as RuntimePluginLike).description ??
        "Loaded runtime plugin discovered without manifest metadata.",
      tags: [],
      enabled:
        readPluginEntryEnabled(pluginId, pluginName, configEntries) ?? true,
      configured: true,
      envKey: null,
      category: "feature",
      source: "bundled",
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: pluginName,
      version: resolveInstalledPackageVersion(pluginName) ?? undefined,
      isActive: true,
      icon: null,
    });
  }

  for (const [pluginName, installRecord] of Object.entries(installEntries)) {
    const pluginId = normalizePluginId(pluginName);
    if (plugins.has(pluginId)) {
      continue;
    }

    plugins.set(pluginId, {
      id: pluginId,
      name: titleCasePluginId(pluginId),
      description: "Installed store plugin.",
      tags: [],
      enabled:
        typeof configEntries[pluginId]?.enabled === "boolean"
          ? Boolean(configEntries[pluginId]?.enabled)
          : false,
      configured: true,
      envKey: null,
      category: "feature",
      source: "store",
      parameters: [],
      validationErrors: [],
      validationWarnings: [],
      npmName: pluginName,
      version:
        typeof installRecord.version === "string"
          ? installRecord.version
          : (resolveInstalledPackageVersion(pluginName) ?? undefined),
      isActive: isPluginLoaded(pluginId, pluginName, loadedNames),
      icon: null,
    });
  }

  // Health gate: a loaded plugin name proves module load, not a live
  // connection. When the plugin's registered service exposes `isHealthy()`
  // (Discord does — its init catches login failures), an unhealthy probe
  // demotes the catalog row to inactive so an invalid or unreachable gateway
  // never reports as active (#18713).
  for (const plugin of plugins.values()) {
    if (!plugin.isActive) {
      continue;
    }
    if (resolvePluginServiceHealth(runtime, plugin.id) === false) {
      plugin.isActive = false;
      plugin.validationWarnings = [
        ...(plugin.validationWarnings ?? []),
        {
          message:
            "Service is loaded but reports unhealthy: the connection is not established. Check credentials and connectivity.",
        },
      ];
    }
  }

  const pluginList = Array.from(plugins.values()).sort((left, right) =>
    String(left.name ?? "").localeCompare(String(right.name ?? "")),
  );
  return { plugins: pluginList };
}

function validateCompatPluginConfig(
  plugin: CompatPluginRecord,
  config: Record<string, unknown>,
): {
  errors: Array<{ field: string; message: string }>;
  values: Record<string, string>;
} {
  const paramMap = new Map(
    plugin.parameters.map((parameter) => [parameter.key, parameter]),
  );
  const errors: Array<{ field: string; message: string }> = [];
  const values: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(config)) {
    const parameter = paramMap.get(key);
    if (!parameter) {
      errors.push({
        field: key,
        message: `${key} is not a declared config key for this plugin`,
      });
      continue;
    }

    if (typeof rawValue !== "string") {
      errors.push({
        field: key,
        message: "Plugin config values must be strings.",
      });
      continue;
    }

    const trimmed = rawValue.trim();
    if (parameter.required && trimmed.length === 0) {
      errors.push({
        field: key,
        message: "Required value is not configured.",
      });
      continue;
    }

    values[key] = rawValue;
  }

  return { errors, values };
}

export function persistCompatPluginMutation(
  pluginId: string,
  body: Record<string, unknown>,
  plugin: CompatPluginRecord,
): {
  status: number;
  payload: Record<string, unknown>;
} {
  const authorityRejection = devCloudPluginMutationRejection(
    plugin.parameters ?? [],
    body,
  );
  if (authorityRejection) {
    return {
      status: 409,
      payload: { ok: false, error: authorityRejection },
    };
  }

  const config = loadElizaConfig();
  const configRecord = config as Record<string, unknown>;
  config.plugins ??= {};
  config.plugins.entries ??= {};
  const canonicalEntryId = canonicalPluginEntryId(pluginId, plugin.npmName);
  const npmDerivedEntryId = plugin.npmName
    ? normalizePluginId(plugin.npmName)
    : null;
  const compatibilityEntry = config.plugins.entries[pluginId] as
    | Record<string, unknown>
    | undefined;
  const npmDerivedEntry = npmDerivedEntryId
    ? (config.plugins.entries[npmDerivedEntryId] as
        | Record<string, unknown>
        | undefined)
    : undefined;
  const canonicalEntry = config.plugins.entries[canonicalEntryId] as
    | Record<string, unknown>
    | undefined;
  const allowAliases = new Set(
    [
      pluginId,
      plugin.npmName,
      npmDerivedEntryId,
      canonicalPluginPackageName(pluginId, plugin.npmName),
    ].filter((value): value is string => Boolean(value)),
  );
  const hadAllowList = Array.isArray(config.plugins.allow);
  const wasAllowed = (config.plugins.allow ?? []).some((candidate) =>
    allowAliases.has(candidate),
  );
  const pluginEntry = {
    ...(compatibilityEntry ?? {}),
    ...(npmDerivedEntry ?? {}),
    ...(canonicalEntry ?? {}),
  };
  config.plugins.entries[canonicalEntryId] = pluginEntry;
  for (const alias of new Set([pluginId, npmDerivedEntryId])) {
    if (alias && alias !== canonicalEntryId) {
      delete config.plugins.entries[alias];
    }
  }

  const persistedEnabled =
    typeof body.enabled === "boolean"
      ? body.enabled
      : typeof pluginEntry.enabled === "boolean"
        ? pluginEntry.enabled
        : undefined;
  if (persistedEnabled !== undefined || hadAllowList) {
    writePluginAllowListEnabled(
      config,
      pluginId,
      plugin.npmName,
      persistedEnabled ?? wasAllowed,
    );
  }

  if (typeof body.enabled === "boolean") {
    pluginEntry.enabled = body.enabled;

    if (CAPABILITY_FEATURE_IDS.has(pluginId)) {
      config.features ??= {};
      config.features[pluginId] = body.enabled;
    }

    if (plugin.category === "connector") {
      writeCompatSectionEnabled(
        configRecord,
        "connectors",
        resolveCompatConfigKey(pluginId, plugin.npmName, CONNECTOR_PLUGINS),
        body.enabled,
      );
    }
  }

  if (body.config !== undefined) {
    if (
      !body.config ||
      typeof body.config !== "object" ||
      Array.isArray(body.config)
    ) {
      return {
        status: 400,
        payload: { ok: false, error: "Plugin config must be a JSON object." },
      };
    }

    const configObject = body.config as Record<string, unknown>;
    const { errors, values } = validateCompatPluginConfig(plugin, configObject);
    if (errors.length > 0) {
      return {
        status: 422,
        payload: { ok: false, plugin, validationErrors: errors },
      };
    }

    const nextConfig =
      pluginEntry.config &&
      typeof pluginEntry.config === "object" &&
      !Array.isArray(pluginEntry.config)
        ? { ...(pluginEntry.config as Record<string, unknown>) }
        : {};

    config.env ??= {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim()) {
        config.env[key] = value;
        nextConfig[key] = value;
      } else {
        delete config.env[key];
        delete nextConfig[key];
      }
    }

    pluginEntry.config = nextConfig;
    if (plugin.category === "connector") {
      syncCompatConnectorConfigValues(
        configRecord,
        pluginId,
        plugin.npmName,
        values,
      );
    }

    saveElizaConfig(config);

    for (const [key, value] of Object.entries(values)) {
      try {
        if (value.trim()) {
          process.env[key] = value;
        } else {
          delete process.env[key];
        }
      } catch {
        // process.env may be read-only in sandboxed or frozen environments.
        // Config is already persisted to disk above, so this is non-fatal.
      }
    }
  } else {
    saveElizaConfig(config);
  }

  const refreshed = buildPluginListResponse(null).plugins.find(
    (candidate) => candidate.id === pluginId,
  );

  return {
    status: 200,
    payload: {
      ok: true,
      plugin: refreshed ?? plugin,
    },
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Plugin management routes.
 *
 * Contract note:
 * - `/api/plugins` is the Settings/UI model.
 * - `/api/plugins/core` is the optional-core allow-list model.
 * - These can drift; use `/api/plugins/diagnostics` to inspect mismatches.
 *
 * - `GET  /api/plugins`             — returns filtered plugin list
 * - `GET  /api/plugins/diagnostics` — returns drift diagnostics
 * - `PUT  /api/plugins/:id`         — updates plugin config, writes env vars
 * - `POST /api/plugins/:id/test`    — tests plugin connectivity
 * - `POST /api/plugins/:id/reveal`  — reveals plugin env var value
 */
export async function handlePluginsCompatRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (!url.pathname.startsWith("/api/plugins")) {
    return false;
  }

  if (method === "GET" && url.pathname === "/api/plugins") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }

    const pluginResponse = buildPluginListResponse(state.current);
    logger.debug(
      `[api/plugins] source=registry total=${pluginResponse.plugins.length} runtime=${state.current ? "active" : "null"}`,
    );
    maybeLogPluginStateDrift(
      buildPluginDriftDiagnosticsForList(pluginResponse.plugins),
    );
    sendJsonResponse(res, 200, pluginResponse);
    return true;
  }

  if (method === "GET" && url.pathname === "/api/plugins/diagnostics") {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }
    const diagnostics = buildPluginDriftDiagnostics(state.current);
    maybeLogPluginStateDrift(diagnostics);
    sendJsonResponse(res, 200, diagnostics);
    return true;
  }

  if (method === "PUT" && url.pathname.startsWith("/api/plugins/")) {
    if (!(await ensureRouteAuthorized(req, res, state))) {
      return true;
    }

    const body = await readCompatJsonBody(req, res);
    if (body == null) {
      return true;
    }

    const decodedPluginId = decodePluginPathSegment(
      url.pathname.slice("/api/plugins/".length),
    );
    if (decodedPluginId === null) {
      sendJsonErrorResponse(res, 400, "Invalid plugin path");
      return true;
    }

    const pluginId = normalizePluginId(decodedPluginId);
    const plugin = buildPluginListResponse(state.current).plugins.find(
      (candidate) => candidate.id === pluginId,
    );

    if (!plugin) {
      sendJsonErrorResponse(res, 404, `Plugin "${pluginId}" not found`);
      return true;
    }

    const previousConfig = structuredClone(loadElizaConfig());
    const result = persistCompatPluginMutation(pluginId, body, plugin);
    if (result.status === 200) {
      const nextConfig = loadElizaConfig();
      // Fold agent-scoped config into runtime.getSetting before hot reload —
      // catalog isSet reads env, connectors read getSetting (#18713).
      if (
        body.config &&
        typeof body.config === "object" &&
        !Array.isArray(body.config)
      ) {
        const bridgedValues: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(
          body.config as Record<string, unknown>,
        )) {
          if (typeof value !== "string") continue;
          if (isBlockedEnvKey(key)) continue;
          bridgedValues[key] = value.trim() ? value : undefined;
        }
        bridgePluginParamsToRuntime(
          state.current,
          plugin.parameters ?? [],
          bridgedValues,
          { isBlockedKey: isBlockedEnvKey },
        );
      } else if (typeof body.enabled === "boolean") {
        if (body.enabled) {
          const entry = asRecord(nextConfig.plugins?.entries?.[pluginId]);
          const agentScoped = collectAgentScopedPluginParamValues(
            plugin.parameters ?? [],
            {
              entryConfig: asRecord(entry?.config),
              configEnv: asRecord(nextConfig.env),
            },
          );
          bridgePluginParamsToRuntime(
            state.current,
            plugin.parameters ?? [],
            agentScoped,
            { isBlockedKey: isBlockedEnvKey },
          );
        } else {
          bridgePluginParamsToRuntime(
            state.current,
            plugin.parameters ?? [],
            clearPluginParamValues(plugin.parameters ?? []),
            { isBlockedKey: isBlockedEnvKey },
          );
        }
      }
      const runtimeApply = await applyCompatRuntimeMutation({
        state,
        pluginId,
        plugin,
        body,
        previousConfig,
        nextConfig,
      });

      if (runtimeApply.requiresRestart) {
        scheduleCompatRuntimeRestart(state, runtimeApply.reason);
      }

      const refreshed = buildPluginListResponse(state.current).plugins.find(
        (candidate) => candidate.id === pluginId,
      );

      result.payload.plugin = refreshed ?? result.payload.plugin ?? plugin;
      result.payload.applied = runtimeApply.mode;
      result.payload.requiresRestart = runtimeApply.requiresRestart;
      result.payload.restartedRuntime = runtimeApply.restartedRuntime;
      result.payload.loadedPackages = runtimeApply.loadedPackages;
      result.payload.unloadedPackages = runtimeApply.unloadedPackages;
      result.payload.reloadedPackages = runtimeApply.reloadedPackages;

      // Write-through mirror to @elizaos/vault. Sensitive fields are
      // copied into the vault (encrypted at rest via the OS-keychain master
      // key). The config.env writes above also persist — vault mirrors them.
      //
      // If vault.set throws (keychain locked, ENOSPC, missing master key,
      // etc.), the save is NOT rolled back — config storage already
      // succeeded. Failed keys are surfaced as `vaultMirrorFailures` so
      // the UI can warn the user rather than silently showing "Saved".
      const mirrorResult = await mirrorPluginSensitiveToVault(plugin, body);
      if (mirrorResult.failures.length > 0) {
        result.payload.vaultMirrorFailures = mirrorResult.failures;
      }
      const diagnostics = buildPluginDriftDiagnostics(state.current);
      if (diagnostics.summary.withDrift > 0) {
        result.payload.diagnostics = diagnostics;
      }
    }
    sendJsonResponse(res, result.status, result.payload);
    return true;
  }

  const testMatch =
    method === "POST" && url.pathname.match(/^\/api\/plugins\/([^/]+)\/test$/);
  if (testMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const decodedTestPluginId = decodePluginPathSegment(testMatch[1]);
    if (decodedTestPluginId === null) {
      sendJsonErrorResponse(res, 400, "Invalid plugin path");
      return true;
    }
    const testPluginId = normalizePluginId(decodedTestPluginId);
    const startMs = Date.now();

    if (testPluginId === "telegram") {
      const token = process.env.TELEGRAM_BOT_TOKEN;
      if (!token) {
        sendJsonResponse(res, 422, {
          success: false,
          pluginId: testPluginId,
          error: "No bot token configured",
          durationMs: Date.now() - startMs,
        });
        return true;
      }
      try {
        const apiRoot =
          process.env.TELEGRAM_API_ROOT || "https://api.telegram.org";
        const tgResp = await fetch(`${apiRoot}/bot${token}/getMe`);
        const tgData = (await tgResp.json()) as {
          ok: boolean;
          result?: { username?: string };
          description?: string;
        };
        sendJsonResponse(res, tgData.ok ? 200 : 422, {
          success: tgData.ok,
          pluginId: testPluginId,
          message: tgData.ok
            ? `Connected as @${tgData.result?.username}`
            : `Telegram API error: ${tgData.description}`,
          durationMs: Date.now() - startMs,
        });
      } catch (err) {
        sendJsonResponse(res, 422, {
          success: false,
          pluginId: testPluginId,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startMs,
        });
      }
      return true;
    }

    const serviceHealth = resolvePluginServiceHealth(
      state.current,
      testPluginId,
    );
    if (serviceHealth !== null) {
      sendJsonResponse(res, serviceHealth ? 200 : 422, {
        success: serviceHealth,
        pluginId: testPluginId,
        message: serviceHealth
          ? "Service reports healthy: connection established."
          : "Service is loaded but reports unhealthy: the connection is not established. Check credentials and connectivity.",
        durationMs: Date.now() - startMs,
      });
      return true;
    }

    sendJsonResponse(res, 200, {
      success: true,
      pluginId: testPluginId,
      message: "Plugin is loaded (no custom test available)",
      durationMs: Date.now() - startMs,
    });
    return true;
  }

  const revealMatch =
    method === "POST" &&
    url.pathname.match(/^\/api\/plugins\/([^/]+)\/reveal$/);
  if (revealMatch) {
    if (!(await ensureRouteAuthorized(req, res, state))) return true;
    const revealBody = await readCompatJsonBody(req, res);
    if (revealBody == null) return true;
    const key = (revealBody.key as string)?.trim();
    if (!key) {
      sendJsonErrorResponse(res, 400, "Missing key parameter");
      return true;
    }
    const upperKey = key.toUpperCase();
    if (
      !REVEALABLE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
    ) {
      sendJsonErrorResponse(
        res,
        403,
        "Key is not in the allowlist of revealable plugin config keys",
      );
      return true;
    }
    // Wallet / private-key prefixes require elevated auth to prevent
    // accidental exposure through the general plugin config UI.
    if (SENSITIVE_KEY_PREFIXES.some((prefix) => upperKey.startsWith(prefix))) {
      if (!ensureCompatSensitiveRouteAuthorized(req, res)) return true;
    }
    // Prefer the vault. Fall back to env/config when the vault has no
    // entry; vault/keychain failures surface instead of silently falling
    // back to env.
    try {
      const decodedRevealPluginId = decodePluginPathSegment(revealMatch[1]);
      if (decodedRevealPluginId === null) {
        sendJsonErrorResponse(res, 400, "Invalid plugin path");
        return true;
      }
      const vaultValue = await sharedVault().reveal(
        key,
        `plugins:${decodedRevealPluginId}:reveal`,
      );
      sendJsonResponse(res, 200, { ok: true, value: vaultValue });
      return true;
    } catch (err) {
      if (!(err instanceof VaultMissError)) {
        logger.warn(
          `[api/plugins] Vault reveal failed for ${key}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        sendJsonErrorResponse(res, 500, "Vault reveal failed");
        return true;
      }
    }
    const config = loadElizaConfig();
    const fallbackValue =
      process.env[key] ??
      (config.env as Record<string, string> | undefined)?.[key] ??
      null;
    // The env/config fallback may itself be a `vault://KEY` sentinel. Resolve
    // it once. If the vault still misses, return null rather than the sentinel;
    // any other vault failure is the same outage the outer lookup reports.
    if (typeof fallbackValue === "string" && isVaultRef(fallbackValue)) {
      const innerKey = parseVaultRef(fallbackValue);
      if (innerKey) {
        try {
          const inner = await sharedVault().get(innerKey);
          if (inner) {
            sendJsonResponse(res, 200, { ok: true, value: inner });
            return true;
          }
        } catch (err) {
          // error-policy:J1 only a genuine miss degrades to `value: null`;
          // a locked or unreachable vault is answered as a structured 500.
          if (!(err instanceof VaultMissError)) {
            logger.warn(
              `[api/plugins] Vault reveal failed for ${key} via ${fallbackValue}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            sendJsonErrorResponse(res, 500, "Vault reveal failed");
            return true;
          }
        }
      }
      sendJsonResponse(res, 200, { ok: true, value: null });
      return true;
    }
    sendJsonResponse(res, 200, { ok: true, value: fallbackValue });
    return true;
  }

  return false;
}
