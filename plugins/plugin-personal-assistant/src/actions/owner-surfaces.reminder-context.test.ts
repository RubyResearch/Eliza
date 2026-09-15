/** Verifies that owner reminder creation fails closed before durable mutation. */

import { promoteSubactionsToActions, validateToolArgs } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

const runLifeOperationHandler = vi.hoisted(() =>
  vi.fn(async () => ({ success: true, text: "delegated" })),
);

vi.mock("./life.js", () => ({
  OWNER_OPERATION_CONTEXTS: ["tasks"],
  OWNER_OPERATION_ROLE_GATE: { minRole: "OWNER" },
  OWNER_OPERATION_SUPPRESS_POST_ACTION_CONTINUATION: true,
  OWNER_OPERATION_TAGS: ["capability:write"],
  OWNER_OPERATION_VALIDATE: async () => true,
  runLifeOperationHandler,
}));
vi.mock("../lifeops/access.js", () => ({ hasLifeOpsAccess: async () => true }));
vi.mock("../lifeops/approval-queue.js", () => ({
  createApprovalQueue: vi.fn(),
}));
vi.mock("./book-travel.js", () => ({ runBookTravelHandler: vi.fn() }));
vi.mock("./health.js", () => ({
  createOwnerHealthAction: vi.fn(() => ({})),
  runHealthHandler: vi.fn(),
}));
vi.mock("./lib/scheduling-handler.js", () => ({
  runSchedulingNegotiationHandler: vi.fn(),
}));
vi.mock("./money.js", () => ({
  MONEY_CONTEXTS: [],
  MONEY_PARAMETERS: [],
  MONEY_TAGS: [],
  OWNER_FINANCE_SIMILES: [],
  runMoneyHandler: vi.fn(),
}));
vi.mock("./schedule.js", () => ({ runScheduleHandler: vi.fn() }));
vi.mock("./screen-time.js", () => ({
  createOwnerScreenTimeAction: vi.fn(() => ({})),
  runScreenTimeHandler: vi.fn(),
}));

const { ownerRemindersAction } = await import("./owner-surfaces.js");

it("exposes the complete plan only on definition creation and validates native fields", () => {
  const promoted = promoteSubactionsToActions(ownerRemindersAction);
  const create = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_CREATE",
  );
  const review = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_REVIEW",
  );
  const remove = promoted.find(
    (action) => action.name === "OWNER_REMINDERS_DELETE",
  );
  expect(create).toBeDefined();
  expect(review).toBeDefined();
  expect(remove).toBeDefined();
  if (!create || !review || !remove) return;
  const createPlan = {
    mode: "create",
    multiStep: false,
    title: "Call Mom",
    requestKind: "reminder",
    cadenceKind: "once",
    dueInDays: 1,
    timeOfDay: "12:00",
  };
  expect(validateToolArgs(create, { createPlan }).valid).toBe(true);
  expect(
    validateToolArgs(create, {
      createPlan: { ...createPlan, timeOfDay: "29:99" },
    }).valid,
  ).toBe(false);
  expect(
    validateToolArgs(create, { createPlan: { ...createPlan, confirmed: true } })
      .valid,
  ).toBe(false);
  expect(validateToolArgs(review, { createPlan }).valid).toBe(false);
  expect(validateToolArgs(remove, { createPlan }).valid).toBe(false);
});

describe("OWNER_REMINDERS non-command mutation defense", () => {
  it.each([
    "Remind me to inspect PR19250 tomorrow appears on the whiteboard.",
    "Remind me to inspect PR19250 tomorrow, actually ignore that request.",
    "Remind me along with Alex to inspect PR19250 tomorrow.",
  ])("rejects create before the LifeOps mutation handler: %s", async (text) => {
    runLifeOperationHandler.mockClear();
    const result = await ownerRemindersAction.handler(
      {} as never,
      { content: { text } } as never,
      undefined,
      { parameters: { action: "create" } },
      undefined,
    );

    expect(result).toMatchObject({
      success: true,
      verifiedUserFacing: true,
      data: {
        outcome: "no_action",
        reason: "REMINDER_CREATE_CONTEXT_REJECTED",
      },
      turnComplete: true,
    });
    expect(runLifeOperationHandler).not.toHaveBeenCalled();
  });

  it("allows an unambiguous create through to the LifeOps handler", async () => {
    runLifeOperationHandler.mockClear();
    const result = await ownerRemindersAction.handler(
      {} as never,
      {
        content: { text: "Remind me in 20 minutes to inspect PR19250." },
      } as never,
      undefined,
      { parameters: { action: "create" } },
      undefined,
    );

    expect(result).toMatchObject({ success: true, text: "delegated" });
    expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  });

  it("does not block an explicit non-create operation with a quoted title", async () => {
    runLifeOperationHandler.mockClear();
    await ownerRemindersAction.handler(
      {} as never,
      {
        content: { text: 'Delete the reminder "Remind me to call Pat".' },
      } as never,
      undefined,
      { parameters: { action: "delete" } },
      undefined,
    );

    expect(runLifeOperationHandler).toHaveBeenCalledOnce();
  });
});
