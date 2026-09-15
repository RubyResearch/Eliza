/**
 * Unit tests for TRIGGER's `create` op: prompt-kind reminders vs workflow
 * triggers. Pins the reminder contract — relative delay (delaySeconds /
 * delayMinutes) converts to a one-off scheduledAtIso, no workflowId means
 * kind:"prompt", prompt triggers are creatable with the autonomy loop off and
 * land in the originating room — against a minimal in-memory runtime.
 * Also pins schedule precedence: a provided cronExpression expresses
 * recurrence and wins over sprayed one-shot delay fields ("every morning at
 * 9am" must not collapse into a single reminder), while an explicit one-shot
 * triggerType still outranks the cron.
 * Also covers the update / delete / toggle lifecycle ops (happy paths and
 * structured not-found failures) and the effect-receipt contract: mutating
 * ops bind their canonical ack text to committed receipts — an applied
 * receipt for fresh mutations, a replayed no-op for the idempotent
 * already-exists path — so the planned-reply egress verifier can ground a
 * truthful completion claim, while failures stay receipt-less.
 * Reply text stays diagnostic. Committed effects require a model-generated
 * confirmation backed by the preserved receipt, including idempotent replays.
 */

import type {
  ActionParameters,
  IAgentRuntime,
  Memory,
  PromptTriggerConfig,
  Task,
  UUID,
} from "@elizaos/core";
import {
  AUTONOMY_SERVICE_TYPE,
  hasAppliedUserFacingEffectProof,
  stringToUuid,
  TRIGGER_SCHEMA_VERSION,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TriggerTaskMetadata } from "../triggers/types.ts";
import { impliedTriggerQuery, triggerAction } from "./trigger.ts";

const AGENT_ID = stringToUuid("trigger-create-test-agent");
const USER_ID = stringToUuid("trigger-create-test-user");
const CHAT_ROOM_ID = stringToUuid("trigger-create-chat-room");
const AUTONOMY_ROOM_ID = stringToUuid("trigger-create-autonomy-room");

interface CreatedTask {
  name: string;
  description?: string;
  roomId?: UUID;
  tags?: string[];
  metadata: TriggerTaskMetadata;
}

function makeRuntime(opts: { enableAutonomy: boolean; timeZone?: string }): {
  runtime: IAgentRuntime;
  createdTasks: CreatedTask[];
} {
  const createdTasks: CreatedTask[] = [];
  const runtime = {
    agentId: AGENT_ID,
    enableAutonomy: opts.enableAutonomy,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getSetting: (key: string) =>
      key === "TIMEZONE" ? opts.timeZone : undefined,
    getService: (name: string) =>
      name === AUTONOMY_SERVICE_TYPE
        ? { getAutonomousRoomId: () => AUTONOMY_ROOM_ID }
        : null,
    getTasks: vi.fn(async () => [] as Task[]),
    getTask: vi.fn(async () => null),
    createTask: vi.fn(async (task: CreatedTask) => {
      createdTasks.push(task);
      return stringToUuid(`created-${createdTasks.length}`);
    }),
    updateTask: vi.fn(async () => undefined),
  } as unknown as IAgentRuntime;
  return { runtime, createdTasks };
}

function makeMessage(
  text: string,
  from?: { entityId?: UUID; roomId?: UUID; uiTimeZone?: string },
): Memory {
  return {
    id: stringToUuid(`msg-${text.slice(0, 24)}`),
    entityId: from?.entityId ?? USER_ID,
    agentId: AGENT_ID,
    roomId: from?.roomId ?? CHAT_ROOM_ID,
    content: {
      text,
      ...(from?.uiTimeZone
        ? { metadata: { uiTimeZone: from.uiTimeZone } }
        : {}),
    },
    createdAt: Date.now(),
  } as Memory;
}

async function create(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  text = "remind me to drink water",
  from?: { entityId?: UUID; roomId?: UUID; uiTimeZone?: string },
) {
  return triggerAction.handler(runtime, makeMessage(text, from), undefined, {
    parameters: { action: "create", ...parameters },
  });
}

describe("TRIGGER create — prompt-kind reminders", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a prompt-kind once trigger from delaySeconds with autonomy off", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const before = Date.now();
    const result = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.kind).toBe("prompt");
    expect(trigger?.triggerType).toBe("once");
    expect(trigger?.notifyOnOutcome).toBe(true);
    const at = Date.parse(trigger?.scheduledAtIso ?? "");
    expect(at).toBeGreaterThanOrEqual(before + 89_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 91_000);
  });

  it("delivers reminders to the originating room, not the autonomy room", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 60,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].roomId).toBe(CHAT_ROOM_ID);
  });

  it("converts delayMinutes when delaySeconds is absent", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const before = Date.now();
    const result = await create(runtime, {
      instructions: "stretch",
      delayMinutes: 5,
    });
    expect(result?.success).toBe(true);
    const at = Date.parse(
      createdTasks[0].metadata.trigger?.scheduledAtIso ?? "",
    );
    expect(at).toBeGreaterThanOrEqual(before + 299_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 301_000);
  });

  it("accepts numeric-string delaySeconds (planner args arrive as strings)", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "call mom",
      delaySeconds: "120",
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("once");
  });

  it("prefers an explicit scheduledAtIso over a relative delay", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const explicit = new Date(Date.now() + 3_600_000).toISOString();
    const result = await create(runtime, {
      instructions: "meeting",
      scheduledAtIso: explicit,
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.scheduledAtIso).toBe(explicit);
  });

  it("accepts an explicit one-shot timestamp when the planner sprays unused zero schedule fields", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const scheduledAtIso = new Date(Date.now() + 3_600_000).toISOString();
    const result = await create(runtime, {
      instructions: "join the meeting",
      triggerType: "once",
      scheduledAtIso,
      delaySeconds: 0,
      delayMinutes: 0,
      intervalMs: 0,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger).toMatchObject({
      triggerType: "once",
      scheduledAtIso,
    });
    expect(createdTasks[0].metadata.trigger?.intervalMs).toBeUndefined();

    for (const parameterName of [
      "delaySeconds",
      "delayMinutes",
      "intervalMs",
    ]) {
      expect(
        triggerAction.parameters?.find(
          (parameter) => parameter.name === parameterName,
        )?.schema,
      ).toMatchObject({ minimum: 0 });
    }
  });

  it("rejects a non-positive delay with a structured failure", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "noop",
      delaySeconds: 0,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_DELAY");
    expect(createdTasks).toHaveLength(0);
  });

  it("rejects a zero interval when interval is the selected schedule", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "review open pull requests",
      triggerType: "interval",
      intervalMs: 0,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_INTERVAL");
    expect(createdTasks).toHaveLength(0);
  });

  it("rejects a sub-minute fractional delayMinutes instead of scheduling 'now'", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "noop",
      delayMinutes: 0.5,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_DELAY");
    expect(createdTasks).toHaveLength(0);
  });

  it("rejects a past explicit scheduledAtIso instead of creating a dead task", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "meeting",
      scheduledAtIso: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_SCHEDULE");
    expect(createdTasks).toHaveLength(0);
  });

  it("keeps the delay one-shot even when the model contradicts with triggerType interval", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "hydrate",
      triggerType: "interval",
      delaySeconds: 90,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("once");
  });

  it("keeps an explicit interval when unused delay fields are sprayed as zero", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "review open pull requests",
      triggerType: "interval",
      intervalMs: 60_000,
      delaySeconds: 0,
      delayMinutes: 0,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger).toMatchObject({
      triggerType: "interval",
      intervalMs: 60_000,
    });
  });

  it("dedupes an identical delay-derived reminder (planner retry double-emit)", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    // Second identical call sees the first trigger as an existing task.
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });
});

