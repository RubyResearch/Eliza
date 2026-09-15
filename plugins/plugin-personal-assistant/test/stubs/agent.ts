/**
 * Test stub for @elizaos/agent: re-exports the real global-pause and handoff store surfaces
 * plus a mutable agent-backup state, so PA tests run without pulling in the full agent
 * package.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GroundedActionReply } from "@elizaos/core";

// The LifeOps route dispatcher rate-limits state-changing routes; re-export the
// real limiter (self-contained, in-memory) so route e2e tests run the genuine
// dispatch path instead of a bypass.
export { checkRateLimit } from "../../../../packages/agent/src/api/rate-limiter.ts";
export {
  APPROVAL_SERVICE,
  ApprovalDispatchControlStore,
  ApprovalService,
  approvalDispatchAdmissionCte,
  resolveApprovalService,
} from "../../../../packages/agent/src/services/approval/index.ts";
export {
  createApprovalQueue,
  PgApprovalQueue,
} from "../../../../packages/agent/src/services/approval/store.ts";
export {
  APPROVAL_EXECUTION_CAPABILITY,
  APPROVAL_EXECUTION_PROTOCOL_VERSION,
  ApprovalIdempotencyConflictError,
  ApprovalNotFoundError,
  ApprovalStateTransitionError,
} from "../../../../packages/agent/src/services/approval/types.ts";
export {
  createGlobalPauseStore,
  GLOBAL_PAUSE_SERVICE,
  GlobalPauseService,
  resolveGlobalPauseService,
} from "../../../../packages/agent/src/services/global-pause/index.ts";
export {
  createHandoffStore,
  describeResumeCondition,
  evaluateResume,
  HANDOFF_SERVICE,
  HandoffService,
  resolveHandoffService,
} from "../../../../packages/agent/src/services/handoff/index.ts";
// The runtime knowledge graph (entity/relationship stores + service + schema)
// is owned by @elizaos/agent. Re-export the real implementations here: they
// are self-contained (only @elizaos/core, @elizaos/shared, drizzle-orm) and do
// not drag the agent server graph into the e2e lane, so the e2e tests exercise
// the genuine stores via the personal-assistant shims.
export {
  EntityStore,
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  knowledgeGraphSchema,
  RelationshipStore,
  resolveKnowledgeGraphService,
} from "../../../../packages/agent/src/services/knowledge-graph/index.ts";
// Cache-backed runtime stores promoted from LifeOps (Slice 3). Like the
// knowledge graph above, they are self-contained (only @elizaos/core) and the
// personal-assistant store shims import them from `@elizaos/agent`, so re-export
// the genuine implementations here for the test lane.
export {
  createPendingPromptsStore,
  PENDING_PROMPTS_SERVICE,
  PendingPromptsService,
  resolvePendingPromptsService,
} from "../../../../packages/agent/src/services/pending-prompts/index.ts";

export class DatabaseSync {}

export async function hasOwnerAccess(): Promise<boolean> {
  return true;
}

export interface LocalAgentBackupStubMetadata {
  fileName: string;
  path: string;
  createdAt: string;
  agentId: string;
  stateSha256: string;
  sizeBytes: number;
}

interface AgentBackupStubState {
  localBackups: LocalAgentBackupStubMetadata[];
  createdBackup?: LocalAgentBackupStubMetadata;
  createCalls: number;
  lastCreateAgentId?: string;
}

const AGENT_BACKUP_STUB_STATE = Symbol.for(
  "eliza.lifeops.test.agentBackupStubState",
);

function getAgentBackupStubState(): AgentBackupStubState {
  const globalWithState = globalThis as typeof globalThis & {
    [AGENT_BACKUP_STUB_STATE]?: AgentBackupStubState;
  };
  globalWithState[AGENT_BACKUP_STUB_STATE] ??= {
    localBackups: [],
    createCalls: 0,
  };
  return globalWithState[AGENT_BACKUP_STUB_STATE];
}

export function resetAgentBackupStubState(): void {
  const state = getAgentBackupStubState();
  state.localBackups = [];
  state.createdBackup = undefined;
  state.createCalls = 0;
  state.lastCreateAgentId = undefined;
}

export function setAgentBackupStubState(
  patch: Partial<AgentBackupStubState>,
): void {
  const state = getAgentBackupStubState();
  if (patch.localBackups) {
    state.localBackups = patch.localBackups;
  }
  if (patch.createdBackup) {
    state.createdBackup = patch.createdBackup;
  }
}

export function getAgentBackupStubStateSnapshot(): AgentBackupStubState {
  const state = getAgentBackupStubState();
  return {
    localBackups: [...state.localBackups],
    ...(state.createdBackup ? { createdBackup: state.createdBackup } : {}),
    createCalls: state.createCalls,
    ...(state.lastCreateAgentId
      ? { lastCreateAgentId: state.lastCreateAgentId }
      : {}),
  };
}

export async function listLocalAgentBackups(
  agentId?: string,
): Promise<LocalAgentBackupStubMetadata[]> {
  const state = getAgentBackupStubState();
  return state.localBackups.filter(
    (backup) => !agentId || backup.agentId === agentId,
  );
}

export async function createLocalAgentBackup(runtime?: {
  agentId?: string;
}): Promise<LocalAgentBackupStubMetadata> {
  const state = getAgentBackupStubState();
  state.createCalls += 1;
  state.lastCreateAgentId = runtime?.agentId;
  const backup =
    state.createdBackup ??
    ({
      fileName: "2026-06-29T120000Z.agent-backup.json",
      path: "/tmp/2026-06-29T120000Z.agent-backup.json",
      createdAt: "2026-06-29T12:00:00.000Z",
      agentId: runtime?.agentId ?? "agent-1",
      stateSha256: "abc123",
      sizeBytes: 4096,
    } satisfies LocalAgentBackupStubMetadata);
  state.localBackups = [backup, ...state.localBackups];
  return backup;
}

export async function extractActionParamsViaLlm(): Promise<unknown> {
  return null;
}

export async function renderGroundedActionReply(args: {
  fallback: string;
}): Promise<GroundedActionReply> {
  // Deterministic model collaborator; tests of unavailable replies override it.
  return { kind: "model", text: args.fallback };
}

// Integration telemetry is self-contained (only the core logger), so the test
// lane runs the real span: route tests then exercise the genuine
// success/failure bookkeeping instead of a shape-drifted fake.
export { createIntegrationTelemetrySpan } from "../../../../packages/agent/src/diagnostics/integration-observability.ts";

export function extractConversationMetadataFromRoom(): Record<string, unknown> {
  return {};
}

export function isPageScopedConversationMetadata(): boolean {
  return false;
}

export function computeNextCronRunAtMs(): number {
  return Date.now() + 60_000;
}

export function parseCronExpression(expression: string): {
  expression: string;
} {
  return { expression };
}

export function registerEscalationChannel(): void {}

export interface AgentEventServiceStubEvent {
  runId: string;
  stream: string;
  agentId?: string;
  data: Record<string, unknown>;
}

interface AgentEventServiceStubState {
  enabled: boolean;
  events: AgentEventServiceStubEvent[];
}

const AGENT_EVENT_SERVICE_STUB_STATE = Symbol.for(
  "eliza.lifeops.test.agentEventServiceStubState",
);

function getAgentEventServiceStubState(): AgentEventServiceStubState {
  const globalWithState = globalThis as typeof globalThis & {
    [AGENT_EVENT_SERVICE_STUB_STATE]?: AgentEventServiceStubState;
  };
  globalWithState[AGENT_EVENT_SERVICE_STUB_STATE] ??= {
    enabled: false,
    events: [],
  };
  return globalWithState[AGENT_EVENT_SERVICE_STUB_STATE];
}

/** Enable the capturing event-bus stand-in; disabled (null service) by default. */
export function enableAgentEventServiceStub(): void {
  getAgentEventServiceStubState().enabled = true;
}

