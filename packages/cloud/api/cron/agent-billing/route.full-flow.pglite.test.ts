/**
 * End-to-end database proof for the scheduled agent-billing path. This suite
 * deliberately uses the real billing and run repositories; run it in its own
 * Bun process so module mocks from the receipt-focused route suite cannot leak.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.TEST_DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { closeDatabaseConnectionsForTests, dbWrite } from "@/db/client";
import { agentBillingRunRepository } from "@/db/repositories/agent-billing-runs";
import { agentComputeStopIntents } from "@/db/schemas/agent-compute-stop-intents";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { apiKeys } from "@/db/schemas/api-keys";
import {
  agentBillingRecords,
  agentBillingRunItems,
  agentBillingRuns,
} from "@/db/schemas/compute-billing";
import { computeBillingRateSegments } from "@/db/schemas/compute-billing-rate-segments";
import { creditTransactions } from "@/db/schemas/credit-transactions";
import { generations } from "@/db/schemas/generations";
import { jobs } from "@/db/schemas/jobs";
import { organizations } from "@/db/schemas/organizations";
import { usageRecords } from "@/db/schemas/usage-records";
import { userCharacters } from "@/db/schemas/user-characters";
import { users } from "@/db/schemas/users";
import {
  makeCronHandler,
  scheduledCronInvocationId,
} from "@/lib/cron/cloudflare-cron";
import { enqueueAgentUnfundedStopForRun } from "@/lib/services/agent-unfunded-stop";
import { emailService } from "@/lib/services/email";
import { provisioningJobService } from "@/lib/services/provisioning-jobs";
import type { Bindings } from "@/types/cloud-worker-env";
import { dispatchFullApp } from "../../src/index";
import route from "./route";

const PATH = "/api/cron/agent-billing";
const SCHEDULE = "0 * * * *";
const SCHEDULED_TIME = Date.UTC(2026, 7, 20, 19, 0, 0);
const CRON_SECRET = "full-flow-cron-secret";
const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

function mountRoute(): Hono {
  const app = new Hono();
  app.route(PATH, route);
  return app;
}

async function dispatchScheduledBilling(app: Hono): Promise<Response> {
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

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[agent-billing full-flow] DATABASE_URL is not isolated PGlite; refusing to mutate it.",
    );
    return;
  }
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        apiKeys,
        usageRecords,
        generations,
        userCharacters,
        agentSandboxes,
        jobs,
        agentComputeStopIntents,
        creditTransactions,
        agentBillingRecords,
        agentBillingRuns,
        agentBillingRunItems,
        computeBillingRateSegments,
      } as never,
      dbWrite as never,
    );
    await apply();
    await dbWrite.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS jobs (
        id uuid PRIMARY KEY,
        type text NOT NULL,
        status text NOT NULL,
        organization_id uuid NOT NULL,
        agent_id text,
        user_id uuid,
        data_storage text NOT NULL DEFAULT 'inline',
        data_key text,
        data jsonb NOT NULL DEFAULT '{}'::jsonb
      )
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TABLE IF NOT EXISTS agent_compute_stop_intents (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        agent_id uuid NOT NULL,
        lifecycle_revision bigint NOT NULL,
        "authorization" text NOT NULL DEFAULT 'billing_request',
        status text NOT NULL DEFAULT 'pending',
        job_id uuid,
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        provider_started_at timestamptz,
        provider_confirmed_at timestamptz,
        retained_backup_billing boolean NOT NULL DEFAULT false,
        retained_backup_rate_per_hour numeric(18, 6),
        superseded_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `),
    );
  } catch (error) {
    // error-policy:J1 isolated test-harness setup boundary; dependent tests
    // fail through the explicit readiness assertion with this diagnostic.
    pgliteReady = false;
    console.error(
      "[agent-billing full-flow] PGlite schema setup failed",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  await dbWrite.delete(computeBillingRateSegments);
  await dbWrite.delete(agentComputeStopIntents);
  await dbWrite.delete(jobs);
  await dbWrite.delete(agentBillingRunItems);
  await dbWrite.delete(agentBillingRuns);
  await dbWrite.delete(agentBillingRecords);
  await dbWrite.delete(creditTransactions);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent billing scheduled full flow on PGlite", () => {
  test("replays one scheduler identity without a second debit or receipt", async () => {
    const [organization] = await dbWrite
      .insert(organizations)
      .values({
        name: "Full Flow Billing",
        slug: `full-flow-${crypto.randomUUID()}`,
        credit_balance: "10.000000",
        billing_email: "billing@example.test",
        pay_as_you_go_from_earnings: false,
      })
      .returning();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: `steward-${crypto.randomUUID()}`,
        organization_id: organization.id,
      })
      .returning();
    const [sandbox] = await dbWrite
      .insert(agentSandboxes)
      .values({
        organization_id: organization.id,
        user_id: user.id,
        agent_name: "full-flow-agent",
        status: "running",
        execution_tier: "dedicated-always",
        billing_status: "active",
        last_billed_at: sql`clock_timestamp() - INTERVAL '1 hour'`,
      })
      .returning();
    await dbWrite.insert(computeBillingRateSegments).values({
      organization_id: organization.id,
      workload_kind: "agent",
      workload_id: sandbox.id,
      lifecycle_revision: sandbox.lifecycle_revision,
      billing_state: "running",
      rate_per_hour: "0.010000",
      effective_at: sandbox.last_billed_at!,
    });

    const app = mountRoute();
    const first = await dispatchScheduledBilling(app);
    const replay = await dispatchScheduledBilling(app);
    const firstBody = (await first.json()) as {
      data: { replayed: boolean; totalRevenue: string; results?: unknown[] };
    };
    const replayBody = (await replay.json()) as {
      data: { replayed: boolean; totalRevenue: string; results?: unknown[] };
    };

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(firstBody.data).toMatchObject({
      replayed: false,
      totalRevenue: "0.010000",
    });
    expect(firstBody.data.results).toHaveLength(1);
    expect(replayBody.data).toMatchObject({
      replayed: true,
      totalRevenue: "0.010000",
    });
    expect(replayBody.data.results).toBeUndefined();

    const [balance] = await dbWrite
      .select({ creditBalance: organizations.credit_balance })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    const transactions = await dbWrite.select().from(creditTransactions);
    const billingReceipts = await dbWrite.select().from(agentBillingRecords);
    const runItems = await dbWrite.select().from(agentBillingRunItems);
    const runs = await dbWrite.select().from(agentBillingRuns);

    expect(balance?.creditBalance).toBe("9.990000");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      organization_id: organization.id,
      amount: "-0.010000",
      type: "debit",
    });
    expect(billingReceipts).toHaveLength(1);
    expect(runItems).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runItems[0]).toMatchObject({
      run_id: runs[0]!.id,
      sandbox_id: sandbox.id,
      action: "billed",
      amount: "0.010000",
      transaction_id: transactions[0]!.id,
    });
    expect(billingReceipts[0]).toMatchObject({
      organization_id: organization.id,
      sandbox_id: sandbox.id,
      amount: "0.010000",
      credit_transaction_id: transactions[0]!.id,
    });
    expect(runs[0]).toMatchObject({
      invocation_key: scheduledCronInvocationId(
        { cron: SCHEDULE, scheduledTime: SCHEDULED_TIME },
        PATH,
      ),
      status: "succeeded",
      sandboxes_processed: 1,
      sandboxes_billed: 1,
      total_revenue: "0.010000",
      attempt_count: 1,
    });
    expect(runs[0]!.duration_ms).toBe(
      runs[0]!.completed_at!.getTime() - runs[0]!.started_at.getTime(),
    );
  });
});

async function seedUnfundedAgent() {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({
      name: "Paid Dedicated",
      slug: `paid-dedicated-${crypto.randomUUID()}`,
      credit_balance: "0.000000",
      billing_email: "billing@example.test",
      pay_as_you_go_from_earnings: false,
    })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({
      steward_user_id: `steward-${crypto.randomUUID()}`,
      organization_id: organization.id,
    })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: organization.id,
      user_id: user.id,
      agent_name: "unfunded-agent",
      status: "running",
      execution_tier: "dedicated-always",
      billing_status: "active",
      last_billed_at: sql`clock_timestamp() - INTERVAL '2 hours'`,
      created_at: sql`clock_timestamp() - INTERVAL '2 hours'`,
    })
    .returning();
  await dbWrite.insert(computeBillingRateSegments).values({
    organization_id: organization.id,
    workload_kind: "agent",
    workload_id: sandbox.id,
    lifecycle_revision: sandbox.lifecycle_revision,
    billing_state: "running",
    rate_per_hour: "0.010000",
    effective_at: sandbox.created_at,
  });
  const claim = await agentBillingRunRepository.startOrLoad({
    invocationKey: `paid-stop-${crypto.randomUUID()}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 300_000,
  });
  if (!claim.leaseToken) throw new Error("Missing test billing lease");
  return {
    organization,
    sandbox,
    input: {
      runId: claim.run.id,
      leaseToken: claim.leaseToken,
      sandboxId: sandbox.id,
      organizationId: organization.id,
      agentName: sandbox.agent_name!,
      now: claim.run.billing_cutoff_at,
    },
  };
}

describe("paid Dedicated stop admission", () => {
  test("zero funds queue one immediate stop and replay without a negative balance", async () => {
    const { organization, sandbox, input } = await seedUnfundedAgent();
    const first = await enqueueAgentUnfundedStopForRun(input);
    expect(first.action).toBe("shutdown");
    expect((await enqueueAgentUnfundedStopForRun(input)).id).toBe(first.id);
    const [updated] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(updated.billing_status).toBe("shutdown_pending");
    expect(updated.scheduled_shutdown_at?.getTime()).toBe(input.now.getTime());
    expect(updated.shutdown_warning_sent_at).toBeNull();
    const intents = await dbWrite.select().from(agentComputeStopIntents);
    const queued = await dbWrite.select().from(jobs);
    expect(intents).toHaveLength(1);
    expect(queued).toHaveLength(1);
    expect(intents[0].authorization).toBe("billing_request");
    expect(intents[0].job_id).toBe(queued[0].id);
    expect(queued[0].type).toBe("agent_suspend");
    const [balance] = await dbWrite
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(Number(balance.credit_balance)).toBe(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(0);
  });

  test("a top-up before the locked recheck settles instead of stopping", async () => {
    const { organization, input } = await seedUnfundedAgent();
    await dbWrite
      .update(organizations)
      .set({ credit_balance: "1.000000" })
      .where(eq(organizations.id, organization.id));
    const result = await enqueueAgentUnfundedStopForRun(input);
    expect(result.action).toBe("billed");
    expect(Number(result.amount)).toBeGreaterThan(0);
    expect(Number(result.new_balance)).toBeGreaterThan(0);
    expect(await dbWrite.select().from(agentComputeStopIntents)).toHaveLength(
      0,
    );
    expect(await dbWrite.select().from(jobs)).toHaveLength(0);
    expect(await dbWrite.select().from(creditTransactions)).toHaveLength(1);
  });

  test("a queue failure rolls back pending state and receipt", async () => {
    const { sandbox, input } = await seedUnfundedAgent();
    const failure = spyOn(
      provisioningJobService,
      "enqueueAgentSuspendOnceInTransaction",
    ).mockRejectedValueOnce(new Error("queue unavailable"));
    try {
      await expect(enqueueAgentUnfundedStopForRun(input)).rejects.toThrow(
        "queue unavailable",
      );
    } finally {
      failure.mockRestore();
    }
    const [updated] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(updated.billing_status).toBe("active");
    expect(updated.scheduled_shutdown_at).toBeNull();
    expect(await dbWrite.select().from(agentBillingRunItems)).toHaveLength(0);
    expect(await dbWrite.select().from(agentComputeStopIntents)).toHaveLength(
      0,
    );
    expect((await enqueueAgentUnfundedStopForRun(input)).action).toBe(
      "shutdown",
    );
  });

  test("the real cron ignores old unpaid grace and does not depend on warning email", async () => {
    const { sandbox } = await seedUnfundedAgent();
    await dbWrite
      .update(agentSandboxes)
      .set({
        billing_status: "shutdown_pending",
        shutdown_warning_sent_at: new Date(),
        scheduled_shutdown_at: new Date(Date.now() + 48 * 60 * 60_000),
      })
      .where(eq(agentSandboxes.id, sandbox.id));
    const email = spyOn(
      emailService,
      "sendContainerShutdownWarningEmail",
    ).mockRejectedValue(new Error("email unavailable"));
    try {
      const response = await mountRoute().request(
        PATH,
        { method: "POST", headers: { Authorization: `Bearer ${CRON_SECRET}` } },
        { CRON_SECRET },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        data: { sandboxesShutdown: 1, warningsSent: 0 },
      });
      expect(email).not.toHaveBeenCalled();
      expect(await dbWrite.select().from(agentComputeStopIntents)).toHaveLength(
        1,
      );
    } finally {
      email.mockRestore();
    }
  });
});
