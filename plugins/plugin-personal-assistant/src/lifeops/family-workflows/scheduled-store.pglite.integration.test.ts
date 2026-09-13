/**
 * Real-PGlite task and history mutation coverage through the canonical runner
 * and SQL stores. A deterministic local channel stands in for external delivery;
 * lifecycle admission, rollback, history retention, and metadata races use real SQL.
 */
import { randomUUID } from "node:crypto";
import {
  getScheduledTaskRunner,
  registerScheduledTaskChannelDispatcher,
} from "@elizaos/plugin-scheduling";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { expect, it } from "vitest";
import { createLifeOpsTestRuntime } from "../../../test/helpers/runtime.js";
import { createApprovalQueue } from "../approval-queue.js";
import { MonthlyFamilyPacketService } from "../family-coordination/monthly-packet.js";
import { HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID } from "../household/types.js";
import { executeRawSql, sqlQuote, withTransaction } from "../sql.js";
import { previewFamilyDeletionDatabase } from "./deletion-database-snapshot.js";
import { createFamilySchedulingStores } from "./scheduled-store.js";
import {
  ensureFamilyWorkspaceOperationStore,
  fenceFamilyWorkspace,
} from "./workspace-operation-store.js";

it("fences family task writes while preserving unrelated execution and history maintenance", async () => {
  const result = await createLifeOpsTestRuntime();
  const runtime = result.runtime;
  try {
    registerScheduledTaskChannelDispatcher(runtime, {
      channelKey: "family_store_test",
      async dispatch() {
        return { ok: true, channelKey: "family_store_test" };
      },
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const stores = createFamilySchedulingStores(runtime, runtime.agentId);
    const input = {
      kind: "recap" as const,
      promptInstructions: "Synthetic store boundary check",
      trigger: { kind: "manual" as const },
      priority: "medium" as const,
      respectsGlobalPause: false,
      source: "plugin" as const,
      createdBy: runtime.agentId,
      ownerVisible: true,
      output: {
        destination: "channel" as const,
        target: "family_store_test:local",
      },
    };
    const family = await runner.schedule({
      ...input,
      metadata: { systemOperation: "family.monthlyCoordination" },
    });
    const unrelated = await runner.schedule(input);
    expect((await runner.fireWithResult(family.taskId)).kind).toBe("fired");
    const familyBefore = await stores.store.get(family.taskId);
    const historyBefore = await stores.logStore.list({
      agentId: runtime.agentId,
      taskId: family.taskId,
    });
    expect(historyBefore.some((row) => row.transition === "fired")).toBe(true);
    await ensureFamilyWorkspaceOperationStore(runtime);
    await withTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );

    await expect(
      runner.schedule({
        ...input,
        metadata: { systemOperation: "family.monthlyCoordination" },
      }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      stores.store.upsert({ ...family, metadata: {} }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(stores.store.delete(family.taskId)).rejects.toMatchObject({
      code: "FAMILY_WORKSPACE_FENCED",
    });
    await expect(
      runner.apply(family.taskId, "dismiss", { reason: "Too late" }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    expect(await stores.store.get(family.taskId)).toEqual(familyBefore);
    expect(
      await stores.logStore.list({
        agentId: runtime.agentId,
        taskId: family.taskId,
      }),
    ).toEqual(historyBefore);

    expect((await runner.fireWithResult(unrelated.taskId)).kind).toBe("fired");
    const newUnrelated = await runner.schedule(input);
    expect(await stores.store.get(newUnrelated.taskId)).not.toBeNull();
    const rolledUp = await stores.logStore.rollupOlderThan({
      agentId: runtime.agentId,
      olderThanIso: "2100-01-01T00:00:00.000Z",
    });
    expect(rolledUp.deletedRaw).toBeGreaterThan(0);
    expect(
      await stores.logStore.list({
        agentId: runtime.agentId,
        taskId: family.taskId,
      }),
    ).toEqual(historyBefore);
    const unrelatedHistory = await stores.logStore.list({
      agentId: runtime.agentId,
      taskId: unrelated.taskId,
    });
    expect(unrelatedHistory.some((row) => row.rolledUp)).toBe(true);
    const original = unrelatedHistory[0];
    if (!original) throw new Error("Synthetic task history disappeared");

    await executeRawSql(
      runtime,
      `CREATE FUNCTION app_scheduling.reject_store_delete_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.task_id=${sqlQuote(unrelated.taskId)} THEN RAISE EXCEPTION 'history delete fault'; END IF; RETURN OLD; END $$`,
    );
    await executeRawSql(
      runtime,
      "CREATE TRIGGER reject_store_delete_test BEFORE DELETE ON app_scheduling.life_scheduled_task_log FOR EACH ROW EXECUTE FUNCTION app_scheduling.reject_store_delete_test()",
    );
    try {
      await expect(stores.store.delete(unrelated.taskId)).rejects.toMatchObject(
        {
          cause: { message: "history delete fault" },
        },
      );
      expect(await stores.store.get(unrelated.taskId)).not.toBeNull();
      expect(
        await stores.logStore.list({
          agentId: runtime.agentId,
          taskId: unrelated.taskId,
        }),
      ).toEqual(unrelatedHistory);
    } finally {
      await executeRawSql(
        runtime,
        "DROP TRIGGER reject_store_delete_test ON app_scheduling.life_scheduled_task_log",
      );
      await executeRawSql(
        runtime,
        "DROP FUNCTION app_scheduling.reject_store_delete_test()",
      );
    }
    await stores.store.delete(unrelated.taskId);
    expect(await stores.store.get(unrelated.taskId)).toBeNull();
    await expect(
      stores.logStore.append({ ...original, logId: randomUUID() }),
    ).rejects.toMatchObject({ code: "FAMILY_SCHEDULING_TARGET_UNAVAILABLE" });
    expect(
      await stores.logStore.list({
        agentId: runtime.agentId,
        taskId: unrelated.taskId,
      }),
    ).toEqual([]);
    expect(await stores.store.get(family.taskId)).toEqual(familyBefore);
  } finally {
    await result.cleanup();
  }
}, 180_000);

it("includes canonical family approval reminders in deletion and rejects their writes after fencing", async () => {
  const result = await createLifeOpsTestRuntime();
  const runtime = result.runtime;
  try {
    const packets = new MonthlyFamilyPacketService(runtime);
    const packet = await packets.buildInternal(
      {
        key: "2048-07",
        startsOn: "2048-07-01",
        endsOnExclusive: "2048-08-01",
        timeZone: "America/New_York",
      },
      [],
    );
    const draft = await packets.createExternalDraft(packet, {
      recipient: "synthetic@example.invalid",
      recipientEntityId: "synthetic-recipient",
      calendarPrivacyMode: "busy_only",
    });
    const queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
    const approval = await packets.enqueueDraftApproval({
      draft,
      queue,
      requestedBy: SELF_ENTITY_ID,
      subjectUserId: SELF_ENTITY_ID,
      expiresAt: new Date("2048-07-01T00:00:00.000Z"),
    });
    // Household enqueue precedes its domain-link acknowledgement in production.
    const pendingHousehold = await queue.enqueue({
      requestedBy: SELF_ENTITY_ID,
      subjectUserId: SELF_ENTITY_ID,
      action: "execute_workflow",
      channel: "internal",
      reason: "Synthetic household approval",
      payload: {
        action: "execute_workflow",
        workflowId: HOUSEHOLD_SCHEDULE_PROPOSAL_APPROVAL_WORKFLOW_ID,
        input: { proposalId: "synthetic-proposal", proposalVersion: 1 },
      },
      expiresAt: new Date("2048-07-01T00:00:00.000Z"),
    });
    const unrelated = await queue.enqueue({
      requestedBy: SELF_ENTITY_ID,
      subjectUserId: SELF_ENTITY_ID,
      action: "execute_workflow",
      channel: "internal",
      reason: "Synthetic unrelated approval",
      payload: {
        action: "execute_workflow",
        workflowId: "synthetic.unrelated.workflow",
        input: {},
      },
      expiresAt: new Date("2048-07-01T00:00:00.000Z"),
    });
    const runner = getScheduledTaskRunner(runtime, {
      agentId: runtime.agentId,
    });
    const reminder = (await runner.list()).find(
      (task) => task.metadata?.approvalRequestId === approval.id,
    );
    if (!reminder)
      throw new Error("Canonical approval reminder was not scheduled");
    const householdReminder = (await runner.list()).find(
      (task) => task.metadata?.approvalRequestId === pendingHousehold.id,
    );
    const unrelatedReminder = (await runner.list()).find(
      (task) => task.metadata?.approvalRequestId === unrelated.id,
    );
    if (!householdReminder || !unrelatedReminder)
      throw new Error("Canonical approval reminders were not scheduled");
    const preview = await previewFamilyDeletionDatabase(
      runtime,
      SELF_ENTITY_ID,
    );
    expect(
      preview.records.some(
        (record) =>
          record.kind === "scheduledTasks" &&
          record.identity.id === reminder.taskId,
      ),
    ).toBe(true);
    expect(
      preview.records.some(
        (record) =>
          record.kind === "scheduledTaskHistory" &&
          record.identity.task_id === reminder.taskId,
      ),
    ).toBe(true);
    expect(
      preview.records.some(
        (record) =>
          record.kind === "approvals" &&
          record.identity.id === pendingHousehold.id,
      ),
    ).toBe(true);
    expect(
      preview.records.some(
        (record) =>
          record.kind === "scheduledTasks" &&
          record.identity.id === householdReminder.taskId,
      ),
    ).toBe(true);
    expect(
      preview.records.some(
        (record) =>
          record.kind === "scheduledTaskHistory" &&
          record.identity.task_id === householdReminder.taskId,
      ),
    ).toBe(true);
    expect(
      preview.records.some(
        (record) =>
          record.kind === "scheduledTasks" &&
          record.identity.id === unrelatedReminder.taskId,
      ),
    ).toBe(false);
    await withTransaction(runtime, (tx) =>
      fenceFamilyWorkspace(tx, runtime.agentId),
    );
    const stores = createFamilySchedulingStores(runtime, runtime.agentId);
    const before = await stores.store.get(reminder.taskId);
    await expect(
      stores.store.upsert({ ...reminder, metadata: {} }),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(runner.fireWithResult(reminder.taskId)).rejects.toMatchObject({
      code: "FAMILY_WORKSPACE_FENCED",
    });
    await expect(stores.store.delete(reminder.taskId)).rejects.toMatchObject({
      code: "FAMILY_WORKSPACE_FENCED",
    });
    expect(await stores.store.get(reminder.taskId)).toEqual(before);
    await expect(
      runner.fireWithResult(householdReminder.taskId),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await expect(
      stores.store.delete(householdReminder.taskId),
    ).rejects.toMatchObject({ code: "FAMILY_WORKSPACE_FENCED" });
    await runner.apply(unrelatedReminder.taskId, "dismiss", {
      reason: "Synthetic unrelated work remains available",
    });
    expect(
      (await stores.store.get(unrelatedReminder.taskId))?.state.status,
    ).toBe("dismissed");
  } finally {
    await result.cleanup();
  }
}, 180_000);
