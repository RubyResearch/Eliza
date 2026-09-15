/**
 * Prompt optimization layer for eliza.
 *
 * Wraps `runtime.useModel()` to capture complete prompt and usage telemetry and
 * inject active-view awareness. Controlled via ELIZA_* env vars.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentRuntime,
  assertActiveTrajectoryForLlmCall,
  ElizaError,
  EventType,
  getTrajectoryContext,
  isLlmGenerationModelType,
  isTextGenerationModelType,
  normalizeTrajectoryLlmPurpose,
} from "@elizaos/core";
import { detectRuntimeModel } from "../api/agent-model.ts";
import {
  type ModelTokenMetadata,
  resolveModelTokenMetadata,
} from "../config/model-metadata.ts";
import type { ElizaConfig } from "../config/types.ts";

import type { TrajectoryLlmCall } from "../types/trajectory.ts";

type CompactorRole = "system" | "developer" | "user" | "assistant" | "tool";

type CompactorToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type CompactorMessage = {
  role: CompactorRole;
  content: string;
  toolCalls?: CompactorToolCall[];
  toolCallId?: string;
  toolName?: string;
  timestamp?: number;
  tags?: string[];
};

import {
  enrichTrajectoryLlmCall,
  ensureTrajectoriesTable,
  isLegacyTrajectoryLogger,
  loadTrajectoryByStepId,
  saveTrajectory,
  toOptionalNumber,
  toText,
} from "./trajectory-internals.ts";
import {
  applyActiveViewAwareness,
  getActiveViewContext,
  renderActiveViewContextBlock,
} from "./view-action-affinity.ts";

// ---------------------------------------------------------------------------
// Env-var driven configuration (evaluated once at import time)
// ---------------------------------------------------------------------------

/**
 * Dump raw prompts to .tmp/prompt-captures/ for analysis. Dev-only.
 * WARNING: captures contain full conversation content including user messages.
 */
const ELIZA_CAPTURE_PROMPTS =
  process.env.ELIZA_CAPTURE_PROMPTS === "1" ||
  process.env.ELIZA_CAPTURE_PROMPTS?.toLowerCase() === "true";

let promptCaptureSeq = 0;

async function writePromptCapture(
  runtime: AgentRuntime,
  capturePath: string,
  content: string,
): Promise<boolean> {
  try {
    await mkdir(path.dirname(capturePath), { recursive: true });
    await writeFile(capturePath, content);
    return true;
  } catch (error) {
    // error-policy:J7 optional prompt diagnostics must not block model calls.
    runtime.reportError("PromptOptimization.capture", error, { capturePath });
    return false;
  }
}

// Track which runtimes have been wrapped to prevent double-installation.
const installedRuntimes = new WeakSet<AgentRuntime>();
const usageCaptureInstalledRuntimes = new WeakSet<AgentRuntime>();
const usageCaptureContext = new AsyncLocalStorage<
  ReadonlyMap<AgentRuntime, readonly ModelUsageAccumulator[]>
>();
const runtimeModelConfigs = new WeakMap<AgentRuntime, ElizaConfig>();
const trackedTrajectoryLoggers = new WeakSet<object>();
const trajectoryLlmLogCounts = new WeakMap<AgentRuntime, Map<string, number>>();
const TRAJECTORY_CONTEXT_MANAGER_KEY = Symbol.for(
  "elizaos.trajectoryContextManager",
);

type GlobalWithTrajectoryContextManager = typeof globalThis & {
  [TRAJECTORY_CONTEXT_MANAGER_KEY]?: {
    active: () => { trajectoryStepId?: string } | undefined;
  };
};

type TrajectoryLoggerLike = {
  logLlmCall?: (...args: unknown[]) => unknown;
  logProviderAccess?: (...args: unknown[]) => unknown;
  getLlmCallLogs?: () => readonly unknown[];
  getProviderAccessLogs?: () => readonly unknown[];
  updateLatestLlmCall?: (
    stepId: string,
    patch: Record<string, unknown>,
  ) => Promise<void> | void;
};

type RuntimeWithTrajectoryService = AgentRuntime & {
  getService?: (serviceType: string) => unknown;
  getServicesByType?: (serviceType: string) => unknown;
};

type RuntimeWithEmitEvent = AgentRuntime & {
  emitEvent: (event: unknown, params?: unknown) => Promise<void> | void;
};

type PromptOptimizationTelemetry = {
  mode: string;
  contextPreserved: boolean;
  originalPromptChars: number;
  finalPromptChars: number;
  originalPromptTokens: number;
  finalPromptTokens: number;
  budgetTokens?: number;
  outputReserveTokens?: number;
  transformations: string[];
};

export interface CapturedModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  provider?: string;
  isEstimated: boolean;
  llmCalls: number;
}

interface ModelUsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cachedInputTokens?: number;
  model?: string;
  provider?: string;
  isEstimated: boolean;
}

interface ModelUsageAccumulator {
  records: ModelUsageRecord[];
}

interface PromptBudget {
  metadata: ModelTokenMetadata;
  outputReserveTokens?: number;
  promptBudgetTokens: number;
}

export function shouldPreserveFullPromptForTrajectoryCapture(): boolean {
  return getActiveTrajectoryStepId() !== null;
}

function getSharedTrajectoryStepId(): string | null {
  const stepId = (globalThis as GlobalWithTrajectoryContextManager)[
    TRAJECTORY_CONTEXT_MANAGER_KEY
  ]?.active?.()?.trajectoryStepId;
  return typeof stepId === "string" && stepId.trim().length > 0
    ? stepId.trim()
    : null;
}

function getActiveTrajectoryStepId(): string | null {
  const coreStepId = getTrajectoryContext()?.trajectoryStepId;
  if (typeof coreStepId === "string" && coreStepId.trim().length > 0) {
    return coreStepId.trim();
  }

  return getSharedTrajectoryStepId();
}

function extractTrajectoryStepIdFromLoggerArgs(args: unknown[]): string | null {
  if (args.length === 0) return null;
  const first = args[0];
  if (typeof first === "string") {
    const stepId = first.trim();
    return stepId.length > 0 ? stepId : null;
  }
  if (!first || typeof first !== "object") return null;
  const stepId = (first as { stepId?: unknown }).stepId;
  return typeof stepId === "string" && stepId.trim().length > 0
    ? stepId.trim()
    : null;
}