describe("TRIGGER delete — target resolution", () => {
  it("resolves a display name passed as taskId instead of failing the delete (live regression)", async () => {
    // Live 2026-09-13: the planner sent {action:"delete", taskId:"Email landlord (nubs)"};
    // the miss cost a replan and the failure text became the delivered reply.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const created = await create(runtime, {
      instructions: "email the landlord",
      delaySeconds: 3600,
    });
    expect(created?.success).toBe(true);
    const stored = createdTasks[0];
    const task = {
      ...stored,
      id: stringToUuid("created-1"),
      tags: stored.tags ?? [],
    } as unknown as Task;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([task]);
    (runtime as unknown as { deleteTask: unknown }).deleteTask = vi.fn(
      async () => undefined,
    );
    const displayName = String(stored.metadata.trigger?.displayName ?? "");
    expect(displayName).not.toBe("");

    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the landlord trigger"),
      undefined,
      { parameters: { action: "delete", taskId: displayName } },
    );

    expect(result?.success).toBe(true);
    expect(
      (runtime as unknown as { deleteTask: { mock: { calls: unknown[][] } } })
        .deleteTask.mock.calls[0]?.[0],
    ).toBe(task.id);
  });

  it("resolves a target-less delete from the user's own words (live regression)", async () => {
    // Live 2026-09-14: "delete the landlord trigger" arrived as
    // {action:"delete"}; the not-found text became the delivered reply
    // although the retry deleted the trigger.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const created = await create(runtime, {
      instructions: "email the landlord",
      delaySeconds: 3600,
    });
    expect(created?.success).toBe(true);
    const stored = createdTasks[0];
    const task = {
      ...stored,
      id: stringToUuid("created-2"),
      tags: stored.tags ?? [],
    } as unknown as Task;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([task]);
    (runtime as unknown as { deleteTask: unknown }).deleteTask = vi.fn(
      async () => undefined,
    );

    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the landlord trigger"),
      undefined,
      { parameters: { action: "delete" } },
    );

    expect(result?.success, JSON.stringify(result)).toBe(true);
    expect(
      (runtime as unknown as { deleteTask: { mock: { calls: unknown[][] } } })
        .deleteTask.mock.calls[0]?.[0],
    ).toBe(task.id);
  });

  it("reports a missing target as read-only when the words name no trigger", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const created = await create(runtime, {
      instructions: "email the landlord",
      delaySeconds: 3600,
    });
    expect(created?.success).toBe(true);
    const stored = createdTasks[0];
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        ...stored,
        id: stringToUuid("created-3"),
        tags: stored.tags ?? [],
      } as unknown as Task,
    ]);
    (runtime as unknown as { deleteTask: unknown }).deleteTask = vi.fn(
      async () => undefined,
    );

    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the trigger"),
      undefined,
      { parameters: { action: "delete" } },
    );

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      error: "TRIGGER_MISSING_TARGET",
      readOnlyOperation: true,
    });
    expect(result?.userFacingText).toContain("Which reminder do you mean?");
    expect(
      (runtime as unknown as { deleteTask: { mock: { calls: unknown[][] } } })
        .deleteTask,
    ).not.toHaveBeenCalled();
  });
});

describe("impliedTriggerQuery", () => {
  it("keeps the named trigger and drops the generic nouns", () => {
    const msg = (text: string) => makeMessage(text);
    expect(impliedTriggerQuery(msg("delete the landlord trigger"))).toBe(
      "landlord",
    );
    expect(impliedTriggerQuery(msg("cancel my vitamins reminder"))).toBe(
      "vitamins",
    );
    expect(impliedTriggerQuery(msg("turn off the oven alarm please"))).toBe(
      "oven",
    );
    expect(impliedTriggerQuery(msg("delete the trigger"))).toBe(undefined);
    expect(impliedTriggerQuery(msg("what triggers do I have?"))).toBe(
      undefined,
    );
    expect(impliedTriggerQuery(undefined)).toBe(undefined);
  });
});

describe("TRIGGER create — recurrence wins over sprayed one-shot fields", () => {
  it("creates a recurring cron reminder from cronExpression alone with autonomy off", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
    });
    expect(result?.success).toBe(true);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.kind).toBe("prompt");
    expect(trigger?.triggerType).toBe("cron");
    expect(trigger?.cronExpression).toBe("0 8 * * *");
    expect(result?.text).toContain("every morning at 8am");
  });

  it("keeps 'every morning at 9am' recurring when the planner sprays every schedule field", async () => {
    // The exact failure shape observed live: the planner emitted the cron AND
    // its derived one-shot echoes (delay/scheduledAtIso computed as the time
    // to the FIRST fire), and the delay used to demote the trigger to "once".
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "brush your teeth",
      displayName: "brush teeth",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      delayMinutes: 420,
      delaySeconds: 25200,
      scheduledAtIso: new Date(Date.now() + 7 * 3_600_000).toISOString(),
      intervalMs: 86_400_000,
      maxRuns: 100,
    });
    expect(result?.success).toBe(true);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.triggerType).toBe("cron");
    expect(trigger?.cronExpression).toBe("0 9 * * *");
    expect(trigger?.scheduledAtIso).toBeUndefined();
    expect(result?.text).toContain("every morning at 9am");
    expect(result?.text).not.toContain("once at");
  });

  it("resolves cronExpression + delay to recurring even without an explicit triggerType", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
      delayMinutes: 720,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("cron");
  });

  it("lets an explicit one-shot triggerType outrank a sprayed cronExpression", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const explicit = new Date(Date.now() + 3_600_000).toISOString();
    const result = await create(runtime, {
      instructions: "join the standup",
      triggerType: "once",
      scheduledAtIso: explicit,
      cronExpression: "0 9 * * *",
    });
    expect(result?.success).toBe(true);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.triggerType).toBe("once");
    expect(trigger?.scheduledAtIso).toBe(explicit);
    expect(trigger?.cronExpression).toBeUndefined();
  });

  it("fails structurally on an unparseable cron instead of degrading to a one-off", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "every morning",
      delayMinutes: 720,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_CRON");
    expect(createdTasks).toHaveLength(0);
  });

  it("ignores an out-of-range delay echo when a valid cron carries the schedule", async () => {
    // Production-valid arguments: the schema accepts any positive number, and
    // this one would fail INVALID_DELAY if it were honored as a schedule. Under
    // a cron it is an ignored first-fire echo and must not block the create.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
      delayMinutes: 999_999_999,
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("cron");
  });

  it("ignores an unparseable delay under a cron (defense-in-depth behind validateToolArgs)", async () => {
    // The production boundary rejects a non-number delay before the handler
    // runs; this direct-handler call pins the inner guard so a bypassed or
    // relaxed boundary still cannot let a junk echo block a valid recurrence.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
      delayMinutes: "soon",
    });
    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger?.triggerType).toBe("cron");
  });

  it("fails structurally when triggerType cron arrives without a cronExpression", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      triggerType: "cron",
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_CRON");
    expect(createdTasks).toHaveLength(0);
  });

  it("dedupes a re-asked recurring reminder even when the sprayed first-fire fields differ", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
      delayMinutes: 300,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-cron-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    // Asked again at a different time of day: the derived delay and first-fire
    // timestamp differ, but the recurring schedule is identical.
    const second = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
      delayMinutes: 990,
      scheduledAtIso: new Date(Date.now() + 990 * 60_000).toISOString(),
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });

  it("replays as a no-op when a clean cron retry follows the full spray shape", async () => {
    // Schedule identity is type-specific: the sprayed intervalMs (and every
    // other ignored echo) must not enter a cron trigger's dedupe key, or the
    // clean retry hashes the default interval and mints a duplicate task.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "brush your teeth",
      displayName: "brush teeth",
      triggerType: "cron",
      cronExpression: "0 9 * * *",
      delayMinutes: 420,
      delaySeconds: 25_200,
      scheduledAtIso: new Date(Date.now() + 7 * 3_600_000).toISOString(),
      intervalMs: 86_400_000,
      maxRuns: 100,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-sprayed-cron-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "brush your teeth",
      cronExpression: "0 9 * * *",
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });

  it("keeps an explicit interval identity stable when a cron echo is sprayed alongside", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "poll the queue",
      triggerType: "interval",
      intervalMs: 3_600_000,
      cronExpression: "0 9 * * *",
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    expect(firstTrigger?.triggerType).toBe("interval");
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-interval-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "poll the queue",
      triggerType: "interval",
      intervalMs: 3_600_000,
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });

  it("keeps an explicit once identity stable when a cron echo is sprayed alongside", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const explicit = new Date(Date.now() + 3_600_000).toISOString();
    const first = await create(runtime, {
      instructions: "join the standup",
      triggerType: "once",
      scheduledAtIso: explicit,
      cronExpression: "0 9 * * *",
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    expect(firstTrigger?.triggerType).toBe("once");
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-once-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "join the standup",
      triggerType: "once",
      scheduledAtIso: explicit,
    });
    expect(second?.success).toBe(true);
    expect(second?.data?.duplicateTaskId).toBeDefined();
    expect(createdTasks).toHaveLength(1);
  });
});

