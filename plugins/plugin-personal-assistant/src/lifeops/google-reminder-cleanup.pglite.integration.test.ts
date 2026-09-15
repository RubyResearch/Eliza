/** Exercises Google imported-event reminder cleanup through the public LifeOps service and real PGlite persistence. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { createLifeOpsReminderPlan, LifeOpsRepository } from "./repository.js";
import { LifeOpsService } from "./service.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

describe("Google imported-event reminder cleanup", () => {
  it("removes only the selected event reminders and safely replays through a fresh service instance", async () => {
    const repo = new LifeOpsRepository(host.runtime);
    const makePlan = (ownerId: string) =>
      createLifeOpsReminderPlan({
        agentId: host.runtime.agentId,
        ownerType: "calendar_event",
        ownerId,
        steps: [],
        mutePolicy: {},
        quietHours: {},
      });
    const removed = makePlan("removed-google-event");
    const retained = makePlan("retained-google-event");
    for (const plan of [removed, retained]) await repo.createReminderPlan(plan);
    await new LifeOpsService(host.runtime).deleteCalendarReminderPlansForEvents(
      [removed.ownerId],
    );
    expect(
      await repo.getReminderPlan(host.runtime.agentId, removed.id),
    ).toBeNull();
    expect(
      await repo.getReminderPlan(host.runtime.agentId, retained.id),
    ).toEqual(retained);
    await new LifeOpsService(host.runtime).deleteCalendarReminderPlansForEvents(
      [removed.ownerId],
    );
    await new LifeOpsService(host.runtime).deleteCalendarReminderPlansForEvents(
      [],
    );
    expect(
      await repo.getReminderPlan(host.runtime.agentId, retained.id),
    ).toEqual(retained);
  });
});