function getTrajectoryLlmLogCount(
  runtime: AgentRuntime,
  stepId: string,
): number {
  return trajectoryLlmLogCounts.get(runtime)?.get(stepId) ?? 0;
}

function incrementTrajectoryLlmLogCount(
  runtime: AgentRuntime,
  stepId: string,
): void {
  const counts =
    trajectoryLlmLogCounts.get(runtime) ?? new Map<string, number>();
  counts.set(stepId, (counts.get(stepId) ?? 0) + 1);
  trajectoryLlmLogCounts.set(runtime, counts);
}

function resolveTrajectoryLogger(
  runtime: AgentRuntime,
): TrajectoryLoggerLike | null {
  const runtimeWithService = runtime as RuntimeWithTrajectoryService;
  const candidates: TrajectoryLoggerLike[] = [];
  const seen = new Set<unknown>();
  const push = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);
    candidates.push(candidate as TrajectoryLoggerLike);
  };

  if (typeof runtimeWithService.getServicesByType === "function") {
    const byType = runtimeWithService.getServicesByType("trajectories");
    if (Array.isArray(byType)) {
      for (const candidate of byType) {
        push(candidate);
      }
    } else {
      push(byType);
    }
  }

  if (typeof runtimeWithService.getService === "function") {
    push(runtimeWithService.getService("trajectories"));
  }

  if (candidates.length === 0) return null;

  let best: TrajectoryLoggerLike | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    let score = 0;
    if (isLegacyTrajectoryLogger(candidate)) score += 100;
    if (typeof candidate.logLlmCall === "function") score += 10;
    if (typeof candidate.logProviderAccess === "function") score += 10;
    if (typeof candidate.getLlmCallLogs === "function") score += 2;
    if (typeof candidate.getProviderAccessLogs === "function") score += 2;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function ensureTrajectoryLoggerTracking(
  runtime: AgentRuntime,
): TrajectoryLoggerLike | null {
  const trajectoryLogger = resolveTrajectoryLogger(runtime);
  if (!trajectoryLogger) {
    return trajectoryLogger;
  }

  if (typeof trajectoryLogger.updateLatestLlmCall !== "function") {
    trajectoryLogger.updateLatestLlmCall = async (
      stepId: string,
      patch: Record<string, unknown>,
    ) => {
      const normalizedStepId = stepId.trim();
      if (!normalizedStepId) return;

      const tableReady = await ensureTrajectoriesTable(runtime);
      if (!tableReady) return;

      const trajectory = await loadTrajectoryByStepId(
        runtime,
        normalizedStepId,
      );
      if (!trajectory || !Array.isArray(trajectory.steps)) return;

      const step =
        [...trajectory.steps]
          .reverse()
          .find((candidate) => candidate.stepId === normalizedStepId) ??
        trajectory.steps[trajectory.steps.length - 1];
      const calls = Array.isArray(step?.llmCalls) ? step.llmCalls : [];
      const latestCall =
        calls.length > 0
          ? (calls[calls.length - 1] as TrajectoryLlmCall)
          : null;
      if (!latestCall) return;

      let updated = false;
      const nextModel = toText(patch.model, "").trim();
      const currentModel = toText(latestCall.model, "").trim();
      if (
        nextModel &&
        currentModel !== nextModel &&
        (currentModel.length === 0 ||
          isGenericTrajectoryModel(currentModel) ||
          !isGenericTrajectoryModel(nextModel))
      ) {
        latestCall.model = nextModel;
        updated = true;
      }

      const nextSystemPrompt = toText(patch.systemPrompt, "");
      if (!toText(latestCall.systemPrompt, "") && nextSystemPrompt) {
        latestCall.systemPrompt = nextSystemPrompt;
        updated = true;
      }

      const nextUserPrompt = toText(patch.userPrompt, "");
      if (!toText(latestCall.userPrompt, "") && nextUserPrompt) {
        latestCall.userPrompt = nextUserPrompt;
        updated = true;
      }

      const nextResponse = toText(patch.response, "");
      if (!toText(latestCall.response, "") && nextResponse) {
        latestCall.response = nextResponse;
        updated = true;
      }

      type NumericLlmCallField =
        | "temperature"
        | "maxTokens"
        | "latencyMs"
        | "promptTokens"
        | "completionTokens";

      function readExistingNumeric(
        call: TrajectoryLlmCall,
        key: NumericLlmCallField,
      ) {
        switch (key) {
          case "temperature":
            return call.temperature;
          case "maxTokens":
            return call.maxTokens;
          case "latencyMs":
            return call.latencyMs;
          case "promptTokens":
            return call.promptTokens;
          case "completionTokens":
            return call.completionTokens;
          default: {
            const _exhaustive: never = key;
            return _exhaustive;
          }
        }
      }

      function writeNumeric(
        call: TrajectoryLlmCall,
        key: NumericLlmCallField,
        value: number,
      ) {
        switch (key) {
          case "temperature":
            call.temperature = value;
            break;
          case "maxTokens":
            call.maxTokens = value;
            break;
          case "latencyMs":
            call.latencyMs = value;
            break;
          case "promptTokens":
            call.promptTokens = value;
            break;
          case "completionTokens":
            call.completionTokens = value;
            break;
          default: {
            const _exhaustive: never = key;
            return _exhaustive;
          }
        }
      }

      const applyMissingNumber = (key: NumericLlmCallField): void => {
        const rawPatch = (patch as Record<string, unknown>)[key];
        const nextValue = toOptionalNumber(rawPatch);
        if (nextValue === undefined) return;
        const currentValue = toOptionalNumber(
          readExistingNumeric(latestCall, key),
        );
        if (currentValue !== undefined && currentValue > 0) return;
        writeNumeric(latestCall, key, nextValue);
        updated = true;
      };

      applyMissingNumber("temperature");
      applyMissingNumber("maxTokens");
      applyMissingNumber("latencyMs");
      applyMissingNumber("promptTokens");
      applyMissingNumber("completionTokens");

      if (typeof patch.tokenUsageEstimated === "boolean") {
        const currentEstimated = latestCall.tokenUsageEstimated;
        if (
          typeof currentEstimated !== "boolean" ||
          (currentEstimated && !patch.tokenUsageEstimated)
        ) {
          latestCall.tokenUsageEstimated = patch.tokenUsageEstimated;
          updated = true;
        }
      }

      const patchProviderMetadata = (patch as Record<string, unknown>)
        .providerMetadata;
      if (
        patchProviderMetadata &&
        typeof patchProviderMetadata === "object" &&
        !Array.isArray(patchProviderMetadata)
      ) {
        const currentProviderMetadata =
          latestCall.providerMetadata &&
          typeof latestCall.providerMetadata === "object" &&
          !Array.isArray(latestCall.providerMetadata)
            ? (latestCall.providerMetadata as Record<string, unknown>)
            : {};
        latestCall.providerMetadata = {
          ...currentProviderMetadata,
          ...(patchProviderMetadata as Record<string, unknown>),
        };
        updated = true;
      }

      const enriched = enrichTrajectoryLlmCall(
        latestCall as Record<string, unknown>,
      );
      const nextStepType = toText(enriched.stepType, "");
      if (nextStepType && toText(latestCall.stepType, "") !== nextStepType) {
        latestCall.stepType = nextStepType;
        updated = true;
      }

      const nextTags = Array.isArray(enriched.tags)
        ? enriched.tags.filter(
            (tag): tag is string => typeof tag === "string" && tag.length > 0,
          )
        : [];
      const currentTags = Array.isArray(latestCall.tags)
        ? latestCall.tags.filter(
            (tag): tag is string => typeof tag === "string" && tag.length > 0,
          )
        : [];
      if (
        nextTags.length > 0 &&
        JSON.stringify(currentTags) !== JSON.stringify(nextTags)
      ) {
        latestCall.tags = nextTags;
        updated = true;
      }

      if (!updated) return;

      trajectory.updatedAt = new Date().toISOString();
      await saveTrajectory(runtime, trajectory, {
        changedStepIds: [step.stepId],
      });
    };
  }

  if (typeof trajectoryLogger.logLlmCall !== "function") {
    return trajectoryLogger;
  }

  const loggerObject = trajectoryLogger as object;
  if (trackedTrajectoryLoggers.has(loggerObject)) {
    return trajectoryLogger;
  }

  const originalLogLlmCall = trajectoryLogger.logLlmCall.bind(trajectoryLogger);
  trajectoryLogger.logLlmCall = ((...args: unknown[]) => {
    const stepId = extractTrajectoryStepIdFromLoggerArgs(args);
    if (stepId) {
      incrementTrajectoryLlmLogCount(runtime, stepId);
    }
    return originalLogLlmCall(...args);
  }) as typeof trajectoryLogger.logLlmCall;

  trackedTrajectoryLoggers.add(loggerObject);
  return trajectoryLogger;
}

