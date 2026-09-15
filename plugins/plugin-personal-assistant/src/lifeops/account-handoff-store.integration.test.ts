/**
 * Exercises handoff review and checkpoint persistence against real PGlite and
 * production migrations. No connector or account mutation is performed here.
 */
import {
  ApprovalDispatchControlStore,
  createApprovalQueue,
} from "@elizaos/agent";
import { CalendarService } from "@elizaos/plugin-calendar";
import { LinkedCalendarRepository } from "@elizaos/plugin-calendar/service/linked-calendar-sync";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import {
  type AccountHandoffReview,
  AccountHandoffStore,
} from "./account-handoff-store.js";
import { executeRawSql, sqlText } from "./sql.js";

const review: AccountHandoffReview = {
  previous: {
    grantId: "old-grant",
    connectorAccountId: "old-account",
    email: "test@example.test",
  },
  replacement: {
    grantId: "real-grant",
    connectorAccountId: "real-account",
    email: "real@example.test",
  },
  readCalendars: [
    {
      grantId: "real-grant",
      connectorAccountId: "real-account",
      calendarId: "family",
    },
  ],
  writeCalendar: {
    grantId: "real-grant",
    connectorAccountId: "real-account",
    calendarId: "family",
  },
  messageDestinations: [
    {
      channel: "email",
      connectorAccountId: "real-account",
      recipientId: "owner@example.test",
    },
  ],
  calendarLinks: [],
  importedData: "retain",
  retireApprovalIds: ["old-draft"],
};