describe("TRIGGER planner contract — recurrence guidance", () => {
  it("tells the planner to map 'every …' requests to cronExpression alone and delays to one-offs", () => {
    const descriptions = new Map(
      (triggerAction.parameters ?? []).map((p) => [p.name, p.description]),
    );
    const cron = descriptions.get("cronExpression") ?? "";
    expect(cron).toMatch(/RECURRING/);
    expect(cron).toMatch(/every/i);
    expect(cron).toMatch(/ALONE/);
    const delaySeconds = descriptions.get("delaySeconds") ?? "";
    expect(delaySeconds).toMatch(/one-off/i);
    expect(delaySeconds).toMatch(/cronExpression/);
    const delayMinutes = descriptions.get("delayMinutes") ?? "";
    expect(delayMinutes).toMatch(/one-off/i);
    expect(delayMinutes).toMatch(/cronExpression/);
    expect(triggerAction.routingHint).toMatch(/RECURRING/);
    expect(triggerAction.routingHint).toMatch(/cronExpression ALONE/);
  });
});

describe("TRIGGER handler — silent, planner-voiced acks (#16863)", () => {
  it("never invokes the user-visible callback on a successful create", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const callback = vi.fn(async () => []);
    const result = await triggerAction.handler(
      runtime,
      makeMessage("remind me to stretch"),
      undefined,
      {
        parameters: {
          action: "create",
          instructions: "stretch",
          delaySeconds: 45,
        },
      },
      callback,
    );
    expect(result?.success).toBe(true);
    expect(createdTasks).toHaveLength(1);
    // The planner's final message is the single user-facing ack; a handler
    // callback here double-posted the mechanical result seconds before it.
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns the invalid-op failure without echoing it to chat", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const callback = vi.fn(async () => []);
    const result = await triggerAction.handler(
      runtime,
      makeMessage("do something"),
      undefined,
      { parameters: { action: "explode" } },
      callback,
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TRIGGER_INVALID");
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("TRIGGER replies — humanized schedule, single final message", () => {
  const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("renders a daily cron as human recurrence — no cron string in user text", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "take vitamins",
        displayName: "take vitamins",
        cronExpression: "0 8 * * *",
      },
      "remind me to take vitamins every morning",
      { uiTimeZone: "America/New_York" },
    );
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.text).toBe(
      'Reminder set: "take vitamins" — every morning at 8am.',
    );
    expect(result.text).not.toContain("0 8 * * *");
    expect(result.text).not.toMatch(/cron/i);
    expect(result.text).not.toMatch(ISO_TIMESTAMP);
    // Machine detail stays in structured data for the planner/telemetry.
    expect(result.data?.cronExpression).toBe("0 8 * * *");
    expect(createdTasks[0].metadata.trigger?.timezone).toBe("America/New_York");
  });

  it("renders a weekly cron as its weekday recurrence", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "review the sprint board",
      displayName: "sprint review",
      cronExpression: "0 9 * * 1",
    });
    if (!result) throw new Error("expected a result");
    expect(result.text).toBe(
      'Reminder set: "sprint review" — every Monday at 9am.',
    );
  });

  it("renders a one-shot ISO timestamp in the sending client's timezone without changing the instant", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00.000Z"));
    try {
      const { runtime } = makeRuntime({ enableAutonomy: false });
      const scheduledAtIso = "2026-08-09T12:00:00.000Z";
      const result = await create(
        runtime,
        {
          instructions: "take vitamins",
          displayName: "take vitamins",
          scheduledAtIso,
        },
        "remind me to take vitamins",
        { uiTimeZone: "America/New_York" },
      );
      if (!result) throw new Error("expected a result");
      expect(result.success).toBe(true);
      expect(result.text).toBe(
        'Reminder set: "take vitamins" — tomorrow at 8am.',
      );
      expect(result.text).not.toMatch(ISO_TIMESTAMP);
      expect(result.data?.scheduledAtIso).toBe(scheduledAtIso);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the client timezone at a date boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T23:30:00.000Z"));
    try {
      const { runtime } = makeRuntime({
        enableAutonomy: false,
        timeZone: "UTC",
      });
      const result = await create(
        runtime,
        {
          instructions: "check the oven",
          displayName: "check the oven",
          scheduledAtIso: "2026-08-09T01:00:00.000Z",
        },
        "remind me to check the oven",
        { uiTimeZone: "America/New_York" },
      );
      expect(result?.text).toBe(
        'Reminder set: "check the oven" — today at 9pm.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back from an invalid client timezone to the agent timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T20:00:00.000Z"));
    try {
      const { runtime, createdTasks } = makeRuntime({
        enableAutonomy: false,
        timeZone: "Europe/Paris",
      });
      const scheduledAtIso = "2026-08-08T22:00:00.000Z";
      const result = await create(
        runtime,
        {
          instructions: "turn off the lights",
          displayName: "turn off the lights",
          scheduledAtIso,
        },
        "remind me to turn off the lights",
        { uiTimeZone: "Mars/Olympus" },
      );
      expect(result?.text).toBe(
        'Reminder set: "turn off the lights" — tomorrow at 12am.',
      );
      expect(result?.data?.scheduledAtIso).toBe(scheduledAtIso);
      expect(result?.data?.timezone).toBe("Europe/Paris");
      expect(createdTasks[0].metadata.trigger?.scheduledAtIso).toBe(
        scheduledAtIso,
      );
      expect(createdTasks[0].metadata.trigger?.timezone).toBe("Europe/Paris");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a delay-derived one-shot as a countdown", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "drink water",
      displayName: "drink water",
      delayMinutes: 5,
    });
    if (!result) throw new Error("expected a result");
    expect(result.text).toBe('Reminder set: "drink water" — in 5 minutes.');
    expect(result.text).not.toMatch(ISO_TIMESTAMP);
  });

  it("strips the internal 'Trigger:' displayName prefix from the reply", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "stretch",
      delaySeconds: 120,
    });
    if (!result) throw new Error("expected a result");
    expect(result.text).not.toContain("Trigger:");
    expect(result.text).toContain('"stretch"');
  });

  it("leaves a committed create confirmation to the model", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      cronExpression: "0 8 * * *",
    });
    if (!result) throw new Error("expected a result");
    expect(result.modelReplyRequired).toBe(true);
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
  });

  it("also uses the model for idempotent replay confirmations", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: {
          updatedAt: Date.now(),
          trigger: createdTasks[0].metadata.trigger,
        },
      } as unknown as Task,
    ]);
    const replay = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    if (!replay) throw new Error("expected a result");
    expect(replay.modelReplyRequired).toBe(true);
    expect(replay.userFacingText).toBeUndefined();
  });
});