function stringifyTrajectoryResponse(response: unknown): string {
  if (typeof response === "string") return response;
  if (response == null) return "";
  try {
    return JSON.stringify(response);
  } catch {
    return String(response);
  }
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

type ModelPayloadMessage = {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
  tool_calls?: unknown;
  toolCallId?: unknown;
  tool_call_id?: unknown;
  toolName?: unknown;
  name?: unknown;
};

// Compactors operate on plain text, but model messages also carry structured
// parts. An enumerable symbol survives the exact object spreads used for the
// protected tail while remaining invisible to JSON/model payloads, letting us
// re-emit untouched provider-neutral envelopes without reconstructing them.
const SOURCE_PAYLOAD_MESSAGE = Symbol(
  "promptOptimization.sourcePayloadMessage",
);

type SourcePayloadMessage = {
  raw: Record<string, unknown>;
  projectionKey: string;
  structureKey: string;
  projectedText: string;
};

type PromptCompactorMessage = CompactorMessage & {
  [SOURCE_PAYLOAD_MESSAGE]?: SourcePayloadMessage;
};

type ContentProjection = {
  text: string;
  toolCalls?: NonNullable<CompactorMessage["toolCalls"]>;
  toolCallId?: string;
  toolName?: string;
};

function stringifyProjectedValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    // error-policy:J3 model content can include cyclic host objects; the string
    // form is an explicit token-budget projection, never the outbound payload.
    return String(value);
  }
}

function toolResultOutputToText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return stringifyProjectedValue(value);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.type === "string" &&
    (record.type === "text" || record.type === "error-text")
  ) {
    return stringifyProjectedValue(record.value);
  }
  if (
    typeof record.type === "string" &&
    (record.type === "json" || record.type === "error-json")
  ) {
    return stringifyProjectedValue(record.value);
  }
  return stringifyProjectedValue(value);
}

function contentPartText(part: unknown): string | null {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object" || Array.isArray(part)) return null;
  const record = part as Record<string, unknown>;
  if (record.type === "tool-result") {
    return toolResultOutputToText(record.output ?? record.result);
  }
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return null;
}

