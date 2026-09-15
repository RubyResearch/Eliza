/**
 * `commitment_extraction` — post-turn evaluator that projects concrete
 * first-person promises in an owner's outbound message into the durable
 * commitment ledger (#14864). The model runs inside the runtime's single
 * merged SMALL-model evaluation call; every extracted row must survive a
 * deterministic false-positive guard before it is persisted, so hedged
 * chit-chat ("yeah maybe sometime") can never become owner work even when
 * the model over-extracts. Deterministic-only paths (sent mail, document
 * hooks, transcripts) stay on `extractCommitmentLedgerRecords`.
 */
import { hasOwnerAccess } from "@elizaos/agent";
import type {
  Evaluator,
  IAgentRuntime,
  JSONSchema,
  Memory,
} from "@elizaos/core";
import { LifeOpsRepository } from "../repository.js";
import {
  classifyCommitmentKind,
  createLifeOpsCommitmentLedgerRecord,
  isSpeculativeCommitmentText,
  type LifeOpsCommitmentLedgerRecord,
  textHasCommitmentCue,
} from "./ledger.js";

export interface ExtractedCommitmentCandidate {
  /** Verbatim sentence from the owner's message that carries the promise. */
  evidence: string;
  /** Short imperative restatement of the promise. */
  summary: string;
  counterparty?: string | null;
  /** ISO-8601 due date when the promise names one; omitted otherwise. */
  dueAtIso?: string | null;
  confidence: number;
}

export interface CommitmentExtractionOutput {
  commitments: ExtractedCommitmentCandidate[];
}

const MIN_CONFIDENCE = 0.6;

