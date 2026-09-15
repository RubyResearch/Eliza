/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by the todos plugin.
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import {
  AgentEventService,
  NotificationService,
  PairingService,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { connectAccountAction } from "../actions/connect-account.ts";
import { contactAction } from "../actions/contact.ts";
import { databaseAction } from "../actions/database.ts";
import { filesAction } from "../actions/files.ts";
import { knowledgeActions } from "../actions/knowledge.ts";
import { logsAction } from "../actions/logs.ts";
import { memoryAction } from "../actions/memories.ts";
import { notifyAction } from "../actions/notify.ts";
import { pageDelegateAction } from "../actions/page-action-groups.ts";
import { pairOwnerAccountAction } from "../actions/pair-owner-account.ts";
import { pluginAction } from "../actions/plugin.ts";
import { runtimeAction } from "../actions/runtime.ts";
import { settingsAction } from "../actions/settings-actions.ts";
import { terminalAction } from "../actions/terminal.ts";
import { triggerAction } from "../actions/trigger.ts";
import { registerAttachmentKnowledgeBackfillWorker } from "../api/attachment-knowledge-backfill.ts";
import { registerAttachmentKnowledgeIngestHook } from "../api/attachment-knowledge-ingest.ts";
import {
  backgroundGenerateImageRoute,
  backgroundUploadImageRoute,
} from "../api/background-routes.ts";
import { filesRoutes } from "../api/files-routes.ts";
import {
  mediaFileRoute,
  registerMediaGcWorker,
  registerMediaPipelineHook,
} from "../api/media-runtime.ts";
import { pendantSessionRoutes } from "../api/pendant-session-routes.ts";
import { adminPanelProvider } from "../providers/admin-panel.ts";
import { adminTrustProvider } from "../providers/admin-trust.ts";
import { automationTerminalBridgeProvider } from "../providers/automation-terminal-bridge.ts";
import { escalationTriggerProvider } from "../providers/escalation-trigger.ts";
import { pageScopedContextProvider } from "../providers/page-scoped-context.ts";
import { pendingPermissionsProvider } from "../providers/pending-permissions-provider.ts";
import { recentConversationsProvider } from "../providers/recent-conversations.ts";
import { relevantConversationsProvider } from "../providers/relevant-conversations.ts";
import { roleBackfillProvider } from "../providers/role-backfill.ts";
import { rolodexProvider } from "../providers/rolodex.ts";
import { createSessionKeyProvider } from "../providers/session-bridge.ts";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../providers/session-utils.ts";
import { createDynamicSkillProvider } from "../providers/skill-provider.ts";
import { createOngoingTasksProvider } from "../providers/tasks.ts";
import {
  uiGenerativeProvider,
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "../providers/ui-catalog.ts";
import { createUserNameProvider } from "../providers/user-name.ts";
import { createWorkspaceProvider } from "../providers/workspace-provider.ts";
import { ApprovalService } from "../services/approval/index.ts";
import { AudioRedactionService } from "../services/audio-redaction-service.ts";
import { ElizaCharacterPersistenceService } from "../services/character-persistence.ts";
import { LocalFileStorageService } from "../services/file-storage.ts";
import { GlobalPauseService } from "../services/global-pause/index.ts";
import { HandoffService } from "../services/handoff/index.ts";
import {
  KnowledgeGraphService,
  knowledgeGraphSchema,
} from "../services/knowledge-graph/index.ts";
import { AgentMediaGenerationService } from "../services/media-generation.ts";
import { MessageInteractionHostService } from "../services/message-interaction-host.ts";
import { OwnerBindingService } from "../services/owner-binding.ts";
import { pendantSessionSchema } from "../services/pendant-session/index.ts";
import { PendingPromptsService } from "../services/pending-prompts/index.ts";
import { PermissionRegistry } from "../services/permissions-registry.ts";
import { NotificationPushService } from "../services/push/notification-push-service.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import { registerTriggerTaskWorker } from "../triggers/runtime.ts";
import { setCustomActionsRuntime } from "./custom-actions.ts";
import { registerErrorEscalation } from "./error-escalation.ts";
import { LogsRetentionService } from "./logs-retention-service.ts";
import { MemoryRetentionService } from "./memory-retention-service.ts";

export type ElizaPluginConfig = {
  workspaceDir?: string;
  sessionStorePath?: string;
  agentId?: string;
};

export function createElizaPlugin(config?: ElizaPluginConfig): Plugin {
  const workspaceDir =
    config?.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const agentId = config?.agentId ?? "main";
  const sessionStorePath =
    config?.sessionStorePath ?? resolveDefaultSessionStorePath(agentId);

  const baseProviders = [
    createWorkspaceProvider({ workspaceDir }),
    adminTrustProvider,
    adminPanelProvider,

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
    createDynamicSkillProvider(),
    pendingPermissionsProvider,
    createUserNameProvider(),
    createOngoingTasksProvider(),
  ];

  const plugin: Plugin = {
    name: "eliza",
    description: "Eliza workspace context, session keys, and lifecycle actions",

    // Runtime-owned app_lifeops tables. Registered here so the SQL plugin
    // migrates the runtime data model whenever the agent runs.
    schema: {
      ...knowledgeGraphSchema,
      ...pendantSessionSchema,
    },

    services: [
      AgentEventService as ServiceClass,
      NotificationService as ServiceClass,
      NotificationPushService as ServiceClass,
      ElizaCharacterPersistenceService as ServiceClass,
      AgentMediaGenerationService as ServiceClass,
      MessageInteractionHostService as ServiceClass,
      LocalFileStorageService as ServiceClass,
      PermissionRegistry as ServiceClass,
      KnowledgeGraphService as ServiceClass,
      PendingPromptsService as ServiceClass,
      GlobalPauseService as ServiceClass,
      HandoffService as ServiceClass,
      // Bounded retention for the memories/embeddings partitions. Registers
      // always but stays a no-op unless ELIZA_MEMORY_RETENTION_DAYS or
      // ELIZA_MEMORY_RETENTION_MAX_ROWS_PER_ROOM is set — the mechanism that
      // keeps the append-only memory store from filling the disk.
      MemoryRetentionService as ServiceClass,
      // Bounded retention for the append-only logs table (empirically the
      // biggest growth surface). Registers always but stays a no-op unless
      // ELIZA_LOGS_RETENTION_DAYS or ELIZA_LOGS_RETENTION_MAX_ROWS_PER_ROOM is
      // set. Independent config + adapter from the memory sweep above.
      LogsRetentionService as ServiceClass,
      ApprovalService as ServiceClass,
      AudioRedactionService as ServiceClass,
      // OWNER_BIND_VERIFY: backend authority for the connector /eliza-pair
      // commands. Registered here (before connector plugins start) so the
      // Discord/Telegram pairing services find it and register their commands.
      OwnerBindingService as ServiceClass,
      // DM pairing-code allowlist backing the connectors' default dmPolicy
      // "pairing". Without it registered, checkPairingAllowed fails CLOSED
      // (#14710) and every non-whitelisted DM sender is denied.
      PairingService as ServiceClass,
    ],

    init: async (_pluginConfig, runtime: IAgentRuntime) => {
      registerTriggerTaskWorker(runtime);
      registerErrorEscalation(runtime);
      setCustomActionsRuntime(runtime);
      // Media store: persist inline data: URLs out of context/history, and
      // sweep orphaned files daily. The serving route is declared below.
      registerMediaPipelineHook(runtime);
      registerMediaGcWorker(runtime);
      // Attachment → knowledge ingest (#13593): mirror chat attachments into the
      // knowledge store, tagged by room/sender/role/media-format, with a
      // source-trust-derived scope (owner/DM → owner-private; public room →
      // user-private) so owner-only knowledge cannot spill into public rooms.
      registerAttachmentKnowledgeIngestHook(runtime);
      // The worker must exist before TaskService starts. The host's awaited
      // post-migration maintenance phase creates its idempotent queue row.
      registerAttachmentKnowledgeBackfillWorker(runtime);
    },

    providers: [
      ...baseProviders,

      automationTerminalBridgeProvider,
      pageScopedContextProvider,
      recentConversationsProvider,
      relevantConversationsProvider,
      rolodexProvider,

      uiWidgetCapabilitiesProvider,
      uiWidgetsProvider,
      uiGenerativeProvider,
      roleBackfillProvider,
      escalationTriggerProvider,
    ],

    // Public media route — only reached on iOS (in-process dispatch, no HTTP
    // server). HTTP platforms serve media via the pre-auth handler in server.ts.
    routes: [
      mediaFileRoute,
      backgroundGenerateImageRoute,
      backgroundUploadImageRoute,
      ...filesRoutes,
      ...pendantSessionRoutes,
    ],

    actions: [
      terminalAction,
      ...promoteSubactionsToActions(triggerAction),
      pageDelegateAction,
      ...promoteSubactionsToActions(contactAction),
      settingsAction,
      ...promoteSubactionsToActions(pluginAction),
      // Observability / introspection actions
      ...promoteSubactionsToActions(logsAction),
      ...promoteSubactionsToActions(runtimeAction),
      ...promoteSubactionsToActions(databaseAction),
      connectAccountAction,
      pairOwnerAccountAction,
      notifyAction,
      ...promoteSubactionsToActions(memoryAction, {
        overrides: {
          create: { description: "Store a memory. Supply text to save." },
          update: {
            description:
              "Correct saved knowledge. Search the subject's existing facts first and reconcile every record affected by the user's correction, preserving unrelated facts in each full replacement text. Every update call MUST include its target memoryId from the search (or a unique query), replacement text, and confirm:true. Updating one record does not correct other contradictory records; verify the saved facts before reporting completion.",
          },
          delete: {
            description:
              "Delete saved knowledge the user asked to forget. Supply confirm:true and either memoryId or a unique query. If the tool returns candidates, review their full text and delete only records expressing the requested claim by memoryId. Shared source messages can contain unrelated facts; preserve those. Verify the requested claim is gone before reporting completion.",
          },
        },
      }).map((action) => {
        // The umbrella keeps its conditional parameters; each promoted tool
        // must expose the requirements of the operation it actually executes.
        // Otherwise planners can repeatedly call UPDATE without replacement text.
        const fields: Record<string, readonly string[]> = {
          MEMORY_CREATE: ["action", "text", "kind", "tags"],
          MEMORY_SEARCH: [
            "action",
            "type",
            "author",
            "entityId",
            "roomId",
            "query",
            "queryMode",
            "limit",
            "offset",
            "snapshot",
          ],
          MEMORY_UPDATE: [
            "action",
            "text",
            "memoryId",
            "query",
            "type",
            "entityId",
            "roomId",
            "confirm",
          ],
          MEMORY_DELETE: [
            "action",
            "memoryId",
            "query",
            "type",
            "entityId",
            "roomId",
            "confirm",
          ],
        };
        const allowed = fields[action.name];
        if (!allowed) return action;
        action.parameters = action.parameters
          ?.filter((parameter) => allowed.includes(parameter.name))
          .map((parameter) => ({
            ...parameter,
            required:
              parameter.name === "text" || parameter.name === "confirm"
                ? true
                : parameter.required,
          }));
        return action;
      }),
      filesAction,
      // Global knowledge-hub actions (#13595): search + attach-to-chat +
      // send-to-someone, callable from any view.
      ...knowledgeActions,
      // SCHEDULE_FOLLOW_UP is now the `followup` op on contactAction.
      // ARCHIVE_CODING_TASK / REOPEN_CODING_TASK live as ops on the TASKS
      // parent in @elizaos/plugin-agent-orchestrator (also surfaced via the
      // CODE umbrella).
    ],

    async dispose(runtime) {
      await runtime
        .getService<PermissionRegistry>(PermissionRegistry.serviceType)
        ?.stop();
      await runtime
        .getService<AgentMediaGenerationService>(
          AgentMediaGenerationService.serviceType,
        )
        ?.stop();
      await runtime
        .getService<ElizaCharacterPersistenceService>(
          ElizaCharacterPersistenceService.serviceType,
        )
        ?.stop();
      await runtime
        .getService<AgentEventService>(AgentEventService.serviceType)
        ?.stop();
    },
  };

  return plugin;
}