function projectMessageContent(
  content: unknown,
  role: string,
): ContentProjection {
  if (!Array.isArray(content)) {
    return { text: stringifyProjectedValue(content) };
  }

  const text: string[] = [];
  const contentToolCalls: NonNullable<CompactorMessage["toolCalls"]> = [];
  let toolCallId: string | undefined;
  let toolName: string | undefined;

  for (const part of content) {
    const projectedText = contentPartText(part);
    if (projectedText) text.push(projectedText);
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const record = part as Record<string, unknown>;
    if (role === "assistant" && record.type === "tool-call") {
      const normalized = normalizeToolCalls([record]);
      if (normalized) contentToolCalls.push(...normalized);
    }
    if (role === "tool" && record.type === "tool-result") {
      toolCallId ??=
        typeof record.toolCallId === "string"
          ? record.toolCallId
          : typeof record.id === "string"
            ? record.id
            : undefined;
      toolName ??=
        typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : undefined;
    }
  }

  return {
    text: text.join("\n"),
    ...(contentToolCalls.length > 0 ? { toolCalls: contentToolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function normalizeToolCalls(value: unknown): CompactorMessage["toolCalls"] {
  if (!Array.isArray(value)) return undefined;
  const out: NonNullable<CompactorMessage["toolCalls"]> = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === "object"
        ? (record.function as Record<string, unknown>)
        : null;
    const id =
      typeof record.toolCallId === "string"
        ? record.toolCallId
        : typeof record.id === "string"
          ? record.id
          : "";
    const name =
      typeof record.toolName === "string"
        ? record.toolName
        : typeof record.name === "string"
          ? record.name
          : typeof fn?.name === "string"
            ? fn.name
            : "";
    if (!id || !name) continue;
    const argsRaw =
      record.input ??
      record.arguments ??
      record.args ??
      (fn ? (fn.arguments ?? fn.args) : undefined);
    let parsedArgs: Record<string, unknown> = {};
    if (argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)) {
      parsedArgs = argsRaw as Record<string, unknown>;
    } else if (typeof argsRaw === "string" && argsRaw.trim().length > 0) {
      try {
        const parsed = JSON.parse(argsRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsedArgs = parsed as Record<string, unknown>;
        }
      } catch {
        // error-policy:J3 non-JSON tool arguments remain explicit raw text in
        // the compactor projection while the source envelope stays untouched.
        parsedArgs = { raw: argsRaw };
      }
    }
    out.push({ id, name, arguments: parsedArgs });
  }
  return out.length > 0 ? out : undefined;
}

function mergeToolCalls(
  ...groups: Array<CompactorMessage["toolCalls"]>
): CompactorMessage["toolCalls"] {
  const merged: NonNullable<CompactorMessage["toolCalls"]> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const call of group ?? []) {
      if (seen.has(call.id)) continue;
      seen.add(call.id);
      merged.push(call);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function compactorProjectionKey(message: CompactorMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  });
}

function compactorStructureKey(message: CompactorMessage): string {
  return JSON.stringify({
    role: message.role,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
  });
}

function normalizePayloadMessages(
  value: unknown,
): PromptCompactorMessage[] | null {
  if (!Array.isArray(value)) return null;
  const out: PromptCompactorMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return null;
    }
    const record = item as ModelPayloadMessage;
    const role = typeof record.role === "string" ? record.role : "";
    if (
      role !== "system" &&
      role !== "developer" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      return null;
    }
    const projectedContent = projectMessageContent(record.content, role);
    const toolCalls = mergeToolCalls(
      normalizeToolCalls(record.toolCalls ?? record.tool_calls),
      projectedContent.toolCalls,
    );
    const toolCallId =
      typeof record.toolCallId === "string"
        ? record.toolCallId
        : typeof record.tool_call_id === "string"
          ? record.tool_call_id
          : projectedContent.toolCallId;
    const toolName =
      typeof record.toolName === "string"
        ? record.toolName
        : typeof record.name === "string"
          ? record.name
          : projectedContent.toolName;
    const normalized: PromptCompactorMessage = {
      role,
      content: projectedContent.text,
      ...(toolCalls ? { toolCalls } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      ...(toolName ? { toolName } : {}),
    };
    normalized[SOURCE_PAYLOAD_MESSAGE] = {
      raw: item as Record<string, unknown>,
      projectionKey: compactorProjectionKey(normalized),
      structureKey: compactorStructureKey(normalized),
      projectedText: projectedContent.text,
    };
    out.push(normalized);
  }
  return out;
}

function renderMessagesForTelemetry(messages: CompactorMessage[]): string {
  return messages
    .map((message) => {
      const toolCalls = message.toolCalls?.length
        ? `\n${message.toolCalls
            .map(
              (call) =>
                `  toolCall id=${call.id} name=${call.name} args=${JSON.stringify(call.arguments)}`,
            )
            .join("\n")}`
        : "";
      const toolMeta =
        message.role === "tool"
          ? ` toolCallId=${message.toolCallId ?? ""} toolName=${message.toolName ?? ""}`
          : "";
      return `[${message.role}${toolMeta}] ${message.content}${toolCalls}`;
    })
    .join("\n");
}

function rewriteSourceContentText(
  content: unknown,
  originalText: string,
  nextText: string,
): unknown {
  if (!Array.isArray(content)) return nextText;
  if (nextText === originalText) return content;

  const projectedParts: Array<{
    index: number;
    start: number;
    end: number;
    text: string;
    writable: boolean;
  }> = [];
  let projectedLength = 0;
  for (const [index, part] of content.entries()) {
    const text = contentPartText(part);
    if (!text) continue;
    if (projectedParts.length > 0) projectedLength += 1;
    const start = projectedLength;
    projectedLength += text.length;
    projectedParts.push({
      index,
      start,
      end: projectedLength,
      text,
      writable:
        !part ||
        typeof part !== "object" ||
        (part as Record<string, unknown>).type !== "tool-result",
    });
  }

  const projectedText = projectedParts.map((part) => part.text).join("\n");
  if (projectedText !== originalText) {
    throw new ElizaError(
      "Structured model content no longer matches its prompt projection",
      {
        code: "PROMPT_CONTENT_PROJECTION_MISMATCH",
        severity: "fatal",
        context: {
          contentPartCount: content.length,
          projectedTextLength: projectedText.length,
          originalTextLength: originalText.length,
        },
      },
    );
  }

  if (projectedParts.length === 0) {
    const emptyTextIndex = content.findIndex((part) => {
      if (contentPartText(part) !== "") return false;
      return (
        !part ||
        typeof part !== "object" ||
        (part as Record<string, unknown>).type !== "tool-result"
      );
    });
    if (emptyTextIndex >= 0) {
      return content.map((part, index) =>
        index === emptyTextIndex
          ? rewriteContentPartText(part, nextText)
          : part,
      );
    }
    return nextText ? [{ type: "text", text: nextText }, ...content] : content;
  }

  let commonPrefixLength = 0;
  while (
    commonPrefixLength < originalText.length &&
    commonPrefixLength < nextText.length &&
    originalText[commonPrefixLength] === nextText[commonPrefixLength]
  ) {
    commonPrefixLength += 1;
  }

  let commonSuffixLength = 0;
  while (
    commonSuffixLength < originalText.length - commonPrefixLength &&
    commonSuffixLength < nextText.length - commonPrefixLength &&
    originalText[originalText.length - 1 - commonSuffixLength] ===
      nextText[nextText.length - 1 - commonSuffixLength]
  ) {
    commonSuffixLength += 1;
  }

  const originalChangeEnd = originalText.length - commonSuffixLength;
  const replacement = nextText.slice(
    commonPrefixLength,
    nextText.length - commonSuffixLength,
  );
  const target = projectedParts.find(
    (part) =>
      part.writable &&
      commonPrefixLength >= part.start &&
      originalChangeEnd <= part.end,
  );
  if (!target) {
    throw new ElizaError(
      "Prompt optimization crossed a structured content-part boundary",
      {
        code: "PROMPT_CONTENT_PART_BOUNDARY_CROSSED",
        severity: "fatal",
        context: {
          contentPartCount: content.length,
          projectedPartCount: projectedParts.length,
          originalTextLength: originalText.length,
          nextTextLength: nextText.length,
          changeStart: commonPrefixLength,
          changeEnd: originalChangeEnd,
        },
      },
    );
  }

  const localStart = commonPrefixLength - target.start;
  const localEnd = originalChangeEnd - target.start;
  const rewrittenText = `${target.text.slice(0, localStart)}${replacement}${target.text.slice(localEnd)}`;
  return content.map((part, index) =>
    index === target.index ? rewriteContentPartText(part, rewrittenText) : part,
  );
}

