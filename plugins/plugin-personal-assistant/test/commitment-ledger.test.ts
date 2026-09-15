/**
 * Regression coverage for the durable commitments/obligations ledger. The
 * extractor is deliberately conservative and deterministic here; live model
 * extraction trajectories belong to the scenario lane once credentials are
 * available.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCommitmentRegretAudit,
  createDocumentObligationLedgerRecord,
  createLifeOpsCommitmentLedgerRecord,
  extractCommitmentLedgerRecords,
  LifeOpsRepository,
  trackDocumentObligationArtifact,
} from "../src/lifeops/index.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000001864";
const OBSERVED_AT = "2026-07-06T15:00:00.000Z";

describe("commitment ledger extraction and audit", () => {
  it("extracts a concrete sent-mail promise with a due date", () => {
    const rows = extractCommitmentLedgerRecords({
      agentId: AGENT_ID,
      source: "sent_mail",
      sourceKey: "gmail:msg-1",
      observedAt: OBSERVED_AT,
      counterparty: "Mira",
      text: "I'll send the deck Friday and include the pricing appendix.",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "sent_mail",
      sourceKey: "gmail:msg-1",
      kind: "commitment",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      status: "open",
      scheduledTaskId: null,
    });
    expect(rows[0]?.summary).toContain("send the deck Friday");
  });

  it("ignores purpose clauses while retaining a separate promise", () => {
    const input = {
      agentId: AGENT_ID,
      source: "chat" as const,
      sourceKey: "purpose-clause",
      observedAt: OBSERVED_AT,
    };
    expect(
      extractCommitmentLedgerRecords({
        ...input,
        text: "Open Notes so I can see it.",
      }),
    ).toEqual([]);
    const rows = extractCommitmentLedgerRecords({
      ...input,
      text: "Open Notes so I can see it. I'll send the deck Friday.",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toBe("I'll send the deck Friday");
  });

  it("does not create rows for speculative chit-chat", () => {
    const rows = extractCommitmentLedgerRecords({
      agentId: AGENT_ID,
      source: "chat",
      sourceKey: "thread:loose",
      observedAt: OBSERVED_AT,
      text: "Yeah maybe sometime we could send something over.",
    });

    expect(rows).toHaveLength(0);
  });

  it("ranks orphaned near-term obligations ahead of tracked or completed rows", () => {
    const orphan = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "sent_mail",
      sourceKey: "gmail:deck",
      kind: "commitment",
      summary: "I'll send the deck Friday",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      confidence: 0.74,
      metadata: {},
      createdAt: "2026-07-06T15:00:00.000Z",
    });
    const tracked = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "document",
      sourceKey: "contract:acme",
      kind: "renewal",
      summary: "Renewal notice for Acme contract",
      counterparty: "Acme",
      dueAt: "2026-07-12T17:00:00.000Z",
      confidence: 0.9,
      status: "tracked",
      scheduledTaskId: "st_acme_renewal",
      metadata: {},
      createdAt: "2026-07-06T16:00:00.000Z",
    });
    const completed = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "chat",
      sourceKey: "thread:done",
      kind: "commitment",
      summary: "I will send the notes",
      counterparty: null,
      dueAt: "2026-07-07T17:00:00.000Z",
      confidence: 0.8,
      status: "completed",
      metadata: {},
      createdAt: "2026-07-06T17:00:00.000Z",
    });

    const audit = buildCommitmentRegretAudit([tracked, completed, orphan], {
      nowIso: "2026-07-09T12:00:00.000Z",
      horizonDays: 7,
    });

    expect(audit.items.map((item) => item.record.id)).toEqual([
      orphan.id,
      tracked.id,
    ]);
    expect(audit.items[0]?.reasons).toContain("no scheduled tracker");
    expect(audit.items[0]?.reasons).toContain("due inside audit horizon");
  });

  it("normalizes document contract deadlines as tracked renewal obligations", () => {
    const record = createDocumentObligationLedgerRecord({
      agentId: AGENT_ID,
      documentId: "doc-acme-sow",
      title: "Acme vendor SOW contract renewal",
      deadline: "2026-09-01T17:00:00.000Z",
      observedAt: OBSERVED_AT,
      counterparty: "Acme",
      scheduledTaskId: "task-renewal-60d",
      metadata: { documentKind: "approval" },
    });

    expect(record).toMatchObject({
      source: "document",
      sourceKey: "doc-acme-sow",
      kind: "renewal",
      summary: "Acme vendor SOW contract renewal deadline",
      counterparty: "Acme",
      dueAt: "2026-09-01T17:00:00.000Z",
      confidence: 0.9,
      status: "tracked",
      scheduledTaskId: "task-renewal-60d",
    });
  });

  it("normalizes warranty documents without inventing a tracker", () => {
    const record = createDocumentObligationLedgerRecord({
      agentId: AGENT_ID,
      documentId: "doc-laptop-warranty",
      title: "Laptop warranty return window",
      deadline: "2026-07-31T17:00:00.000Z",
      observedAt: OBSERVED_AT,
    });

    expect(record).toMatchObject({
      kind: "warranty",
      status: "open",
      scheduledTaskId: null,
    });
  });
});

describe("commitment ledger repository", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("persists extracted obligations through the LifeOps schema", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repo = new LifeOpsRepository(runtime);
    const record = extractCommitmentLedgerRecords({
      agentId: runtime.agentId,
      source: "sent_mail",
      sourceKey: "gmail:msg-commitment",
      observedAt: OBSERVED_AT,
      counterparty: "Mira",
      text: "I'll send the deck Friday and include the pricing appendix.",
    })[0];
    if (!record) {
      throw new Error("Expected commitment extraction to produce one record.");
    }

    await repo.upsertCommitmentLedgerRecord(record);

    const reloaded = new LifeOpsRepository(runtime);
    const rows = await reloaded.listCommitmentLedgerRecords(runtime.agentId, {
      statuses: ["open"],
      dueBeforeIso: "2026-07-11T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: record.id,
      source: "sent_mail",
      sourceKey: "gmail:msg-commitment",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      scheduledTaskId: null,
    });

    await reloaded.upsertCommitmentLedgerRecord({
      ...record,
      status: "tracked",
      scheduledTaskId: "st_deck_followup",
      updatedAt: "2026-07-06T18:00:00.000Z",
    });

    const tracked = await reloaded.getCommitmentLedgerRecord(
      runtime.agentId,
      record.id,
    );
    expect(tracked).toMatchObject({
      status: "tracked",
      scheduledTaskId: "st_deck_followup",
    });
  });

  it("tracks a standing document guarantee with one ledger row and one watcher", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repo = new LifeOpsRepository(runtime);

    const first = await trackDocumentObligationArtifact(runtime, {
      agentId: runtime.agentId,
      documentId: "doc-acme-msa",
      title: "Acme MSA contract renewal",
      deadline: "2026-09-01T17:00:00.000Z",
      observedAt: OBSERVED_AT,
      counterparty: "Acme",
      note: "Renewal notice must go out 60 days before term end.",
      metadata: { standingGuaranteeId: "guarantee-renewals" },
    });

    expect(first.record).toMatchObject({
      source: "document",
      sourceKey: "doc-acme-msa",
      kind: "renewal",
      status: "tracked",
      scheduledTaskId: first.task.taskId,
    });
    expect(first.task).toMatchObject({
      kind: "watcher",
      trigger: { kind: "once", atIso: "2026-09-01T17:00:00.000Z" },
      subject: { kind: "document", id: "doc-acme-msa" },
      idempotencyKey:
        "commitment-ledger:document:doc-acme-msa:deadline:2026-09-01T17:00:00.000Z",
    });

    const replay = await trackDocumentObligationArtifact(runtime, {
      agentId: runtime.agentId,
      documentId: "doc-acme-msa",
      title: "Acme MSA contract renewal",
      deadline: "2026-09-01T17:00:00.000Z",
      observedAt: OBSERVED_AT,
      counterparty: "Acme",
      note: "Renewal notice must go out 60 days before term end.",
      metadata: { standingGuaranteeId: "guarantee-renewals" },
    });

    expect(replay.task.taskId).toBe(first.task.taskId);
    expect(replay.record.id).toBe(first.record.id);

    const rows = await repo.listCommitmentLedgerRecords(runtime.agentId, {
      source: "document",
      statuses: ["tracked"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first.record.id,
      scheduledTaskId: first.task.taskId,
      metadata: {
        standingGuaranteeId: "guarantee-renewals",
      },
    });

    const persistedTask = await repo.getScheduledTask(
      runtime.agentId,
      first.task.taskId,
    );
    expect(persistedTask).toMatchObject({
      idempotencyKey:
        "commitment-ledger:document:doc-acme-msa:deadline:2026-09-01T17:00:00.000Z",
      metadata: {
        commitmentLedgerId: first.record.id,
        standingGuarantee: true,
      },
    });
  });
});