describe("TRIGGER create — workflow triggers", () => {
  it("still requires the autonomy loop for workflow triggers", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      delaySeconds: 60,
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("AUTONOMY_OFF");
    expect(createdTasks).toHaveLength(0);
  });

  it("creates a workflow-kind trigger into the autonomy room when autonomy is on", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      workflowName: "Report",
      intervalMs: 3_600_000,
    });
    expect(result?.success).toBe(true);
    const trigger = createdTasks[0].metadata.trigger;
    expect(trigger?.kind).toBe("workflow");
    expect(trigger?.kind === "workflow" ? trigger.workflowId : undefined).toBe(
      "wf-1",
    );
    expect(createdTasks[0].roomId).toBe(AUTONOMY_ROOM_ID);
  });

  it("creates a valid cron trigger", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      cronExpression: "0 9 * * 1-5",
    });

    expect(result?.success).toBe(true);
    expect(createdTasks[0].metadata.trigger).toMatchObject({
      triggerType: "cron",
      cronExpression: "0 9 * * 1-5",
    });
  });

  it("rejects an invalid cron expression without creating a task", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: true });
    const result = await create(runtime, {
      instructions: "run the report workflow",
      workflowId: "wf-1",
      triggerType: "cron",
      cronExpression: "not a cron",
    });

    expect(result?.success).toBe(false);
    expect(result?.error).toBe("INVALID_CRON");
    expect(createdTasks).toHaveLength(0);
  });
});

describe("TRIGGER lifecycle", () => {
  it("resolves a task UUID and accepts a string boolean when toggling", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    await create(runtime, { instructions: "drink water", delaySeconds: 90 });
    const taskId = stringToUuid("existing-trigger-task");
    vi.mocked(runtime.getTask).mockResolvedValue({
      id: taskId,
      name: createdTasks[0].name,
      tags: createdTasks[0].tags,
      metadata: createdTasks[0].metadata,
    } as Task);

    const result = await triggerAction.handler(
      runtime,
      makeMessage("enable my reminder"),
      undefined,
      { parameters: { action: "toggle", taskId, enabled: "yes" } },
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.enabled).toBe(true);
    expect(runtime.updateTask).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ metadata: expect.any(Object) }),
    );
  });
});