const commitmentExtractionSchema: JSONSchema = {
  type: "object",
  properties: {
    commitments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          evidence: { type: "string" },
          summary: { type: "string" },
          counterparty: { type: ["string", "null"] },
          dueAtIso: { type: ["string", "null"] },
          confidence: { type: "number" },
        },
        required: ["evidence", "summary", "confidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["commitments"],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function validIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function parseCommitmentExtractionOutput(
  output: unknown,
): CommitmentExtractionOutput | null {
  if (!isRecord(output) || !Array.isArray(output.commitments)) return null;
  const commitments: ExtractedCommitmentCandidate[] = [];
  for (const entry of output.commitments) {
    if (!isRecord(entry)) continue;
    const evidence = typeof entry.evidence === "string" ? entry.evidence : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    const confidence =
      typeof entry.confidence === "number" ? entry.confidence : Number.NaN;
    if (!evidence.trim() || !summary.trim() || Number.isNaN(confidence)) {
      continue;
    }
    commitments.push({
      evidence,
      summary,
      counterparty:
        typeof entry.counterparty === "string" && entry.counterparty.trim()
          ? entry.counterparty.trim()
          : null,
      dueAtIso: validIsoOrNull(entry.dueAtIso),
      confidence,
    });
  }
  return { commitments };
}

/**
 * Deterministic false-positive guard over model-extracted candidates. A
 * candidate survives only when its verbatim evidence actually appears in the
 * source text, carries a first-person commitment cue, is not hedged, and the
 * model's own confidence clears the floor. The guard is pure so tests can
 * prove "yeah maybe sometime" creates nothing regardless of model output.
 */
export function filterExtractedCommitments(
  sourceText: string,
  candidates: readonly ExtractedCommitmentCandidate[],
): ExtractedCommitmentCandidate[] {
  const haystack = normalizeForMatch(sourceText);
  return candidates.filter((candidate) => {
    const evidence = candidate.evidence.trim();
    if (evidence.length === 0) return false;
    if (!haystack.includes(normalizeForMatch(evidence))) return false;
    if (!textHasCommitmentCue(evidence)) return false;
    if (isSpeculativeCommitmentText(evidence)) return false;
    return candidate.confidence >= MIN_CONFIDENCE;
  });
}

/** Build ledger rows from guarded candidates; exported for direct test proof. */
export function ledgerRecordsFromCandidates(args: {
  agentId: string;
  sourceKey: string;
  observedAt: string;
  candidates: readonly ExtractedCommitmentCandidate[];
}): LifeOpsCommitmentLedgerRecord[] {
  return args.candidates.map((candidate) =>
    createLifeOpsCommitmentLedgerRecord({
      agentId: args.agentId,
      source: "chat",
      sourceKey: args.sourceKey,
      kind: classifyCommitmentKind(candidate.evidence),
      summary: candidate.summary,
      counterparty: candidate.counterparty ?? null,
      dueAt: candidate.dueAtIso ?? null,
      confidence: candidate.confidence,
      metadata: {
        observedAt: args.observedAt,
        extractedBy: "commitment_extraction",
        evidence: candidate.evidence,
      },
    }),
  );
}

function hasSqlAdapter(runtime: IAgentRuntime): boolean {
  const adapter = (runtime as { adapter?: { db?: unknown } }).adapter;
  return Boolean(adapter?.db);
}

function messageSourceKey(message: Memory): string {
  return `message:${String(message.id ?? message.createdAt ?? "unknown")}`;
}

export const commitmentExtractionEvaluator: Evaluator<
  CommitmentExtractionOutput,
  Record<string, never>
> = {
  name: "commitment_extraction",
  inputScope: "current_message",
  description:
    "Extracts concrete first-person promises from the owner's message into the durable commitment ledger.",
  priority: 120,
  schema: commitmentExtractionSchema,

  async shouldRun({ runtime, message }) {
    const text = message.content.text;
    if (typeof text !== "string" || text.trim().length === 0) return false;
    if (message.entityId === runtime.agentId) return false;
    // Deterministic prefilter: no commitment cue (or a hedge) means no model
    // spend and structurally no row — the false-positive guard's outer wall.
    if (!textHasCommitmentCue(text)) return false;
    if (!hasSqlAdapter(runtime)) return false;
    return hasOwnerAccess(runtime, message);
  },

  async prepare() {
    return {};
  },

  prompt({ message }) {
    return `Extract the concrete commitments (promises to do something) the owner makes in their message below.

Rules:
- Only include firm first-person promises ("I'll send the deck Friday"). Exclude hedged or speculative remarks ("maybe", "sometime", "we could").
- "evidence" must be the exact verbatim sentence copied from the message.
- "summary" is a short restatement of the promised work.
- "counterparty" is the person the promise is made to, when the message names one.
- "dueAtIso" is an ISO-8601 timestamp only when the promise names an explicit date; otherwise omit it.
- "confidence" in [0,1]: how certain you are this is a firm commitment.
- Return {"commitments": []} when the message contains no firm promise.

Source message timestamp: ${new Date(message.createdAt ?? Date.now()).toISOString()}

Owner message:
${message.content.text ?? ""}`;
  },

  parse: parseCommitmentExtractionOutput,

  processors: [
    {
      name: "persistExtractedCommitments",
      async process({ runtime, message, output }) {
        const text = message.content.text ?? "";
        const guarded = filterExtractedCommitments(text, output.commitments);
        if (guarded.length === 0) {
          return { success: true, values: { commitmentRowsCreated: 0 } };
        }
        const records = ledgerRecordsFromCandidates({
          agentId: String(runtime.agentId),
          sourceKey: messageSourceKey(message),
          observedAt: new Date(
            typeof message.createdAt === "number"
              ? message.createdAt
              : Date.now(),
          ).toISOString(),
          candidates: guarded,
        });
        const repository = new LifeOpsRepository(runtime);
        for (const record of records) {
          await repository.upsertCommitmentLedgerRecord(record);
        }
        return {
          success: true,
          values: {
            commitmentRowsCreated: records.length,
            commitmentLedgerIds: records.map((record) => record.id),
          },
        };
      },
    },
  ],
};