export function resetAgentEventServiceStub(): void {
  const state = getAgentEventServiceStubState();
  state.enabled = false;
  state.events = [];
}

export function getAgentEventServiceStubEvents(): AgentEventServiceStubEvent[] {
  return [...getAgentEventServiceStubState().events];
}

export function getAgentEventService(runtime?: {
  getService?: (serviceType: string) => unknown;
}): {
  emit: (event: AgentEventServiceStubEvent) => void;
} | null {
  const runtimeService = runtime?.getService?.("agent_event");
  if (
    runtimeService &&
    typeof runtimeService === "object" &&
    "emit" in runtimeService &&
    typeof runtimeService.emit === "function"
  ) {
    return runtimeService as {
      emit: (event: AgentEventServiceStubEvent) => void;
    };
  }
  const state = getAgentEventServiceStubState();
  if (!state.enabled) return null;
  return {
    emit: (event) => {
      state.events.push(event);
    },
  };
}

export const PERMISSIONS_REGISTRY_SERVICE = "eliza_permissions_registry";

export function resolveOwnerEntityId(runtime?: {
  agentId?: string;
  getSetting?: (key: string) => unknown;
}): string {
  const configured = runtime?.getSetting?.("ELIZA_ADMIN_ENTITY_ID");
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  return runtime?.agentId ?? "owner-1";
}

