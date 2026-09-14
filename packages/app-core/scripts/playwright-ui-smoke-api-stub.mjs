/**
 * Deterministic API stand-in for UI-smoke Playwright runs: serves the dashboard
 * HTTP/WebSocket surface with canned data and real, provenance-tagged view
 * bundles where they exist; audit mode (ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES=1)
 * turns a missing real bundle into a 424 instead of synthesizing one.
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
// Single source of the host-external view-import rewrite (owned by the agent
// bundle route). Plain ESM so this node-run stub can import it without a build.
import {
  parseHostExternalSpecifiers,
  wrapBundleAsHostExternalFactory,
} from "../../agent/src/api/dynamic-view-host-external.mjs";
// Pure catalog data; keep the Node-run stub aligned without loading a runtime.
import { VOICE_MODEL_VERSIONS } from "../../shared/src/local-inference/voice-models.ts";
// The declarations + provenance decision live in one place so a removed plugin
// cannot linger in the stub and a fabricated bundle can never masquerade as the
// production one. Audit mode (ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES=1) turns a
// missing real bundle into an observable 424 instead of a synthesized surface.
import {
  resolveBundleProvenance,
  smokeViewDeclarations,
  VIEW_BUNDLE_PROVENANCE_HEADER,
} from "./smoke-view-declarations.mjs";

const REQUIRE_REAL_VIEW_BUNDLES =
  process.env.ELIZA_UI_SMOKE_REQUIRE_REAL_BUNDLES === "1";

const port = Number(process.env.ELIZA_UI_SMOKE_API_PORT || "31337");
const repoRoot = path.resolve(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const VIEW_BUNDLE_ROOT =
  process.env.ELIZA_UI_SMOKE_VIEW_BUNDLE_ROOT?.trim() ||
  path.join(repoRoot, "plugins");
const SMOKE_GENERATED_AT = "2026-01-01T00:00:00.000Z";
const DEMO_ORCHESTRATOR = process.env.ELIZA_UI_SMOKE_DEMO_ORCHESTRATOR === "1";
const HUMAN_CHAT_FIXTURES = process.env.ELIZA_UI_SMOKE_HUMAN_CHAT === "1";
const SMOKE_NOTIFICATIONS = process.env.ELIZA_UI_SMOKE_NOTIFICATIONS === "1";
let browserWorkspaceCounter = 0;
let browserWorkspaceTabs = [];
let lifeOpsAppEnabled = true;
let conversationCounter = 0;
let messageCounter = 0;
const stubConversations = [];
const stubConversationMessages = new Map();
const unhandledApiRequests = [];
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

// A minimal valid 16-bit PCM mono WAV of silence. The local-inference voice
// path POSTs /api/tts/local-inference and plays the returned bytes as
// audio/wav, so the stub must return decodable audio (not a 501) to avoid a
// console.error.
function buildSilentWav() {
  const sampleRate = 8000;
  const dataBytes = 1600; // ~0.1s of silence
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audioFormat = PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byteRate (mono, 16-bit)
  header.writeUInt16LE(2, 32); // blockAlign
  header.writeUInt16LE(16, 34); // bitsPerSample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

const SILENT_WAV = buildSilentWav();
// Deterministic transcript the local-inference ASR stub returns for any audio
// the /chat overlay captures — keeps the voice e2e turn reproducible.
const SMOKE_VOICE_TRANSCRIPT = "this is the voice smoke transcript";
// The spoken reply the stub returns for that transcript — a clean sentence so
// the overlay's TTS output is non-empty and the assistant bubble is assertable.
const SMOKE_VOICE_REPLY = "Got it, this is the spoken reply.";
const SMOKE_NETWORK_POLICY_PREFERENCES = {
  autoUpdateOnWifi: true,
  autoUpdateOnCellular: false,
  autoUpdateOnMetered: false,
  quietHours: [{ start: "22:00", end: "08:00" }],
};

// `smokeViewDeclarations` is imported from ./smoke-view-declarations.mjs so it
// stays pinned to shipping plugins by `checkSmokeViewParity` (removed views such
// as Shopify/Steward/Social Alpha cannot reappear here). The viewType contract
// still accepts future modalities; this fixture ships GUI-only rows.

function smokeViewObject({
  id,
  label,
  pluginDirName,
  viewPath,
  componentExport,
  viewType,
  surface,
}) {
  const encodedId = encodeURIComponent(id);
  const query = "?v=ui-smoke";
  const bundlePath = path.join(
    VIEW_BUNDLE_ROOT,
    pluginDirName,
    "dist",
    "views",
    "bundle.js",
  );
  return {
    id,
    label,
    viewType,
    pluginName: `@elizaos/${pluginDirName}`,
    path: viewPath,
    order: 100,
    bundlePath: "dist/views/bundle.js",
    bundleUrl: `/api/views/${encodedId}/bundle.js${query}`,
    componentExport,
    available: true,
    realBundleAvailable: existsSync(bundlePath),
    visibleInManager: true,
    capabilities: [
      {
        id: "get-state",
        description: "Read the mounted view state.",
      },
    ],
    ...(surface === undefined ? {} : { surface }),
    _smokePluginDirName: pluginDirName,
  };
}

// The 6th tuple slot remains a viewType override for future compatibility, but
// shipped fixture declarations default to GUI.
const smokeViews = smokeViewDeclarations.flatMap(
  ([
    id,
    label,
    pluginDirName,
    viewPath,
    componentExport,
    modalitiesOrViewType = "gui",
    surface,
  ]) => {
    const viewTypes = Array.isArray(modalitiesOrViewType)
      ? modalitiesOrViewType
      : [modalitiesOrViewType];
    return viewTypes.map((viewType) =>
      smokeViewObject({
        id,
        label,
        pluginDirName,
        viewPath,
        componentExport,
        viewType,
        surface,
      }),
    );
  },
);

const stubPlugins = [
  {
    id: "openai",
    name: "OpenAI",
    description:
      "Integrates OpenAI's GPT models for automated text generation with customizable prompts.",
    tags: ["ai-provider"],
    enabled: false,
    configured: false,
    envKey: "OPENAI_API_KEY",
    category: "ai-provider",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: false,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description:
      "Anthropic model provider for Claude chat and reasoning models.",
    tags: ["ai-provider"],
    enabled: false,
    configured: false,
    envKey: "ANTHROPIC_API_KEY",
    category: "ai-provider",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: false,
  },
  {
    id: "plugin-browser",
    name: "Browser Workspace",
    description: "Agent-controlled browser workspace.",
    tags: ["feature"],
    enabled: true,
    configured: true,
    envKey: null,
    category: "feature",
    source: "bundled",
    parameters: [],
    validationErrors: [],
    validationWarnings: [],
    isActive: true,
  },
];

function stubCatalogApp({
  name,
  displayName,
  description,
  category = "utility",
  capabilities = [],
  heroImage = null,
}) {
  return {
    name,
    displayName,
    description,
    category,
    launchType: "local",
    launchUrl: null,
    icon: null,
    heroImage,
    capabilities,
    stars: 0,
    repository: "",
    latestVersion: null,
    supports: { v0: false, v1: false, v2: true },
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: null,
    },
  };
}

const stubCatalogApps = [
  // No entry sets heroImage: the /app-heroes/*.png launcher art shipped only
  // in the retired eliza-archive overlay (#16290), so the files do not exist
  // in a clean checkout. The catalog renders the hero conditionally and falls
  // back to derived hero art, so omitting the field avoids the 404 console
  // errors the visual smoke asserts against.
  stubCatalogApp({
    name: "@elizaos/plugin-personal-assistant",
    displayName: "LifeOps",
    description:
      "Run tasks, reminders, calendar, inbox, and connected workflows.",
    capabilities: ["lifeops", "tasks", "calendar", "gmail"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-plugin-viewer",
    displayName: "Plugin Viewer",
    description:
      "Inspect installed plugins, connectors, and runtime feature flags.",
    capabilities: ["plugins", "connectors", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-skills-viewer",
    displayName: "Skills Viewer",
    description: "Create, enable, review, and install custom agent skills.",
    capabilities: ["skills", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-trajectory-viewer",
    displayName: "Trajectory Viewer",
    description: "Inspect LLM call history, prompts, and execution traces.",
    capabilities: ["trajectories", "debug", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-relationship-viewer",
    displayName: "Relationship Viewer",
    description: "Explore people, identities, and relationship graphs.",
    capabilities: ["relationships", "graph", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-memory-viewer",
    displayName: "Memory Viewer",
    description: "Browse memory, fact, and extraction activity.",
    capabilities: ["memory", "facts", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-runtime-debugger",
    displayName: "Runtime Debugger",
    description:
      "Inspect runtime objects, plugin order, providers, and services.",
    capabilities: ["runtime", "debug", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-database-viewer",
    displayName: "Database Viewer",
    description: "Inspect tables, media, vectors, and ad-hoc SQL.",
    capabilities: ["database", "sql", "viewer"],
  }),
  stubCatalogApp({
    name: "@elizaos/app-log-viewer",
    displayName: "Log Viewer",
    description: "Search runtime and service logs.",
    capabilities: ["logs", "debug", "viewer"],
  }),
];

let smokeFavoriteApps = [];

const stubMemoryStats = {
  total: 0,
  byType: {},
};

const stubRelationshipsPeopleResponse = {
  data: [],
  stats: {
    totalPeople: 0,
    totalEntities: 0,
    totalEdges: 0,
  },
};

const stubRelationshipsGraphResponse = {
  data: {
    people: [],
    relationships: [],
    stats: {
      totalPeople: 0,
      totalRelationships: 0,
      totalIdentities: 0,
    },
    candidateMerges: [],
  },
};

const stubAuthIdentity = {
  id: "owner-1",
  displayName: "Owner",
  kind: "owner",
};

const stubAuthSession = {
  id: "local-session",
  kind: "local",
  expiresAt: null,
};

const stubAuthAccess = {
  mode: "local",
  passwordConfigured: false,
  ownerConfigured: true,
};

const stubLogsResponse = {
  entries: [
    {
      timestamp: Date.now(),
      level: "info",
      message: "smoke API ready",
      source: "smoke",
      tags: ["smoke"],
    },
  ],
  sources: ["smoke"],
  tags: ["smoke"],
};

const stubMemoryFeedResponse = {
  memories: [],
  hasMore: false,
};

const stubMemoryBrowseResponse = {
  memories: [],
  total: 0,
  limit: 50,
  offset: 0,
};

const smokeNotifications = [
  {
    id: "smoke-notification-view-qa",
    title: "View switching ready",
    body: "Shopify and Wallet are registered for desktop QA.",
    category: "workflow",
    priority: "high",
    source: "ui-smoke",
    createdAt: Date.UTC(2026, 5, 25, 9, 0, 0),
    deepLink: "/views",
  },
  {
    id: "smoke-notification-cloud-chat",
    title: "Cloud chat stub online",
    body: "The smoke backend is serving deterministic chat responses.",
    category: "status",
    priority: "normal",
    source: "ui-smoke",
    createdAt: Date.UTC(2026, 5, 25, 8, 55, 0),
  },
];

const emptyComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};

const emptySkillsResponse = {
  skills: [],
};

const emptyLocalInferenceActive = {
  modelId: null,
  loadedAt: null,
  status: "idle",
};

const emptyLocalInferenceHardware = {
  totalRamGb: 16,
  freeRamGb: 8,
  gpu: null,
  cpuCores: 8,
  platform: process.platform,
  arch: process.arch,
  appleSilicon: process.platform === "darwin" && process.arch === "arm64",
  recommendedBucket: "small",
  source: "os-fallback",
};

const emptyLocalInferenceHub = {
  catalog: [],
  installed: [],
  active: emptyLocalInferenceActive,
  downloads: [],
  hardware: emptyLocalInferenceHardware,
};

const emptyWalletConfig = {
  evmAddress: null,
  solanaAddress: null,
  selectedRpcProviders: {
    evm: "eliza-cloud",
    bsc: "eliza-cloud",
    solana: "eliza-cloud",
  },
  legacyCustomChains: [],
  alchemyKeySet: false,
  infuraKeySet: false,
  ankrKeySet: false,
  nodeRealBscRpcSet: false,
  quickNodeBscRpcSet: false,
  managedBscRpcReady: false,
  cloudManagedAccess: false,
  evmBalanceReady: false,
  ethereumBalanceReady: false,
  baseBalanceReady: false,
  bscBalanceReady: false,
  avalancheBalanceReady: false,
  solanaBalanceReady: false,
  heliusKeySet: false,
  birdeyeKeySet: false,
  evmChains: [],
  walletSource: "none",
  pluginEvmLoaded: false,
  pluginEvmRequired: false,
  executionReady: false,
  executionBlockedReason: null,
  evmSigningCapability: "none",
  solanaSigningAvailable: false,
  wallets: [],
  primary: {
    evm: "local",
    solana: "local",
  },
};

const emptyWalletBalances = {
  evm: null,
  solana: null,
};

const emptyWalletNfts = {
  evm: [],
  solana: null,
};

const emptyWalletTradingProfile = {
  window: "30d",
  source: "all",
  generatedAt: new Date(0).toISOString(),
  summary: {
    totalSwaps: 0,
    buyCount: 0,
    sellCount: 0,
    settledCount: 0,
    successCount: 0,
    revertedCount: 0,
    tradeWinRate: null,
    txSuccessRate: null,
    winningTrades: 0,
    evaluatedTrades: 0,
    realizedPnlBnb: "0",
    volumeBnb: "0",
  },
  pnlSeries: [],
  tokenBreakdown: [],
  recentSwaps: [],
};

const emptyWalletMarketSource = {
  providerId: "coingecko",
  providerName: "CoinGecko",
  providerUrl: "https://www.coingecko.com",
  available: false,
  stale: false,
  error: null,
};

const emptyWalletMarketOverview = {
  generatedAt: new Date(0).toISOString(),
  cacheTtlSeconds: 300,
  stale: false,
  sources: {
    prices: emptyWalletMarketSource,
    movers: emptyWalletMarketSource,
    predictions: {
      providerId: "polymarket",
      providerName: "Polymarket",
      providerUrl: "https://polymarket.com",
      available: false,
      stale: false,
      error: null,
    },
  },
  prices: [],
  movers: [],
  predictions: [],
};

const smokeGeneratedAt = "2026-01-01T00:00:00.000Z";

const emptyLifeOpsOverviewSummary = {
  activeGoalCount: 0,
  activeOccurrenceCount: 0,
  activeReminderCount: 0,
  overdueOccurrenceCount: 0,
  snoozedOccurrenceCount: 0,
};

const emptyLifeOpsOverviewSection = {
  occurrences: [],
  goals: [],
  reminders: [],
  summary: emptyLifeOpsOverviewSummary,
};

const emptyLifeOpsOverview = {
  occurrences: [],
  goals: [],
  reminders: [],
  summary: emptyLifeOpsOverviewSummary,
  owner: emptyLifeOpsOverviewSection,
  agentOps: emptyLifeOpsOverviewSection,
  schedule: null,
};

const emptyLifeOpsCapabilities = {
  generatedAt: smokeGeneratedAt,
  appEnabled: true,
  relativeTime: null,
  capabilities: [],
  summary: {
    totalCount: 0,
    workingCount: 0,
    degradedCount: 0,
    blockedCount: 0,
    notConfiguredCount: 0,
  },
};

const emptyLifeOpsCalendarFeed = {
  calendarId: "primary",
  events: [],
  source: "cache",
  timeMin: smokeGeneratedAt,
  timeMax: smokeGeneratedAt,
  syncedAt: null,
};

const emptyLifeOpsInbox = {
  messages: [],
  channelCounts: {},
  fetchedAt: smokeGeneratedAt,
  threadGroups: [],
};

const emptyLifeOpsScreenTimeSummary = {
  items: [],
  totalSeconds: 0,
};

const emptyLifeOpsScreenTimeBreakdown = {
  items: [],
  totalSeconds: 0,
  bySource: [],
  byCategory: [],
  byDevice: [],
  byService: [],
  byBrowser: [],
  fetchedAt: smokeGeneratedAt,
};

const emptyLifeOpsSocialSummary = {
  since: smokeGeneratedAt,
  until: smokeGeneratedAt,
  totalSeconds: 0,
  services: [],
  devices: [],
  surfaces: [],
  browsers: [],
  sessions: [],
  messages: {
    channels: [],
    inbound: 0,
    outbound: 0,
    opened: 0,
    replied: 0,
  },
  dataSources: [],
  fetchedAt: smokeGeneratedAt,
};

const emptyBrowserBridgeSettings = {
  enabled: true,
  trackingMode: "current_tab",
  allowBrowserControl: false,
  requireConfirmationForAccountAffecting: true,
  incognitoEnabled: false,
  siteAccessMode: "current_site_only",
  grantedOrigins: [],
  blockedOrigins: [],
  maxRememberedTabs: 10,
  pauseUntil: null,
  metadata: {},
  updatedAt: null,
};

const emptyBrowserBridgePackageStatus = {
  extensionPath: null,
  chromeBuildPath: null,
  chromePackagePath: null,
  safariAppPath: null,
  safariPackagePath: null,
  safariWebExtensionPath: null,
  releaseManifest: null,
};

const stubCharacter = {
  name: "Eliza",
  username: "eliza",
  bio: ["A concise local assistant for UI smoke tests."],
  system: "You are Eliza, a concise assistant for UI smoke tests.",
  adjectives: ["focused", "direct"],
  topics: [],
  style: {
    all: [],
    chat: [],
    post: [],
  },
  messageExamples: [],
  postExamples: [],
};

const stubExperiences = [
  {
    id: "stub-exp-vite-env",
    type: "correction",
    outcome: "positive",
    context:
      "A local Vite app kept stale environment variables after .env changed.",
    action: "Restarted the dev server and reran the route check.",
    result: "The updated API base URL appeared after restart.",
    learning:
      "Restart the dev server after changing environment variables so the running process loads new config.",
    tags: ["vite", "env", "restart"],
    keywords: ["vite", "env", "restart", "config"],
    associatedEntityIds: ["stub-user-local", "stub-agent"],
    domain: "coding",
    confidence: 0.91,
    importance: 0.88,
    createdAt: "2026-04-20T12:00:00.000Z",
    updatedAt: "2026-04-21T12:00:00.000Z",
    accessCount: 3,
    embeddingDimensions: 1536,
    sourceMessageIds: ["stub-msg-1", "stub-msg-2", "stub-msg-3"],
    sourceRoomId: "stub-room-local-dev",
    sourceTriggerMessageId: "stub-msg-3",
    extractionMethod: "experience_evaluator",
  },
  {
    id: "stub-exp-test-deps",
    type: "warning",
    outcome: "negative",
    context:
      "A TypeScript test run started before workspace dependencies were ready.",
    action: "Ran tests before installing packages.",
    result: "The test suite failed on missing dependencies.",
    learning:
      "Install workspace dependencies before running app tests or local dev commands.",
    tags: ["setup", "tests"],
    keywords: ["dependencies", "tests", "workspace", "setup"],
    associatedEntityIds: ["stub-user-local"],
    domain: "coding",
    confidence: 0.78,
    importance: 0.76,
    createdAt: "2026-04-22T12:00:00.000Z",
    updatedAt: "2026-04-22T13:00:00.000Z",
    accessCount: 2,
    embeddingDimensions: 1536,
  },
  {
    id: "stub-exp-release-notes",
    type: "success",
    outcome: "positive",
    context: "A release note draft contained too much implementation detail.",
    action: "Grouped changes by user impact first.",
    result: "The summary was accepted without follow-up edits.",
    learning:
      "For release notes, group by user impact before implementation details.",
    tags: ["writing", "release-notes"],
    keywords: ["release", "notes", "impact", "writing"],
    associatedEntityIds: ["stub-user-docs"],
    domain: "writing",
    confidence: 0.86,
    importance: 0.52,
    createdAt: "2026-04-23T12:00:00.000Z",
    updatedAt: "2026-04-23T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
  },
  {
    id: "stub-exp-graph-ux",
    type: "learning",
    outcome: "neutral",
    context: "The experience graph used text cards inside the map.",
    action: "Reviewed visual density and interaction clarity.",
    result: "The graph felt like a list pasted into a canvas.",
    learning:
      "Use visual encodings in graph views and keep text in the detail panel outside the map.",
    tags: ["graph", "ux"],
    keywords: ["graph", "visual", "detail", "map"],
    associatedEntityIds: ["stub-user-design", "stub-agent"],
    domain: "ux",
    confidence: 0.82,
    importance: 0.9,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    relatedExperiences: ["stub-exp-search-action"],
  },
  {
    id: "stub-exp-automation-cadence",
    type: "correction",
    outcome: "mixed",
    context:
      "Older automation cadence guidance conflicted with newer direct feedback.",
    action: "Kept the latest explicit preference and linked older records.",
    result: "Future automation suggestions used the corrected cadence.",
    learning:
      "Prefer the latest explicit cadence preference when automation guidance conflicts.",
    tags: ["automation", "preference"],
    keywords: ["automation", "cadence", "preference"],
    associatedEntityIds: ["stub-user-design"],
    domain: "planning",
    confidence: 0.72,
    importance: 0.82,
    createdAt: "2026-04-25T12:00:00.000Z",
    updatedAt: "2026-04-25T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    supersedes: "stub-exp-release-notes",
  },
  {
    id: "stub-exp-search-action",
    type: "discovery",
    outcome: "neutral",
    context: "A graph search needed more than top-level context injection.",
    action: "Added a dedicated experience search action with graph data.",
    result: "The agent can retrieve detailed experience results on demand.",
    learning:
      "Expose experience graph search as an action so planning context can stay compact but details remain searchable.",
    tags: ["search", "graph"],
    keywords: ["experience", "graph", "search", "action"],
    associatedEntityIds: ["stub-agent"],
    domain: "coding",
    confidence: 0.84,
    importance: 0.86,
    createdAt: "2026-04-26T12:00:00.000Z",
    updatedAt: "2026-04-26T12:00:00.000Z",
    accessCount: 1,
    embeddingDimensions: 1536,
    relatedExperiences: ["stub-exp-graph-ux"],
  },
];

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createStubConversation({ title = "New chat", metadata = {} } = {}) {
  conversationCounter += 1;
  const createdAt = nowIso();
  const conversation = {
    id: `stub-conversation-${conversationCounter}`,
    title:
      typeof title === "string" && title.trim().length > 0
        ? title.trim()
        : "New chat",
    roomId: `stub-room-${conversationCounter}`,
    metadata:
      metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata
        : {},
    createdAt,
    updatedAt: createdAt,
  };
  stubConversations.unshift(conversation);
  stubConversationMessages.set(conversation.id, []);
  return conversation;
}

function findStubConversation(id) {
  return stubConversations.find((conversation) => conversation.id === id);
}

function createStubMessage(role, text) {
  messageCounter += 1;
  return {
    id: `stub-message-${messageCounter}`,
    role,
    text: typeof text === "string" ? text : "",
    timestamp: Date.now(),
  };
}

function stableTextHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function normalizeAssistantInput(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function classifyAssistantAction(text) {
  const normalized = text.toLowerCase();
  if (/\b(wallet|inventory|address|balance)\b/.test(normalized)) {
    return { type: "navigate", target: "/wallet" };
  }
  if (/\b(view|views|app|apps)\b/.test(normalized)) {
    return { type: "navigate", target: "/views" };
  }
  if (/\b(setting|settings|provider|model|voice)\b/.test(normalized)) {
    return { type: "navigate", target: "/settings" };
  }
  if (/\b(chat|conversation|message)\b/.test(normalized)) {
    return { type: "navigate", target: "/chat" };
  }
  return { type: "noop", target: null };
}

function navigationDetailForTarget(target) {
  switch (target) {
    case "/wallet":
      return { viewId: "wallet", viewPath: "/wallet", viewLabel: "Wallet" };
    case "/views":
      return { viewPath: "/views", viewLabel: "Launcher" };
    case "/settings":
      return {
        viewId: "settings",
        viewPath: "/settings",
        viewLabel: "Settings",
      };
    case "/chat":
      return { viewPath: "/chat", viewLabel: "Chat" };
    default:
      return typeof target === "string" && target.length > 0
        ? { viewPath: target }
        : null;
  }
}

function maybeBroadcastAssistantNavigation(text) {
  if (!HUMAN_CHAT_FIXTURES) return;
  const action = classifyAssistantAction(text);
  if (action.type !== "navigate") return;
  const detail = navigationDetailForTarget(action.target);
  if (!detail) return;
  setTimeout(() => {
    broadcastWsEvent({
      type: "shell:navigate:view",
      viewType: "gui",
      alwaysOnTop: false,
      ...detail,
    });
  }, 50);
}

function createDeterministicAssistantText({ body, conversationId, transport }) {
  const inputText = normalizeAssistantInput(body?.text ?? body?.message);
  if (inputText === SMOKE_VOICE_TRANSCRIPT) {
    // Voice e2e: reply to the spoken turn with a plain sentence (not the JSON
    // fixture) so the bidirectional voice output is speakable + assertable.
    return SMOKE_VOICE_REPLY;
  }
  if (/\bbroken[_ -]?llm[_ -]?response\b/i.test(inputText)) {
    return `BROKEN_MOCK_LLM_RESPONSE:${JSON.stringify({
      fixture: "ui-smoke-assistant-v1",
      conversationId,
      transport,
      input: { text: inputText },
      action: classifyAssistantAction(inputText),
    }).slice(0, -2)}`;
  }
  const action = classifyAssistantAction(inputText);
  if (HUMAN_CHAT_FIXTURES) {
    if (action.type === "navigate") {
      const label = action.target?.replace(/^\//, "") || "that view";
      return `Opening ${label}.`;
    }
    return inputText
      ? `I received "${inputText}".`
      : "I am ready when you are.";
  }
  const payload = {
    fixture: "ui-smoke-assistant-v1",
    registrySeam: "strict-fixture-registry",
    conversationId,
    transport,
    input: {
      text: inputText,
      length: inputText.length,
      hash: stableTextHash(inputText),
    },
    action,
  };
  return JSON.stringify(payload);
}

function recordUnhandledApiRequest(req, url) {
  const entry = {
    method: req.method ?? "GET",
    path: url.pathname,
    search: url.search,
    at: nowIso(),
  };
  unhandledApiRequests.push(entry);
  if (unhandledApiRequests.length > 50) {
    unhandledApiRequests.shift();
  }
  console.error(
    `[playwright-ui-smoke-api-stub] unhandled API route: ${entry.method} ${entry.path}${entry.search}`,
  );
  return entry;
}

function appendStubMessage(conversationId, message) {
  const messages = stubConversationMessages.get(conversationId) ?? [];
  messages.push(message);
  stubConversationMessages.set(conversationId, messages);
  const conversation = findStubConversation(conversationId);
  if (conversation) conversation.updatedAt = nowIso();
  return message;
}

function cleanupEmptyStubConversations({ keepId } = {}) {
  const deleted = [];
  for (let index = stubConversations.length - 1; index >= 0; index -= 1) {
    const conversation = stubConversations[index];
    if (typeof keepId === "string" && conversation.id === keepId) continue;
    const messages = stubConversationMessages.get(conversation.id) ?? [];
    const hasUserMessage = messages.some((message) => message.role === "user");
    if (hasUserMessage) continue;
    stubConversations.splice(index, 1);
    stubConversationMessages.delete(conversation.id);
    deleted.push(conversation.id);
  }
  return deleted;
}

function buildRuntimeSnapshot(url) {
  const maxDepth = parsePositiveInt(url.searchParams.get("depth"), 10);
  const maxArrayLength = parsePositiveInt(
    url.searchParams.get("maxArrayLength"),
    1000,
  );
  const maxObjectEntries = parsePositiveInt(
    url.searchParams.get("maxObjectEntries"),
    1000,
  );
  const maxStringLength = parsePositiveInt(
    url.searchParams.get("maxStringLength"),
    280,
  );

  return {
    runtimeAvailable: true,
    generatedAt: Date.now(),
    settings: {
      maxDepth,
      maxArrayLength,
      maxObjectEntries,
      maxStringLength,
    },
    meta: {
      agentId: "playwright-ui-smoke-agent",
      agentState: "running",
      agentName: "UI Smoke Runtime",
      model: "stubbed",
      pluginCount: 1,
      actionCount: 1,
      providerCount: 1,
      evaluatorCount: 1,
      serviceTypeCount: 1,
      serviceCount: 1,
    },
    order: {
      plugins: [
        {
          index: 0,
          name: "plugin-browser",
          className: "BrowserWorkspacePlugin",
          id: "plugin-browser",
        },
      ],
      actions: [
        {
          index: 0,
          name: "open_browser_workspace",
          className: "BrowserWorkspaceAction",
          id: "browser-workspace-action",
        },
      ],
      providers: [
        {
          index: 0,
          name: "browser_workspace_provider",
          className: "BrowserWorkspaceProvider",
          id: "browser-workspace-provider",
        },
      ],
      evaluators: [
        {
          index: 0,
          name: "browser_workspace_health",
          className: "BrowserWorkspaceHealthEvaluator",
          id: "browser-workspace-health",
        },
      ],
      services: [
        {
          index: 0,
          serviceType: "browser-workspace",
          count: 1,
          instances: [
            {
              index: 0,
              name: "browser-workspace-service",
              className: "BrowserWorkspaceService",
              id: "browser-workspace-service",
            },
          ],
        },
      ],
    },
    sections: {
      runtime: {
        agent: {
          id: "playwright-ui-smoke-agent",
          name: "UI Smoke Runtime",
          state: "running",
        },
        environment: {
          mode: "stub",
          ci: process.env.CI === "true",
        },
        settings: {
          maxDepth,
          maxArrayLength,
          maxObjectEntries,
          maxStringLength,
        },
      },
      plugins: {
        "plugin-browser": {
          id: "plugin-browser",
          source: "bundled",
          enabled: true,
        },
      },
      actions: {
        open_browser_workspace: {
          enabled: true,
          description: "Stub browser workspace action for UI smoke tests.",
        },
      },
      providers: {
        browser_workspace_provider: {
          enabled: true,
          source: "stub",
        },
      },
      evaluators: {
        browser_workspace_health: {
          enabled: true,
          status: "ok",
        },
      },
      services: {
        "browser-workspace": {
          instances: 1,
          status: "ready",
        },
      },
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStubBrowserUrl(rawUrl) {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "about:blank") {
    return trimmed;
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return new URL(trimmed).toString();
  }
  return new URL(`https://${trimmed}`).toString();
}

function inferStubBrowserTitle(url) {
  if (url === "about:blank") {
    return "New Tab";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "") || "Browser";
  } catch {
    return "Browser";
  }
}

function browserWorkspaceSnapshot() {
  return {
    mode: "web",
    tabs: browserWorkspaceTabs,
  };
}

function showBrowserWorkspaceTab(tabId) {
  let selected = null;
  browserWorkspaceTabs = browserWorkspaceTabs.map((tab) => {
    const visible = tab.id === tabId;
    const nextTab = {
      ...tab,
      visible,
      updatedAt: nowIso(),
      lastFocusedAt: visible ? nowIso() : tab.lastFocusedAt,
    };
    if (visible) {
      selected = nextTab;
    }
    return nextTab;
  });
  return selected;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(req, res, status, payload) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function sendEmpty(req, res, status) {
  applyCors(req, res);
  res.statusCode = status;
  res.end();
}

function sendBinary(req, res, status, contentType, body) {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.end(req.method === "HEAD" ? undefined : body);
}

function contentTypeForSmokeViewAsset(assetPath) {
  const ext = path.extname(assetPath).toLowerCase();
  if (ext === ".js" || ext === ".mjs")
    return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".map" || ext === ".json")
    return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function smokeViewByRequest(id, viewType) {
  return smokeViews.find(
    (view) => view.id === id && view.viewType === (viewType || "gui"),
  );
}

function safeComponentExportName(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : "SmokeView";
}

function smokeScreenshareBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function maskSession(value) {
  if (!value) return "";
  return value.slice(0, 6) + "\\u2026" + value.slice(-4);
}

function maskToken(value) {
  if (!value) return "";
  return "\\u2022\\u2022\\u2022\\u2022 " + value.slice(-4);
}

function SmokeView() {
  const [capabilities, setCapabilities] = React.useState(null);
  const [host, setHost] = React.useState(null);
  const [token, setToken] = React.useState("");
  const [viewerUrl, setViewerUrl] = React.useState("");
  const [remoteBase, setRemoteBase] = React.useState("");
  const [remoteSession, setRemoteSession] = React.useState("");
  const [remoteToken, setRemoteToken] = React.useState("");

  const refreshCapabilities = React.useCallback(async () => {
    const response = await fetch("/api/apps/screenshare/capabilities");
    setCapabilities(await response.json());
  }, []);

  React.useEffect(() => {
    void refreshCapabilities();
  }, [refreshCapabilities]);

  const startHost = async () => {
    const response = await fetch("/api/apps/screenshare/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "This machine" })
    });
    const result = await response.json();
    setHost(result.session);
    setToken(result.token);
    setViewerUrl(result.viewerUrl);
  };

  const copyDetails = async () => {
    await navigator.clipboard.writeText(JSON.stringify({
      sessionId: host?.id,
      token
    }));
  };

  const openHostViewer = () => {
    if (viewerUrl) window.open(viewerUrl);
  };

  const openRemote = () => {
    const url = new URL("/api/apps/screenshare/viewer", remoteBase);
    url.searchParams.set("sessionId", remoteSession);
    url.searchParams.set("token", remoteToken);
    url.searchParams.set("remoteBase", remoteBase);
    window.open(url.toString());
  };

  const stopHost = async () => {
    if (!host?.id) return;
    const response = await fetch("/api/apps/screenshare/session/" + encodeURIComponent(host.id) + "/stop", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-screenshare-token": token
      },
      body: JSON.stringify({ token })
    });
    const result = await response.json();
    setHost(result.session);
  };

  const capabilityList = capabilities?.capabilities ?? {};
  return React.createElement(
    "section",
    { "aria-label": viewMeta.label, style: { minHeight: "100vh", padding: 24 } },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("h2", null, "Host"),
    React.createElement("button", { type: "button", onClick: startHost }, "Start host session"),
    host && React.createElement("button", { type: "button", onClick: copyDetails }, "Copy host details"),
    host && React.createElement("button", { type: "button", onClick: openHostViewer }, "Open host viewer"),
    host && React.createElement("button", { type: "button", onClick: stopHost }, "Stop host session"),
    host && React.createElement("div", null,
      React.createElement("input", { placeholder: "Session", readOnly: true, value: maskSession(host.id) }),
      React.createElement("input", { placeholder: "Token", readOnly: true, value: maskToken(token) }),
      React.createElement("span", null, String(host.frameCount ?? 0)),
      React.createElement("span", null, String(host.inputCount ?? 0)),
      React.createElement("span", null, host.status)
    ),
    React.createElement("h2", null, "Capabilities"),
    React.createElement("button", { type: "button", onClick: () => void refreshCapabilities() }, "Refresh capabilities"),
    React.createElement("div", null,
      React.createElement("span", null, "Screenshot"),
      React.createElement("span", null, capabilityList.screenshot?.available ? "Ready" : "Unavailable")
    ),
    React.createElement("div", null,
      React.createElement("span", null, "Keyboard"),
      React.createElement("span", null, capabilityList.keyboard?.available ? "Ready" : "Unavailable")
    ),
    React.createElement("h2", null, "Remote"),
    React.createElement("input", { placeholder: "Server URL", value: remoteBase, onChange: (event) => setRemoteBase(event.target.value) }),
    React.createElement("input", { placeholder: "Session", value: remoteSession, onChange: (event) => setRemoteSession(event.target.value) }),
    React.createElement("input", { placeholder: "Token", value: remoteToken, onChange: (event) => setRemoteToken(event.target.value) }),
    React.createElement("button", { type: "button", onClick: openRemote }, "Connect to remote")
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeTaskCoordinatorBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function statusLabel(thread) {
  return String(thread?.status ?? "open").replace(/_/g, " ");
}

function SmokeView() {
  const [tasks, setTasks] = React.useState([]);
  const [detail, setDetail] = React.useState(null);
  const [search, setSearch] = React.useState("");

  const loadTasks = React.useCallback(async (nextSearch = search) => {
    const url = new URL("/api/orchestrator/tasks", window.location.origin);
    url.searchParams.set("limit", "50");
    if (nextSearch) url.searchParams.set("search", nextSearch);
    const response = await fetch(url.pathname + url.search);
    const result = await response.json();
    setTasks(result.tasks ?? []);
  }, [search]);

  React.useEffect(() => {
    void loadTasks("");
  }, []);

  const updateSearch = (value) => {
    setSearch(value);
    void loadTasks(value);
  };

  const openTask = async (task) => {
    const response = await fetch("/api/orchestrator/tasks/" + encodeURIComponent(task.id));
    setDetail(await response.json());
  };

  const archiveTask = async () => {
    if (!detail?.id) return;
    await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id) + "/archive", { method: "POST" });
    await loadTasks(search);
  };

  const reopenTask = async () => {
    if (!detail?.id) return;
    await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id) + "/reopen", { method: "POST" });
    const response = await fetch("/api/orchestrator/tasks/" + encodeURIComponent(detail.id));
    setDetail(await response.json());
    await loadTasks(search);
  };

  return React.createElement(
    "section",
    {
      "aria-label": viewMeta.label,
      "data-testid": "chat-widget-orchestrator",
      style: { minHeight: "100vh", padding: 24 }
    },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("input", {
      placeholder: "Search tasks",
      value: search,
      onChange: (event) => updateSearch(event.target.value)
    }),
    React.createElement(
      "div",
      null,
      ...tasks.map((task) =>
        React.createElement(
          "button",
          {
            key: task.id,
            type: "button",
            onClick: () => void openTask(task),
            style: { display: "block", marginTop: 8 }
          },
          task.title + " " + statusLabel(task)
        )
      )
    ),
    detail && React.createElement(
      "article",
      { "aria-label": "Task detail", style: { marginTop: 16 } },
      React.createElement("h2", null, detail.title),
      React.createElement("p", null, detail.summary ?? detail.originalRequest ?? ""),
      ...(detail.acceptanceCriteria ?? []).map((item) => React.createElement("p", { key: item }, item)),
      ...(detail.sessions ?? []).map((session) =>
        React.createElement(
          "div",
          { key: session.id },
          React.createElement("span", null, session.label),
          React.createElement("span", null, (session.framework ?? "") + " (" + (session.providerSource ?? "") + ")")
        )
      ),
      ...(detail.artifacts ?? []).map((artifact) => React.createElement("p", { key: artifact.id }, artifact.title)),
      ...(detail.pendingDecisions ?? []).map((decision) => React.createElement("p", { key: decision.sessionId }, decision.promptText)),
      ...(detail.events ?? []).map((event) => React.createElement("p", { key: event.id }, event.summary)),
      ...(detail.transcripts ?? []).map((transcript) => React.createElement("p", { key: transcript.id }, transcript.content)),
      detail.status === "archived"
        ? React.createElement("button", { type: "button", onClick: () => void reopenTask() }, "Reopen")
        : React.createElement("button", { type: "button", onClick: () => void archiveTask() }, "Delete")
    )
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeGenericViewBundleSource(view, exportName) {
  const label = JSON.stringify(view.label);
  const id = JSON.stringify(view.id);
  const viewType = JSON.stringify(view.viewType);
  const pluginName = JSON.stringify(view.pluginName);
  return `import React from "react";

const viewMeta = {
  id: ${id},
  label: ${label},
  viewType: ${viewType},
  pluginName: ${pluginName}
};

function SmokeView() {
  return React.createElement(
    "section",
    { "aria-label": viewMeta.label, style: { minHeight: "100vh", padding: 24 } },
    React.createElement("h1", null, viewMeta.label),
    React.createElement("p", null, viewMeta.pluginName + " dynamic view smoke surface is ready."),
    React.createElement("button", { type: "button" }, "Refresh view"),
    React.createElement("input", { "aria-label": viewMeta.label + " input", defaultValue: viewMeta.id })
  );
}

export { SmokeView as ${exportName} };
export default SmokeView;
export async function interact(capability, params = {}) {
  return { ok: true, viewId: viewMeta.id, viewType: viewMeta.viewType, capability, params };
}
`;
}

function smokeViewBundleSource(view) {
  const exportName = safeComponentExportName(view.componentExport);
  if (view.id === "screenshare") {
    return smokeScreenshareBundleSource(view, exportName);
  }
  if (view.id === "task-coordinator") {
    return smokeTaskCoordinatorBundleSource(view, exportName);
  }
  return smokeGenericViewBundleSource(view, exportName);
}

function sendSmokeViewAsset(req, res, url, view, subResource) {
  const bundleDir = path.join(
    VIEW_BUNDLE_ROOT,
    view._smokePluginDirName,
    "dist",
    "views",
  );
  const assetPath = path.resolve(bundleDir, decodeURIComponent(subResource));
  const relative = path.relative(bundleDir, assetPath);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative === ""
  ) {
    sendJson(req, res, 400, { error: "Malformed view asset path" });
    return;
  }
  const hostExternalSpecifiers = parseHostExternalSpecifiers(url);
  if (subResource === "bundle.js") {
    // The bundle route is the one an audit trusts to prove the production
    // surface, so its provenance is always decided explicitly and echoed on the
    // response header — real built bundle, marked synthesis, or (audit mode)
    // observable failure — never a silent fabrication.
    const provenance = resolveBundleProvenance({
      viewId: view.id,
      realBundleExists: existsSync(assetPath),
      requireRealBundle: REQUIRE_REAL_VIEW_BUNDLES,
    });
    res.setHeader(VIEW_BUNDLE_PROVENANCE_HEADER, provenance.mode);
    res.setHeader("X-Eliza-View-Component", view.componentExport);
    res.setHeader("X-Eliza-View-Id", view.id);
    if (provenance.mode === "missing-real-bundle") {
      sendJson(req, res, provenance.status, {
        error: `Missing production view bundle: ${view.pluginName}`,
        viewId: view.id,
        componentExport: view.componentExport,
        provenance: provenance.mode,
        expectedBundlePath: `plugins/${view._smokePluginDirName}/dist/views/bundle.js`,
        hint: "Build the plugin view bundle (bun run build-views) before running the audit; audit mode refuses to fabricate a placeholder.",
      });
      return;
    }
    if (provenance.mode === "real-dist") {
      const rawBody = readFileSync(assetPath);
      const body =
        hostExternalSpecifiers.length > 0
          ? Buffer.from(
              wrapBundleAsHostExternalFactory(
                rawBody.toString("utf8"),
                hostExternalSpecifiers,
              ),
              "utf8",
            )
          : rawBody;
      sendBinary(
        req,
        res,
        provenance.status,
        "application/javascript; charset=utf-8",
        body,
      );
      return;
    }
    // Non-audit synthesized placeholder: prefix a provenance banner so the byte
    // stream itself, not just the header, marks the bundle as synthesized.
    const banner =
      `/* eliza-view-bundle-provenance: ${provenance.mode}; component=${view.componentExport}; view=${view.id} */\n` +
      `globalThis.__ELIZA_VIEW_BUNDLE_PROVENANCE__ = Object.assign(globalThis.__ELIZA_VIEW_BUNDLE_PROVENANCE__ || {}, { ${JSON.stringify(view.id)}: ${JSON.stringify(provenance.mode)} });\n`;
    const source = banner + smokeViewBundleSource(view);
    const body =
      hostExternalSpecifiers.length > 0
        ? wrapBundleAsHostExternalFactory(source, hostExternalSpecifiers)
        : source;
    sendBinary(
      req,
      res,
      provenance.status,
      "application/javascript; charset=utf-8",
      Buffer.from(body, "utf8"),
    );
    return;
  }
  if (!existsSync(assetPath)) {
    sendJson(req, res, 404, { error: `View asset not found: ${subResource}` });
    return;
  }
  const rawBody = readFileSync(assetPath);
  const body =
    hostExternalSpecifiers.length > 0 &&
    contentTypeForSmokeViewAsset(assetPath).startsWith("application/javascript")
      ? Buffer.from(
          wrapBundleAsHostExternalFactory(
            rawBody.toString("utf8"),
            hostExternalSpecifiers,
          ),
          "utf8",
        )
      : rawBody;
  sendBinary(req, res, 200, contentTypeForSmokeViewAsset(assetPath), body);
}

function sendSseHeaders(req, res) {
  applyCors(req, res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeSseEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendReadySseStream(req, res) {
  sendSseHeaders(req, res);
  writeSseEvent(res, { type: "ready" });
  const interval = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);
  req.on("close", () => clearInterval(interval));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Consume and discard a request body (binary or irrelevant) so the socket
// drains cleanly before the response is sent.
async function drainRequest(req) {
  await new Promise((resolve) => {
    req.on("data", () => {});
    req.on("end", resolve);
    req.on("error", resolve);
    req.resume();
  });
}

function workbenchOverview() {
  return {
    tasks: [],
    triggers: [],
    todos: [],
    summary: {
      totalTasks: 0,
      completedTasks: 0,
      totalTriggers: 0,
      activeTriggers: 0,
      totalTodos: 0,
      completedTodos: 0,
    },
    tasksAvailable: false,
    triggersAvailable: false,
    todosAvailable: false,
    lifeopsAvailable: false,
  };
}

const emptyOrchestratorUsage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "unavailable",
  byProvider: [],
};

function emptyOrchestratorStatus() {
  return {
    taskCount: 0,
    activeTaskCount: 0,
    pausedTaskCount: 0,
    blockedTaskCount: 0,
    validatingTaskCount: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    usage: emptyOrchestratorUsage,
    byStatus: {
      open: 0,
      active: 0,
      waiting_on_user: 0,
      blocked: 0,
      validating: 0,
      done: 0,
      failed: 0,
      archived: 0,
      interrupted: 0,
    },
  };
}

function emptyTrajectoryList(url) {
  return {
    trajectories: [],
    total: 0,
    offset: Number(url.searchParams.get("offset") ?? 0),
    limit: Number(url.searchParams.get("limit") ?? 50),
  };
}

function orchestratorUsage(overrides = {}) {
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "unavailable",
    usageState: "unavailable",
    byProvider: [],
    metadata: {},
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    ...overrides,
  };
}

function createDemoOrchestratorState() {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const richUsage = orchestratorUsage({
    inputTokens: 8400,
    outputTokens: 2600,
    reasoningTokens: 1345,
    totalTokens: 12_345,
    costUsd: 0.42,
    state: "measured",
    usageState: "measured",
    byProvider: [
      {
        provider: "cerebras",
        model: "gpt-oss-120b",
        inputTokens: 8400,
        outputTokens: 2600,
        reasoningTokens: 1345,
        cacheTokens: 0,
        totalTokens: 12_345,
        costUsd: 0.42,
        state: "measured",
      },
      {
        provider: "codex",
        model: "codex-cli",
        inputTokens: 1200,
        outputTokens: 900,
        reasoningTokens: 0,
        cacheTokens: 0,
        totalTokens: 2100,
        costUsd: 0,
        state: "estimated",
      },
    ],
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  const detail = createDemoTaskDetail({
    id: "smoke-task-1",
    title: "Build Kanban planner app",
    status: "active",
    priority: "urgent",
    goal: "Build and verify a tiny Kanban planner app with accessible columns, cards, and persistence.",
    originalRequest:
      "Use Codex plus Cerebras gpt-oss-120b to build a planner app.",
    summary: "Codex has generated files; Cerebras is reviewing UX.",
    sessionCount: 2,
    activeSessionCount: 2,
    latestSessionId: "session-codex",
    latestSessionLabel: "Codex Builder",
    latestWorkdir: "/tmp/orchestrator-kanban",
    latestRepo: "/workspaces/eliza",
    latestActivityAt: startedAtMs,
    createdAt: startedAt,
    updatedAt: startedAt,
    acceptanceCriteria: [
      "Planner renders three workflow columns",
      "Cards can be created and moved",
      "Generated files pass syntax checks",
    ],
    currentPlan: {
      summary: "Build, review, and verify the Kanban planner.",
      steps: [
        { title: "Generate app shell", status: "completed" },
        { title: "Review visual affordances", status: "in_progress" },
        { title: "Run browser smoke checks", status: "pending" },
      ],
    },
    planRevisions: [
      {
        id: "plan-rev-1",
        threadId: "smoke-task-1",
        plan: {
          summary: "Build, review, and verify the Kanban planner.",
          steps: [
            { title: "Generate app shell", status: "completed" },
            { title: "Review visual affordances", status: "in_progress" },
            { title: "Run browser smoke checks", status: "pending" },
          ],
        },
        basePlanRevisionId: null,
        editSummary: null,
        createdBy: "system",
        metadata: {},
        timestamp: startedAtMs,
        createdAt: startedAt,
      },
    ],
    providerPolicy: {
      preferredFramework: "codex",
      providerSource: "cerebras",
      model: "gpt-oss-120b",
    },
    sessions: [
      {
        id: "session-codex-record",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        label: "Codex Builder",
        status: "running",
        framework: "codex",
        providerSource: "local-auth",
        model: "codex-cli",
        originalTask:
          "Generate the planner shell and persist card movement locally.",
        workdir: "/tmp/orchestrator-kanban",
        repo: "/workspaces/eliza",
        activeTool: "write",
        decisionCount: 0,
        autoResolvedCount: 0,
        registeredAt: startedAtMs,
        lastActivityAt: startedAtMs,
        idleCheckCount: 0,
        taskDelivered: true,
        completionSummary: null,
        lastSeenDecisionIndex: 0,
        lastInputSentAt: null,
        stoppedAt: null,
        inputTokens: 1200,
        outputTokens: 900,
        reasoningTokens: 0,
        totalTokens: 2100,
        cacheTokens: 0,
        costUsd: 0,
        usageState: "estimated",
        metadata: {},
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        id: "session-cerebras-record",
        threadId: "smoke-task-1",
        sessionId: "session-cerebras",
        label: "Cerebras Reviewer",
        status: "running",
        framework: "eliza",
        providerSource: "cerebras",
        model: "gpt-oss-120b",
        originalTask:
          "Review the planner visual affordances and interaction model.",
        workdir: "/tmp/orchestrator-kanban",
        repo: "/workspaces/eliza",
        activeTool: "review",
        decisionCount: 0,
        autoResolvedCount: 0,
        registeredAt: startedAtMs,
        lastActivityAt: startedAtMs,
        idleCheckCount: 0,
        taskDelivered: true,
        completionSummary: null,
        lastSeenDecisionIndex: 0,
        lastInputSentAt: null,
        stoppedAt: null,
        inputTokens: 8400,
        outputTokens: 2600,
        reasoningTokens: 1345,
        totalTokens: 12_345,
        cacheTokens: 0,
        costUsd: 0.42,
        usageState: "measured",
        metadata: {},
        createdAt: startedAt,
        updatedAt: startedAt,
      },
    ],
    artifacts: [
      {
        id: "artifact-index",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        title: "Kanban planner HTML",
        artifactType: "file",
        path: "planner/index.html",
        uri: null,
        mimeType: "text/html",
        verificationStatus: "passed",
        metadata: {},
        createdAt: startedAt,
      },
      {
        id: "artifact-test",
        threadId: "smoke-task-1",
        sessionId: "session-cerebras",
        title: "Browser smoke report",
        artifactType: "verification",
        path: "reports/kanban-smoke.md",
        uri: null,
        mimeType: "text/markdown",
        verificationStatus: "pending",
        metadata: {},
        createdAt: startedAt,
      },
    ],
    usage: richUsage,
  });

  return {
    tasks: [detail],
    messages: [
      {
        id: "message-user-1",
        threadId: "smoke-task-1",
        sessionId: null,
        senderKind: "user",
        direction: "stdout",
        content: "Create a compact Kanban planner app.",
        timestamp: startedAtMs - 4000,
        metadata: {},
        createdAt: new Date(startedAtMs - 4000).toISOString(),
      },
      {
        id: "message-agent-1",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        senderKind: "sub_agent",
        direction: "stdout",
        content: "Generated the planner shell and wired card movement.",
        timestamp: startedAtMs - 2000,
        metadata: {},
        createdAt: new Date(startedAtMs - 2000).toISOString(),
      },
    ],
    events: [
      {
        id: "event-tool-write",
        threadId: "smoke-task-1",
        sessionId: "session-codex",
        eventType: "tool_running",
        summary: "write planner files",
        timestamp: startedAtMs - 1000,
        data: {
          toolCall: {
            id: "tool-write-index",
            title: "write",
            kind: "edit",
            status: "completed",
            rawInput: {
              path: "planner/index.html",
              content: '<main id="board"></main>',
            },
            output: "Wrote planner/index.html",
          },
        },
        createdAt: new Date(startedAtMs - 1000).toISOString(),
      },
      {
        id: "event-validation",
        threadId: "smoke-task-1",
        sessionId: "session-cerebras",
        eventType: "task_registered",
        summary: "Cerebras reviewer joined for UX validation",
        timestamp: startedAtMs - 500,
        data: {},
        createdAt: new Date(startedAtMs - 500).toISOString(),
      },
    ],
    nextTaskId: 2,
    nextMessageId: 2,
    nextEventId: 2,
    nextSessionId: 3,
  };
}

function createDemoTaskDetail(overrides = {}) {
  const id = overrides.id ?? "smoke-task-1";
  const createdAt = overrides.createdAt ?? new Date().toISOString();
  return {
    id,
    title: "Audit orchestrator surface",
    kind: "coding",
    status: "open",
    priority: "high",
    paused: false,
    originalRequest: "Audit orchestrator surface",
    summary: "Created by ui-smoke demo mode.",
    sessionCount: 0,
    activeSessionCount: 0,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    usage: orchestratorUsage(),
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    closedAt: null,
    archivedAt: null,
    goal: "Verify controls, routing, and message flow.",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: ["Task appears in rail", "Message posts"],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    ...overrides,
  };
}

function summarizeDemoTask(detail) {
  return {
    id: detail.id,
    title: detail.title,
    kind: detail.kind,
    status: detail.status,
    priority: detail.priority,
    paused: detail.paused,
    originalRequest: detail.originalRequest,
    summary: detail.summary,
    sessionCount: detail.sessionCount,
    activeSessionCount: detail.activeSessionCount,
    latestSessionId: detail.latestSessionId,
    latestSessionLabel: detail.latestSessionLabel,
    latestWorkdir: detail.latestWorkdir,
    latestRepo: detail.latestRepo,
    latestActivityAt: detail.latestActivityAt,
    decisionCount: detail.decisionCount,
    usage: detail.usage,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    closedAt: detail.closedAt,
    archivedAt: detail.archivedAt,
  };
}

function demoOrchestratorStatus(state) {
  const visibleTasks = state.tasks;
  const byStatus = {
    open: 0,
    active: 0,
    waiting_on_user: 0,
    blocked: 0,
    validating: 0,
    done: 0,
    failed: 0,
    archived: 0,
    interrupted: 0,
  };
  let sessionCount = 0;
  let activeSessionCount = 0;
  for (const task of visibleTasks) {
    if (byStatus[task.status] !== undefined) byStatus[task.status] += 1;
    sessionCount += Number(task.sessionCount ?? 0);
    activeSessionCount += Number(task.activeSessionCount ?? 0);
  }
  return {
    taskCount: visibleTasks.length,
    activeTaskCount: byStatus.active,
    pausedTaskCount: visibleTasks.filter((task) => task.paused === true).length,
    blockedTaskCount: byStatus.blocked + byStatus.waiting_on_user,
    validatingTaskCount: byStatus.validating,
    sessionCount,
    activeSessionCount,
    usage: visibleTasks[0]?.usage ?? emptyOrchestratorUsage,
    byStatus,
  };
}

function demoTaskList(state, url) {
  const status = url.searchParams.get("status");
  const includeArchived = url.searchParams.get("includeArchived") === "true";
  const search = (url.searchParams.get("search") ?? "").toLowerCase();
  const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 50));
  return state.tasks
    .filter((task) => includeArchived || task.status !== "archived")
    .filter((task) => !status || task.status === status)
    .filter((task) => {
      if (!search) return true;
      return [task.title, task.goal, task.summary, task.originalRequest]
        .join(" ")
        .toLowerCase()
        .includes(search);
    })
    .slice(0, limit)
    .map(summarizeDemoTask);
}

function demoTimelinePage(state, taskId, url) {
  const limit =
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "100", 10)) ||
    100;
  const start =
    Math.max(0, Number.parseInt(url.searchParams.get("cursor") ?? "0", 10)) ||
    0;
  const items = [
    ...state.messages
      .filter((message) => message.threadId === taskId)
      .map((message) => ({
        id: `message:${message.id}`,
        kind: "message",
        threadId: message.threadId,
        sessionId: message.sessionId ?? null,
        timestamp: message.timestamp,
        createdAt: message.createdAt,
        message,
      })),
    ...state.events
      .filter((event) => event.threadId === taskId)
      .map((event) => ({
        id: `event:${event.id}`,
        kind: "event",
        threadId: event.threadId,
        sessionId: event.sessionId ?? null,
        timestamp: event.timestamp,
        createdAt: event.createdAt,
        event,
      })),
  ].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  const page = items.slice(start, start + limit);
  const next = start + limit;
  return {
    items: page,
    nextCursor: next < items.length ? String(next) : null,
  };
}

function pushDemoEvent(state, taskId, summary, data = {}) {
  const event = {
    id: `demo-event-${state.nextEventId++}`,
    threadId: taskId,
    sessionId: null,
    eventType: "operator_action",
    summary,
    timestamp: Date.now(),
    data,
    createdAt: new Date().toISOString(),
  };
  state.events.push(event);
  return event;
}

function pushDemoMessage(state, taskId, senderKind, content, sessionId = null) {
  const message = {
    id: `demo-message-${state.nextMessageId++}`,
    threadId: taskId,
    sessionId,
    senderKind,
    direction: "stdout",
    content,
    timestamp: Date.now(),
    metadata: {},
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  return message;
}

const demoOrchestratorState = DEMO_ORCHESTRATOR
  ? createDemoOrchestratorState()
  : null;

async function handleDemoOrchestratorRoute(req, res, url) {
  if (!demoOrchestratorState) return false;
  if (!url.pathname.startsWith("/api/orchestrator")) return false;

  if (req.method === "GET" && url.pathname === "/api/orchestrator/status") {
    sendJson(req, res, 200, demoOrchestratorStatus(demoOrchestratorState));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/orchestrator/tasks") {
    sendJson(req, res, 200, {
      tasks: demoTaskList(demoOrchestratorState, url),
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orchestrator/tasks") {
    const body = (await readJsonBody(req)) || {};
    const id = `demo-task-${demoOrchestratorState.nextTaskId++}`;
    const detail = createDemoTaskDetail({
      id,
      title: body.title || "Demo orchestrator task",
      goal: body.goal || body.originalRequest || body.title || "Demo task",
      originalRequest:
        body.originalRequest || body.goal || body.title || "Demo task",
      priority: body.priority || "normal",
      acceptanceCriteria: Array.isArray(body.acceptanceCriteria)
        ? body.acceptanceCriteria
        : ["Created from the visible local UI"],
      providerPolicy: body.providerPolicy ?? null,
      status: "open",
      summary: "Created locally in demo mode.",
      currentPlan: {
        summary: "Demo task created from the local UI.",
        steps: [
          { title: "Capture request", status: "completed" },
          { title: "Assign sub-agent", status: "pending" },
          { title: "Verify result", status: "pending" },
        ],
      },
    });
    demoOrchestratorState.tasks.unshift(detail);
    pushDemoMessage(
      demoOrchestratorState,
      id,
      "user",
      detail.originalRequest || detail.goal,
    );
    pushDemoEvent(demoOrchestratorState, id, "Task created from local demo UI");
    sendJson(req, res, 200, detail);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/orchestrator/pause-all") {
    for (const task of demoOrchestratorState.tasks) task.paused = true;
    sendJson(req, res, 200, { paused: demoOrchestratorState.tasks.length });
    return true;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/orchestrator/resume-all"
  ) {
    for (const task of demoOrchestratorState.tasks) task.paused = false;
    sendJson(req, res, 200, { resumed: demoOrchestratorState.tasks.length });
    return true;
  }

  const taskPath = url.pathname.slice("/api/orchestrator/tasks/".length);
  if (!taskPath || taskPath === url.pathname) return false;
  const parts = taskPath.split("/").map((part) => decodeURIComponent(part));
  const [taskId, action, subId, subAction] = parts;
  const task = demoOrchestratorState.tasks.find((item) => item.id === taskId);

  if (action === "stream" && req.method === "GET") {
    sendReadySseStream(req, res);
    return true;
  }

  if (!task) {
    sendJson(req, res, 404, { error: `Task not found: ${taskId}` });
    return true;
  }

  if (!action) {
    if (req.method === "GET") {
      sendJson(req, res, 200, task);
      return true;
    }
    if (req.method === "PATCH") {
      const body = (await readJsonBody(req)) || {};
      Object.assign(task, body, { updatedAt: new Date().toISOString() });
      sendJson(req, res, 200, task);
      return true;
    }
    if (req.method === "DELETE") {
      demoOrchestratorState.tasks = demoOrchestratorState.tasks.filter(
        (item) => item.id !== taskId,
      );
      demoOrchestratorState.messages = demoOrchestratorState.messages.filter(
        (item) => item.threadId !== taskId,
      );
      demoOrchestratorState.events = demoOrchestratorState.events.filter(
        (item) => item.threadId !== taskId,
      );
      sendJson(req, res, 200, { deleted: true });
      return true;
    }
  }

  if (action === "messages") {
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        items: demoOrchestratorState.messages.filter(
          (item) => item.threadId === taskId,
        ),
        nextCursor: null,
      });
      return true;
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) || {};
      const content = String(body.content ?? "").trim();
      if (content) {
        pushDemoMessage(demoOrchestratorState, taskId, "user", content);
        pushDemoMessage(
          demoOrchestratorState,
          taskId,
          "orchestrator",
          `Demo orchestrator received: ${content}`,
        );
        pushDemoEvent(demoOrchestratorState, taskId, "Message forwarded");
        task.summary = "New demo message received from the local UI.";
        task.updatedAt = new Date().toISOString();
      }
      sendJson(req, res, 200, { recorded: true, forwardedTo: [] });
      return true;
    }
  }

  if (action === "events" && req.method === "GET") {
    sendJson(req, res, 200, {
      items: demoOrchestratorState.events.filter(
        (item) => item.threadId === taskId,
      ),
      nextCursor: null,
    });
    return true;
  }

  if (action === "timeline" && req.method === "GET") {
    sendJson(
      req,
      res,
      200,
      demoTimelinePage(demoOrchestratorState, taskId, url),
    );
    return true;
  }

  if (action === "usage" && req.method === "GET") {
    sendJson(req, res, 200, task.usage ?? emptyOrchestratorUsage);
    return true;
  }

  if (action === "plan-revisions") {
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        items: task.planRevisions ?? [],
        nextCursor: null,
      });
      return true;
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) || {};
      const revision = {
        id: `plan-rev-${(task.planRevisions?.length ?? 0) + 1}`,
        threadId: taskId,
        plan: body.plan ?? task.currentPlan ?? {},
        basePlanRevisionId: body.basePlanRevisionId ?? null,
        editSummary: body.editSummary ?? "Edited in local demo mode",
        createdBy: body.createdBy ?? "operator",
        metadata: body.metadata ?? {},
        timestamp: Date.now(),
        createdAt: new Date().toISOString(),
      };
      task.planRevisions = [revision, ...(task.planRevisions ?? [])];
      task.currentPlan = revision.plan;
      sendJson(req, res, 200, revision);
      return true;
    }
  }

  if (action === "agents" && req.method === "POST" && !subId) {
    const body = (await readJsonBody(req)) || {};
    const sessionId = `demo-session-${demoOrchestratorState.nextSessionId++}`;
    const session = {
      id: `${sessionId}-record`,
      threadId: taskId,
      sessionId,
      label: body.label || "Demo sub-agent",
      status: "running",
      framework: body.framework || "codex",
      providerSource: body.providerSource || "local-demo",
      model: body.model || "gpt-5.4",
      originalTask: body.task || "Assist with the demo task.",
      workdir: body.workdir || task.latestWorkdir || "/tmp/orchestrator-demo",
      repo: body.repo || task.latestRepo || null,
      activeTool: "thinking",
      decisionCount: 0,
      autoResolvedCount: 0,
      registeredAt: Date.now(),
      lastActivityAt: Date.now(),
      idleCheckCount: 0,
      taskDelivered: true,
      completionSummary: null,
      lastSeenDecisionIndex: 0,
      lastInputSentAt: null,
      stoppedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      usageState: "estimated",
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    task.sessions = [...(task.sessions ?? []), session];
    task.sessionCount = task.sessions.length;
    task.activeSessionCount = task.sessions.filter(
      (item) => item.status === "running",
    ).length;
    task.latestSessionId = session.sessionId;
    task.latestSessionLabel = session.label;
    task.latestActivityAt = session.lastActivityAt;
    pushDemoEvent(demoOrchestratorState, taskId, `Added ${session.label}`);
    sendJson(req, res, 200, task);
    return true;
  }

  if (
    action === "agents" &&
    subId &&
    subAction === "stop" &&
    req.method === "POST"
  ) {
    task.sessions = (task.sessions ?? []).map((session) =>
      session.sessionId === subId
        ? {
            ...session,
            status: "stopped",
            stoppedAt: Date.now(),
            activeTool: null,
            updatedAt: new Date().toISOString(),
          }
        : session,
    );
    task.activeSessionCount = task.sessions.filter(
      (item) => item.status === "running",
    ).length;
    pushDemoEvent(demoOrchestratorState, taskId, `Stopped agent ${subId}`);
    sendJson(req, res, 200, { stopped: true });
    return true;
  }

  if (req.method === "POST") {
    const body = (await readJsonBody(req)) || {};
    if (action === "pause") {
      task.paused = true;
      pushDemoEvent(demoOrchestratorState, taskId, "Task paused");
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "resume") {
      task.paused = false;
      pushDemoEvent(demoOrchestratorState, taskId, "Task resumed");
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "archive") {
      task.status = "archived";
      task.archivedAt = new Date().toISOString();
      pushDemoEvent(demoOrchestratorState, taskId, "Task archived");
      sendJson(req, res, 200, { archived: true });
      return true;
    }
    if (action === "reopen") {
      task.status = "open";
      task.archivedAt = null;
      pushDemoEvent(demoOrchestratorState, taskId, "Task reopened");
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "fork") {
      const forked = createDemoTaskDetail({
        ...task,
        id: `demo-task-${demoOrchestratorState.nextTaskId++}`,
        title: body.title || `Fork of ${task.title}`,
        goal: body.goal || task.goal,
        parentTaskId: task.id,
        status: "open",
        archivedAt: null,
        sessions: [],
        sessionCount: 0,
        activeSessionCount: 0,
      });
      demoOrchestratorState.tasks.unshift(forked);
      pushDemoEvent(demoOrchestratorState, forked.id, "Task forked");
      sendJson(req, res, 200, forked);
      return true;
    }
    if (action === "validate") {
      task.status = body.passed === true ? "done" : "blocked";
      task.summary = body.summary || task.summary;
      pushDemoEvent(
        demoOrchestratorState,
        taskId,
        "Validation submitted",
        body,
      );
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "retry-turn") {
      pushDemoEvent(
        demoOrchestratorState,
        taskId,
        "Retry turn requested",
        body,
      );
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "rerun-from-event") {
      pushDemoEvent(
        demoOrchestratorState,
        taskId,
        "Rerun from event requested",
        body,
      );
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "restart") {
      task.status = "active";
      pushDemoEvent(
        demoOrchestratorState,
        taskId,
        "Task restart requested",
        body,
      );
      sendJson(req, res, 200, task);
      return true;
    }
    if (action === "restart-with-edited-plan") {
      task.status = "active";
      if (body.plan && typeof body.plan === "object")
        task.currentPlan = body.plan;
      pushDemoEvent(
        demoOrchestratorState,
        taskId,
        "Restart with edited plan requested",
        body,
      );
      sendJson(req, res, 200, task);
      return true;
    }
  }

  sendJson(req, res, 404, {
    error: `Unhandled demo orchestrator route ${url.pathname}`,
  });
  return true;
}

function streamSettings(payload = {}) {
  return {
    ok: true,
    settings: {
      theme: "eliza",
      avatarIndex: 0,
      ...payload,
    },
  };
}

const databaseRowsByTable = {
  messages: [
    {
      id: "msg-smoke-1",
      content:
        "UI smoke database row with https://example.com/smoke-image.png media",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
    },
    {
      id: "msg-smoke-2",
      content: "UI smoke vector sample row",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
    },
  ],
  memories: [
    {
      id: "memory-smoke-1",
      text: "Deterministic memory fixture for UI smoke.",
      roomId: "room-smoke",
      entityId: "entity-smoke",
      createdAt: SMOKE_GENERATED_AT,
      dim_0: 0.12,
      dim_1: 0.34,
      dim_2: 0.56,
    },
  ],
  media: [
    {
      id: "media-smoke-1",
      url: "https://example.com/smoke-image.png",
      type: "image",
      filename: "smoke-image.png",
      createdAt: SMOKE_GENERATED_AT,
    },
  ],
};

const databaseTables = Object.entries(databaseRowsByTable).map(
  ([name, rows]) => ({
    name,
    schema: "public",
    rowCount: rows.length,
    columns: Object.keys(rows[0] ?? {}).map((columnName) => ({
      name: columnName,
      type: columnName.startsWith("dim_") ? "double precision" : "text",
      nullable: false,
      defaultValue: null,
      isPrimaryKey: columnName === "id",
    })),
  }),
);

function databaseRowsResponse(tableName, url) {
  const rows = databaseRowsByTable[tableName] ?? [];
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const sort = url.searchParams.get("sort");
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const sortedRows = sort
    ? [...rows].sort((left, right) => {
        const leftValue = String(left[sort] ?? "");
        const rightValue = String(right[sort] ?? "");
        return order === "desc"
          ? rightValue.localeCompare(leftValue)
          : leftValue.localeCompare(rightValue);
      })
    : rows;
  const pageRows = sortedRows.slice(offset, offset + limit);
  return {
    table: tableName,
    rows: pageRows,
    columns: Object.keys(rows[0] ?? {}),
    total: rows.length,
    offset,
    limit,
  };
}

function executeDatabaseQueryResult(sql) {
  const match = /from\s+"?([a-z0-9_-]+)"?/iu.exec(sql ?? "");
  const tableName =
    match?.[1] && databaseRowsByTable[match[1]] ? match[1] : "messages";
  const rows = databaseRowsByTable[tableName] ?? [];
  return {
    columns: Object.keys(rows[0] ?? {}),
    rows,
    rowCount: rows.length,
    durationMs: 1,
  };
}

const sockets = new Set();
const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `127.0.0.1:${port}`}`,
  );

  if (req.method === "OPTIONS") {
    sendEmpty(req, res, 204);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/avatar/vrm"
  ) {
    // The character VRM is optional. A 404 mirrors "no custom avatar configured";
    // returning the catch-all 501 makes diagnostics treat the fallback as a bug.
    sendEmpty(req, res, 404);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/avatar/background"
  ) {
    sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname.startsWith("/api/apps/hero/")
  ) {
    sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/commands") {
    sendJson(req, res, 200, {
      commands: [],
      surface: url.searchParams.get("surface"),
      agentId: null,
      generatedAt: SMOKE_GENERATED_AT,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/custom-actions") {
    sendJson(req, res, 200, { actions: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/notifications") {
    const notifications = SMOKE_NOTIFICATIONS ? smokeNotifications : [];
    sendJson(req, res, 200, {
      notifications,
      unreadCount: notifications.filter((notification) => {
        return !notification.readAt;
      }).length,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/views") {
    const requestedViewType = url.searchParams.get("viewType");
    const views =
      requestedViewType === "gui" || requestedViewType === "tui"
        ? smokeViews.filter((view) => view.viewType === requestedViewType)
        : smokeViews;
    sendJson(req, res, 200, { views });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/views/current") {
    sendJson(req, res, 200, { currentView: null });
    return;
  }

  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname.startsWith("/api/views/")
  ) {
    const afterPrefix = url.pathname.slice("/api/views/".length);
    const slashIndex = afterPrefix.indexOf("/");
    const rawId =
      slashIndex === -1 ? afterPrefix : afterPrefix.slice(0, slashIndex);
    const subResource =
      slashIndex === -1 ? "" : afterPrefix.slice(slashIndex + 1);
    const id = decodeURIComponent(rawId);
    const view = smokeViewByRequest(id, url.searchParams.get("viewType"));
    if (!view) {
      sendJson(req, res, 404, { error: `View not found: ${id}` });
      return;
    }
    if (subResource === "") {
      sendJson(req, res, 200, view);
      return;
    }
    if (subResource === "hero") {
      sendBinary(req, res, 200, "image/png", ONE_PIXEL_PNG);
      return;
    }
    if (subResource === "bundle.js") {
      sendSmokeViewAsset(req, res, url, view, "bundle.js");
      return;
    }
    sendSmokeViewAsset(req, res, url, view, subResource);
    return;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/views/")) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(req, res, 200, { status: "ok" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/first-run/status") {
    sendJson(req, res, 200, { complete: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/first-run/options") {
    sendJson(req, res, 200, {
      names: [],
      styles: [],
      providers: [],
      cloudProviders: [],
      models: {
        nano: [],
        small: [],
        medium: [],
        large: [],
        mega: [],
      },
      inventoryProviders: [],
      sharedStyleRules: "",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    sendJson(req, res, 200, {
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    sendJson(req, res, 200, {
      identity: stubAuthIdentity,
      session: stubAuthSession,
      access: stubAuthAccess,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/sessions") {
    sendJson(req, res, 200, {
      sessions: [
        {
          id: stubAuthSession.id,
          kind: stubAuthSession.kind,
          ip: "127.0.0.1",
          userAgent: "Playwright smoke",
          lastSeenAt: Date.now(),
          expiresAt: null,
          current: true,
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/status") {
    sendJson(req, res, 200, { firstRunComplete: true, status: "running" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(req, res, 200, {
      state: "running",
      agentName: "Playwright Smoke",
      model: "ui-smoke",
      startup: { phase: "running", attempt: 0 },
      pendingRestart: false,
      pendingRestartReasons: [],
    });
    return;
  }

  if (url.pathname === "/api/config") {
    const config = {
      cloud: { enabled: false },
      media: {},
      // Select the local-inference voice provider so the /chat overlay's
      // bidirectional loop drives /api/asr/local-inference (in) and
      // /api/tts/local-inference (out) — both stubbed below.
      messages: {
        tts: { provider: "local-inference" },
        asr: { provider: "local-inference" },
      },
      plugins: { entries: {} },
      ui: {},
      wallet: {},
    };
    if (req.method === "GET") {
      sendJson(req, res, 200, config);
      return;
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const body = (await readJsonBody(req)) || {};
      sendJson(req, res, 200, {
        ...config,
        ...(body && typeof body === "object" && !Array.isArray(body)
          ? body
          : {}),
      });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/database/status") {
    sendJson(req, res, 200, {
      provider: "pglite",
      connected: true,
      serverVersion: "16.0-ui-smoke",
      tableCount: databaseTables.length,
      pgliteDataDir: null,
      postgresHost: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/config") {
    sendJson(req, res, 200, {
      config: {},
      activeProvider: "pglite",
      needsRestart: false,
    });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/database/config") {
    sendJson(req, res, 200, {
      config: (await readJsonBody(req)) || {},
      activeProvider: "pglite",
      needsRestart: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/database/test") {
    sendJson(req, res, 200, {
      success: true,
      serverVersion: "16.0-ui-smoke",
      error: null,
      durationMs: 1,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/database/tables") {
    sendJson(req, res, 200, { tables: databaseTables });
    return;
  }

  const databaseRowsMatch = /^\/api\/database\/tables\/([^/]+)\/rows$/.exec(
    url.pathname,
  );
  if (databaseRowsMatch) {
    const tableName = decodeURIComponent(databaseRowsMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, databaseRowsResponse(tableName, url));
      return;
    }
    if (["POST", "PUT", "DELETE"].includes(req.method ?? "GET")) {
      sendJson(req, res, 200, {
        ok: true,
        table: tableName,
        row: databaseRowsByTable[tableName]?.[0] ?? null,
      });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/database/query") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, executeDatabaseQueryResult(String(body.sql ?? "")));
    return;
  }

  if (
    (req.method === "GET" || req.method === "POST") &&
    url.pathname === "/api/database/vectors/search"
  ) {
    const query =
      req.method === "POST"
        ? (await readJsonBody(req))?.query
        : url.searchParams.get("query");
    sendJson(req, res, 200, {
      query: typeof query === "string" ? query : "",
      table: "memories",
      limit: 10,
      count: 1,
      results: [
        {
          id: "memory-smoke-1",
          text: "Deterministic memory fixture for UI smoke.",
          similarity: 0.98,
          roomId: "room-smoke",
          entityId: "entity-smoke",
          createdAt: SMOKE_GENERATED_AT,
          tableName: "memories",
        },
      ],
    });
    return;
  }

  if (url.pathname === "/api/conversations") {
    if (req.method === "GET") {
      sendJson(req, res, 200, { conversations: stubConversations });
      return;
    }
    if (req.method === "POST") {
      const body = (await readJsonBody(req)) || {};
      const conversation = createStubConversation({
        title: body.title,
        metadata: body.metadata,
      });
      sendJson(req, res, 200, { conversation });
      return;
    }
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/conversations/cleanup-empty"
  ) {
    const body = (await readJsonBody(req)) || {};
    const deleted = cleanupEmptyStubConversations({
      keepId: body.keepId,
    });
    sendJson(req, res, 200, { deleted });
    return;
  }

  const conversationMessagesMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/messages(?:\/(stream|truncate))?$/,
  );
  if (conversationMessagesMatch) {
    const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
    const action = conversationMessagesMatch[2] ?? null;
    const conversation = findStubConversation(conversationId);
    if (!conversation) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }

    if (req.method === "GET" && action === null) {
      sendJson(req, res, 200, {
        messages: stubConversationMessages.get(conversationId) ?? [],
      });
      return;
    }

    if (req.method === "POST" && action === "truncate") {
      stubConversationMessages.set(conversationId, []);
      conversation.updatedAt = nowIso();
      sendJson(req, res, 200, { ok: true, messages: [] });
      return;
    }

    if (req.method === "POST" && action === "stream") {
      const body = (await readJsonBody(req)) || {};
      const userMessage = createStubMessage("user", body.text);
      appendStubMessage(conversationId, userMessage);
      const text = createDeterministicAssistantText({
        body,
        conversationId,
        transport: "sse",
      });
      const assistantMessage = createStubMessage("assistant", text);
      appendStubMessage(conversationId, assistantMessage);
      sendSseHeaders(req, res);
      writeSseEvent(res, { type: "token", text, fullText: text });
      writeSseEvent(res, {
        type: "done",
        fullText: text,
        agentName: "Eliza",
        messageId: assistantMessage.id,
        userMessageId: userMessage.id,
      });
      res.end();
      maybeBroadcastAssistantNavigation(body.text);
      return;
    }

    if (req.method === "POST" && action === null) {
      const body = (await readJsonBody(req)) || {};
      const userMessage = createStubMessage("user", body.text);
      appendStubMessage(conversationId, userMessage);
      const text = createDeterministicAssistantText({
        body,
        conversationId,
        transport: "json",
      });
      const assistantMessage = createStubMessage("assistant", text);
      appendStubMessage(conversationId, assistantMessage);
      sendJson(req, res, 200, {
        text,
        agentName: "Eliza",
        messageId: assistantMessage.id,
        userMessageId: userMessage.id,
      });
      maybeBroadcastAssistantNavigation(body.text);
      return;
    }
  }

  const conversationMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)$/,
  );
  if (conversationMatch) {
    const conversationId = decodeURIComponent(conversationMatch[1]);
    const conversation = findStubConversation(conversationId);
    if (!conversation) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }
    if (req.method === "PATCH") {
      const body = (await readJsonBody(req)) || {};
      if (typeof body.title === "string" && body.title.trim().length > 0) {
        conversation.title = body.title.trim();
      }
      if (
        Object.hasOwn(body, "metadata") &&
        body.metadata &&
        typeof body.metadata === "object" &&
        !Array.isArray(body.metadata)
      ) {
        conversation.metadata = body.metadata;
      }
      conversation.updatedAt = nowIso();
      sendJson(req, res, 200, { conversation });
      return;
    }
    if (req.method === "DELETE") {
      const index = stubConversations.findIndex(
        (item) => item.id === conversationId,
      );
      if (index >= 0) stubConversations.splice(index, 1);
      stubConversationMessages.delete(conversationId);
      sendJson(req, res, 200, { ok: true });
      return;
    }
  }

  const conversationGreetingMatch = url.pathname.match(
    /^\/api\/conversations\/([^/]+)\/greeting$/,
  );
  if (req.method === "POST" && conversationGreetingMatch) {
    const conversationId = decodeURIComponent(conversationGreetingMatch[1]);
    if (!findStubConversation(conversationId)) {
      sendJson(req, res, 404, { error: "Conversation not found" });
      return;
    }
    sendJson(req, res, 200, {
      text: "What would you like to check?",
      agentName: "Eliza",
      generated: false,
      persisted: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agents") {
    sendJson(req, res, 200, { agents: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workbench/overview") {
    sendJson(req, res, 200, workbenchOverview());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/workbench/todos") {
    sendJson(req, res, 200, { todos: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/plugins") {
    sendJson(req, res, 200, { plugins: stubPlugins });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runtime") {
    sendJson(req, res, 200, buildRuntimeSnapshot(url));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runtime/mode") {
    sendJson(req, res, 200, {
      mode: "local",
      deploymentRuntime: "local",
      isRemoteController: false,
      remoteApiBaseConfigured: false,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/stats") {
    sendJson(req, res, 200, stubMemoryStats);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/feed") {
    sendJson(req, res, 200, stubMemoryFeedResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/memories/browse") {
    const limit = Number(url.searchParams.get("limit") || "50");
    const offset = Number(url.searchParams.get("offset") || "0");
    sendJson(req, res, 200, {
      ...stubMemoryBrowseResponse,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname.startsWith("/api/memories/by-entity/")
  ) {
    const limit = Number(url.searchParams.get("limit") || "50");
    const offset = Number(url.searchParams.get("offset") || "0");
    sendJson(req, res, 200, {
      ...stubMemoryBrowseResponse,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/graph") {
    sendJson(req, res, 200, stubRelationshipsGraphResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/people") {
    sendJson(req, res, 200, stubRelationshipsPeopleResponse);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-workspace") {
    sendJson(req, res, 200, browserWorkspaceSnapshot());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/browser-workspace/tabs") {
    const body = (await readJsonBody(req)) || {};
    const urlValue = normalizeStubBrowserUrl(body.url || "about:blank");
    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : inferStubBrowserTitle(urlValue);
    const timestamp = nowIso();
    const tab = {
      id: `stub-tab-${++browserWorkspaceCounter}`,
      title,
      url: urlValue,
      partition: "persist:ui-smoke",
      visible: body.show !== false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastFocusedAt: body.show !== false ? timestamp : null,
    };
    if (tab.visible) {
      browserWorkspaceTabs = browserWorkspaceTabs.map((entry) => ({
        ...entry,
        visible: false,
      }));
    }
    browserWorkspaceTabs = [...browserWorkspaceTabs, tab];
    sendJson(req, res, 200, { tab });
    return;
  }

  const browserTabMatch =
    /^\/api\/browser-workspace\/tabs\/([^/]+)(?:\/(navigate|show|hide))?$/.exec(
      url.pathname,
    );
  if (browserTabMatch) {
    const tabId = decodeURIComponent(browserTabMatch[1]);
    const action = browserTabMatch[2] || null;
    const existing = browserWorkspaceTabs.find((tab) => tab.id === tabId);
    if (!existing) {
      sendJson(req, res, 404, { error: `Tab not found: ${tabId}` });
      return;
    }

    if (req.method === "DELETE" && !action) {
      browserWorkspaceTabs = browserWorkspaceTabs.filter(
        (tab) => tab.id !== tabId,
      );
      sendJson(req, res, 200, { closed: true });
      return;
    }

    if (req.method === "POST" && action === "show") {
      sendJson(req, res, 200, { tab: showBrowserWorkspaceTab(tabId) });
      return;
    }

    if (req.method === "POST" && action === "hide") {
      browserWorkspaceTabs = browserWorkspaceTabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, visible: false, updatedAt: nowIso() }
          : tab,
      );
      sendJson(req, res, 200, {
        tab: browserWorkspaceTabs.find((tab) => tab.id === tabId),
      });
      return;
    }

    if (req.method === "POST" && action === "navigate") {
      const body = (await readJsonBody(req)) || {};
      const nextUrl = normalizeStubBrowserUrl(body.url);
      const nextUpdatedAt = nowIso();
      browserWorkspaceTabs = browserWorkspaceTabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              url: nextUrl,
              title: inferStubBrowserTitle(nextUrl),
              updatedAt: nextUpdatedAt,
              lastFocusedAt: nextUpdatedAt,
            }
          : tab,
      );
      sendJson(req, res, 200, {
        tab: browserWorkspaceTabs.find((tab) => tab.id === tabId),
      });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/character") {
    sendJson(req, res, 200, { character: stubCharacter, agentName: "Eliza" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/character/history") {
    sendJson(req, res, 200, { history: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/character/experiences") {
    sendJson(req, res, 200, {
      data: stubExperiences,
      total: stubExperiences.length,
    });
    return;
  }

  // Experience edit/delete seams: the Experience view's per-record PATCH
  // (inline edit save) and DELETE (remove) both target
  // /api/character/experiences/:id. Mutate the in-memory stub list so the
  // follow-up GET reflects the write.
  {
    const experienceMatch = /^\/api\/character\/experiences\/([^/]+)$/.exec(
      url.pathname,
    );
    if (experienceMatch) {
      const experienceId = decodeURIComponent(experienceMatch[1]);
      const index = stubExperiences.findIndex(
        (experience) => experience.id === experienceId,
      );
      if (req.method === "GET") {
        if (index === -1) {
          sendJson(req, res, 404, { error: "experience not found" });
          return;
        }
        sendJson(req, res, 200, { data: stubExperiences[index] });
        return;
      }
      if (req.method === "PATCH") {
        if (index === -1) {
          sendJson(req, res, 404, { error: "experience not found" });
          return;
        }
        const body = (await readJsonBody(req)) || {};
        Object.assign(stubExperiences[index], body, {
          id: experienceId,
          updatedAt: nowIso(),
        });
        sendJson(req, res, 200, { data: stubExperiences[index] });
        return;
      }
      if (req.method === "DELETE") {
        if (index !== -1) stubExperiences.splice(index, 1);
        sendJson(req, res, 200, { success: true });
        return;
      }
    }
  }

  if (req.method === "GET" && url.pathname === "/api/relationships/activity") {
    sendJson(req, res, 200, { activity: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/documents") {
    sendJson(req, res, 200, {
      documents: [],
      total: 0,
      limit: parsePositiveInt(url.searchParams.get("limit"), 100),
      offset: parsePositiveInt(url.searchParams.get("offset"), 0),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/voice/profiles") {
    sendJson(req, res, 200, { profiles: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/subscription/status") {
    sendJson(req, res, 200, { providers: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/update/status") {
    sendJson(req, res, 200, {
      currentVersion: "0.0.0-ui-smoke",
      channel: "stable",
      installMethod: "source",
      updateAuthority: "manual",
      nextAction: "manual",
      canAutoUpdate: false,
      canExecuteUpdate: false,
      remoteDisplay: false,
      updateCommand: null,
      updateInstructions: null,
      updateAvailable: false,
      latestVersion: "0.0.0-ui-smoke",
      channels: {
        stable: "0.0.0-ui-smoke",
        beta: "0.0.0-ui-smoke",
        nightly: "0.0.0-ui-smoke",
      },
      distTags: {},
      lastCheckAt: null,
      error: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions") {
    const permission = {
      id: "shell",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: process.platform,
    };
    sendJson(req, res, 200, {
      shell: permission,
      notifications: { ...permission, id: "notifications" },
      microphone: { ...permission, id: "microphone" },
      camera: { ...permission, id: "camera" },
      "screen-capture": { ...permission, id: "screen-capture" },
      accessibility: { ...permission, id: "accessibility" },
      "website-blocking": {
        ...permission,
        id: "website-blocking",
        status: "not-applicable",
      },
      _platform: process.platform,
      _shellEnabled: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/permissions/shell") {
    sendJson(req, res, 200, {
      id: "shell",
      status: "granted",
      lastChecked: Date.now(),
      canRequest: false,
      platform: process.platform,
    });
    return;
  }

  // OWNER-only consumer-key administration is backed by an agent-host facade
  // in production. The deterministic smoke fixture models a healthy host with
  // no issued keys for the exact read-only collection route; writes and item
  // routes deliberately continue to the catch-all 501 below so the fixture
  // never fabricates key-management authority.
  if (req.method === "GET" && url.pathname === "/api/accounts/consumer-keys") {
    sendJson(req, res, 200, { keys: [] });
    return;
  }

  if (
    (req.method === "GET" || req.method === "PUT") &&
    url.pathname === "/api/secrets/manager/preferences"
  ) {
    if (req.method === "PUT") {
      await readJsonBody(req);
    }
    sendJson(req, res, 200, {
      preferences: { enabled: ["in-house"], routing: {} },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/backends"
  ) {
    sendJson(req, res, 200, {
      backends: [
        {
          id: "in-house",
          label: "Local (encrypted)",
          available: true,
          signedIn: true,
          detail: "UI smoke local vault",
          authMode: null,
        },
      ],
    });
    return;
  }

  // Secrets-manager modal load endpoints — the modal's load() requires all of
  // these to be ok or it shows an error banner instead of the tabs/add-secret
  // form. Minimal valid shapes (vault-tabs/types.ts) so the modal renders.
  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/backends"
  ) {
    sendJson(req, res, 200, {
      backends: [{ id: "in-house", label: "In-House Vault", available: true }],
    });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/preferences"
  ) {
    sendJson(req, res, 200, { preferences: { enabled: ["in-house"] } });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/install/methods"
  ) {
    sendJson(req, res, 200, { methods: {} });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/secrets/manager/protection"
  ) {
    // The smoke host has no platform secure-store backend. Preserve the real
    // protection DTO while reporting that boundary as unavailable rather than
    // claiming a device key exists.
    sendJson(req, res, 200, {
      ok: true,
      protection: {
        localVault: {
          encryptedAtRest: true,
          cipher: "AES-256-GCM",
          masterKey: {
            backend: "none",
            available: false,
            synchronized: false,
            scope: "unavailable",
            access: "unavailable",
          },
        },
        nativeSessionState: {
          policy: "platform-protected-store",
          synchronized: false,
          plaintextFallback: false,
        },
        connectorSessions: {
          telegramPersonal: "vault-master-key-encrypted",
        },
        cloudTrustDomain: "separate-organization-kms",
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/secrets/logins") {
    sendJson(req, res, 200, { ok: true, logins: [], failures: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/secrets/routing") {
    sendJson(req, res, 200, { config: { rules: [] } });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/secrets/inventory") {
    const category = url.searchParams.get("category");
    sendJson(req, res, 200, {
      entries:
        category === "wallet"
          ? [
              {
                key: "EVM_PRIVATE_KEY",
                label: "EVM private key",
                category: "wallet",
                backend: "in-house",
                isSet: true,
                updatedAt: SMOKE_GENERATED_AT,
              },
              {
                key: "SOLANA_PRIVATE_KEY",
                label: "Solana private key",
                category: "wallet",
                backend: "in-house",
                isSet: true,
                updatedAt: SMOKE_GENERATED_AT,
              },
            ]
          : [],
    });
    return;
  }

  const secretInventoryMatch = /^\/api\/secrets\/inventory\/([^/]+)$/.exec(
    url.pathname,
  );
  if (secretInventoryMatch) {
    const key = decodeURIComponent(secretInventoryMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        value: key.includes("SOLANA")
          ? "5HueCGU8rMjxEXxiPuD5BDuRa"
          : "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        source: "bare",
      });
      return;
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      if (req.method === "PUT") {
        await readJsonBody(req);
      }
      sendJson(req, res, 200, { ok: true, key });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/addresses") {
    sendJson(req, res, 200, { evmAddress: null, solanaAddress: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/config") {
    sendJson(req, res, 200, emptyWalletConfig);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/wallet/config") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ...emptyWalletConfig,
      selectedRpcProviders:
        body && typeof body === "object" && "selections" in body
          ? body.selections
          : emptyWalletConfig.selectedRpcProviders,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/keys") {
    sendJson(req, res, 200, {
      evmPrivateKeySet: true,
      solanaPrivateKeySet: true,
      evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
      solanaAddress: "So11111111111111111111111111111111111111112",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/os-store") {
    sendJson(req, res, 200, {
      available: true,
      backend: "in-house",
      evmKeyInOsStore: true,
      solanaKeyInOsStore: true,
      envKeysPresent: false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/os-store") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, { ok: true, action: body.action ?? null });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/refresh-cloud") {
    sendJson(req, res, 200, {
      ok: true,
      imported: [],
      warnings: [],
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/primary") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, { ok: true, ...body });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/generate") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ok: true,
      chain: body.chain ?? "evm",
      source: body.source ?? "local",
      address:
        body.chain === "solana"
          ? "So11111111111111111111111111111111111111112"
          : "0x1234567890abcdef1234567890abcdef12345678",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallet/export") {
    await readJsonBody(req);
    sendJson(req, res, 200, {
      evmPrivateKey:
        "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      solanaPrivateKey: "5HueCGU8rMjxEXxiPuD5BDuRa",
    });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/wallet/production-defaults"
  ) {
    await readJsonBody(req);
    sendJson(req, res, 200, {
      ok: true,
      updated: true,
      warnings: [],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/balances") {
    sendJson(req, res, 200, emptyWalletBalances);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/nfts") {
    sendJson(req, res, 200, emptyWalletNfts);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/trading/profile") {
    sendJson(req, res, 200, emptyWalletTradingProfile);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallet/market-overview") {
    sendJson(req, res, 200, emptyWalletMarketOverview);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream/settings") {
    sendJson(req, res, 200, streamSettings());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stream/settings") {
    const body = await readJsonBody(req);
    const settings =
      body &&
      typeof body === "object" &&
      body.settings &&
      typeof body.settings === "object"
        ? body.settings
        : {};
    sendJson(req, res, 200, streamSettings(settings));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stream/status") {
    sendJson(req, res, 200, {
      isLive: false,
      isConnected: false,
      viewers: 0,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/cloud/status") {
    sendJson(req, res, 200, {
      connected: false,
      enabled: false,
      cloudVoiceProxyAvailable: false,
      hasApiKey: false,
      reason: "runtime_not_started",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/events") {
    sendJson(req, res, 200, {
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/approvals") {
    // Mirror the canonical pending-actions route
    // (packages/agent/src/api/approval-routes.ts). With no approval service in
    // the smoke stub, the real route serves an empty pending list so the home
    // widget stays quiet and retries without logging a 501.
    sendJson(req, res, 200, { pending: [] });
    return;
  }

  // The computer-use session view polls this route as soon as its real bundle
  // mounts. A fresh keyless smoke runtime has no sessions, so mirror the real
  // route's designed-empty response instead of surfacing the catch-all 501 as
  // a product console error in lifecycle, interaction, and visual coverage.
  if (req.method === "GET" && url.pathname === "/api/computer-use/sessions") {
    sendJson(req, res, 200, { sessions: [] });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/computer-use/approvals/stream"
  ) {
    sendSseHeaders(req, res);
    writeSseEvent(res, {
      type: "snapshot",
      snapshot: emptyComputerUseApprovalSnapshot,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/computer-use/approvals") {
    sendJson(req, res, 200, emptyComputerUseApprovalSnapshot);
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/computer-use/approval-mode"
  ) {
    sendJson(req, res, 200, {
      mode: emptyComputerUseApprovalSnapshot.mode,
    });
    return;
  }

  const computerUseApprovalMatch =
    /^\/api\/computer-use\/approvals\/([^/]+)$/.exec(url.pathname);
  if (req.method === "POST" && computerUseApprovalMatch) {
    const approvalId = decodeURIComponent(computerUseApprovalMatch[1]);
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      id: approvalId,
      command: "computer-use-command",
      approved: body.approved === true,
      cancelled: body.approved !== true,
      mode: emptyComputerUseApprovalSnapshot.mode,
      requestedAt: nowIso(),
      resolvedAt: nowIso(),
      ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/drop/status") {
    sendJson(req, res, 200, {
      dropEnabled: false,
      publicMintOpen: false,
      whitelistMintOpen: false,
      mintedOut: false,
      currentSupply: 0,
      maxSupply: 2138,
      shinyPrice: "0.1",
      userHasMinted: false,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inbox/chats") {
    sendJson(req, res, 200, { chats: [], unreadCount: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/registry/status") {
    sendJson(req, res, 200, { connected: false, online: false });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/downloads/stream"
  ) {
    sendSseHeaders(req, res);
    writeSseEvent(res, {
      type: "snapshot",
      downloads: emptyLocalInferenceHub.downloads,
      active: emptyLocalInferenceHub.active,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/hub") {
    sendJson(req, res, 200, emptyLocalInferenceHub);
    return;
  }

  // Model catalog behind the Settings model panel + slash-command completions.
  // Empty providers with an empty validated catalog keeps the panel in its
  // designed-empty state without tripping the catch-all 501.
  if (req.method === "GET" && url.pathname === "/api/models") {
    sendJson(req, res, 200, { providers: {}, catalog: { providers: {} } });
    return;
  }

  // Authoritative device-tier assessment consumed by the Settings voice
  // section and first-run gate. Shape mirrors plugin-local-inference's
  // /api/local-inference/device-tier response.
  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/device-tier"
  ) {
    sendJson(req, res, 200, {
      tier: {
        tier: "GOOD",
        reasons: ["ui-smoke stub assessment"],
        canRunLocalLm: true,
        canRunLocalVoice: true,
        recommendedMode: "local",
        recommendedFit: null,
        numericContext: { vramGb: 16, appleSilicon: true, mobile: false },
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/hardware"
  ) {
    sendJson(req, res, 200, emptyLocalInferenceHardware);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/catalog") {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/routing") {
    sendJson(req, res, 200, {
      registrations: [],
      preferences: {
        preferredProvider: {},
        policy: {},
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/installed"
  ) {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/hf-search"
  ) {
    sendJson(req, res, 200, { models: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local-inference/active") {
    sendJson(req, res, 200, emptyLocalInferenceActive);
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/local-inference/downloads"
  ) {
    const body = (await readJsonBody(req)) || {};
    const modelId =
      typeof body.modelId === "string" && body.modelId.trim().length > 0
        ? body.modelId.trim()
        : typeof body.spec?.id === "string" && body.spec.id.trim().length > 0
          ? body.spec.id.trim()
          : "local-inference-model";
    sendJson(req, res, 200, {
      job: {
        jobId: `job-${modelId}`,
        modelId,
        state: "queued",
        received: 0,
        total: 0,
        bytesPerSec: 0,
        etaMs: null,
        startedAt: nowIso(),
        updatedAt: nowIso(),
      },
    });
    return;
  }

  const localInferenceDownloadMatch =
    /^\/api\/local-inference\/downloads\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && localInferenceDownloadMatch) {
    sendJson(req, res, 200, { cancelled: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/local-inference/active") {
    const body = (await readJsonBody(req)) || {};
    const modelId =
      typeof body.modelId === "string" && body.modelId.trim().length > 0
        ? body.modelId.trim()
        : null;
    sendJson(req, res, 200, {
      modelId,
      loadedAt: modelId ? nowIso() : null,
      status: modelId ? "ready" : "idle",
    });
    return;
  }

  if (
    req.method === "DELETE" &&
    url.pathname === "/api/local-inference/active"
  ) {
    sendJson(req, res, 200, emptyLocalInferenceActive);
    return;
  }

  const localInferenceInstalledMatch =
    /^\/api\/local-inference\/installed\/([^/]+)$/.exec(url.pathname);
  if (req.method === "DELETE" && localInferenceInstalledMatch) {
    sendJson(req, res, 200, { removed: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/coding-agents") {
    sendJson(req, res, 200, []);
    return;
  }

  if (await handleDemoOrchestratorRoute(req, res, url)) {
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orchestrator/status") {
    sendJson(req, res, 200, emptyOrchestratorStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orchestrator/tasks") {
    sendJson(req, res, 200, { tasks: [] });
    return;
  }

  const orchestratorTaskMatch =
    /^\/api\/orchestrator\/tasks\/([^/]+)(?:\/([^/]+))?$/.exec(url.pathname);
  if (orchestratorTaskMatch) {
    const [, taskId, action] = orchestratorTaskMatch;
    if (req.method === "GET" && action === "stream") {
      sendReadySseStream(req, res);
      return;
    }
    if (req.method === "GET" && action === "messages") {
      sendJson(req, res, 200, { items: [], nextCursor: null });
      return;
    }
    if (req.method === "GET" && action === "events") {
      sendJson(req, res, 200, { items: [], nextCursor: null });
      return;
    }
    if (req.method === "GET" && action === "timeline") {
      sendJson(req, res, 200, { items: [], nextCursor: null });
      return;
    }
    if (req.method === "GET" && action === "usage") {
      sendJson(req, res, 200, emptyOrchestratorUsage);
      return;
    }
    if (req.method === "GET" && !action) {
      sendJson(req, res, 404, { error: `Task not found: ${taskId}` });
      return;
    }
    if (req.method === "POST") {
      sendJson(req, res, 200, { ok: true, id: taskId });
      return;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/trajectories/stats") {
    sendJson(req, res, 200, {
      totalTrajectories: 0,
      totalLlmCalls: 0,
      totalProviderAccesses: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      averageDurationMs: 0,
      bySource: {},
      byModel: {},
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/trajectories/config") {
    sendJson(req, res, 200, { enabled: false });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/trajectories/latest") {
    sendJson(req, res, 200, { trajectory: null });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/trajectories") {
    sendJson(req, res, 200, emptyTrajectoryList(url));
    return;
  }

  const trajectoryDetailMatch = /^\/api\/trajectories\/([^/]+)$/.exec(
    url.pathname,
  );
  if (req.method === "GET" && trajectoryDetailMatch) {
    sendJson(req, res, 200, {
      trajectory: {
        id: decodeURIComponent(trajectoryDetailMatch[1] ?? "unknown"),
        status: "completed",
        llmCallCount: 0,
      },
      llmCalls: [],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/coding-agents/preflight") {
    sendJson(req, res, 200, {
      ok: true,
      missingTools: [],
      ready: true,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/coding-agents/coordinator/status"
  ) {
    sendJson(req, res, 200, {
      supervisionLevel: "autonomous",
      taskCount: 0,
      tasks: [],
      pendingConfirmations: 0,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/coding-agents/coordinator/threads"
  ) {
    sendJson(req, res, 200, { threads: [], total: 0 });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/extension/status") {
    sendJson(req, res, 200, {
      installed: false,
      connected: false,
      relayReachable: false,
      relayPort: 0,
      extensionPath: null,
      chromeBuildPath: null,
      chromePackagePath: null,
      safariWebExtensionPath: null,
      safariAppPath: null,
      safariPackagePath: null,
      releaseManifest: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/overview") {
    sendJson(req, res, 200, emptyLifeOpsOverview);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/capabilities") {
    sendJson(req, res, 200, emptyLifeOpsCapabilities);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/calendar/feed") {
    sendJson(req, res, 200, emptyLifeOpsCalendarFeed);
    return;
  }

  // Family Operations owns explicit empty states. Keep its four read models
  // available so the visual audit reviews the real upload and workflow UI
  // instead of the generic unavailable boundary.
  if (req.method === "GET" && url.pathname === "/api/lifeops/agreements") {
    sendJson(req, res, 200, { agreements: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lifeops/calendar/links") {
    sendJson(req, res, 200, { links: [] });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/family-workflows/school/status"
  ) {
    sendJson(req, res, 200, {
      sourceId: "concord-public-schools",
      config: null,
      lastRun: null,
    });
    return;
  }
  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/family-workflows/packets"
  ) {
    sendJson(req, res, 200, { packets: [], packetStates: [] });
    return;
  }

  // Meeting sessions (calendar view polls active sessions on mount). Return
  // 200-empty so the calendar view renders without the catch-all 501 the
  // page-error guard would otherwise flag.
  if (req.method === "GET" && url.pathname === "/api/meetings") {
    sendJson(req, res, 200, { sessions: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/inbox") {
    sendJson(req, res, 200, emptyLifeOpsInbox);
    return;
  }

  // Decomposed domain-view read routes — return 200-empty so the views render
  // their EMPTY state (not the catch-all 501 error state) in the visual smoke.
  if (req.method === "GET" && url.pathname === "/api/lifeops/goals") {
    sendJson(req, res, 200, { goals: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lifeops/relationships") {
    sendJson(req, res, 200, { relationships: [], entities: [] });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/lifeops/money/dashboard") {
    sendJson(req, res, 200, {
      balanceUsd: 0,
      sources: [],
      recentTransactions: [],
      recurringCharges: [],
      spendByCategory: [],
    });
    return;
  }
  if (
    req.method === "GET" &&
    (url.pathname === "/api/lifeops/money/sources" ||
      url.pathname === "/api/lifeops/money/transactions" ||
      url.pathname === "/api/lifeops/money/recurring")
  ) {
    const key = url.pathname.endsWith("sources")
      ? "sources"
      : url.pathname.endsWith("transactions")
        ? "transactions"
        : "recurringCharges";
    sendJson(req, res, 200, { [key]: [] });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/screen-time/summary"
  ) {
    sendJson(req, res, 200, emptyLifeOpsScreenTimeSummary);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/screen-time/breakdown"
  ) {
    sendJson(req, res, 200, emptyLifeOpsScreenTimeBreakdown);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/social/summary") {
    sendJson(req, res, 200, emptyLifeOpsSocialSummary);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/lifeops/connectors/google/status"
  ) {
    sendJson(req, res, 200, {
      connected: false,
      available: false,
      authUrl: null,
      lastSyncedAt: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-bridge/settings") {
    sendJson(req, res, 200, { settings: emptyBrowserBridgeSettings });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/browser-bridge/companions"
  ) {
    sendJson(req, res, 200, { companions: [] });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/browser-bridge/packages") {
    sendJson(req, res, 200, { status: emptyBrowserBridgePackageStatus });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lifeops/app-state") {
    sendJson(req, res, 200, { enabled: lifeOpsAppEnabled });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/lifeops/app-state") {
    const body = (await readJsonBody(req)) || {};
    lifeOpsAppEnabled = body.enabled === true;
    sendJson(req, res, 200, { enabled: lifeOpsAppEnabled });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/lifeops/activity-signals"
  ) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/catalog/apps") {
    sendJson(req, res, 200, stubCatalogApps);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps") {
    sendJson(req, res, 200, []);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/permissions") {
    sendJson(req, res, 200, []);
    return;
  }

  const appPermissionsMatch = /^\/api\/apps\/permissions\/([^/]+)$/.exec(
    url.pathname,
  );
  if (appPermissionsMatch) {
    const slug = decodeURIComponent(appPermissionsMatch[1]);
    if (req.method === "GET") {
      sendJson(req, res, 200, {
        slug,
        displayName: slug,
        requestedNamespaces: [],
        grantedNamespaces: [],
      });
      return;
    }
    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) || {};
      sendJson(req, res, 200, {
        slug,
        displayName: slug,
        requestedNamespaces: [],
        grantedNamespaces: Array.isArray(body.namespaces)
          ? body.namespaces
          : [],
      });
      return;
    }
  }

  if (url.pathname === "/api/apps/favorites") {
    if (req.method === "GET") {
      sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
      return;
    }

    if (req.method === "PUT") {
      const body = (await readJsonBody(req)) || {};
      const appName =
        typeof body.appName === "string" ? body.appName.trim() : "";
      if (appName) {
        const next = new Set(smokeFavoriteApps);
        if (body.isFavorite === false) {
          next.delete(appName);
        } else {
          next.add(appName);
        }
        smokeFavoriteApps = [...next];
      }
      sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
      return;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/apps/favorites/replace") {
    const body = (await readJsonBody(req)) || {};
    smokeFavoriteApps = Array.isArray(body.favoriteAppNames)
      ? body.favoriteAppNames.filter((name) => typeof name === "string")
      : [];
    sendJson(req, res, 200, { favoriteApps: smokeFavoriteApps });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/apps/overlay-presence") {
    const body = (await readJsonBody(req)) || {};
    sendJson(req, res, 200, {
      ok: true,
      app: typeof body.app === "string" ? body.app : null,
      present: body.present === true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills") {
    sendJson(req, res, 200, emptySkillsResponse);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills/refresh") {
    sendJson(req, res, 200, { ok: true, ...emptySkillsResponse });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/skills/curated") {
    sendJson(req, res, 200, { skills: [] });
    return;
  }

  if (
    (req.method === "POST" || req.method === "DELETE") &&
    url.pathname.startsWith("/api/skills/curated/")
  ) {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/skills/install") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/installed") {
    sendJson(req, res, 200, []);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/apps/runs") {
    sendJson(req, res, 200, []);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/apps/screenshare/capabilities"
  ) {
    sendJson(req, res, 200, {
      platform: "smoke",
      capabilities: {
        screenshot: { available: true, tool: "screencapture" },
        headfulGui: { available: true, tool: "browser" },
        keyboard: { available: false, tool: "computer-use" },
      },
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/apps/screenshare/sessions"
  ) {
    sendJson(req, res, 200, {
      sessions: [
        {
          id: "smoke-session",
          label: "Smoke session",
          status: "active",
          createdAt: SMOKE_GENERATED_AT,
          updatedAt: SMOKE_GENERATED_AT,
          stoppedAt: null,
          platform: "smoke",
          frameCount: 1,
          inputCount: 0,
          lastFrameAt: SMOKE_GENERATED_AT,
          lastInputAt: null,
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    sendJson(req, res, 200, stubLogsResponse);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/__ui-smoke/unhandled-requests"
  ) {
    sendJson(req, res, 200, { requests: unhandledApiRequests });
    return;
  }

  if (
    req.method === "POST" &&
    url.pathname === "/api/__ui-smoke/unhandled-requests/reset"
  ) {
    unhandledApiRequests.length = 0;
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/info/")) {
    sendJson(req, res, 404, { error: "App not found" });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/apps/search")) {
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    const results = query
      ? stubCatalogApps.filter((app) =>
          [app.name, app.displayName, app.description, app.category]
            .join(" ")
            .toLowerCase()
            .includes(query),
        )
      : stubCatalogApps;
    sendJson(req, res, 200, results);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/apps/launch") {
    sendJson(req, res, 200, {
      pluginInstalled: true,
      needsRestart: false,
      displayName: "Smoke App",
      launchType: "connect",
      launchUrl: null,
      viewer: null,
      session: null,
      run: null,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/i18n/locale") {
    // Mirror the real public language-suggestion route
    // (packages/app-core/src/api/i18n-locale-routes.ts). The SPA polls this on
    // first paint; without it the stub's catch-all 501 spams console.error.
    sendJson(req, res, 200, { language: "en" });
    return;
  }

  // ── Local-inference voice (drives the /chat overlay's bidirectional loop) ──
  // The client mic capture + VAD end-of-turn are REAL (Chromium fake-audio
  // file); these endpoints stand in for the on-device ASR/TTS models so the
  // transcript-in / spoken-reply-out round trip stays deterministic.
  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/device/stream"
  ) {
    const payload = {
      type: "status",
      status: {
        connected: false,
        devices: [],
        primaryDeviceId: null,
        pendingRequests: 0,
        deviceId: null,
        capabilities: null,
        loadedPath: null,
        connectedSince: null,
      },
    };
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "close",
    });
    res.end(`retry: 60000\ndata: ${JSON.stringify(payload)}\n\n`);
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/voice-models"
  ) {
    // Production lists known models even when no version is installed.
    const installations = [
      ...new Set(VOICE_MODEL_VERSIONS.map((version) => version.id)),
    ]
      .sort()
      .map((id) => ({
        id,
        installedVersion: null,
        pinned: false,
        lastError: null,
      }));
    sendJson(req, res, 200, { installations });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/local-inference/voice-models/preferences"
  ) {
    sendJson(req, res, 200, {
      preferences: SMOKE_NETWORK_POLICY_PREFERENCES,
      isOwner: true,
    });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/asr/local-inference/status"
  ) {
    sendJson(req, res, 200, { ready: true, provider: "local-inference" });
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/api/tts/local-inference/status"
  ) {
    // Symmetric with ASR: the /chat overlay polls TTS readiness before the
    // spoken-reply loop. Without this the catch-all 501 below surfaces as a
    // console.error the e2e diagnostics treat as a bug.
    sendJson(req, res, 200, { ready: true, provider: "local-inference" });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/asr/local-inference") {
    // The WAV body is real captured audio; we don't transcribe it, we return a
    // fixed phrase so the spoken turn resolves to a known message.
    await drainRequest(req);
    sendJson(req, res, 200, { text: SMOKE_VOICE_TRANSCRIPT });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tts/local-inference") {
    // Assistant reply spoken back. Decodable silence is enough — the request
    // itself is the bidirectional-output signal the e2e asserts on.
    await drainRequest(req);
    sendBinary(req, res, 200, "audio/wav", SILENT_WAV);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    const request = recordUnhandledApiRequest(req, url);
    if (req.method === "HEAD") {
      sendEmpty(req, res, 501);
      return;
    }
    sendJson(req, res, 501, {
      error: `Unhandled UI smoke API route: ${request.method} ${request.path}`,
      fixture: "ui-smoke-api-stub",
      request,
    });
    return;
  }

  sendJson(req, res, 404, {
    error: `Unhandled ${req.method ?? "GET"} ${url.pathname}`,
  });
});

server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => {
    sockets.delete(socket);
  });
});

const wsServer = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? `127.0.0.1:${port}`}`,
  );
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(req, socket, head, (ws) => {
    wsServer.emit("connection", ws, req);
  });
});

wsServer.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "ready" }));
  ws.on("message", () => {});
});

function broadcastWsEvent(payload) {
  const message = JSON.stringify(payload);
  for (const client of wsServer.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("UI smoke stub did not bind a TCP port");
  }
  console.log(
    `[playwright-ui-smoke-api-stub] listening on http://127.0.0.1:${address.port}`,
  );
});

async function shutdown() {
  for (const client of wsServer.clients) {
    client.terminate();
  }
  wsServer.close();
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (
      signal === "SIGTERM" &&
      process.env.ELIZA_UI_SMOKE_STUB_IGNORE_SIGTERM === "1"
    ) {
      console.warn("[playwright-ui-smoke-api-stub] ignoring SIGTERM");
      return;
    }
    void shutdown();
  });
}