function rewriteContentPartText(part: unknown, text: string): unknown {
  if (typeof part === "string") return text;
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    throw new ElizaError("Prompt content part is not text-addressable", {
      code: "PROMPT_CONTENT_PART_INVALID",
      severity: "fatal",
    });
  }
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return { ...record, text };
  if (typeof record.content === "string") return { ...record, content: text };
  throw new ElizaError("Prompt content part is not text-addressable", {
    code: "PROMPT_CONTENT_PART_INVALID",
    severity: "fatal",
    context: { partType: record.type },
  });
}

function sourcePayloadMessage(
  message: PromptCompactorMessage,
): Record<string, unknown> | null {
  const source = message[SOURCE_PAYLOAD_MESSAGE];
  if (!source) return null;
  if (compactorProjectionKey(message) === source.projectionKey) {
    return { ...source.raw };
  }
  if (compactorStructureKey(message) !== source.structureKey) return null;
  return {
    ...source.raw,
    content: rewriteSourceContentText(
      source.raw.content,
      source.projectedText,
      message.content,
    ),
  };
}

/** Rehydrates compactor messages into provider-neutral model wire envelopes. */
export function serializeCompactorMessagesForModel(
  messages: CompactorMessage[],
): Array<Record<string, unknown>> {
  return messages.map((rawMessage) => {
    const message = rawMessage as PromptCompactorMessage;
    const source = sourcePayloadMessage(message);
    if (source) return source;
    const record: Record<string, unknown> = {
      role: message.role,
      content: message.content,
    };
    if (message.role === "assistant" && message.toolCalls?.length) {
      record.toolCalls = message.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      }));
    }
    if (message.role === "tool") {
      if (message.toolCallId) record.toolCallId = message.toolCallId;
      if (message.toolName) record.toolName = message.toolName;
    }
    return record;
  });
}

/**
 * Append the fresh view snapshot to the last user message. Keeping the original
 * content first preserves the reusable planner prefix as feedback grows. Each
 * dispatch starts from the caller's unchanged messages; never strip headings
 * from them, since a quoted Active View block can be original source evidence.
 */
function applyActiveViewAwarenessToMessages(
  messages: CompactorMessage[],
  view: Parameters<typeof applyActiveViewAwareness>[1],
): CompactorMessage[] {
  let userMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      userMessageIndex = index;
      break;
    }
  }
  if (userMessageIndex === -1) return messages;

  const message = messages[userMessageIndex];
  if (!view) return messages;
  const block = renderActiveViewContextBlock(view);
  const awareContent =
    message.content.length > 0 ? `${message.content}\n\n${block}` : block;

  const rewritten = [...messages];
  rewritten[userMessageIndex] = { ...message, content: awareContent };
  return rewritten;
}