export function resolveStateDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-state");
}

export function resolveOAuthDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-oauth");
}

export function resolveDefaultAgentWorkspaceDir(): string {
  return path.join(os.tmpdir(), "eliza-lifeops-test-workspace");
}

export function loadElizaConfig(): Record<string, unknown> {
  return {};
}

export function loadEffectiveElizaConfig(): Record<string, unknown> {
  return loadElizaConfig();
}

function readTestElizaConfig(): Record<string, unknown> {
  const configPath = process.env.ELIZA_CONFIG_PATH?.trim();
  if (!configPath) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

export function loadOwnerContactsConfig(): Record<
  string,
  { entityId?: string; channelId?: string; roomId?: string }
> {
  const config = readTestElizaConfig();
  const agents = config.agents as
    | { defaults?: { ownerContacts?: Record<string, unknown> } }
    | undefined;
  return (agents?.defaults?.ownerContacts ?? {}) as Record<
    string,
    { entityId?: string; channelId?: string; roomId?: string }
  >;
}

export async function loadOwnerContactRoutingHints(
  _runtime: unknown,
  ownerContacts: Record<
    string,
    { entityId?: string; channelId?: string; roomId?: string }
  >,
): Promise<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(ownerContacts).map(([source, contact]) => [
      source,
      {
        source,
        entityId: contact.entityId ?? null,
        channelId: contact.channelId ?? null,
        roomId: contact.roomId ?? null,
        preferredCommunicationChannel: null,
        platformIdentities: [],
        lastResponseAt: null,
        lastResponseChannel: null,
        resolvedFrom: "config",
      },
    ]),
  );
}

export function resolveOwnerContactWithFallback(args: {
  ownerContacts: Record<
    string,
    { entityId?: string; channelId?: string; roomId?: string }
  >;
  source: string | null | undefined;
  ownerEntityId: string | null | undefined;
}): {
  source: string;
  contact: { entityId?: string; channelId?: string; roomId?: string };
  resolvedFrom: "config" | "owner_entity";
} | null {
  const source = typeof args.source === "string" ? args.source.trim() : "";
  const candidates =
    source === "telegram"
      ? ["telegram", "telegram-account", "telegramAccount"]
      : source === "telegram-account"
        ? ["telegram-account", "telegramAccount", "telegram"]
        : source
          ? [source]
          : [];
  for (const candidate of candidates) {
    const contact = args.ownerContacts[candidate];
    if (contact) {
      return {
        source:
          candidate === "telegramAccount" ? "telegram-account" : candidate,
        contact,
        resolvedFrom: "config",
      };
    }
  }
  if (source === "discord" && args.ownerEntityId) {
    return {
      source,
      contact: { entityId: args.ownerEntityId },
      resolvedFrom: "owner_entity",
    };
  }
  return null;
}

export function saveElizaConfig(): void {}

export function createElizaPlugin(plugin: unknown): unknown {
  return plugin;
}

export async function startApiServer(): Promise<{
  close: () => Promise<void>;
}> {
  return { close: async () => undefined };
}

export async function handleConnectorAccountRoutes(args: {
  pathname: string;
  error: (res: unknown, message: string, status?: number) => void;
  res: unknown;
}): Promise<boolean> {
  if (args.pathname.endsWith("/oauth/callback")) {
    args.error(args.res, "Missing OAuth state", 400);
    return true;
  }
  return false;
}
