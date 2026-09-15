/**
 * Zod schemas validating the per-agent and agent-defaults slice of the eliza
 * config: heartbeat scheduling with active-hours windows, sandbox execution
 * (docker/browser/prune), tool profiles and allow/deny policies (with the
 * conflicting-allowlist refinement), semantic memory search, media/link
 * understanding tools, owner contacts, escalation, and inbox triage. Composes
 * the shared building blocks from zod-schema.core.ts into `AgentEntrySchema`
 * (one configured agent) and `AgentDefaultsSchema` (fallbacks applied to every
 * agent). `.strict()` throughout, so unknown keys surface as validation errors.
 */

import { parseDurationMs } from "@elizaos/shared";
import * as zod from "zod";
import {
  BlockStreamingChunkSchema,
  BlockStreamingCoalesceSchema,
  CliBackendSchema,
  GroupChatSchema,
  HumanDelaySchema,
  IdentitySchema,
  ToolsLinksSchema,
  ToolsMediaSchema,
} from "./zod-schema.core.ts";

const z = (zod as typeof zod & { z?: typeof zod }).z ?? zod;

export const HeartbeatSchema = z
  .object({
    every: z.string().optional(),
    activeHours: z
      .object({
        start: z.string().optional(),
        end: z.string().optional(),
        timezone: z.string().optional(),
      })
      .strict()
      .optional(),
    model: z.string().optional(),
    session: z.string().optional(),
    includeReasoning: z.boolean().optional(),
    target: z.string().optional(),
    to: z.string().optional(),
    prompt: z.string().optional(),
    ackMaxChars: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.every) {
      return;
    }
    try {
      parseDurationMs(val.every, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["every"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }

    const active = val.activeHours;
    if (!active) {
      return;
    }
    const timePattern = /^([01]\d|2[0-3]|24):([0-5]\d)$/;
    const validateTime = (
      raw: string | undefined,
      opts: { allow24: boolean },
      path: string,
    ) => {
      if (!raw) {
        return;
      }
      if (!timePattern.test(raw)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: 'invalid time (use "HH:MM" 24h format)',
        });
        return;
      }
      const [hourStr, minuteStr] = raw.split(":");
      const hour = Number(hourStr);
      const minute = Number(minuteStr);
      if (hour === 24 && minute !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (24:00 is the only allowed 24:xx value)",
        });
        return;
      }
      if (hour === 24 && !opts.allow24) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeHours", path],
          message: "invalid time (start cannot be 24:00)",
        });
      }
    };

    validateTime(active.start, { allow24: false }, "start");
    validateTime(active.end, { allow24: true }, "end");
  })
  .optional();