function providerOptionsWithPromptOptimization(
  payloadRecord: Record<string, unknown>,
  telemetry: PromptOptimizationTelemetry,
): Record<string, unknown> {
  const providerOptions = (
    payloadRecord.providerOptions &&
    typeof payloadRecord.providerOptions === "object" &&
    !Array.isArray(payloadRecord.providerOptions)
      ? (payloadRecord.providerOptions as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  const eliza = (
    providerOptions.eliza &&
    typeof providerOptions.eliza === "object" &&
    !Array.isArray(providerOptions.eliza)
      ? (providerOptions.eliza as Record<string, unknown>)
      : {}
  ) as Record<string, unknown>;
  eliza.promptOptimization = telemetry;
  providerOptions.eliza = eliza;
  payloadRecord.providerOptions = providerOptions;
  return providerOptions;
}

function isModelUsedEvent(event: unknown): boolean {
  if (event === EventType.MODEL_USED) {
    return true;
  }
  if (Array.isArray(event)) {
    return event.some((entry) => isModelUsedEvent(entry));
  }
  return false;
}

function toUsageModelLabel(
  payload: Record<string, unknown>,
): string | undefined {
  for (const key of ["model", "modelId", "modelName"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeModelUsageRecord(payload: unknown): ModelUsageRecord | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const tokens =
    record.tokens &&
    typeof record.tokens === "object" &&
    !Array.isArray(record.tokens)
      ? (record.tokens as Record<string, unknown>)
      : undefined;
  if (!tokens) return null;

  const promptTokens = toOptionalNumber(tokens.prompt);
  const completionTokens = toOptionalNumber(tokens.completion);
  const totalTokens = toOptionalNumber(tokens.total);
  const cacheReadInputTokens =
    toOptionalNumber(tokens.cacheReadInputTokens) ??
    toOptionalNumber(tokens.cache_read_input_tokens) ??
    toOptionalNumber(tokens.cacheReadTokens) ??
    toOptionalNumber(tokens.cachedInputTokens) ??
    toOptionalNumber(tokens.cached_input_tokens) ??
    toOptionalNumber(tokens.cached);
  const cacheCreationInputTokens =
    toOptionalNumber(tokens.cacheCreationInputTokens) ??
    toOptionalNumber(tokens.cache_creation_input_tokens) ??
    toOptionalNumber(tokens.cacheWriteInputTokens) ??
    toOptionalNumber(tokens.cacheWriteTokens);
  const cachedInputTokens =
    toOptionalNumber(tokens.cachedInputTokens) ??
    toOptionalNumber(tokens.cached_input_tokens) ??
    toOptionalNumber(tokens.cached) ??
    cacheReadInputTokens;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    cacheReadInputTokens === undefined &&
    cacheCreationInputTokens === undefined &&
    cachedInputTokens === undefined
  ) {
    return null;
  }

  const normalizedPromptTokens = promptTokens ?? 0;
  const normalizedCompletionTokens =
    completionTokens ??
    Math.max(
      0,
      (totalTokens ?? normalizedPromptTokens) - normalizedPromptTokens,
    );
  const normalizedTotalTokens =
    totalTokens ?? normalizedPromptTokens + normalizedCompletionTokens;
  const provider =
    typeof record.provider === "string" && record.provider.trim().length > 0
      ? record.provider.trim()
      : typeof record.source === "string" && record.source.trim().length > 0
        ? record.source.trim()
        : undefined;

  return {
    promptTokens: normalizedPromptTokens,
    completionTokens: normalizedCompletionTokens,
    totalTokens: normalizedTotalTokens,
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(toUsageModelLabel(record) ? { model: toUsageModelLabel(record) } : {}),
    ...(provider ? { provider } : {}),
    isEstimated:
      record.usageEstimated === true ||
      record.estimated === true ||
      tokens.estimated === true,
  };
}

function aggregateModelUsage(
  records: readonly ModelUsageRecord[],
): CapturedModelUsage | null {
  if (records.length === 0) return null;

  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cachedInputTokens = 0;
  let hasCacheReadInputTokens = false;
  let hasCacheCreationInputTokens = false;
  let hasCachedInputTokens = false;
  let model: string | undefined;
  let provider: string | undefined;
  let isEstimated = false;

  for (const record of records) {
    promptTokens += record.promptTokens;
    completionTokens += record.completionTokens;
    totalTokens += record.totalTokens;
    if (record.cacheReadInputTokens !== undefined) {
      cacheReadInputTokens += record.cacheReadInputTokens;
      hasCacheReadInputTokens = true;
    }
    if (record.cacheCreationInputTokens !== undefined) {
      cacheCreationInputTokens += record.cacheCreationInputTokens;
      hasCacheCreationInputTokens = true;
    }
    if (record.cachedInputTokens !== undefined) {
      cachedInputTokens += record.cachedInputTokens;
      hasCachedInputTokens = true;
    }
    model = record.model ?? model;
    provider = record.provider ?? provider;
    isEstimated ||= record.isEstimated;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    ...(hasCacheReadInputTokens ? { cacheReadInputTokens } : {}),
    ...(hasCacheCreationInputTokens ? { cacheCreationInputTokens } : {}),
    ...(hasCachedInputTokens ? { cachedInputTokens } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    isEstimated,
    llmCalls: records.length,
  };
}

function ensureModelUsageEventCapture(runtime: AgentRuntime): void {
  if (usageCaptureInstalledRuntimes.has(runtime)) return;
  usageCaptureInstalledRuntimes.add(runtime);

  const runtimeWithEmit = runtime as RuntimeWithEmitEvent;
  if (typeof runtimeWithEmit.emitEvent !== "function") return;

  const originalEmitEvent = runtimeWithEmit.emitEvent.bind(runtime);
  runtimeWithEmit.emitEvent = (async (event: unknown, params?: unknown) => {
    if (isModelUsedEvent(event)) {
      const usageRecord = normalizeModelUsageRecord(params);
      if (usageRecord) {
        for (const accumulator of usageCaptureContext
          .getStore()
          ?.get(runtime) ?? []) {
          accumulator.records.push(usageRecord);
        }
      }
    }
    return originalEmitEvent(event, params);
  }) as RuntimeWithEmitEvent["emitEvent"];
}

export async function withModelUsageCapture<T>(
  runtime: AgentRuntime,
  run: () => Promise<T>,
): Promise<{ result: T; usage: CapturedModelUsage | null }> {
  ensureModelUsageEventCapture(runtime);

  const inherited = usageCaptureContext.getStore();
  const accumulator: ModelUsageAccumulator = { records: [] };
  const scoped = new Map(inherited);
  scoped.set(runtime, [...(inherited?.get(runtime) ?? []), accumulator]);

  return usageCaptureContext.run(scoped, async () => {
    const result = await run();
    return {
      result,
      usage: aggregateModelUsage(accumulator.records),
    };
  });
}

function resolvePayloadModelId(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
): string {
  for (const key of ["model", "modelId", "modelName"]) {
    const value = payloadRecord[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  const config = runtimeModelConfigs.get(runtime);
  const detected = detectRuntimeModel(runtime, config);
  if (detected && detected.trim().length > 0) {
    return detected.trim();
  }

  return modelType;
}

function resolvePromptBudget(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
): PromptBudget {
  const metadata = resolveModelTokenMetadata(
    runtimeModelConfigs.get(runtime),
    resolvePayloadModelId(runtime, modelType, payloadRecord),
  );
  const requestedOutputTokens = [
    toOptionalNumber(payloadRecord.maxOutputTokens),
    toOptionalNumber(payloadRecord.maxTokens),
  ].find((value): value is number => value !== undefined && value > 0);
  // Model metadata describes provider capacity; it must never become an
  // outbound generation cap. Preserve an explicit caller request exactly so
  // the provider can either honor it or reject it as unsupported.
  const outputReserveTokens = requestedOutputTokens;
  const promptBudgetTokens = Math.max(
    0,
    Math.floor((metadata.contextWindow - (outputReserveTokens ?? 0)) * 0.95),
  );

  return {
    metadata,
    outputReserveTokens,
    promptBudgetTokens,
  };
}

function shouldApplyPromptBudget(modelType: string): boolean {
  return isTextGenerationModelType(modelType);
}

function isGenericTrajectoryModel(model: string): boolean {
  const normalized = model.trim().toUpperCase();
  return (
    normalized.length === 0 ||
    normalized === "UNKNOWN" ||
    normalized.startsWith("TEXT_") ||
    normalized.startsWith("REASONING_") ||
    normalized.startsWith("OBJECT_")
  );
}

function resolveTrajectoryModelLabel(
  runtime: AgentRuntime,
  modelType: string,
  payloadRecord: Record<string, unknown>,
  providerHint?: unknown,
): string {
  const explicitModel =
    typeof payloadRecord.model === "string"
      ? payloadRecord.model.trim()
      : typeof payloadRecord.modelId === "string"
        ? payloadRecord.modelId.trim()
        : "";
  if (explicitModel) {
    return explicitModel;
  }

  const provider =
    typeof providerHint === "string" && providerHint.trim().length > 0
      ? providerHint.trim()
      : typeof payloadRecord.provider === "string" &&
          payloadRecord.provider.trim().length > 0
        ? payloadRecord.provider.trim()
        : "";
  if (provider) {
    return modelType ? `${provider}/${modelType}` : provider;
  }

  const configuredModel = detectRuntimeModel(runtime);
  if (configuredModel && configuredModel.trim().length > 0) {
    return configuredModel.trim();
  }

  return modelType;
}

// ---------------------------------------------------------------------------
// Public API — install the useModel wrapper on a runtime
// ---------------------------------------------------------------------------

export function installPromptOptimizations(
  runtime: AgentRuntime,
  config?: ElizaConfig,
): void {
  if (config) {
    runtimeModelConfigs.set(runtime, config);
  }
  ensureModelUsageEventCapture(runtime);
  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  const originalUseModel = runtime.useModel.bind(runtime);

  runtime.useModel = (async (...args: Parameters<typeof originalUseModel>) => {
    const modelType = String(args[0] ?? "").toUpperCase();
    const llmPurpose = normalizeTrajectoryLlmPurpose(
      getTrajectoryContext()?.purpose,
      modelType === "ACTION_PLANNER" ? "planner" : "action",
    );
    if (isLlmGenerationModelType(modelType)) {
      assertActiveTrajectoryForLlmCall({
        actionType: "runtime.useModel",
        modelType,
        purpose: llmPurpose,
      });
    }

    const normalizedTrajectoryStepId = getActiveTrajectoryStepId();
    const trajectoryLogger = normalizedTrajectoryStepId
      ? ensureTrajectoryLoggerTracking(runtime)
      : null;
    const llmLogCountBefore = normalizedTrajectoryStepId
      ? getTrajectoryLlmLogCount(runtime, normalizedTrajectoryStepId)
      : 0;
    const startedAt = Date.now();

    const payload = args[1];
    if (!payload || typeof payload !== "object") {
      const { result } = await withModelUsageCapture(runtime, () =>
        originalUseModel(...args),
      );
      return result;
    }

    const promptRecord = payload as Record<string, unknown>;
    const promptKey =
      typeof promptRecord.prompt === "string"
        ? "prompt"
        : typeof promptRecord.userPrompt === "string"
          ? "userPrompt"
          : typeof promptRecord.input === "string"
            ? "input"
            : null;
    const originalMessages = promptKey
      ? null
      : normalizePayloadMessages(promptRecord.messages);
    if (!promptKey && !originalMessages) {
      const { result } = await withModelUsageCapture(runtime, () =>
        originalUseModel(...args),
      );
      return result;
    }

    const originalPrompt = promptKey
      ? String(promptRecord[promptKey] ?? "")
      : renderMessagesForTelemetry(originalMessages ?? []);
    const promptOptimizationTelemetry: PromptOptimizationTelemetry = {
      mode: "lossless",
      contextPreserved: true,
      originalPromptChars: originalPrompt.length,
      finalPromptChars: originalPrompt.length,
      originalPromptTokens: estimateTokenCount(originalPrompt),
      finalPromptTokens: estimateTokenCount(originalPrompt),
      transformations: [],
    };

    // --- Prompt capture (dev debugging) ---
    if (ELIZA_CAPTURE_PROMPTS) {
      const captureDir = path.resolve(".tmp", "prompt-captures");
      const seq = String(++promptCaptureSeq).padStart(4, "0");
      const filename = `${seq}-${modelType}.txt`;
      const capturePath = path.join(captureDir, filename);
      if (
        await writePromptCapture(
          runtime,
          capturePath,
          `--- model: ${modelType} | key: ${promptKey ?? "messages"} | chars: ${originalPrompt.length} ---\n\n${originalPrompt}`,
        )
      ) {
        promptOptimizationTelemetry.transformations.push(
          `capture:original:${capturePath}`,
        );
      }
    }

    let rewrittenArgs = args;
    let nextPrompt = originalPrompt;
    let nextMessages = originalMessages;
    let outputReserveTokens: number | undefined;

    // The shell reports the view the user is looking at via POST
    // /api/views/:id/navigate (stored in view-action-affinity). Read it once so
    // both the action-weighting (keep view-scoped actions at full param detail)
    // and the awareness block below stay consistent for this prompt.
    const activeView = getActiveViewContext();

    if (shouldApplyPromptBudget(modelType)) {
      const budget = resolvePromptBudget(runtime, modelType, {
        ...promptRecord,
        ...(promptKey ? { [promptKey]: nextPrompt } : {}),
        ...(nextMessages
          ? { messages: serializeCompactorMessagesForModel(nextMessages) }
          : {}),
      });
      outputReserveTokens = budget.outputReserveTokens;
      promptOptimizationTelemetry.budgetTokens = budget.promptBudgetTokens;
      if (budget.outputReserveTokens !== undefined) {
        promptOptimizationTelemetry.outputReserveTokens =
          budget.outputReserveTokens;
      }
    }

    // Inject the "# Active View" awareness block into planner prompts so the
    // model knows which surface the user is looking at and that it can drive
    // every element through the view-interact capabilities.
    if (
      activeView &&
      (nextPrompt.includes("# Available Actions") ||
        modelType === "ACTION_PLANNER")
    ) {
      if (promptKey) {
        const awarePrompt = applyActiveViewAwareness(nextPrompt, activeView);
        if (awarePrompt !== nextPrompt) {
          promptOptimizationTelemetry.transformations.push(
            `active-view-awareness:${activeView.viewId}`,
          );
          nextPrompt = awarePrompt;
        }
      } else if (nextMessages) {
        const awareMessages = applyActiveViewAwarenessToMessages(
          nextMessages,
          activeView,
        );
        if (awareMessages !== nextMessages) {
          nextMessages = awareMessages;
          nextPrompt = renderMessagesForTelemetry(nextMessages);
          promptOptimizationTelemetry.transformations.push(
            `active-view-awareness:${activeView.viewId}`,
          );
        }
      }
    }

    const finalPromptForTelemetry = promptKey
      ? nextPrompt
      : renderMessagesForTelemetry(nextMessages ?? []);
    promptOptimizationTelemetry.finalPromptChars =
      finalPromptForTelemetry.length;
    promptOptimizationTelemetry.finalPromptTokens = estimateTokenCount(
      finalPromptForTelemetry,
    );

    if (ELIZA_CAPTURE_PROMPTS && finalPromptForTelemetry !== originalPrompt) {
      const captureDir = path.resolve(".tmp", "prompt-captures");
      const seq = String(promptCaptureSeq).padStart(4, "0");
      const filename = `${seq}-${modelType}-rewritten.txt`;
      const capturePath = path.join(captureDir, filename);
      if (
        await writePromptCapture(
          runtime,
          capturePath,
          `--- model: ${modelType} | key: ${promptKey ?? "messages"} | chars: ${finalPromptForTelemetry.length} | rewritten ---\n\n${finalPromptForTelemetry}`,
        )
      ) {
        promptOptimizationTelemetry.transformations.push(
          `capture:rewritten:${capturePath}`,
        );
      }
    }

    const shouldSetMaxOutputTokens =
      outputReserveTokens !== undefined &&
      toOptionalNumber(promptRecord.maxOutputTokens) !== undefined;
    const mergedProviderOptions = providerOptionsWithPromptOptimization(
      promptRecord,
      promptOptimizationTelemetry,
    );
    // Always write nextMessages when present so post-budget Active View
    // re-injection is not dropped (#17918).
    const rewrittenPayload = {
      ...(payload as Record<string, unknown>),
      ...(promptKey ? { [promptKey]: nextPrompt } : {}),
      ...(!promptKey && nextMessages
        ? { messages: serializeCompactorMessagesForModel(nextMessages) }
        : {}),
      providerOptions: mergedProviderOptions,
      ...(outputReserveTokens !== undefined
        ? shouldSetMaxOutputTokens
          ? { maxOutputTokens: outputReserveTokens }
          : { maxTokens: outputReserveTokens }
        : {}),
    };
    rewrittenArgs = [
      args[0],
      rewrittenPayload as Parameters<typeof originalUseModel>[1],
      ...args.slice(2),
    ] as Parameters<typeof originalUseModel>;

    const { result, usage: capturedUsage } = await withModelUsageCapture(
      runtime,
      () => originalUseModel(...rewrittenArgs),
    );
    const responseText = stringifyTrajectoryResponse(result);
    const payloadRecord = rewrittenArgs[1] as Record<string, unknown>;
    const systemPrompt =
      typeof payloadRecord.system === "string"
        ? payloadRecord.system
        : typeof runtime.character.system === "string"
          ? runtime.character.system
          : "";
    const payloadMessages = normalizePayloadMessages(payloadRecord.messages);
    const userPromptForTrajectory = promptKey
      ? String(payloadRecord[promptKey] ?? "")
      : payloadMessages
        ? renderMessagesForTelemetry(payloadMessages)
        : "";
    const promptTokens =
      capturedUsage?.promptTokens ??
      estimateTokenCount(systemPrompt + userPromptForTrajectory);
    const completionTokens =
      capturedUsage?.completionTokens ?? estimateTokenCount(responseText);
    const fallbackCall = {
      stepId: normalizedTrajectoryStepId ?? undefined,
      model:
        capturedUsage?.model ??
        resolveTrajectoryModelLabel(runtime, modelType, payloadRecord, args[2]),
      systemPrompt,
      userPrompt: userPromptForTrajectory,
      response: responseText,
      temperature:
        typeof payloadRecord.temperature === "number"
          ? payloadRecord.temperature
          : 0,
      maxTokens:
        toOptionalNumber(payloadRecord.maxTokens) ??
        toOptionalNumber(payloadRecord.maxOutputTokens) ??
        outputReserveTokens ??
        0,
      purpose: llmPurpose,
      actionType: "runtime.useModel",
      latencyMs: Math.max(0, Date.now() - startedAt),
      promptTokens,
      completionTokens,
      ...(capturedUsage?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: capturedUsage.cacheReadInputTokens }
        : {}),
      ...(capturedUsage?.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: capturedUsage.cacheCreationInputTokens }
        : {}),
      tokenUsageEstimated: !capturedUsage,
      providerMetadata: {
        ...(payloadRecord.providerMetadata &&
        typeof payloadRecord.providerMetadata === "object" &&
        !Array.isArray(payloadRecord.providerMetadata)
          ? (payloadRecord.providerMetadata as Record<string, unknown>)
          : {}),
        promptOptimization: promptOptimizationTelemetry,
      },
    };

    if (
      normalizedTrajectoryStepId &&
      trajectoryLogger &&
      typeof trajectoryLogger.logLlmCall === "function" &&
      getTrajectoryLlmLogCount(runtime, normalizedTrajectoryStepId) ===
        llmLogCountBefore
    ) {
      try {
        trajectoryLogger.logLlmCall(fallbackCall);
        runtime.logger.warn(
          `[eliza] Trajectory logger missed live LLM capture for ${normalizedTrajectoryStepId}; recorded fallback call from prompt optimization wrapper`,
        );
      } catch {
        // Ignore fallback logging failures; the model call itself already succeeded.
      }
    } else if (
      normalizedTrajectoryStepId &&
      trajectoryLogger &&
      typeof trajectoryLogger.updateLatestLlmCall === "function"
    ) {
      try {
        await trajectoryLogger.updateLatestLlmCall(normalizedTrajectoryStepId, {
          ...fallbackCall,
          // The provider has already recorded its actual model. A runtime
          // configuration or plugin label is only a fallback for missing
          // captures, never evidence that can overwrite that identity.
          model: capturedUsage?.model,
        });
      } catch {
        // Ignore enrichment failures; the model call itself already succeeded.
      }
    }

    return result;
  }) as typeof runtime.useModel;
}