describe("TRIGGER update / delete / toggle — lifecycle ops (#16863)", () => {
  const LIFECYCLE_TASK_ID = stringToUuid("trigger-lifecycle-task");

  function makePromptTrigger(
    overrides: Partial<PromptTriggerConfig> = {},
  ): PromptTriggerConfig {
    return {
      version: TRIGGER_SCHEMA_VERSION,
      triggerId: stringToUuid("trigger-lifecycle-config"),
      displayName: "Trigger: water the plants",
      instructions: "water the plants",
      triggerType: "interval",
      enabled: true,
      wakeMode: "inject_now",
      createdBy: String(USER_ID),
      runCount: 0,
      intervalMs: 3_600_000,
      kind: "prompt",
      ...overrides,
    };
  }

  function makeTriggerTask(trigger: PromptTriggerConfig): Task {
    return {
      id: LIFECYCLE_TASK_ID,
      name: "TRIGGER_DISPATCH",
      description: trigger.displayName,
      roomId: CHAT_ROOM_ID,
      tags: ["queue", "repeat", "trigger"],
      metadata: { updatedAt: Date.now(), trigger },
    } as unknown as Task;
  }

  interface TaskPatch {
    description?: string;
    metadata?: TriggerTaskMetadata;
  }

  function makeLifecycleRuntime(
    tasks: Task[],
    timeZone?: string,
  ): {
    runtime: IAgentRuntime;
    updates: Array<{ taskId: UUID; patch: TaskPatch }>;
    deletions: UUID[];
  } {
    const updates: Array<{ taskId: UUID; patch: TaskPatch }> = [];
    const deletions: UUID[] = [];
    const runtime = {
      agentId: AGENT_ID,
      enableAutonomy: false,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      getSetting: (key: string) => (key === "TIMEZONE" ? timeZone : undefined),
      getService: () => null,
      getTask: vi.fn(async (id: UUID) => tasks.find((t) => t.id === id)),
      getTasks: vi.fn(async () => tasks),
      createTask: vi.fn(async (input: CreatedTask) => {
        const taskId = stringToUuid(`lifecycle-created-${tasks.length}`);
        tasks.push({ id: taskId, ...input } as unknown as Task);
        return taskId;
      }),
      updateTask: vi.fn(async (taskId: UUID, patch: TaskPatch) => {
        updates.push({ taskId, patch });
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index >= 0) {
          tasks[index] = { ...tasks[index], ...patch } as Task;
        }
      }),
      deleteTask: vi.fn(async (taskId: UUID) => {
        deletions.push(taskId);
      }),
    } as unknown as IAgentRuntime;
    return { runtime, updates, deletions };
  }

  async function dispatch(
    runtime: IAgentRuntime,
    parameters: ActionParameters,
    from?: { uiTimeZone?: string },
  ) {
    return triggerAction.handler(
      runtime,
      makeMessage("manage my triggers", from),
      undefined,
      { parameters },
    );
  }

  it("update patches displayName and interval and persists a recomputed schedule", async () => {
    const { runtime, updates } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger()),
    ]);
    const before = Date.now();
    const result = await dispatch(runtime, {
      action: "update",
      taskId: LIFECYCLE_TASK_ID,
      displayName: "Trigger: hydrate",
      intervalMs: 120_000,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Updated "hydrate" — every 2 minutes.');
    expect(result?.modelReplyRequired).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].taskId).toBe(LIFECYCLE_TASK_ID);
    expect(updates[0].patch.description).toBe("Trigger: hydrate");
    const next = updates[0].patch.metadata?.trigger;
    expect(next?.displayName).toBe("Trigger: hydrate");
    expect(next?.intervalMs).toBe(120_000);
    // buildTriggerMetadata re-armed the schedule off the new interval.
    expect(next?.nextRunAtMs).toBeGreaterThanOrEqual(before + 120_000);
  });

  it("uses neutral wording for a legacy cron whose scheduler timezone is unknown", async () => {
    const { runtime } = makeLifecycleRuntime([
      makeTriggerTask(
        makePromptTrigger({
          triggerType: "cron",
          intervalMs: undefined,
          cronExpression: "0 8 * * *",
          timezone: undefined,
        }),
      ),
    ]);
    const result = await dispatch(runtime, {
      action: "update",
      taskId: LIFECYCLE_TASK_ID,
      displayName: "Trigger: morning check",
    });
    expect(result?.text).toBe(
      'Updated "morning check" — on its saved recurring schedule.',
    );
  });

  it("anchors an updated cron to the sending client's timezone", async () => {
    const { runtime, updates } = makeLifecycleRuntime([
      makeTriggerTask(
        makePromptTrigger({
          triggerType: "cron",
          intervalMs: undefined,
          cronExpression: "0 8 * * *",
          timezone: "UTC",
        }),
      ),
    ]);
    const result = await dispatch(
      runtime,
      {
        action: "update",
        taskId: LIFECYCLE_TASK_ID,
        cronExpression: "0 9 * * *",
      },
      { uiTimeZone: "America/New_York" },
    );
    expect(result?.text).toBe(
      'Updated "water the plants" — every morning at 9am.',
    );
    expect(updates[0].patch.metadata?.trigger?.timezone).toBe(
      "America/New_York",
    );
  });

  it("rekeys a cron after a timezone update so old and current schedules dedupe correctly", async () => {
    const seed = makeRuntime({ enableAutonomy: false });
    const seeded = await create(
      seed.runtime,
      {
        instructions: "water the plants",
        cronExpression: "0 8 * * *",
      },
      "remind me to water the plants every morning at 8",
      { uiTimeZone: "America/New_York" },
    );
    expect(seeded?.success).toBe(true);
    const initialTrigger = seed.createdTasks[0].metadata.trigger;
    if (!initialTrigger) throw new Error("expected seeded trigger");
    const originalDedupeKey = initialTrigger.dedupeKey;
    const tasks = [makeTriggerTask(initialTrigger as PromptTriggerConfig)];
    const { runtime, updates } = makeLifecycleRuntime(tasks);

    const updated = await dispatch(
      runtime,
      {
        action: "update",
        taskId: LIFECYCLE_TASK_ID,
        cronExpression: "0 8 * * *",
      },
      { uiTimeZone: "America/Los_Angeles" },
    );
    expect(updated?.success).toBe(true);
    const updatedTrigger = updates[0].patch.metadata?.trigger;
    expect(updatedTrigger?.timezone).toBe("America/Los_Angeles");
    expect(updatedTrigger?.dedupeKey).not.toBe(originalDedupeKey);

    const recreatedOldSchedule = await create(
      runtime,
      {
        instructions: "water the plants",
        cronExpression: "0 8 * * *",
      },
      "remind me to water the plants every morning at 8",
      { uiTimeZone: "America/New_York" },
    );
    expect(recreatedOldSchedule?.success).toBe(true);
    expect(recreatedOldSchedule?.data?.duplicateTaskId).toBeUndefined();
    expect(tasks).toHaveLength(2);

    const replayedCurrentSchedule = await create(
      runtime,
      {
        instructions: "water the plants",
        cronExpression: "0 8 * * *",
      },
      "remind me to water the plants every morning at 8",
      { uiTimeZone: "America/Los_Angeles" },
    );
    expect(replayedCurrentSchedule?.success).toBe(true);
    expect(replayedCurrentSchedule?.data?.duplicateTaskId).toBe(
      LIFECYCLE_TASK_ID,
    );
    expect(tasks).toHaveLength(2);
  });

  it("update fails structurally on a missing or unknown taskId without persisting", async () => {
    const { runtime, updates } = makeLifecycleRuntime([]);
    const missing = await dispatch(runtime, {
      action: "update",
      taskId: stringToUuid("no-such-task"),
      displayName: "whatever",
    });
    expect(missing?.success).toBe(false);
    expect(missing?.error).toBe("TRIGGER_NOT_FOUND");
    expect(missing?.data).toMatchObject({
      error: "TRIGGER_NOT_FOUND",
      readOnlyOperation: true,
    });

    const noId = await dispatch(runtime, {
      action: "update",
      displayName: "whatever",
    });
    expect(noId?.success).toBe(false);
    expect(noId?.error).toBe("MISSING_TASK_ID");
    expect(noId?.data).toMatchObject({
      error: "MISSING_TASK_ID",
      readOnlyOperation: true,
    });
    expect(updates).toHaveLength(0);
  });

  it("delete resolves the trigger by displayName fragment and removes its task", async () => {
    const { runtime, deletions } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger()),
    ]);
    const result = await dispatch(runtime, {
      action: "delete",
      displayName: "water the plants",
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Deleted "water the plants".');
    expect(result?.modelReplyRequired).toBe(true);
    expect(deletions).toEqual([LIFECYCLE_TASK_ID]);
  });

  it("delete reports TRIGGER_NOT_FOUND when no triggers exist", async () => {
    const { runtime, deletions } = makeLifecycleRuntime([]);
    const result = await dispatch(runtime, {
      action: "delete",
      displayName: "anything",
    });
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TRIGGER_NOT_FOUND");
    expect(result?.text).toBe("No triggers exist.");
    expect(deletions).toHaveLength(0);
  });

  it("toggle flips a disabled trigger back on and persists the re-armed schedule", async () => {
    const { runtime, updates } = makeLifecycleRuntime([
      makeTriggerTask(makePromptTrigger({ enabled: false })),
    ]);
    const result = await dispatch(runtime, {
      action: "toggle",
      taskId: LIFECYCLE_TASK_ID,
    });
    expect(result?.success).toBe(true);
    expect(result?.text).toBe('Enabled "water the plants".');
    expect(result?.modelReplyRequired).toBe(true);
    expect(result?.data?.enabled).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.metadata?.trigger?.enabled).toBe(true);
  });
});

