/**
 * Exercises real PGlite selection deduplication, tenant isolation, owner review,
 * stale-write rejection and withdrawal of selected family correspondence.
 * The document/model/HTTP consumers are outside this persistence harness.
 */
import { createHash, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { AccessContext, Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LifeOpsDatabaseContext, RawSqlQuery } from "../sql.js";
import {
  type FamilyIntakeFact,
  FamilyIntakeReviewStore,
  type FamilyIntakeSelection,
} from "./intake-review.js";
import { FamilyIntakeService } from "./intake-service.js";

const owner = randomUUID();
const recipient = randomUUID();
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

describe("Family intake review persistence", () => {
  let db: PGlite;
  let context: LifeOpsDatabaseContext;
  let store: FamilyIntakeReviewStore;
  let selection: FamilyIntakeSelection;
  let fact: FamilyIntakeFact;

  beforeEach(async () => {
    db = await PGlite.create();
    await db.exec("CREATE SCHEMA app_lifeops");
    context = {
      agentId: randomUUID(),
      adapter: {
        db: {
          execute: (query: RawSqlQuery) =>
            db.query(
              query.queryChunks.map((chunk) => chunk.value ?? "").join(""),
            ),
        },
      },
    };
    store = new FamilyIntakeReviewStore(context);
    selection = {
      id: randomUUID(),
      periodKey: "2026-10",
      selectedByEntityId: owner,
      source: {
        documentId: randomUUID(),
        contentSha256: digest("Please confirm pickup at 3 PM."),
      },
    };
    fact = {
      id: randomUUID(),
      section: "unanswered",
      statement: "Confirm pickup time.",
      sourceQuote: "Please confirm pickup at 3 PM.",
      dates: [],
      requests: ["Confirm pickup time"],
      commitments: [],
      accountability: [],
      urgency: null,
      unanswered: true,
      recipientEntityIds: [],
    };
  });

  afterEach(async () => {
    await db.close();
  });

  it("audits explicit resolution and reopening without overwriting concurrent decisions", async () => {
    const selected = await store.select(selection);
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: selection.source.contentSha256,
      facts: [fact],
    });
    const reviewed = await store.review({
      id: selected.id,
      expectedRevision: proposed.revision,
      reviewerEntityId: owner,
      facts: [fact],
    });
    const input = {
      id: selected.id,
      expectedRevision: reviewed.revision,
      reviewerEntityId: owner,
      decision: {
        operationId: randomUUID(),
        factId: fact.id,
        state: "resolved" as const,
        reason: "Owner received pickup confirmation.",
      },
    };
    await expect(
      store.review({
        id: selected.id,
        expectedRevision: reviewed.revision,
        reviewerEntityId: owner,
        facts: [{ ...fact, unanswered: false }],
      }),
    ).rejects.toMatchObject({
      code: "FAMILY_INTAKE_REQUEST_DECISION_REQUIRED",
    });
    await expect(
      store.decideRequest({ ...input, reviewerEntityId: recipient }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEWER_MISMATCH" });
    await expect(
      store.decideRequest({
        ...input,
        decision: { ...input.decision, reason: " " },
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_INPUT_INVALID" });
    const outcomes = await Promise.allSettled([
      store.decideRequest(input),
      store.decideRequest({
        ...input,
        decision: {
          ...input.decision,
          operationId: randomUUID(),
          reason: "Conflicting explanation.",
        },
      }),
    ]);
    expect(
      outcomes.filter((value) => value.status === "fulfilled"),
    ).toHaveLength(1);
    const resolved = await store.read(selected.id);
    if (!resolved?.requestDecision)
      throw new Error("Expected persisted decision");
    expect(resolved.facts[0]?.unanswered).toBe(false);
    const restarted = new FamilyIntakeReviewStore(context);
    expect(
      await restarted.decideRequest({
        ...input,
        decision: resolved.requestDecision,
      }),
    ).toEqual(resolved);
    const reopened = await restarted.decideRequest({
      ...input,
      expectedRevision: resolved.revision,
      decision: {
        operationId: randomUUID(),
        factId: fact.id,
        state: "open",
        reason: "Pickup arrangements changed; confirmation is needed again.",
      },
    });
    expect(reopened.facts[0]?.unanswered).toBe(true);
    expect(
      (await restarted.history(selected.id))
        .map((value) => value.requestDecision)
        .filter(Boolean),
    ).toEqual([resolved.requestDecision, reopened.requestDecision]);
    await expect(
      restarted.decideRequest({
        ...input,
        expectedRevision: reopened.revision,
        decision: resolved.requestDecision,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    const closedAgain = await restarted.decideRequest({
      ...input,
      expectedRevision: reopened.revision,
      decision: { ...input.decision, operationId: randomUUID() },
    });
    const excluded = await restarted.review({
      id: selected.id,
      expectedRevision: closedAgain.revision,
      reviewerEntityId: owner,
      facts: [],
    });
    await expect(
      restarted.review({
        id: selected.id,
        expectedRevision: excluded.revision,
        reviewerEntityId: owner,
        facts: [fact],
      }),
    ).rejects.toMatchObject({
      code: "FAMILY_INTAKE_REQUEST_DECISION_REQUIRED",
    });
    const restored = await restarted.review({
      id: selected.id,
      expectedRevision: excluded.revision,
      reviewerEntityId: owner,
      facts: [{ ...fact, unanswered: false }],
    });
    expect(restored.facts[0]?.unanswered).toBe(false);
  });

  it("deduplicates concurrent retries and rejects a different selection for the same document/month", async () => {
    await store.list(selection.periodKey);
    const [first, retried] = await Promise.all([
      store.select(selection),
      store.select(selection),
    ]);
    expect(retried).toEqual(first);
    await expect(
      store.select({ ...selection, id: randomUUID() }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SELECTION_CONFLICT" });
    await expect(
      store.select({
        ...selection,
        source: {
          ...selection.source,
          contentSha256: digest("different source"),
        },
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SELECTION_CONFLICT" });
    expect(await store.list(selection.periodKey)).toEqual([first]);
  });

  it("does not let a retry resurrect a withdrawn review or retain old grants when explicitly reselected", async () => {
    const selected = await store.select(selection);
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: selection.source.contentSha256,
      facts: [fact],
    });
    const reviewed = await store.review({
      id: proposed.id,
      expectedRevision: proposed.revision,
      reviewerEntityId: owner,
      facts: [{ ...fact, recipientEntityIds: [recipient] }],
    });
    const withdrawn = await store.withdraw(reviewed.id, reviewed.revision);
    expect(await store.select(selection)).toEqual(withdrawn);
    await expect(
      store.review({
        id: reviewed.id,
        expectedRevision: reviewed.revision,
        reviewerEntityId: owner,
        facts: [fact],
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    const reselected = await store.reselect({
      id: withdrawn.id,
      expectedRevision: withdrawn.revision,
      sourceSha256: digest("new correspondence"),
    });
    expect(reselected.status).toBe("selected");
    expect(reselected.facts).toEqual([]);
    expect(reselected.reviewedByEntityId).toBeNull();
    expect(reselected.source.contentSha256).toBe(digest("new correspondence"));
    expect(
      await new FamilyIntakeReviewStore(context).read(selection.id),
    ).toEqual(reselected);
    const freshFact = {
      ...fact,
      id: randomUUID(),
      sourceQuote: "new correspondence",
    };
    const freshProposal = await store.propose({
      id: reselected.id,
      expectedRevision: reselected.revision,
      sourceSha256: reselected.source.contentSha256,
      facts: [freshFact],
    });
    await expect(
      store.review({
        id: reselected.id,
        expectedRevision: freshProposal.revision,
        reviewerEntityId: owner,
        facts: [fact],
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_UNPROPOSED_FACT" });
    expect(await store.history(selected.id)).toEqual([
      selected,
      proposed,
      reviewed,
      withdrawn,
      reselected,
      freshProposal,
    ]);
  });

  it("allows only one concurrent owner edit and preserves the winning review after reopening", async () => {
    const selected = await store.select(selection);
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: selection.source.contentSha256,
      facts: [fact],
    });
    const edits = ["Pickup at 3 PM", "Pickup at 4 PM"].map((statement) =>
      store.review({
        id: proposed.id,
        expectedRevision: proposed.revision,
        reviewerEntityId: owner,
        facts: [{ ...fact, statement, recipientEntityIds: [recipient] }],
      }),
    );
    const results = await Promise.allSettled(edits);
    const winner = results.find((result) => result.status === "fulfilled");
    const loser = results.find((result) => result.status === "rejected");
    if (winner?.status !== "fulfilled" || !loser || loser.status !== "rejected")
      throw new Error("Expected one accepted review and one stale edit");
    expect(loser.reason).toMatchObject({
      code: "FAMILY_INTAKE_REVIEW_CONFLICT",
    });
    expect(
      await new FamilyIntakeReviewStore(context).read(selection.id),
    ).toEqual(winner.value);
    expect(await store.history(selection.id)).toEqual([
      selected,
      proposed,
      winner.value,
    ]);
    expect(await store.list(selection.periodKey)).toEqual([winner.value]);
  });

  it("restores a previously excluded proposal without losing the owner's earlier decisions", async () => {
    const selected = await store.select(selection);
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: selection.source.contentSha256,
      facts: [fact],
    });
    const excluded = await store.review({
      id: selected.id,
      expectedRevision: proposed.revision,
      reviewerEntityId: owner,
      facts: [],
    });
    const reopened = new FamilyIntakeReviewStore(context);
    const included = await reopened.review({
      id: selected.id,
      expectedRevision: excluded.revision,
      reviewerEntityId: owner,
      facts: [{ ...fact, recipientEntityIds: [recipient] }],
    });
    expect(await reopened.history(selected.id)).toEqual([
      selected,
      proposed,
      excluded,
      included,
    ]);
    expect(await reopened.read(selected.id)).toEqual(included);
    expect(await reopened.select(selection)).toEqual(included);
    await expect(
      reopened.select({ ...selection, id: randomUUID() }),
    ).rejects.toMatchObject({
      code: "FAMILY_INTAKE_SELECTION_CONFLICT",
    });
  });

  it("keeps proposal disclosure private and refuses another reviewer or forged source citations", async () => {
    const selected = await store.select(selection);
    await expect(
      store.propose({
        id: selected.id,
        expectedRevision: selected.revision,
        sourceSha256: selection.source.contentSha256,
        facts: [{ ...fact, recipientEntityIds: [recipient] }],
      }),
    ).rejects.toMatchObject({
      code: "FAMILY_INTAKE_PROPOSAL_DISCLOSURE_INVALID",
    });
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: selection.source.contentSha256,
      facts: [fact],
    });
    await expect(
      store.review({
        id: proposed.id,
        expectedRevision: proposed.revision,
        reviewerEntityId: recipient,
        facts: [fact],
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEWER_MISMATCH" });
    await expect(
      store.review({
        id: proposed.id,
        expectedRevision: proposed.revision,
        reviewerEntityId: owner,
        facts: [{ ...fact, sourceQuote: "The other parent agreed." }],
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_UNPROPOSED_FACT" });
    expect(await store.read(selection.id)).toEqual(proposed);
  });

  it("keeps the same selection identity isolated between agents", async () => {
    const first = await store.select(selection);
    const other = new FamilyIntakeReviewStore({
      ...context,
      agentId: randomUUID(),
    });
    expect(await other.read(selection.id)).toBeNull();
    await expect(
      other.withdraw(selection.id, first.revision),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    const second = await other.select({
      ...selection,
      selectedByEntityId: recipient,
    });
    expect(await store.read(selection.id)).toEqual(first);
    expect(await other.read(selection.id)).toEqual(second);
  });

  it("rejects uncited proposals and invalidates disclosure after source changes, access loss and withdrawal", async () => {
    const fullText = `${"Earlier context.\n".repeat(8000)}${fact.sourceQuote}`;
    const access: AccessContext = {
      requesterEntityId: owner as UUID,
      role: "OWNER",
      isOwner: true,
    };
    let readable = true;
    let content = fullText;
    let ingestionState = "ready";
    let contentType = "text/plain";
    const intake = new FamilyIntakeService(
      store,
      {
        async getDocumentByIdWithAccessContext(
          id,
          requestedAccess,
        ): Promise<Memory | null> {
          // Deterministic document boundary; real canonical ACL enforcement is
          // covered by the document service's integration lane, not this harness.
          expect(requestedAccess).toEqual(access);
          if (!readable) return null;
          return {
            id,
            agentId: context.agentId,
            roomId: context.agentId,
            entityId: owner as UUID,
            content: { text: content },
            metadata: {
              type: "document",
              contentType,
              ingestionState,
            },
          };
        },
      },
      access,
    );
    ingestionState = "pending";
    await expect(
      intake.select({
        id: selection.id,
        periodKey: selection.periodKey,
        documentId: selection.source.documentId,
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SOURCE_NOT_READY" });
    ingestionState = "ready";
    contentType = "application/pdf";
    await expect(
      intake.select({
        id: selection.id,
        periodKey: selection.periodKey,
        documentId: selection.source.documentId,
      }),
    ).rejects.toMatchObject({
      code: "FAMILY_INTAKE_SOURCE_FORMAT_UNSUPPORTED",
    });
    expect(await store.read(selection.id)).toBeNull();
    contentType = "text/plain";
    const selected = await intake.select({
      id: selection.id,
      periodKey: selection.periodKey,
      documentId: selection.source.documentId,
    });
    expect(await intake.extractionInput(selected.id, selected.revision)).toBe(
      fullText,
    );
    await expect(
      intake.propose({
        id: selected.id,
        expectedRevision: selected.revision,
        facts: [{ ...fact, sourceQuote: "Fabricated agreement" }],
      }),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_CITATION_INVALID" });
    expect(await store.read(selected.id)).toEqual(selected);
    const proposed = await intake.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      facts: [fact],
    });
    const reviewed = await intake.review({
      id: selected.id,
      expectedRevision: proposed.revision,
      facts: [{ ...fact, recipientEntityIds: [recipient] }],
    });
    const [projected] = await intake.reviewedFacts(selection.periodKey);
    if (!projected)
      throw new Error("Expected the reviewed correspondence fact");
    expect(await intake.reviewedFacts("2026-09")).toEqual([]);
    expect(await intake.reviewedFacts("2026-11")).toEqual([projected]);
    expect(await intake.reviewedFacts("2027-03")).toEqual([projected]);
    expect(
      await intake.validateDisclosure(projected.binding, recipient),
    ).toEqual(projected);
    await expect(
      intake.validateDisclosure(projected.binding, randomUUID()),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_RECIPIENT_DENIED" });
    content = "The pickup request was canceled.";
    await expect(
      intake.validateDisclosure(projected.binding, recipient),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SOURCE_CHANGED" });
    await expect(
      intake.reviewedFacts(selection.periodKey),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SOURCE_CHANGED" });
    content = fullText;
    readable = false;
    await expect(
      intake.validateDisclosure(projected.binding, recipient),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_SOURCE_UNAVAILABLE" });
    const withdrawn = await intake.withdraw(reviewed.id, reviewed.revision);
    expect(await intake.withdraw(withdrawn.id, withdrawn.revision)).toEqual(
      withdrawn,
    );
    await expect(
      intake.validateDisclosure(projected.binding, recipient),
    ).rejects.toMatchObject({ code: "FAMILY_INTAKE_REVIEW_CONFLICT" });
    expect(await intake.reviewedFacts(selection.periodKey)).toEqual([]);
    expect(await intake.reviewedFacts("2027-03")).toEqual([]);
  });

  it("preserves complete long source quotations through proposal, review and readback", async () => {
    const complete = `${"Context paragraph.\n".repeat(8000)}FINAL-SOURCE-SENTINEL`;
    const selected = await store.select({
      ...selection,
      source: { ...selection.source, contentSha256: digest(complete) },
    });
    const proposed = await store.propose({
      id: selected.id,
      expectedRevision: selected.revision,
      sourceSha256: digest(complete),
      facts: [{ ...fact, sourceQuote: complete }],
    });
    const reviewed = await store.review({
      id: proposed.id,
      expectedRevision: proposed.revision,
      reviewerEntityId: owner,
      facts: proposed.facts,
    });
    const read = await new FamilyIntakeReviewStore(context).read(reviewed.id);
    expect(read?.facts[0]?.sourceQuote).toBe(complete);
    expect(read?.source.contentSha256).toBe(digest(complete));
  });
});