describe("account handoff persistence", () => {
  let result: RealTestRuntimeResult;
  beforeAll(async () => {
    result = await createLifeOpsTestRuntime();
  }, 60_000);
  afterAll(async () => {
    await result.cleanup();
  });

  it("recovers an applied mapping after checkpoint failure and skips completed links on the next step", async () => {
    const isolated = await createLifeOpsTestRuntime();
    try {
      const runtime = isolated.runtime;
      const owner = "mapping-owner";
      const service = new CalendarService(runtime);
      await service.getLinkedCalendarControl();
      const links = new LinkedCalendarRepository(runtime);
      const records = [];
      for (const id of ["first", "second"])
        records.push(
          await links.create({
            agentId: runtime.agentId,
            localEventId: id,
            connectorAccountId: "old-account",
            providerCalendarId: "old-calendar",
            localRevision: 1,
          }),
        );
      const store = new AccountHandoffStore(runtime, owner);
      let state = await store.review("mapping-recovery", {
        ...review,
        writeCalendar: null,
        retireApprovalIds: [],
        calendarLinks: records.map((link) => ({
          linkId: link.id,
          expectedUpdatedAt: link.updatedAt,
          expectedLocalRevision: link.localRevision,
          disposition: "retain_local" as const,
        })),
      });
      const admission = new AccountHandoffAdmission(
        runtime,
        owner,
        service,
        new URL("http://localhost"),
      );
      state = await admission.begin(state.operationId, state.revision);
      state = await admission.pause(state.operationId, state.revision);
      state = await admission.drain(state.operationId, state.revision);
      state = await admission.retireApprovals(
        state.operationId,
        state.revision,
      );
      const coordinator = () =>
        new AccountHandoffCalendarMappings(
          runtime,
          owner,
          new CalendarService(runtime),
          new URL("http://localhost"),
        );
      state = await coordinator().applyNext(state.operationId, state.revision);
      const before = state;
      const first = records[0];
      if (!first) throw new Error("Missing first test link");
      await executeRawSql(
        runtime,
        `ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_mapping_checkpoint CHECK (NOT (receipt_json::jsonb ? ${sqlText(`mapping:${first.id}`)}))`,
      );
      await expect(
        coordinator().applyNext(state.operationId, state.revision),
      ).rejects.toThrow();
      expect(await store.read(state.operationId)).toEqual(before);
      expect(await links.getById(runtime.agentId, first.id)).toMatchObject({
        state: "local_only",
        pendingOperation: null,
      });
      const committedControl = await service.getLinkedCalendarControl();
      await executeRawSql(
        runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_mapping_checkpoint",
      );
      state = await coordinator().applyNext(state.operationId, state.revision);
      expect((await service.getLinkedCalendarControl()).revision).toBe(
        committedControl.revision,
      );
      const firstReceipt = state.receipt[`mapping:${first.id}`];
      state = await coordinator().applyNext(state.operationId, state.revision);
      expect(state.receipt[`mapping:${first.id}`]).toEqual(firstReceipt);
      expect((await service.getLinkedCalendarControl()).revision).toBe(
        committedControl.revision + 1,
      );
      state = await coordinator().applyNext(state.operationId, state.revision);
      expect(state.phase).toBe("verifying_replacement");
      expect((await service.getLinkedCalendarControl()).paused).toBe(true);
      await expect(
        coordinator().applyNext(before.operationId, before.revision),
      ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    } finally {
      await isolated.cleanup();
    }
  }, 60_000);

  it("admits only one racing review per owner, retaining the exact winner across instances", async () => {
    const store = new AccountHandoffStore(result.runtime, "race-owner");
    const outcomes = await Promise.allSettled([
      store.review("review-one", review),
      store.review("review-two", review),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = await store.active();
    if (!winner) throw new Error("Expected a persisted winner");
    const reopened = new AccountHandoffStore(result.runtime, "race-owner");
    expect(await reopened.read(winner.operationId)).toEqual(winner);
    expect(await reopened.review(winner.operationId, review)).toEqual(winner);
    await expect(
      reopened.review(winner.operationId, {
        ...review,
        importedData: "remove_previous_account_imports",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    const otherOwner = new AccountHandoffStore(result.runtime, "other-owner");
    expect(await otherOwner.read(winner.operationId)).toBeNull();
    expect(await otherOwner.active()).toBeNull();
    await otherOwner.review(winner.operationId, review);
  });

  it("rejects stale and out-of-order checkpoints and retains receipts while advancing", async () => {
    const store = new AccountHandoffStore(result.runtime, "checkpoint-owner");
    await store.review("checkpoint", review);
    const first = {
      operationId: "checkpoint",
      expectedRevision: 0,
      expectedPhase: "reviewed" as const,
      phase: "pausing" as const,
      receipt: { approvalPauseRevision: 4 },
    };
    const outcomes = await Promise.allSettled([
      store.advance(first),
      store.advance(first),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(
      store.advance({
        ...first,
        expectedRevision: 1,
        expectedPhase: "pausing",
        phase: "completed",
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_STEP_INVALID" });
    const reopened = new AccountHandoffStore(
      result.runtime,
      "checkpoint-owner",
    );
    const beforeOverwrite = await reopened.read("checkpoint");
    await expect(
      reopened.advance({
        operationId: "checkpoint",
        expectedRevision: 1,
        expectedPhase: "pausing",
        phase: "draining",
        receipt: { approvalPauseRevision: 99 },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(await reopened.read("checkpoint")).toEqual(beforeOverwrite);
    const next = await reopened.advance({
      operationId: "checkpoint",
      expectedRevision: 1,
      expectedPhase: "pausing",
      phase: "draining",
      receipt: { calendarPauseRevision: 9 },
    });
    expect(next.receipt).toEqual({
      approvalPauseRevision: 4,
      calendarPauseRevision: 9,
    });
    expect(next.review).toEqual(review);
    await expect(
      new AccountHandoffStore(result.runtime, "wrong-owner").advance({
        ...first,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    await expect(
      reopened.advance({
        operationId: "checkpoint",
        expectedRevision: 2,
        expectedPhase: "draining",
        phase: "cancelled",
        receipt: {},
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_STEP_INVALID" });
  });

  it("allows cancelling an untouched review and starting a different operation without losing history", async () => {
    const store = new AccountHandoffStore(result.runtime, "cancel-owner");
    await store.review("before", review);
    await store.advance({
      operationId: "before",
      expectedRevision: 0,
      expectedPhase: "reviewed",
      phase: "cancelled",
      receipt: {},
    });
    expect(await store.active()).toBeNull();
    await store.review("after", review);
    expect((await store.read("before"))?.phase).toBe("cancelled");
    expect((await store.active())?.operationId).toBe("after");
  });

  it("checkpoints original pauses and drains through the real approval and calendar services", async () => {
    const owner = "admission-owner";
    const calendar = result.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Calendar service is unavailable");
    const original = await calendar.getLinkedCalendarControl();
    const store = new AccountHandoffStore(result.runtime, owner);
    await store.review("admission", review);
    const admission = new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    );
    const begun = await admission.begin("admission", 0);
    expect(begun.receipt.admissionBaseline).toEqual({
      approval: { revision: 0, paused: false, operationId: null },
      calendar: { revision: original.revision, paused: original.paused },
    });
    const paused = await admission.pause("admission", begun.revision);
    const control = await new ApprovalDispatchControlStore(result.runtime).read(
      owner,
    );
    expect(control.paused).toBe(true);
    if (original.paused)
      expect((await calendar.getLinkedCalendarControl()).revision).toBe(
        original.revision,
      );
    const reopened = new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    );
    const drained = await reopened.drain("admission", paused.revision);
    expect(drained.phase).toBe("retiring_approvals");
    expect(
      await new ApprovalDispatchControlStore(result.runtime).read(owner),
    ).toEqual(control);
    expect(drained.receipt.admissionBaseline).toEqual(
      begun.receipt.admissionBaseline,
    );
  });

  it("recovers the same owned pause after calendar failure before checkpointing", async () => {
    const owner = "admission-restart";
    const calendar = result.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Calendar service is unavailable");
    const store = new AccountHandoffStore(result.runtime, owner);
    await store.review("restart", review);
    const url = new URL("http://localhost");
    const begun = await new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      url,
    ).begin("restart", 0);
    const failingCalendar = {
      async getLinkedCalendarControl(): Promise<never> {
        throw new Error("Injected calendar outage");
      },
      async executeLinkedCalendarControl(): Promise<never> {
        throw new Error("Injected calendar outage");
      },
    };
    await expect(
      new AccountHandoffAdmission(
        result.runtime,
        owner,
        failingCalendar,
        url,
      ).pause("restart", begun.revision),
    ).rejects.toThrow("Injected calendar outage");
    const controls = new ApprovalDispatchControlStore(result.runtime);
    const owned = await controls.read(owner);
    expect(owned.paused).toBe(true);
    expect((await store.read("restart"))?.phase).toBe("pausing");
    const resumed = await new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      url,
    ).pause("restart", begun.revision);
    expect(resumed.phase).toBe("draining");
    expect(await controls.read(owner)).toEqual(owned);
    expect(resumed.receipt.admissionBaseline).toEqual(
      begun.receipt.admissionBaseline,
    );
  });

  it("keeps account changes behind unresolved delivery after admission is paused", async () => {
    const owner = "admission-inflight";
    const calendar = result.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Calendar service is unavailable");
    const queue = createApprovalQueue(result.runtime, {
      agentId: result.runtime.agentId,
    });
    const request = await queue.enqueue({
      requestedBy: owner,
      subjectUserId: owner,
      action: "send_message",
      payload: {
        action: "send_message",
        recipient: "+15555550101",
        body: "Synthetic admission test",
        replyToMessageId: null,
      },
      channel: "sms",
      reason: "Synthetic no-provider fixture",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await queue.approve(request.id, owner, {
      resolvedBy: owner,
      resolutionReason: "Fixture owner approval",
    });
    const claimed = await queue.claimExecution({
      requestId: request.id,
      subjectUserId: owner,
      provider: "synthetic",
      providerIdempotencyKey: request.id,
    });
    if (!claimed.execution) throw new Error("Expected persisted attempt");
    const mutation = {
      requestId: request.id,
      subjectUserId: owner,
      attemptId: claimed.execution.attemptId,
    };
    const store = new AccountHandoffStore(result.runtime, owner);
    await store.review("inflight", review);
    const admission = new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    );
    const begun = await admission.begin("inflight", 0);
    const paused = await admission.pause("inflight", begun.revision);
    await expect(
      admission.drain("inflight", paused.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_DRAIN_REQUIRED" });
    await queue.markDispatchStarted(mutation);
    await queue.markReconciliationRequired({
      ...mutation,
      error: "Synthetic unknown outcome",
    });
    await expect(
      admission.drain("inflight", paused.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_DRAIN_REQUIRED" });
    expect((await store.read("inflight"))?.phase).toBe("draining");
    await queue.reconcileExecution({
      ...mutation,
      outcome: "not_delivered",
      reconciledBy: owner,
      reconciliationReason: "No provider was invoked",
    });
    await queue.markExpired(request.id, owner);
    expect((await admission.drain("inflight", paused.revision)).phase).toBe(
      "retiring_approvals",
    );
  });

  it("retires exactly reviewed approvals and resumes after a partially completed retirement", async () => {
    const owner = "retirement-owner";
    const calendar = result.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Calendar service is unavailable");
    const queue = createApprovalQueue(result.runtime, {
      agentId: result.runtime.agentId,
    });
    const enqueue = () =>
      queue.enqueue({
        requestedBy: owner,
        subjectUserId: owner,
        action: "send_message",
        payload: {
          action: "send_message",
          recipient: "+15555550101",
          body: "Synthetic retirement",
          replyToMessageId: null,
        },
        channel: "sms",
        reason: "No provider used",
        expiresAt: new Date(Date.now() + 60_000),
      });
    const first = await enqueue();
    const second = await enqueue();
    const unselected = await enqueue();
    await queue.approve(second.id, owner, {
      resolvedBy: owner,
      resolutionReason: "Synthetic fixture",
    });
    const store = new AccountHandoffStore(result.runtime, owner);
    await store.review("retirement", {
      ...review,
      retireApprovalIds: [first.id, second.id, first.id],
    });
    const admission = new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    );
    const begun = await admission.begin("retirement", 0);
    const paused = await admission.pause("retirement", begun.revision);
    const drained = await admission.drain("retirement", paused.revision);
    await queue.markExpired(first.id, owner);
    const completed = await new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    ).retireApprovals("retirement", drained.revision);
    expect(completed.phase).toBe("applying_mappings");
    expect(completed.receipt.retiredApprovals).toEqual([
      { requestId: first.id, state: "expired" },
      { requestId: second.id, state: "expired" },
    ]);
    expect((await queue.byId(unselected.id, owner))?.state).toBe("pending");
    expect((await queue.byId(second.id, owner))?.state).toBe("expired");
    await expect(
      admission.retireApprovals("retirement", drained.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
  });

  it("checks every selected approval's owner before retiring any", async () => {
    const owner = "retirement-isolation";
    const calendar = result.runtime.getService<CalendarService>(
      CalendarService.serviceType,
    );
    if (!calendar) throw new Error("Calendar service is unavailable");
    const queue = createApprovalQueue(result.runtime, {
      agentId: result.runtime.agentId,
    });
    const enqueue = (subjectUserId: string) =>
      queue.enqueue({
        requestedBy: subjectUserId,
        subjectUserId,
        action: "send_message",
        payload: {
          action: "send_message",
          recipient: "+15555550101",
          body: "Synthetic scope fixture",
          replyToMessageId: null,
        },
        channel: "sms",
        reason: "No provider used",
        expiresAt: new Date(Date.now() + 60_000),
      });
    const own = await enqueue(owner);
    const foreign = await enqueue("foreign-retirement-owner");
    const store = new AccountHandoffStore(result.runtime, owner);
    await store.review("invalid-retirement", {
      ...review,
      retireApprovalIds: [own.id, foreign.id],
    });
    const admission = new AccountHandoffAdmission(
      result.runtime,
      owner,
      calendar,
      new URL("http://localhost"),
    );
    const begun = await admission.begin("invalid-retirement", 0);
    const paused = await admission.pause("invalid-retirement", begun.revision);
    const drained = await admission.drain(
      "invalid-retirement",
      paused.revision,
    );
    await expect(
      admission.retireApprovals("invalid-retirement", drained.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_APPROVAL_UNAVAILABLE" });
    expect((await queue.byId(own.id, owner))?.state).toBe("pending");
    expect(
      (await queue.byId(foreign.id, "foreign-retirement-owner"))?.state,
    ).toBe("pending");
    expect((await store.read("invalid-retirement"))?.phase).toBe(
      "retiring_approvals",
    );
  });

  it("checkpoints each reviewed mapping without advancing the phase or overwriting recovery history", async () => {
    const store = new AccountHandoffStore(
      result.runtime,
      "mapping-checkpoints",
    );
    const links = ["first-link", "second-link"].map((linkId) => ({
      linkId,
      expectedUpdatedAt: "2026-09-10T12:00:00Z",
      expectedLocalRevision: 1,
      disposition: "copy_to_replacement" as const,
    }));
    let record = await store.review("mapping-checkpoints", {
      ...review,
      calendarLinks: links,
    });
    for (const phase of [
      "pausing",
      "draining",
      "retiring_approvals",
      "applying_mappings",
    ] as const)
      record = await store.advance({
        operationId: record.operationId,
        expectedRevision: record.revision,
        expectedPhase: record.phase,
        phase,
        receipt: {},
      });
    const checkpoint = {
      operationId: record.operationId,
      expectedRevision: record.revision,
      receipt: {
        linkId: "first-link",
        disposition: "copy_to_replacement" as const,
        operationKey: "first-mapping",
        controlRevision: 8,
      },
    };
    const raced = await Promise.allSettled([
      store.checkpointMapping(checkpoint),
      store.checkpointMapping(checkpoint),
    ]);
    expect(
      raced.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const reopened = new AccountHandoffStore(
      result.runtime,
      "mapping-checkpoints",
    );
    const first = await reopened.read(record.operationId);
    if (!first) throw new Error("Expected mapping checkpoint");
    expect(first.phase).toBe("applying_mappings");
    expect(first.receipt["mapping:first-link"]).toEqual(checkpoint.receipt);
    await expect(
      reopened.advance({
        operationId: first.operationId,
        expectedRevision: first.revision,
        expectedPhase: first.phase,
        phase: "verifying_replacement",
        receipt: {},
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_MAPPINGS_INCOMPLETE" });
    await expect(
      reopened.checkpointMapping({
        ...checkpoint,
        expectedRevision: first.revision,
        receipt: { ...checkpoint.receipt, controlRevision: 99 },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    await expect(
      reopened.checkpointMapping({
        ...checkpoint,
        expectedRevision: first.revision,
        receipt: { ...checkpoint.receipt, linkId: "unreviewed-link" },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_MAPPING_NOT_REVIEWED" });
    const second = await reopened.checkpointMapping({
      ...checkpoint,
      expectedRevision: first.revision,
      receipt: {
        ...checkpoint.receipt,
        linkId: "second-link",
        operationKey: "second-mapping",
        controlRevision: 9,
      },
    });
    const ready = await reopened.advance({
      operationId: second.operationId,
      expectedRevision: second.revision,
      expectedPhase: second.phase,
      phase: "verifying_replacement",
      receipt: {},
    });
    expect(ready.receipt["mapping:first-link"]).toEqual(checkpoint.receipt);
    expect(ready.review.calendarLinks).toEqual(links);
  });

  it("rejects mismatched calendar ownership and duplicate accounts before persisting a review", async () => {
    const store = new AccountHandoffStore(result.runtime, "invalid-owner");
    await expect(store.review(" padded-operation ", review)).rejects.toThrow();
    await expect(
      store.review("copy-without-destination", {
        ...review,
        writeCalendar: null,
        calendarLinks: [
          {
            linkId: "copy-link",
            expectedUpdatedAt: "2026-09-10T12:00:00Z",
            expectedLocalRevision: 1,
            disposition: "copy_to_replacement",
          },
        ],
      }),
    ).rejects.toThrow();

    await expect(
      store.review("bad-calendar", {
        ...review,
        writeCalendar: { ...review.readCalendars[0], grantId: "old-grant" },
      }),
    ).rejects.toThrow();
    await expect(
      store.review("same-account", { ...review, replacement: review.previous }),
    ).rejects.toThrow();
    expect(await store.active()).toBeNull();
  });
});