describe("TRIGGER effect receipts — completion-claim grounding", () => {
  it("preserves an applied receipt without prescribing confirmation text", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      triggerType: "cron",
      cronExpression: "0 8 * * *",
    });
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.userFacingText).toBeUndefined();
    const receipt = result.effectReceipts?.[0];
    expect(receipt).toMatchObject({
      operation: "trigger.create",
      outcome: "applied",
      resource: { kind: "trigger.task", id: String(result.data?.taskId) },
      idempotency: { key: result.data?.dedupeKey, replayed: false },
    });
    expect(result.userFacingEffectReceiptIds).toBeUndefined();
    expect(hasAppliedUserFacingEffectProof(result)).toBe(false);
    expect(createdTasks).toHaveLength(1);
  });

  it("grounds the already-exists dedupe as a replayed no-op — success, not a lie", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    const firstTrigger = createdTasks[0].metadata.trigger;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("existing-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: firstTrigger },
      } as unknown as Task,
    ]);
    const second = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.verifiedUserFacing).toBeUndefined();
    expect(second.userFacingText).toBeUndefined();
    expect(second.effectReceipts?.[0]).toMatchObject({
      operation: "trigger.create",
      outcome: "noop",
      resource: {
        kind: "trigger.task",
        id: String(second.data?.duplicateTaskId),
      },
      idempotency: { key: second.data?.dedupeKey, replayed: true },
    });
    // The model can cite the receipt; there is no action-owned final text.
    expect(hasAppliedUserFacingEffectProof(second)).toBe(false);
    expect(createdTasks).toHaveLength(1);
  });

  it("legacy fuzzy match (instructions+type, schedule unknown) reports the near-duplicate WITHOUT a replayed receipt", async () => {
    // A stored row with no dedupeKey matches on instructions+type only — it
    // cannot prove the SCHEDULE matches (an 8am row "matches" a 9am ask), so
    // it must not mint verified already-covered proof.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    // Build a real trigger config via the action, then strip its dedupeKey
    // and change its schedule — the legacy row shape: same instructions and
    // type, different timing, no key to prove equivalence.
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 30,
    });
    expect(first?.success).toBe(true);
    const legacyTrigger = {
      ...(createdTasks[0].metadata.trigger as unknown as Record<
        string,
        unknown
      >),
      dedupeKey: undefined,
    };
    createdTasks.length = 0;
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      {
        id: stringToUuid("legacy-task"),
        name: "TRIGGER_DISPATCH",
        tags: ["queue", "repeat", "trigger"],
        metadata: { updatedAt: Date.now(), trigger: legacyTrigger },
      } as unknown as Task,
    ]);
    const result = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.text).toContain("similar");
    expect(result.effectReceipts).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(result.data?.legacyFuzzyMatch).toBe(true);
    expect(createdTasks).toHaveLength(0);
  });

  it("refuses to claim success for a failed create — no receipts, no verified text", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(runtime, {
      instructions: "take vitamins",
      triggerType: "cron",
      cronExpression: "not a cron",
    });
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(false);
    expect(result.effectReceipts).toBeUndefined();
    expect(result.verifiedUserFacing).toBeUndefined();
    expect(hasAppliedUserFacingEffectProof(result)).toBe(false);
    expect(createdTasks).toHaveLength(0);
  });

  it("binds delete to an applied receipt for the removed task", async () => {
    const taskId = stringToUuid("receipt-delete-task");
    const task = {
      id: taskId,
      name: "TRIGGER_DISPATCH",
      description: "Trigger: water the plants",
      roomId: CHAT_ROOM_ID,
      tags: ["queue", "repeat", "trigger"],
      metadata: {
        updatedAt: Date.now(),
        trigger: {
          version: TRIGGER_SCHEMA_VERSION,
          triggerId: stringToUuid("receipt-delete-config"),
          displayName: "Trigger: water the plants",
          instructions: "water the plants",
          triggerType: "interval",
          enabled: true,
          wakeMode: "inject_now",
          createdBy: String(USER_ID),
          runCount: 0,
          intervalMs: 3_600_000,
          kind: "prompt",
        },
      },
    } as unknown as Task;
    const runtime = {
      agentId: AGENT_ID,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      getSetting: () => undefined,
      getService: () => null,
      getTask: async (id: UUID) => (id === taskId ? task : null),
      getTasks: async () => [task],
      deleteTask: vi.fn(async () => undefined),
    } as unknown as IAgentRuntime;
    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the plants trigger"),
      undefined,
      { parameters: { action: "delete", taskId } },
    );
    if (!result) throw new Error("expected a result");
    expect(result.success).toBe(true);
    expect(result.userFacingText).toBeUndefined();
    expect(result.effectReceipts?.[0]).toMatchObject({
      operation: "trigger.delete",
      outcome: "applied",
      resource: { kind: "trigger.task", id: String(taskId) },
    });
    expect(hasAppliedUserFacingEffectProof(result)).toBe(false);
  });
});

describe("TRIGGER dedupe — replay key is the complete delivery identity", () => {
  const OTHER_USER_ID = stringToUuid("trigger-create-other-user");
  const OTHER_ROOM_ID = stringToUuid("trigger-create-other-room");

  function storeTasks(
    runtime: IAgentRuntime,
    triggers: Array<Record<string, unknown> | undefined>,
  ): void {
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue(
      triggers.map(
        (trigger, i) =>
          ({
            id: stringToUuid(`stored-task-${i}`),
            name: "TRIGGER_DISPATCH",
            tags: ["queue", "repeat", "trigger"],
            metadata: { updatedAt: Date.now(), trigger },
          }) as unknown as Task,
      ),
    );
  }

  it("a second recipient sharing the same request still gets their own delivery", async () => {
    // Two users in the SAME channel ask for the same reminder. Recipient A's
    // stored trigger must not suppress recipient B: B's reminder would never
    // fire for B, yet B would be told "you're covered" with a verified
    // receipt minted from A's row.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    storeTasks(runtime, [
      createdTasks[0].metadata.trigger as unknown as Record<string, unknown>,
    ]);
    const second = await create(
      runtime,
      { instructions: "drink water", delaySeconds: 90 },
      "remind me to drink water",
      { entityId: OTHER_USER_ID },
    );
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.data?.duplicateTaskId).toBeUndefined();
    expect(second.effectReceipts?.[0]).toMatchObject({
      outcome: "applied",
      idempotency: { replayed: false },
    });
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[1].metadata.trigger?.createdBy).toBe(
      String(OTHER_USER_ID),
    );
    // Distinct recipients produce distinct replay keys for the same request.
    expect(createdTasks[1].metadata.trigger?.dedupeKey).not.toBe(
      createdTasks[0].metadata.trigger?.dedupeKey,
    );
  });

  it("the same recipient asking in a different room gets a delivery there too", async () => {
    // A reminder delivers into the room it was created in; the same wording
    // requested from a different room is a different delivery, not a replay.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    storeTasks(runtime, [
      createdTasks[0].metadata.trigger as unknown as Record<string, unknown>,
    ]);
    const second = await create(
      runtime,
      { instructions: "drink water", delaySeconds: 90 },
      "remind me to drink water",
      { roomId: OTHER_ROOM_ID },
    );
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.data?.duplicateTaskId).toBeUndefined();
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[1].roomId).toBe(OTHER_ROOM_ID);
  });

  it("the same recipient replaying the same delivery is suppressed as a replayed no-op", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    storeTasks(runtime, [
      createdTasks[0].metadata.trigger as unknown as Record<string, unknown>,
    ]);
    const replay = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    if (!replay) throw new Error("expected a result");
    expect(replay.success).toBe(true);
    expect(replay.effectReceipts?.[0]).toMatchObject({
      outcome: "noop",
      idempotency: { replayed: true },
    });
    expect(createdTasks).toHaveLength(1);
  });

  it("a dedupe-key collision can never cross recipients — createdBy is structurally required", async () => {
    // dedupeHash is a 32-bit djb2, so two different identities CAN collide.
    // Simulate the collision adversarially: store recipient A's row carrying
    // the exact key recipient B's ask will compute. B must still get their
    // own trigger — key equality alone is never proof across creators.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const probe = await create(
      runtime,
      { instructions: "drink water", delaySeconds: 90 },
      "remind me to drink water",
      { entityId: OTHER_USER_ID },
    );
    expect(probe?.success).toBe(true);
    const collidingKey = createdTasks[0].metadata.trigger?.dedupeKey;
    const attackerRow = {
      ...(createdTasks[0].metadata.trigger as unknown as Record<
        string,
        unknown
      >),
      createdBy: String(USER_ID),
      dedupeKey: collidingKey,
    };
    createdTasks.length = 0;
    storeTasks(runtime, [attackerRow]);
    const second = await create(
      runtime,
      { instructions: "drink water", delaySeconds: 90 },
      "remind me to drink water",
      { entityId: OTHER_USER_ID },
    );
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.data?.duplicateTaskId).toBeUndefined();
    expect(createdTasks).toHaveLength(1);
  });

  it("another user's legacy (pre-key) row is not near-duplicate advice for a new recipient", async () => {
    // The fuzzy tier matches instructions+type on rows without a dedupeKey.
    // Scoped to the creator: telling recipient B "a similar trigger exists,
    // delete it first" about A's row suppresses B's own delivery.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const first = await create(runtime, {
      instructions: "drink water",
      delaySeconds: 90,
    });
    expect(first?.success).toBe(true);
    const legacyRow = {
      ...(createdTasks[0].metadata.trigger as unknown as Record<
        string,
        unknown
      >),
      dedupeKey: undefined,
    };
    createdTasks.length = 0;
    storeTasks(runtime, [legacyRow]);
    const second = await create(
      runtime,
      { instructions: "drink water", delaySeconds: 90 },
      "remind me to drink water",
      { entityId: OTHER_USER_ID },
    );
    if (!second) throw new Error("expected a result");
    expect(second.success).toBe(true);
    expect(second.data?.legacyFuzzyMatch).toBeUndefined();
    expect(createdTasks).toHaveLength(1);
    expect(createdTasks[0].metadata.trigger?.createdBy).toBe(
      String(OTHER_USER_ID),
    );
  });
});

