/**
 * `commitment_extraction` evaluator — unit tests (#14864). Deterministic
 * harness: the runtime, owner-access check, and ledger repository are mocked;
 * the parse/guard/record functions under test are the real production
 * exports. The load-bearing proof is the false-positive guard: hedged
 * chit-chat ("yeah maybe sometime") must never become a ledger row, even
 * when the model over-extracts it with high confidence.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
  upsertCommitmentLedgerRecord: vi.fn(async () => undefined),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

vi.mock("../src/lifeops/repository.js", () => ({
  LifeOpsRepository: class {
    upsertCommitmentLedgerRecord = mocks.upsertCommitmentLedgerRecord;
  },
}));

import {
  commitmentExtractionEvaluator,
  filterExtractedCommitments,
  ledgerRecordsFromCandidates,
  parseCommitmentExtractionOutput,
} from "../src/lifeops/commitments/extraction-evaluator.js";

function makeRuntime(withDb = true): IAgentRuntime {
  return {
    agentId: "agent-commit-test" as UUID,
    ...(withDb ? { adapter: { db: {} } } : {}),
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string, entityId = "owner-1"): Memory {
  return {
    id: "msg-commit-1" as UUID,
    entityId: entityId as UUID,
    roomId: "room-commit-1" as UUID,
    createdAt: Date.parse("2026-08-10T15:00:00.000Z"),
    content: { text },
  } as Memory;
}

describe("commitment_extraction evaluator", () => {
  beforeEach(() => {
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
    mocks.upsertCommitmentLedgerRecord.mockClear();
  });

  describe("parseCommitmentExtractionOutput", () => {
    it("accepts well-formed output and normalizes optional fields", () => {
      const parsed = parseCommitmentExtractionOutput({
        commitments: [
          {
            evidence: "I'll send the deck Friday",
            summary: "Send the deck",
            counterparty: " Dana ",
            dueAtIso: "2026-08-14T17:00:00.000Z",
            confidence: 0.9,
          },
        ],
      });
      expect(parsed?.commitments).toHaveLength(1);
      expect(parsed?.commitments[0]).toMatchObject({
        counterparty: "Dana",
        dueAtIso: "2026-08-14T17:00:00.000Z",
      });
    });

    it("drops malformed entries and invalid dates instead of fabricating rows", () => {
      const parsed = parseCommitmentExtractionOutput({
        commitments: [
          { evidence: "", summary: "x", confidence: 0.9 },
          { evidence: "I'll call", summary: "", confidence: 0.9 },
          {
            evidence: "I'll call Bob",
            summary: "Call Bob",
            dueAtIso: "not-a-date",
            confidence: 0.9,
          },
        ],
      });
      expect(parsed?.commitments).toHaveLength(1);
      expect(parsed?.commitments[0]?.dueAtIso).toBeNull();
    });

    it("returns null for non-object output", () => {
      expect(parseCommitmentExtractionOutput("nope")).toBeNull();
      expect(parseCommitmentExtractionOutput({ items: [] })).toBeNull();
    });
  });

  describe("filterExtractedCommitments (false-positive guard)", () => {
    it("rejects hedged chit-chat even when the model is confident", () => {
      const text = "Yeah maybe sometime I'll organize the garage.";
      const guarded = filterExtractedCommitments(text, [
        {
          evidence: "Yeah maybe sometime I'll organize the garage.",
          summary: "Organize the garage",
          confidence: 0.99,
        },
      ]);
      expect(guarded).toHaveLength(0);
    });

    it("rejects candidates whose evidence is not verbatim in the source", () => {
      const guarded = filterExtractedCommitments("Thanks, talk soon!", [
        {
          evidence: "I'll send the numbers by Friday",
          summary: "Send numbers",
          confidence: 0.95,
        },
      ]);
      expect(guarded).toHaveLength(0);
    });

    it("rejects candidates below the confidence floor", () => {
      const text = "I'll send the numbers by Friday.";
      const guarded = filterExtractedCommitments(text, [
        {
          evidence: "I'll send the numbers by Friday",
          summary: "Send numbers",
          confidence: 0.3,
        },
      ]);
      expect(guarded).toHaveLength(0);
    });

    it("keeps a firm verbatim promise", () => {
      const text = "Sounds good. I'll send the numbers by Friday. Bye!";
      const guarded = filterExtractedCommitments(text, [
        {
          evidence: "I'll send the numbers by Friday",
          summary: "Send numbers",
          confidence: 0.85,
        },
      ]);
      expect(guarded).toHaveLength(1);
    });
  });

  describe("ledgerRecordsFromCandidates", () => {
    it("builds chat-source rows with typed kind and evidence metadata", () => {
      const records = ledgerRecordsFromCandidates({
        agentId: "agent-commit-test",
        sourceKey: "message:msg-commit-1",
        observedAt: "2026-08-10T15:00:00.000Z",
        candidates: [
          {
            evidence: "I'll file the quarterly tax return by 2026-09-15",
            summary: "File the quarterly tax return",
            counterparty: null,
            dueAtIso: "2026-09-15T17:00:00.000Z",
            confidence: 0.9,
          },
        ],
      });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        source: "chat",
        kind: "filing",
        status: "open",
        dueAt: "2026-09-15T17:00:00.000Z",
      });
      expect(records[0]?.metadata).toMatchObject({
        extractedBy: "commitment_extraction",
      });
    });
  });

  describe("shouldRun", () => {
    it.each([
      'Create a note titled "Context QA" with body "Test". Then open Notes so I can see it.',
      "Show my calendar so that I can choose a time.",
      "Open the document so\nthat I can read it.",
    ])("skips purpose clauses without a promise: %s", async (text) => {
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime: makeRuntime(),
          message: makeMessage(text),
          options: {},
        }),
      ).resolves.toBe(false);
      expect(mocks.hasOwnerAccess).not.toHaveBeenCalled();
    });

    it.each([
      "I can send the deck Friday.",
      "Open Notes so I can see it. I'll send the deck Friday.",
      "I'll send the deck Friday so I can finish the handoff.",
    ])("preserves offers and independent promises: %s", async (text) => {
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime: makeRuntime(),
          message: makeMessage(text),
          options: {},
        }),
      ).resolves.toBe(true);
    });

    it("skips the agent's own messages", async () => {
      const runtime = makeRuntime();
      const message = makeMessage(
        "I'll send it Friday",
        String(runtime.agentId),
      );
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime,
          message,
          options: {},
        }),
      ).resolves.toBe(false);
    });

    it("skips hedged text without spending a model call", async () => {
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime: makeRuntime(),
          message: makeMessage("yeah maybe sometime we could do that"),
          options: {},
        }),
      ).resolves.toBe(false);
      expect(mocks.hasOwnerAccess).not.toHaveBeenCalled();
    });

    it("skips runtimes without a SQL ledger", async () => {
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime: makeRuntime(false),
          message: makeMessage("I'll send the deck Friday"),
          options: {},
        }),
      ).resolves.toBe(false);
    });

    it("runs for an owner promise on a SQL-backed runtime", async () => {
      await expect(
        commitmentExtractionEvaluator.shouldRun({
          runtime: makeRuntime(),
          message: makeMessage("I'll send the deck Friday"),
          options: {},
        }),
      ).resolves.toBe(true);
    });
  });

  describe("persistExtractedCommitments processor", () => {
    async function runProcessor(text: string, confidence: number) {
      const processor = commitmentExtractionEvaluator.processors?.[0];
      if (!processor) throw new Error("processor missing");
      const runtime = makeRuntime();
      const message = makeMessage(text);
      return processor.process({
        runtime,
        message,
        state: {} as never,
        prepared: {},
        options: {},
        evaluatorName: "commitment_extraction",
        output: {
          commitments: [
            {
              evidence: text.replace(/[.!?]+$/, ""),
              summary: "Do it",
              confidence,
            },
          ],
        },
      });
    }

    it("persists a guarded firm promise", async () => {
      const result = await runProcessor("I'll send the deck Friday", 0.9);
      expect(result?.success).toBe(true);
      expect(result?.values).toMatchObject({ commitmentRowsCreated: 1 });
      expect(mocks.upsertCommitmentLedgerRecord).toHaveBeenCalledTimes(1);
    });

    it("writes nothing for hedged output that slipped past the model", async () => {
      const result = await runProcessor(
        "yeah maybe sometime I'll do that",
        0.99,
      );
      expect(result?.success).toBe(true);
      expect(result?.values).toMatchObject({ commitmentRowsCreated: 0 });
      expect(mocks.upsertCommitmentLedgerRecord).not.toHaveBeenCalled();
    });
  });
});