export const SandboxDockerSchema = z
  .object({
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    workdir: z.string().optional(),
    readOnlyRoot: z.boolean().optional(),
    tmpfs: z.array(z.string()).optional(),
    network: z.string().optional(),
    user: z.string().optional(),
    capDrop: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    setupCommand: z.string().optional(),
    pidsLimit: z.number().int().positive().optional(),
    memory: z.union([z.string(), z.number()]).optional(),
    memorySwap: z.union([z.string(), z.number()]).optional(),
    cpus: z.number().positive().optional(),
    ulimits: z
      .record(
        z.string(),
        z.union([
          z.string(),
          z.number(),
          z
            .object({
              soft: z.number().int().nonnegative().optional(),
              hard: z.number().int().nonnegative().optional(),
            })
            .strict(),
        ]),
      )
      .optional(),
    seccompProfile: z.string().optional(),
    apparmorProfile: z.string().optional(),
    dns: z.array(z.string()).optional(),
    extraHosts: z.array(z.string()).optional(),
    binds: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const SandboxBrowserSchema = z
  .object({
    enabled: z.boolean().optional(),
    image: z.string().optional(),
    containerPrefix: z.string().optional(),
    cdpPort: z.number().int().positive().optional(),
    vncPort: z.number().int().positive().optional(),
    noVncPort: z.number().int().positive().optional(),
    headless: z.boolean().optional(),
    enableNoVnc: z.boolean().optional(),
    allowHostControl: z.boolean().optional(),
    autoStart: z.boolean().optional(),
    autoStartTimeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const SandboxPruneSchema = z
  .object({
    idleHours: z.number().int().nonnegative().optional(),
    maxAgeDays: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const ToolPolicyBaseSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict();

type ToolPolicyConflictValue = {
  allow?: string[];
  alsoAllow?: string[];
};

const validateToolPolicyConflict = (
  scope: string,
  value: ToolPolicyConflictValue,
  ctx: zod.RefinementCtx,
) => {
  if (
    value.allow &&
    value.allow.length > 0 &&
    value.alsoAllow &&
    value.alsoAllow.length > 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${scope} cannot set both allow and alsoAllow in the same scope (merge alsoAllow into allow, or remove allow and use profile + alsoAllow)`,
    });
  }
};

const makeToolPolicySchema = (scope: string) =>
  ToolPolicyBaseSchema.superRefine((value, ctx) => {
    validateToolPolicyConflict(scope, value, ctx);
  });

// `provider`, `apiKey` and `perplexity` are retired: WEB_SEARCH is keyless and
// no runtime path reads them. They stay accepted so an existing config file
// that still carries them keeps validating; the settings surface no longer
// offers them.
export const ToolsWebSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.union([z.literal("brave"), z.literal("perplexity")]).optional(),
    apiKey: z.string().optional(),
    maxResults: z.number().int().positive().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    perplexity: z
      .object({
        apiKey: z.string().optional(),
        baseUrl: z.string().optional(),
        model: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const ToolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    cacheTtlMinutes: z.number().nonnegative().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    userAgent: z.string().optional(),
  })
  .strict()
  .optional();

export const ToolsWebSchema = z
  .object({
    search: ToolsWebSearchSchema,
    fetch: ToolsWebFetchSchema,
  })
  .strict()
  .optional();

/**
 * Top-level cross-tool cache config. Drives the two-tier `ToolCallCache`
 * (in-memory LRU + on-disk persistent under <stateDir>/tool-cache).
 *
 * Per-tool TTL overrides live under `perTool` keyed by tool name; values
 * are minutes for parity with the existing web search/fetch knobs. The
 * `cacheTtlMinutes` fields on `tools.web.search` / `tools.web.fetch` are
 * preserved for back-compat and feed into the same cache.
 */
export const ToolsCacheSchema = z
  .object({
    enabled: z.boolean().optional(),
    memoryCapacity: z.number().int().positive().optional(),
    diskRoot: z.string().optional(),
    perTool: z
      .record(
        z.string(),
        z
          .object({
            ttlMinutes: z.number().nonnegative().optional(),
            version: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .optional();

export const ToolProfileSchema = z
  .union([
    z.literal("minimal"),
    z.literal("coding"),
    z.literal("messaging"),
    z.literal("full"),
  ])
  .optional();

export const ToolPolicySchema = makeToolPolicySchema("tools policy").optional();

export const ToolPolicyWithProfileSchema = makeToolPolicySchema(
  "tools.byProvider policy",
)
  .extend({
    profile: ToolProfileSchema,
  })
  .strict();

// Provider docking: allowlists keyed by provider id (no schema updates when adding providers).
export const ElevatedAllowFromSchema = z
  .record(z.string(), z.array(z.union([z.string(), z.number()])))
  .optional();

export const AgentSandboxSchema = z
  .object({
    mode: z
      .union([z.literal("off"), z.literal("non-main"), z.literal("all")])
      .optional(),
    workspaceAccess: z
      .union([z.literal("none"), z.literal("ro"), z.literal("rw")])
      .optional(),
    sessionToolsVisibility: z
      .union([z.literal("spawned"), z.literal("all")])
      .optional(),
    scope: z
      .union([z.literal("session"), z.literal("agent"), z.literal("shared")])
      .optional(),
    perSession: z.boolean().optional(),
    workspaceRoot: z.string().optional(),
    docker: SandboxDockerSchema,
    browser: SandboxBrowserSchema,
    prune: SandboxPruneSchema,
  })
  .strict()
  .optional();

export const AgentToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        pathPrepend: z.array(z.string()).optional(),
        safeBins: z.array(z.string()).optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        approvalRunningNoticeMs: z.number().int().nonnegative().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateToolPolicyConflict("agent tools", value, ctx);
  })
  .optional();

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z
      .array(z.union([z.literal("memory"), z.literal("sessions")]))
      .optional(),
    extraPaths: z.array(z.string()).optional(),
    experimental: z
      .object({
        sessionMemory: z.boolean().optional(),
      })
      .strict()
      .optional(),
    provider: z
      .union([z.literal("openai"), z.literal("local"), z.literal("gemini")])
      .optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: z.string().optional(),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
            wait: z.boolean().optional(),
            concurrency: z.number().int().positive().optional(),
            pollIntervalMs: z.number().int().nonnegative().optional(),
            timeoutMinutes: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fallback: z
      .union([
        z.literal("openai"),
        z.literal("gemini"),
        z.literal("local"),
        z.literal("none"),
      ])
      .optional(),
    model: z.string().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
      })
      .strict()
      .optional(),
    store: z
      .object({
        driver: z.literal("sqlite").optional(),
        path: z.string().optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    chunking: z
      .object({
        tokens: z.number().int().positive().optional(),
        overlap: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sync: z
      .object({
        onSessionStart: z.boolean().optional(),
        onSearch: z.boolean().optional(),
        watch: z.boolean().optional(),
        watchDebounceMs: z.number().int().nonnegative().optional(),
        intervalMinutes: z.number().int().nonnegative().optional(),
        sessions: z
          .object({
            deltaBytes: z.number().int().nonnegative().optional(),
            deltaMessages: z.number().int().nonnegative().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
        hybrid: z
          .object({
            enabled: z.boolean().optional(),
            vectorWeight: z.number().min(0).max(1).optional(),
            textWeight: z.number().min(0).max(1).optional(),
            candidateMultiplier: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
    })
    .strict(),
]);
export const AgentEntrySchema = z
  .object({
    id: z.string(),
    default: z.boolean().optional(),
    name: z.string().optional(),
    workspace: z.string().optional(),
    agentDir: z.string().optional(),
    model: AgentModelSchema.optional(),
    skills: z.array(z.string()).optional(),
    memorySearch: MemorySearchSchema,
    advancedMemory: z.boolean().optional(),
    agentOrchestrator: z.boolean().optional(),
    gitpathologist: z.boolean().optional(),
    humanDelay: HumanDelaySchema.optional(),
    heartbeat: HeartbeatSchema,
    identity: IdentitySchema,
    groupChat: GroupChatSchema,
    subagents: z
      .object({
        allowAgents: z.array(z.string()).optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    sandbox: AgentSandboxSchema,
    tools: AgentToolsSchema,
  })
  .strict();

export const ToolsSchema = z
  .object({
    profile: ToolProfileSchema,
    allow: z.array(z.string()).optional(),
    alsoAllow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), ToolPolicyWithProfileSchema).optional(),
    web: ToolsWebSchema,
    cache: ToolsCacheSchema,
    media: ToolsMediaSchema,
    links: ToolsLinksSchema,
    message: z
      .object({
        allowCrossContextSend: z.boolean().optional(),
        crossContext: z
          .object({
            allowWithinProvider: z.boolean().optional(),
            allowAcrossProviders: z.boolean().optional(),
            marker: z
              .object({
                enabled: z.boolean().optional(),
                prefix: z.string().optional(),
                suffix: z.string().optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
        broadcast: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    agentToAgent: z
      .object({
        enabled: z.boolean().optional(),
        allow: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    elevated: z
      .object({
        enabled: z.boolean().optional(),
        allowFrom: ElevatedAllowFromSchema,
      })
      .strict()
      .optional(),
    exec: z
      .object({
        host: z.enum(["sandbox", "gateway", "node"]).optional(),
        security: z.enum(["deny", "allowlist", "full"]).optional(),
        ask: z.enum(["off", "on-miss", "always"]).optional(),
        node: z.string().optional(),
        pathPrepend: z.array(z.string()).optional(),
        safeBins: z.array(z.string()).optional(),
        backgroundMs: z.number().int().positive().optional(),
        timeoutSec: z.number().int().positive().optional(),
        cleanupMs: z.number().int().positive().optional(),
        notifyOnExit: z.boolean().optional(),
        applyPatch: z
          .object({
            enabled: z.boolean().optional(),
            allowModels: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        tools: ToolPolicySchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateToolPolicyConflict("tools", value, ctx);
  })
  .optional();

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OwnerContactEntrySchema = z
  .object({
    source: z.string().trim().min(1).optional(),
    entityId: z.string().regex(uuidPattern, "invalid UUID").optional(),
    channelId: z.string().optional(),
    roomId: z.string().regex(uuidPattern, "invalid UUID").optional(),
  })
  .strict();

export const OwnerContactsSchema = z
  .record(z.string(), OwnerContactEntrySchema)
  .optional();

export const EscalationSchema = z
  .object({
    channels: z.array(z.string()).optional(),
    waitMinutes: z.number().min(1).max(60).optional(),
    maxRetries: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .optional();

// --- Inbox triage ---

const InboxAutoReplySchema = z
  .object({
    enabled: z.boolean().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    senderWhitelist: z.array(z.string()).optional(),
    channelWhitelist: z.array(z.string()).optional(),
    maxAutoRepliesPerHour: z.number().int().min(0).optional(),
  })
  .strict()
  .optional();

const InboxTriageRulesSchema = z
  .object({
    alwaysUrgent: z.array(z.string()).optional(),
    alwaysIgnore: z.array(z.string()).optional(),
    alwaysNotify: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const InboxTriageConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    triageCron: z.string().optional(),
    digestCron: z.string().optional(),
    digestTimezone: z.string().optional(),
    channels: z.array(z.string()).optional(),
    prioritySenders: z.array(z.string()).optional(),
    priorityChannels: z.array(z.string()).optional(),
    autoReply: InboxAutoReplySchema,
    triageRules: InboxTriageRulesSchema,
    digestDeliveryChannel: z.string().optional(),
    retentionDays: z.number().int().min(1).optional(),
  })
  .strict()
  .optional();

export const AgentDefaultsSchema = z
  .object({
    model: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    imageModel: z
      .object({
        primary: z.string().optional(),
        fallbacks: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    models: z
      .record(
        z.string(),
        z
          .object({
            alias: z.string().optional(),
            /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
            params: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .optional(),
    workspace: z.string().optional(),
    adminEntityId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        "invalid UUID format",
      )
      .optional(),
    ownerContacts: OwnerContactsSchema,
    escalation: EscalationSchema,
    repoRoot: z.string().optional(),
    skipInit: z.boolean().optional(),
    enableInitProviders: z.boolean().optional(),
    userTimezone: z.string().optional(),
    timeFormat: z
      .union([z.literal("auto"), z.literal("12"), z.literal("24")])
      .optional(),
    envelopeTimezone: z.string().optional(),
    envelopeTimestamp: z.union([z.literal("on"), z.literal("off")]).optional(),
    envelopeElapsed: z.union([z.literal("on"), z.literal("off")]).optional(),
    contextTokens: z.number().int().positive().optional(),
    cliBackends: z.record(z.string(), CliBackendSchema).optional(),
    memorySearch: MemorySearchSchema,
    advancedMemory: z.boolean().optional(),
    agentOrchestrator: z.boolean().optional(),
    gitpathologist: z.boolean().optional(),
    thinkingDefault: z
      .union([
        z.literal("off"),
        z.literal("minimal"),
        z.literal("low"),
        z.literal("medium"),
        z.literal("high"),
        z.literal("xhigh"),
      ])
      .optional(),
    verboseDefault: z
      .union([z.literal("off"), z.literal("on"), z.literal("full")])
      .optional(),
    elevatedDefault: z
      .union([
        z.literal("off"),
        z.literal("on"),
        z.literal("ask"),
        z.literal("full"),
      ])
      .optional(),
    blockStreamingDefault: z
      .union([z.literal("off"), z.literal("on")])
      .optional(),
    blockStreamingBreak: z
      .union([z.literal("text_end"), z.literal("message_end")])
      .optional(),
    blockStreamingChunk: BlockStreamingChunkSchema.optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    humanDelay: HumanDelaySchema.optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    mediaMaxMb: z.number().positive().optional(),
    typingIntervalSeconds: z.number().int().positive().optional(),
    typingMode: z
      .union([
        z.literal("never"),
        z.literal("instant"),
        z.literal("thinking"),
        z.literal("message"),
      ])
      .optional(),
    heartbeat: HeartbeatSchema,
    maxConcurrent: z.number().int().positive().optional(),
    subagents: z
      .object({
        maxConcurrent: z.number().int().positive().optional(),
        archiveAfterMinutes: z.number().int().positive().optional(),
        model: z
          .union([
            z.string(),
            z
              .object({
                primary: z.string().optional(),
                fallbacks: z.array(z.string()).optional(),
              })
              .strict(),
          ])
          .optional(),
        thinking: z.string().optional(),
      })
      .strict()
      .optional(),
    sandbox: z
      .object({
        mode: z
          .union([z.literal("off"), z.literal("non-main"), z.literal("all")])
          .optional(),
        workspaceAccess: z
          .union([z.literal("none"), z.literal("ro"), z.literal("rw")])
          .optional(),
        sessionToolsVisibility: z
          .union([z.literal("spawned"), z.literal("all")])
          .optional(),
        scope: z
          .union([
            z.literal("session"),
            z.literal("agent"),
            z.literal("shared"),
          ])
          .optional(),
        perSession: z.boolean().optional(),
        workspaceRoot: z.string().optional(),
        docker: SandboxDockerSchema,
        browser: SandboxBrowserSchema,
        prune: SandboxPruneSchema,
      })
      .strict()
      .optional(),
    inboxTriage: InboxTriageConfigSchema,
  })
  .strict()
  .optional();