describe("a trigger failure carries a user-safe explanation", () => {
  // Live 2026-08-14: "cancel the reminder about the oven" answered with
  // "the available runtime step failed before it produced a usable result."
  // The action was CORRECT — the reminder had already fired, so nothing
  // matched — but its `text` mixes the explanation with an operator hint
  // ("Pass taskId or a displayName fragment") that must never reach chat, and
  // it offered no user-safe alternative, so the planner-loop fallback shipped
  // its generic string and the user learned nothing.
  it("keeps the operator hint out of the user-facing sentence", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    const result = await triggerAction.handler(
      runtime,
      makeMessage("cancel the reminder about the oven"),
      undefined,
      { parameters: { action: "delete", name: "oven" } },
    );
    expect(result?.success).toBe(false);
    const shown = (result as { userFacingText?: string }).userFacingText ?? "";
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain("taskId");
    expect(shown).not.toContain("displayName");
    expect(shown).not.toContain("fragment");
  });
});

describe("TRIGGER list — dropped rows are counted, not hidden", () => {
  // op:list scopes to tasks tagged queue+repeat+trigger and then silently
  // skips every row whose metadata.trigger will not parse. A user whose
  // reminder rows fail that parse was told flatly that no reminders are set,
  // and the populated branch presented the survivors as the whole schedule.
  function taskWith(metadata: Record<string, unknown>, id: string): Task {
    return {
      id: stringToUuid(id),
      name: "TRIGGER_DISPATCH",
      tags: ["queue", "repeat", "trigger"],
      metadata,
    } as unknown as Task;
  }

  function readableTask(displayName: string, id: string): Task {
    return taskWith(
      {
        updatedAt: Date.now(),
        trigger: {
          schemaVersion: TRIGGER_SCHEMA_VERSION,
          triggerId: id,
          displayName,
          kind: "prompt",
          triggerType: "interval",
          intervalMs: 3_600_000,
          enabled: true,
          instructions: "stretch",
        },
      },
      id,
    );
  }

  async function list(runtime: IAgentRuntime) {
    const result = await triggerAction.handler(
      runtime,
      makeMessage("what reminders do i have"),
      undefined,
      { parameters: { action: "list" } },
    );
    if (!result) throw new Error("expected a result");
    return result;
  }

  it("says how many tagged trigger rows were unreadable instead of 'none are set'", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      taskWith({ updatedAt: Date.now() }, "no-trigger-metadata"),
      taskWith({ updatedAt: Date.now(), trigger: {} }, "no-trigger-id"),
    ]);

    const result = await list(runtime);
    const text = String(result.text ?? "");

    expect(text).not.toBe("No reminders or scheduled triggers are set.");
    expect(text).toContain("2 tagged trigger tasks");
    expect(text).toContain("could not be read");
    expect(result.data).toMatchObject({ count: 0, unreadable: 2 });
  });

  it("discloses skipped rows alongside the ones it can list", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([
      readableTask("stretch reminder", "trigger-readable"),
      taskWith({ updatedAt: Date.now() }, "no-trigger-metadata"),
    ]);

    const result = await list(runtime);
    const text = String(result.text ?? "");

    expect(text).toContain("1 scheduled item");
    expect(text).toContain("1 more tagged trigger task");
    expect(text).toContain("stretch reminder");
    expect(result.data).toMatchObject({ count: 1, unreadable: 1 });
  });

  it("stays plain when every tagged row was readable", async () => {
    const { runtime } = makeRuntime({ enableAutonomy: false });
    (
      runtime.getTasks as unknown as { mockResolvedValue: (v: Task[]) => void }
    ).mockResolvedValue([readableTask("stretch reminder", "trigger-readable")]);

    const result = await list(runtime);
    const text = String(result.text ?? "");

    expect(text).toContain("1 scheduled item");
    expect(text).not.toContain("could not be read");
    expect(result.data).toMatchObject({ count: 1, unreadable: 0 });
  });

  it("describes the persisted occurrence for a one-shot cron", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T10:00:00.000Z"));
      const { runtime } = makeRuntime({
        enableAutonomy: false,
        timeZone: "UTC",
      });
      const persistedNextRunAtMs = Date.parse("2026-08-15T09:00:00.000Z");
      (
        runtime.getTasks as unknown as {
          mockResolvedValue: (v: Task[]) => void;
        }
      ).mockResolvedValue([
        taskWith(
          {
            updatedAt: Date.now(),
            trigger: {
              schemaVersion: TRIGGER_SCHEMA_VERSION,
              triggerId: "yearly-one-shot",
              displayName: "yearly reminder",
              kind: "prompt",
              triggerType: "cron",
              cronExpression: "0 0 1 1 *",
              timezone: "America/Los_Angeles",
              maxRuns: 1,
              nextRunAtMs: persistedNextRunAtMs,
              enabled: true,
              instructions: "remember the persisted occurrence",
            },
          },
          "yearly-one-shot",
        ),
      ]);

      const result = await list(runtime);

      expect(result.text).toContain("today at 9am");
      expect(result.text).not.toContain("January");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("trigger reference id/name mismatch guard", () => {
  it("refuses to delete when taskId resolves to a different trigger than named", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const created = await create(
      runtime,
      {
        instructions: "do 20 pushups",
        cronExpression: "0 8 * * *",
      },
      "do 20 pushups every morning at 8am",
    );
    expect(created?.success).toBe(true);
    // The default harness's createTask does not attach ids; materialize the
    // stored task with one so the id-based reference path is exercised.
    (runtime as unknown as { deleteTask: unknown }).deleteTask = vi.fn(
      async () => undefined,
    );
    const storedTask = { ...createdTasks[0], id: stringToUuid("pushups-task") };
    const taskId = String(storedTask.id);
    (
      runtime.getTask as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(storedTask);
    // Live repro shape: the planner paired the pushups task id with the
    // orchid's name; the delete must fail structurally, not fire.
    const result = await triggerAction.handler(
      runtime,
      makeMessage("no, just once tomorrow morning"),
      undefined,
      {
        parameters: {
          action: "delete",
          taskId,
          displayName: "water the orchid",
        },
      },
    );
    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({ error: "TRIGGER_REF_MISMATCH" });
    expect(runtime.deleteTask).not.toHaveBeenCalled();
  });

  it("deletes when the stated name matches the resolved trigger", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const created = await create(
      runtime,
      { instructions: "do 20 pushups", cronExpression: "0 8 * * *" },
      "do 20 pushups every morning at 8am",
    );
    expect(created?.success).toBe(true);
    (runtime as unknown as { deleteTask: unknown }).deleteTask = vi.fn(
      async () => undefined,
    );
    const storedTask = { ...createdTasks[0], id: stringToUuid("pushups-task") };
    const taskId = String(storedTask.id);
    (
      runtime.getTask as unknown as { mockResolvedValue: (v: unknown) => void }
    ).mockResolvedValue(storedTask);
    const result = await triggerAction.handler(
      runtime,
      makeMessage("delete the pushups trigger"),
      undefined,
      {
        parameters: {
          action: "delete",
          taskId,
          displayName: "pushups",
        },
      },
    );
    expect(result?.success).toBe(true);
    expect(runtime.deleteTask).toHaveBeenCalled();
  });
});

