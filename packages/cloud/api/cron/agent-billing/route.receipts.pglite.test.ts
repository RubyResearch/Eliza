/**
 * Drives the real agent-billing run repository and schema through the Hono
 * route and Cloudflare cron dispatcher on isolated PGlite. External billing,
 * email, webhook, and provisioning boundaries remain deterministic fakes.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentHourlyBillingOutcome } from "@/db/repositories/agent-billing";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const firstSandbox = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  agent_name: "First Agent",
  organization_id: "123e4567-e89b-42d3-a456-426614174010",
  user_id: "123e4567-e89b-42d3-a456-426614174020",
  agent_config: null,
  status: "running",
  billing_status: "active",
  last_billed_at: null,
  total_billed: "0",
  shutdown_warning_sent_at: null,
  scheduled_shutdown_at: null,
  created_at: new Date("2026-08-20T16:00:00.000Z"),
};
const secondSandbox = {
  ...firstSandbox,
  id: "223e4567-e89b-42d3-a456-426614174001",
  agent_name: "Second Agent",
};

let selectedSandboxes = [firstSandbox];
let selectionFailure: Error | null = null;
let billingFailureIds = new Set<string>();
const exactAmounts = new Map([
  [firstSandbox.id, "0.100000"],
  [secondSandbox.id, "0.200000"],
]);

const listBillableSandboxes = mock(
  async (_now?: Date, _rebillCutoff?: Date) => {
    const rows = await dbWrite.select().from(agentBillingRuns);
    expect(rows.filter((row) => row.status === "started")).toHaveLength(1);
    if (selectionFailure) throw selectionFailure;
    return { runningSandboxes: selectedSandboxes, stoppedWithBackups: [] };
  },
);
const listBillingOrganizations = mock(async () => [
  {
    id: firstSandbox.organization_id,
    name: "Receipt Org",
    credit_balance: "100",
    billing_email: "billing@example.test",
  },
]);
async function defaultRecordHourlyBilling(input: {
  sandboxId: string;
}): Promise<AgentHourlyBillingOutcome> {
  if (billingFailureIds.has(input.sandboxId)) {
    throw new Error("sk_live_secret raw provider response stack dump");
  }
  const amountDecimal = exactAmounts.get(input.sandboxId) ?? "0.000000";
  return {
    status: "billed" as const,
    amount: Number(amountDecimal),
    amountDecimal,
    newBalance: 99,
    transactionId: `transaction-${input.sandboxId}`,
  };
}
const recordHourlyBilling = mock(defaultRecordHourlyBilling);
const suspendFailedSandboxBilling = mock(async () => 0);
const getOrganizationCreditBalance = mock(async () => 100);
const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);

mock.module("@/db/repositories/agent-billing", () => ({
  agentBillingRepository: {
    listBillableSandboxes,
    listBillingOrganizations,
    recordHourlyBilling,
    suspendFailedSandboxBilling,
    getOrganizationCreditBalance,
    scheduleShutdownWarning: mock(async () => undefined),
    suspendSandboxForInsufficientCredits: mock(async () => undefined),
  },
}));

mock.module("@/db/repositories/users", () => ({
  providerForPlatform: (platform: string | undefined) =>
    platform === "telegram" || platform === "discord" || platform === "whatsapp"
      ? platform
      : platform === "twilio" || platform === "blooio"
        ? "phone"
        : undefined,
  usersRepository: { listByOrganization: mock(async () => []) },
}));

mock.module("@/lib/services/agent-unfunded-stop", () => ({
  enqueueAgentUnfundedStopForRun: async () => {
    throw new Error("Unexpected unfunded stop in receipt-only fixture");
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  readAdminCanaryImageJobData: (job: { data: unknown }) => job.data,
  listRecoverableAgentComputeStopIntents: mock(async () => []),
  rearmRecoverableAgentComputeStopIntentOnce: mock(async () => ({
    id: "recovered-stop-job",
    rearmed: true,
  })),
  provisioningJobService: {
    enqueueAgentSuspendOnce: mock(async () => ({
      job: { id: "stop-job" },
      created: true,
    })),
    triggerImmediate: mock(async () => undefined),
  },
}));

mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: mock(async () => Response.json({ ok: true })),
}));

mock.module("@/lib/utils/logger", () => ({
  redact: {
    txHash: (value: string | null | undefined) => value ?? "[missing]",
    id: (value: string | null | undefined) => value ?? "[missing]",
    orgId: (value: string | null | undefined) => value ?? "[missing]",
    userId: (value: string | null | undefined) => value ?? "[missing]",
    paymentId: (value: string | null | undefined) => value ?? "[missing]",
    trackId: (value: string | null | undefined) => value ?? "[missing]",
    ip: (value: string | null | undefined) => value ?? "[missing]",
    address: (value: string | null | undefined) => value ?? "[missing]",
    context: (value: Record<string, unknown>) => value,
  },
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { agentBillingRunRepository } from "@/db/repositories/agent-billing-runs";
import {
  agentBillingRunItems,
  agentBillingRuns,
} from "@/db/schemas/compute-billing";
import type { Bindings } from "@/types/cloud-worker-env";

const {
  CRON_FANOUT,
  CRON_INVOCATION_ID_HEADER,
  CRON_SCHEDULED_TIME_HEADER,
  CRON_SCHEDULE_HEADER,
  makeCronHandler,
  scheduledCronInvocationId,
} = await import("@/lib/cron/cloudflare-cron");
const route = (await import("./route")).default;
const { dispatchFullApp } = await import("../../src/index");

const PATH = "/api/cron/agent-billing";
const SCHEDULE = "0 * * * *";
const SCHEDULED_TIME = Date.UTC(2026, 7, 20, 17, 0, 0);
const CRON_SECRET = "test-cron-secret";
const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

function mountRoute(): Hono {
  const app = new Hono();
  app.route(PATH, route);
  return app;
}

function scheduledHeaders(): Record<string, string> {
  return {
    "x-cron-secret": CRON_SECRET,
    [CRON_INVOCATION_ID_HEADER]: scheduledCronInvocationId(
      { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
      PATH,
    ),
    [CRON_SCHEDULE_HEADER]: SCHEDULE,
    [CRON_SCHEDULED_TIME_HEADER]: String(SCHEDULED_TIME),
  };
}

async function dispatchScheduledRequest(app: Hono): Promise<Response> {
  let routeResponse: Response | null = null;
  const pending: Promise<unknown>[] = [];
  const scheduled = makeCronHandler(async (request, env, ctx) => {
    if (new URL(request.url).pathname !== PATH) {
      return new Response(null, { status: 204 });
    }
    routeResponse = await dispatchFullApp(
      request,
      env,
      ctx,
      async () => app as never,
    );
    return routeResponse;
  });
  await scheduled(
    { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
    {
      CRON_SECRET,
      NEXT_PUBLIC_APP_URL: "http://internal",
    } as Bindings,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
    } as never,
  );
  await Promise.all(pending);
  if (!routeResponse)
    throw new Error("Scheduled agent-billing route did not run");
  return routeResponse;
}

function dispatchHttpThroughFullApp(
  app: Hono,
  request: Request,
): Promise<Response> {
  return dispatchFullApp(
    request,
    { CRON_SECRET, NEXT_PUBLIC_APP_URL: "http://internal" } as Bindings,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as never,
    async () => app as never,
  );
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing route receipts] DATABASE_URL is not isolated PGlite; refusing to mutate it.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema(
      { agentBillingRuns, agentBillingRunItems } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    // error-policy:J1 isolated test-harness setup boundary; dependent tests
    // fail through the explicit readiness assertion with this diagnostic.
    pgliteReady = false;
    console.error(
      "[agent-billing route receipts] PGlite schema setup failed",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  selectedSandboxes = [firstSandbox];
  selectionFailure = null;
  billingFailureIds = new Set();
  listBillableSandboxes.mockClear();
  listBillingOrganizations.mockClear();
  recordHourlyBilling.mockClear();
  recordHourlyBilling.mockImplementation(defaultRecordHourlyBilling);
  getOrganizationCreditBalance.mockClear();
  getOrganizationCreditBalance.mockImplementation(async () => 100);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent billing durable run receipts on PGlite", () => {
  test("preserves the scheduler brand through the real full-app dispatch clone", async () => {
    selectedSandboxes = [];

    const response = await dispatchScheduledRequest(mountRoute());

    expect(response.status).toBe(200);
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      trigger_kind: "scheduled",
      schedule: SCHEDULE,
      scheduled_at: new Date(SCHEDULED_TIME),
      status: "empty",
    });
  });

  test("persists started before selection and terminally records an empty manual run", async () => {
    selectedSandboxes = [];
    const response = await mountRoute().fetch(
      new Request(`http://internal${PATH}`, {
        method: "POST",
        headers: { "x-cron-secret": CRON_SECRET },
      }),
      { CRON_SECRET } as Bindings,
    );

    expect(response.status).toBe(200);
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      trigger_kind: "manual",
      status: "empty",
      sandboxes_processed: 0,
      errors: 0,
      total_revenue: "0.000000",
    });
    expect(receipt?.completed_at).toBeInstanceOf(Date);
  });

  test("a duplicate scheduled delivery reconstructs one receipt and never rebills", async () => {
    selectedSandboxes = [firstSandbox, secondSandbox];
    const app = mountRoute();

    const first = await dispatchScheduledRequest(app);
    const second = await dispatchScheduledRequest(app);
    const firstBody = (await first.json()) as { runId: string };
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      success: true,
      runId: firstBody.runId,
      data: {
        status: "succeeded",
        totalRevenue: "0.300000",
        replayed: true,
      },
    });
    expect(recordHourlyBilling).toHaveBeenCalledTimes(2);
    const receipts = await dbWrite.select().from(agentBillingRuns);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      status: "succeeded",
      sandboxes_processed: 2,
      sandboxes_billed: 2,
      errors: 0,
      total_revenue: "0.300000",
    });
  });

  test("mixed sandbox outcomes persist bounded diagnostics and trip the real dispatcher", async () => {
    expect(CRON_FANOUT[SCHEDULE]).toContain(PATH);
    selectedSandboxes = [firstSandbox, secondSandbox];
    billingFailureIds.add(secondSandbox.id);
    const app = mountRoute();
    const statuses = new Map<string, number>();
    const scheduled = makeCronHandler(async (request, env, ctx) => {
      if (new URL(request.url).pathname !== PATH) {
        return new Response(null, { status: 204 });
      }
      const response = await app.fetch(request, env, ctx);
      statuses.set(PATH, response.status);
      return response;
    });
    const pending: Promise<unknown>[] = [];
    await scheduled(
      { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
      {
        CRON_SECRET,
        NEXT_PUBLIC_APP_URL: "http://internal",
      } as Bindings,
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        passThroughOnException: () => undefined,
      } as never,
    );
    await Promise.all(pending);

    expect(statuses.get(PATH)).toBe(500);
    expect(loggerWarn).toHaveBeenCalledWith(`[Cron] ${PATH} -> 500`);
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      status: "partial_failure",
      sandboxes_processed: 2,
      sandboxes_billed: 1,
      errors: 1,
      total_revenue: "0.100000",
      error_samples: [
        {
          code: "sandbox_processing_failed",
          message: "Sandbox billing processing failed",
          sandboxId: secondSandbox.id,
        },
      ],
    });
    expect(JSON.stringify(receipt)).not.toContain("sk_live_secret");
    expect(JSON.stringify(receipt)).not.toContain("raw provider response");
  });

  test("a selection exception leaves a durable failed receipt and returns non-2xx", async () => {
    selectionFailure = new Error("raw database statement with secret value");
    const response = await mountRoute().fetch(
      new Request(`http://internal${PATH}`, {
        method: "POST",
        headers: { "x-cron-secret": CRON_SECRET },
      }),
      { CRON_SECRET } as Bindings,
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain("raw database statement");
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      status: "failed",
      sandboxes_processed: 0,
      errors: 1,
      error_samples: [
        { code: "billing_run_failed", message: "Agent billing run failed" },
      ],
    });
  });

  test("caps persisted diagnostics at twenty for an all-failed sweep", async () => {
    selectedSandboxes = Array.from({ length: 125 }, (_, index) => ({
      ...firstSandbox,
      id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}`,
      agent_name: `Agent ${index}`,
    }));
    billingFailureIds = new Set(selectedSandboxes.map((sandbox) => sandbox.id));
    const response = await mountRoute().fetch(
      new Request(`http://internal${PATH}`, {
        method: "POST",
        headers: { "x-cron-secret": CRON_SECRET },
      }),
      { CRON_SECRET } as Bindings,
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      data: { resultsTruncated: boolean; results: unknown[] };
    };
    expect(body.data.resultsTruncated).toBe(true);
    expect(body.data.results).toHaveLength(100);
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      status: "failed",
      sandboxes_processed: 125,
      errors: 125,
    });
    expect(receipt?.error_samples).toHaveLength(20);
  });

  test("stores server-generated manual identities that cannot collide with scheduled runs", async () => {
    selectedSandboxes = [];
    const app = mountRoute();
    for (const method of ["GET", "POST"] as const) {
      const response = await app.fetch(
        new Request(`http://internal${PATH}`, {
          method,
          headers: { "x-cron-secret": CRON_SECRET },
        }),
        { CRON_SECRET } as Bindings,
      );
      expect(response.status).toBe(200);
    }

    const receipts = await dbWrite.select().from(agentBillingRuns);
    expect(receipts).toHaveLength(2);
    expect(
      new Set(receipts.map((receipt) => receipt.invocation_key)).size,
    ).toBe(2);
    expect(
      receipts.every(
        (receipt) =>
          receipt.trigger_kind === "manual" &&
          receipt.invocation_key.startsWith("manual:agent-billing:"),
      ),
    ).toBe(true);
    const scheduledIdentity = scheduledCronInvocationId(
      { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
      PATH,
    );
    expect(receipts.map((receipt) => receipt.invocation_key)).not.toContain(
      scheduledIdentity,
    );
  });

  test("rejects an exact but unbranded scheduled identity before creating a receipt", async () => {
    const response = await dispatchHttpThroughFullApp(
      mountRoute(),
      new Request(`http://internal${PATH}`, {
        method: "POST",
        headers: scheduledHeaders(),
      }),
    );

    expect(response.status).toBe(400);
    expect(
      await dbWrite
        .select()
        .from(agentBillingRuns)
        .where(eq(agentBillingRuns.trigger_kind, "scheduled")),
    ).toEqual([]);
    expect(listBillableSandboxes).not.toHaveBeenCalled();
  });

  test("recovers one stale scheduled receipt after a crashed attempt", async () => {
    const staleStartedAt = new Date(Date.now() - 10 * 60_000);
    const stale = await agentBillingRunRepository.startOrLoad({
      invocationKey: scheduledCronInvocationId(
        { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
        PATH,
      ),
      triggerKind: "scheduled",
      schedule: SCHEDULE,
      scheduledAt: new Date(SCHEDULED_TIME),
      leaseDurationMs: 5 * 60_000,
    });
    await dbWrite
      .update(agentBillingRuns)
      .set({
        started_at: staleStartedAt,
        billing_cutoff_at: staleStartedAt,
        lease_expires_at: new Date(staleStartedAt.getTime() + 60_000),
        updated_at: staleStartedAt,
      })
      .where(eq(agentBillingRuns.id, stale.run.id));
    selectedSandboxes = [firstSandbox];

    const response = await dispatchScheduledRequest(mountRoute());

    expect(response.status).toBe(200);
    const receipts = await dbWrite.select().from(agentBillingRuns);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: stale.run.id,
      attempt_count: 2,
      status: "succeeded",
      sandboxes_processed: 1,
      sandboxes_billed: 1,
      total_revenue: "0.100000",
    });
    expect(receipts[0]!.duration_ms).toBe(
      receipts[0]!.completed_at!.getTime() - receipts[0]!.started_at.getTime(),
    );
    expect(receipts[0]!.duration_ms).toBeGreaterThanOrEqual(10 * 60_000);
    expect(recordHourlyBilling).toHaveBeenCalledTimes(1);
  });

  test("reconstructs a crash-after-debit result from the durable run item", async () => {
    const billingCutoffAt = new Date(SCHEDULED_TIME);
    const crashed = await agentBillingRunRepository.startOrLoad({
      invocationKey: scheduledCronInvocationId(
        { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
        PATH,
      ),
      triggerKind: "scheduled",
      schedule: SCHEDULE,
      scheduledAt: new Date(SCHEDULED_TIME),
      leaseDurationMs: 5 * 60_000,
    });
    if (!crashed.leaseToken) throw new Error("Expected initial run lease");
    await agentBillingRunRepository.recordItem(
      { runId: crashed.run.id, leaseToken: crashed.leaseToken },
      {
        sandboxId: firstSandbox.id,
        organizationId: firstSandbox.organization_id,
        agentName: firstSandbox.agent_name,
        action: "billed",
        amountDecimal: "0.100000",
        newBalanceDecimal: "99.900000",
        transactionId: "transaction-committed-before-crash",
        completedAt: new Date(),
      },
    );
    const staleUpdatedAt = new Date(Date.now() - 2 * 60_000);
    await dbWrite
      .update(agentBillingRuns)
      .set({
        billing_cutoff_at: billingCutoffAt,
        lease_expires_at: new Date(staleUpdatedAt.getTime() + 60_000),
        updated_at: staleUpdatedAt,
      })
      .where(eq(agentBillingRuns.id, crashed.run.id));
    listBillableSandboxes.mockImplementationOnce(
      async (cutoff, rebillCutoff) => {
        expect(cutoff).toEqual(billingCutoffAt);
        expect(rebillCutoff).toEqual(
          new Date(billingCutoffAt.getTime() - 55 * 60_000),
        );
        return {
          runningSandboxes: [firstSandbox],
          stoppedWithBackups: [],
        };
      },
    );

    const response = await dispatchScheduledRequest(mountRoute());

    expect(response.status).toBe(200);
    expect(recordHourlyBilling).not.toHaveBeenCalled();
    const [receipt] = await dbWrite.select().from(agentBillingRuns);
    expect(receipt).toMatchObject({
      id: crashed.run.id,
      status: "succeeded",
      attempt_count: 2,
      billing_cutoff_at: billingCutoffAt,
      sandboxes_processed: 1,
      sandboxes_billed: 1,
      total_revenue: "0.100000",
    });
    expect(await dbWrite.select().from(agentBillingRunItems)).toHaveLength(1);
  });

  test("fences a lease-lost owner and recovers through the sandbox debit guard", async () => {
    let committedDebits = 0;
    recordHourlyBilling.mockImplementation(async () => {
      if (committedDebits > 0) {
        return { status: "already_billed_recently" as const };
      }
      committedDebits++;
      return {
        status: "billed" as const,
        amount: 0.1,
        amountDecimal: "0.100000",
        newBalance: 99.9,
        transactionId: "transaction-before-lease-loss",
      };
    });
    listBillableSandboxes.mockImplementationOnce(async () => {
      const [started] = await dbWrite.select().from(agentBillingRuns);
      expect(started?.status).toBe("started");
      const takeoverAt = new Date();
      await dbWrite
        .update(agentBillingRuns)
        .set({
          lease_token: crypto.randomUUID(),
          lease_expires_at: new Date(takeoverAt.getTime() + 5 * 60_000),
          updated_at: takeoverAt,
        })
        .where(eq(agentBillingRuns.id, started!.id));
      return { runningSandboxes: [firstSandbox], stoppedWithBackups: [] };
    });

    const app = mountRoute();
    const response = await dispatchScheduledRequest(app);

    expect(response.status).toBe(500);
    const [leaseLostReceipt] = await dbWrite.select().from(agentBillingRuns);
    expect(leaseLostReceipt).toMatchObject({
      status: "started",
      attempt_count: 1,
      sandboxes_processed: 0,
      sandboxes_billed: 0,
    });
    const staleUpdatedAt = new Date(Date.now() - 2 * 60_000);
    await dbWrite
      .update(agentBillingRuns)
      .set({
        lease_expires_at: new Date(staleUpdatedAt.getTime() + 60_000),
        updated_at: staleUpdatedAt,
      })
      .where(eq(agentBillingRuns.id, leaseLostReceipt!.id));

    const recovered = await dispatchScheduledRequest(app);

    expect(recovered.status).toBe(200);
    const receipts = await dbWrite.select().from(agentBillingRuns);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: leaseLostReceipt?.id,
      status: "succeeded",
      attempt_count: 2,
      sandboxes_processed: 1,
      sandboxes_billed: 0,
      total_revenue: "0.000000",
    });
    expect(recordHourlyBilling).toHaveBeenCalledTimes(2);
    expect(committedDebits).toBe(1);
  });

  test("admits only one concurrent HTTP delivery for one scheduled identity", async () => {
    let releaseSelection: () => void = () => {
      throw new Error("Selection barrier was not initialized");
    };
    let announceSelection: () => void = () => {
      throw new Error("Selection announcement was not initialized");
    };
    const selectionEntered = new Promise<void>((resolve) => {
      announceSelection = resolve;
    });
    const selectionBarrier = new Promise<void>((resolve) => {
      releaseSelection = resolve;
    });
    listBillableSandboxes.mockImplementationOnce(async () => {
      announceSelection();
      await selectionBarrier;
      return { runningSandboxes: [firstSandbox], stoppedWithBackups: [] };
    });
    const app = mountRoute();

    const firstDelivery = dispatchScheduledRequest(app);
    await selectionEntered;
    const second = await dispatchScheduledRequest(app);
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as {
      runId: string;
      data: { status: string };
    };
    expect(secondBody.data.status).toBe("started");
    releaseSelection();
    const first = await firstDelivery;

    expect(first.status).toBe(200);
    expect(listBillableSandboxes).toHaveBeenCalledTimes(1);
    expect(recordHourlyBilling).toHaveBeenCalledTimes(1);
    const receipts = await dbWrite.select().from(agentBillingRuns);
    expect(receipts).toHaveLength(1);
    expect(secondBody.runId).toBe(receipts[0]?.id);
    expect(receipts[0]).toMatchObject({
      status: "succeeded",
      attempt_count: 1,
      sandboxes_processed: 1,
      sandboxes_billed: 1,
    });
  });
});