describe("sprayed one-shot cap on an explicit recurrence", () => {
  it("drops maxRuns=1 when the user's own words state a repeating cadence", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    // Field-spraying planners answering "every morning" emit the cron AND a
    // derived one-shot maxRuns:1 echo; the user's stated cadence wins.
    const result = await create(
      runtime,
      {
        instructions: "do 20 pushups",
        cronExpression: "0 8 * * *",
        maxRuns: 1,
      },
      "do 20 pushups every morning at 8am",
    );
    expect(result?.success).toBe(true);
    const trigger = (
      createdTasks[0]?.metadata as { trigger?: { maxRuns?: number } }
    )?.trigger;
    expect(trigger?.maxRuns).toBeUndefined();
  });

  it("drops the cap on a bare weekday recurrence ('every tuesday')", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "take out recycling",
        cronExpression: "0 8 * * 2",
        maxRuns: 1,
      },
      "take out recycling every tuesday at 8am",
    );
    expect(result?.success).toBe(true);
    const trigger = (
      createdTasks[0]?.metadata as { trigger?: { maxRuns?: number } }
    )?.trigger;
    expect(trigger?.maxRuns).toBeUndefined();
  });

  it("drops maxRuns=1 for explicit Japanese recurrence", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "水を飲む",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      },
      "毎日午前9時に水を飲むようにリマインドして",
    );
    expect(result?.success).toBe(true);
    const trigger = (
      createdTasks[0]?.metadata as { trigger?: { maxRuns?: number } }
    )?.trigger;
    expect(trigger?.maxRuns).toBeUndefined();
  });

  it("drops maxRuns=1 for explicit numeric cadence", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "check the queue",
        cronExpression: "*/15 * * * *",
        maxRuns: 1,
      },
      "check the queue every 15 minutes",
    );
    expect(result?.success).toBe(true);
    expect(createdTasks[0]?.metadata.trigger?.maxRuns).toBeUndefined();
  });

  it("keeps maxRuns=1 when the current user negates recurrence", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "call the bank",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      },
      "remind me tomorrow, not every day",
    );
    expect(result?.success).toBe(true);
    expect(createdTasks[0]?.metadata.trigger?.maxRuns).toBe(1);
  });

  it("keeps maxRuns=1 when cadence words remain inside a negated clause", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "call the bank",
        cronExpression: "0 9 * * 1",
        maxRuns: 1,
      },
      "do not repeat this every week",
    );
    expect(result?.success).toBe(true);
    expect(createdTasks[0]?.metadata.trigger?.maxRuns).toBe(1);
  });

  it("keeps maxRuns=1 when the text has only a time-of-day window phrase", async () => {
    // "in the morning" is a WINDOW, not a recurrence — a one-shot reminder
    // must not become an unbounded daily cron because of it.
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "call mom",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      },
      "remind me to call mom in the morning",
    );
    expect(result?.success).toBe(true);
    const trigger = (
      createdTasks[0]?.metadata as { trigger?: { maxRuns?: number } }
    )?.trigger;
    expect(trigger?.maxRuns).toBe(1);
  });

  it("keeps maxRuns=1 when the text states no recurrence", async () => {
    const { runtime, createdTasks } = makeRuntime({ enableAutonomy: false });
    const result = await create(
      runtime,
      {
        instructions: "call the bank",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      },
      "remind me to call the bank at 9am",
    );
    expect(result?.success).toBe(true);
    const trigger = (
      createdTasks[0]?.metadata as { trigger?: { maxRuns?: number } }
    )?.trigger;
    expect(trigger?.maxRuns).toBe(1);
  });
});

describe("one-shot cron reminder confirmation", () => {
  it("describes a maxRuns=1 cron by its next occurrence, never as recurring", async () => {
    // Pin the clock well before 9am: within an hour of the fire the
    // humanizer legitimately says "in NN minutes" instead of naming 9am.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T03:00:00.000Z"));
    try {
      const { runtime } = makeRuntime({
        enableAutonomy: false,
        timeZone: "UTC",
      });
      const result = await create(runtime, {
        instructions: "call the bank",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      });
      expect(result?.success).toBe(true);
      // The trigger fires once at the next 9am and stops; the confirmation must
      // read as a one-shot, not a recurrence the trigger cannot have.
      expect(result?.text).not.toContain("every morning");
      expect(result?.text).not.toContain("every day");
      expect(result?.text).toMatch(/9(:00)?\s?(a\.?m\.?)/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("describes the persisted occurrence when persistence crosses the cron boundary", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-15T08:59:59.000Z"));
      const { runtime, createdTasks } = makeRuntime({
        enableAutonomy: false,
        timeZone: "UTC",
      });
      vi.mocked(runtime.createTask).mockImplementation(async (task) => {
        createdTasks.push(task as CreatedTask);
        vi.setSystemTime(new Date("2026-08-15T09:00:01.000Z"));
        return stringToUuid("created-across-cron-boundary");
      });

      const result = await create(runtime, {
        instructions: "call the bank",
        cronExpression: "0 9 * * *",
        maxRuns: 1,
      });

      expect(createdTasks[0]?.metadata.trigger?.nextRunAtMs).toBe(
        Date.parse("2026-08-15T09:00:00.000Z"),
      );
      expect(result?.text).toContain("today at 9am");
      expect(result?.text).not.toContain("tomorrow");
    } finally {
      vi.useRealTimers();
    }
  });
});
