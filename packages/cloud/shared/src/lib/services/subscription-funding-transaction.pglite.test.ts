/** Verifies funding admission, renewal and stop refunds on PGlite or empty loopback PostgreSQL. An explicit SSH fixture adds real Docker rollback/retry proof on a host without an existing compute guard. */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createBillingSnapshotFixture } from "../../db/repositories/account-billing-snapshot-test-fixture";

const postgresTestUrl = process.env.COMPUTE_FUNDING_POSTGRES_TEST_URL;
const sshFixturePath = process.env.COMPUTE_FUNDING_SSH_FIXTURE;
if (sshFixturePath && !postgresTestUrl) {
  throw new Error("The real SSH suspend test requires isolated PostgreSQL");
}

if (postgresTestUrl) {
  const target = new URL(postgresTestUrl);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
    !/^\/dedicated_compute_test_[a-z0-9]+$/.test(target.pathname)
  ) {
    throw new Error("Funding tests require an isolated loopback dedicated_compute_test_ database");
  }
}
process.env.DATABASE_URL = postgresTestUrl ?? "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
process.env.ENVIRONMENT = "local";

const organizationId = "61000000-0000-4000-8000-000000000002";
const allowanceOrganizationId = "61000000-0000-4000-8000-000000000001";
const subscriptionId = "62000000-0000-4000-8000-000000000001";
let client: typeof import("../../db/client");
let helpers: typeof import("../../db/helpers");
let funding: typeof import("./subscription-funding");
let postgresPool: import("pg").Pool | undefined;
let fixture: {
  exec(query: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    parameters?: unknown[],
  ): Promise<{ rows: T[] }>;
};

beforeAll(async () => {
  client = await import("../../db/client");
  helpers = await import("../../db/helpers");
  funding = await import("./subscription-funding");
  if (postgresTestUrl) {
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: postgresTestUrl, max: 4 });
    postgresPool = pool;
    fixture = {
      async exec(query) {
        await pool.query(query);
      },
      async query<T extends Record<string, unknown>>(query: string, parameters?: unknown[]) {
        return pool.query<T>(query, parameters);
      },
    };
    const tables = await fixture.query(
      "SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'",
    );
    if (tables.rows[0]?.count !== 0)
      throw new Error("PostgreSQL funding test database must be empty");
  } else {
    const pglite = client.getPgliteClientForTests();
    fixture = {
      async exec(query) {
        await pglite.exec(query);
      },
      async query<T extends Record<string, unknown>>(query: string, parameters?: unknown[]) {
        return pglite.query<T>(query, parameters);
      },
    };
  }
  await createBillingSnapshotFixture((query) => fixture.exec(query), "");
  await fixture.exec(`
    ALTER TABLE credit_transactions ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE credit_transactions ADD COLUMN user_id uuid;
    ALTER TABLE credit_transactions ADD COLUMN description text;
    ALTER TABLE credit_transactions ADD COLUMN stripe_payment_intent_id text UNIQUE;
    ALTER TABLE credit_transactions ADD COLUMN created_at timestamp DEFAULT now();
    ALTER TABLE credit_transactions ADD COLUMN settled_at timestamp;
    INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision,
      settings, is_active, auto_top_up_enabled, account_lifecycle_state)
    VALUES ('${organizationId}', '10.000001', 1, 0, '{}', true, false, 'active');
  `);
  await fixture.exec(`
    ALTER TABLE agent_sandboxes ADD CONSTRAINT agent_sandboxes_id_organization_unique UNIQUE(id, organization_id);
    ALTER TABLE agent_sandboxes ADD COLUMN IF NOT EXISTS node_id text;
    INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
    VALUES ('63000000-0000-4000-8000-000000000001','${organizationId}','provisioning','dedicated-always',1);
  `);
  const computeMigration = await readFile(
    new URL("../../db/migrations/0387_agent_compute_funding.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(computeMigration);
  // The generated migration must also be safe when recovery repeats it.
  await fixture.exec(computeMigration);
  const stopMigration = await readFile(
    new URL("../../db/migrations/0389_agent_compute_stop_receipts.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(stopMigration);
  await fixture.exec(stopMigration);
  const readinessMigration = await readFile(
    new URL("../../db/migrations/0390_agent_compute_runtime_readiness.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(readinessMigration);
  await fixture.exec(readinessMigration);
  const subjectMigration = await readFile(
    new URL("../../db/migrations/0391_agent_compute_subjects.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(subjectMigration);
  await fixture.exec(subjectMigration);
  const retirementMigration = await readFile(
    new URL("../../db/migrations/0392_agent_compute_retirement_backup.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(retirementMigration);
  await fixture.exec(retirementMigration);
  const minimumMigration = await readFile(
    new URL("../../db/migrations/0393_agent_compute_activation_minimum.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(minimumMigration);
  await fixture.exec(minimumMigration);
  const legacyBillingMigration = await readFile(
    new URL("../../db/migrations/0265_compute_billing_recovery.sql", import.meta.url),
    "utf8",
  );
  const legacyReceiptTable = legacyBillingMigration.match(
    /CREATE TABLE agent_billing_records \([\s\S]*?\n\);/,
  );
  if (!legacyReceiptTable) throw new Error("Missing canonical legacy billing receipt DDL");
  await fixture.exec(legacyReceiptTable[0]);
  const receiptMigration = await readFile(
    new URL("../../db/migrations/0388_agent_compute_funded_receipts.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(receiptMigration);
  const minimumReceiptMigration = await readFile(
    new URL("../../db/migrations/0394_agent_billing_activation_minimum.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(minimumReceiptMigration);
  await fixture.exec(minimumReceiptMigration);
  await fixture.exec(receiptMigration);
  await fixture.exec(
    await readFile(
      new URL("../../db/migrations/0274_agent_billing_run_receipts.sql", import.meta.url),
      "utf8",
    ),
  );
  const baseline = await readFile(
    new URL("../../db/migrations/0000_last_reavers.sql", import.meta.url),
    "utf8",
  );
  const jobsDDL = baseline.match(/CREATE TABLE "jobs" \([\s\S]*?\n\);/);
  if (!jobsDDL) throw new Error("Missing canonical jobs DDL");
  await fixture.exec(jobsDDL[0]);
  const { jobs } = await import("../../db/schemas/jobs");
  for (const column of getTableConfig(jobs).columns) {
    await fixture.exec(
      `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS "${column.name}" ${column.getSQLType()}`,
    );
  }
  await fixture.exec(
    await readFile(
      new URL("../../db/migrations/0184_job_execution_leases.sql", import.meta.url),
      "utf8",
    ),
  );
  const { subscriptionAuthorityRepository: authority } = await import(
    "../../db/repositories/subscription-authority"
  );
  const { subscriptionEntitlementsRepository: entitlements } = await import(
    "../../db/repositories/subscription-entitlements"
  );
  const current = await authority.findById(allowanceOrganizationId, subscriptionId);
  if (!current) throw new Error("Missing paid subscription fixture");
  const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
  const periodStart = new Date(Date.now() - 86400000);
  const periodEnd = new Date(Date.now() + 86400000);
  const advanced = await authority.advance({
    organizationId: allowanceOrganizationId,
    subscriptionId,
    expectedRevision: lifecycle_revision,
    source: "webhook",
    observation: "authoritative_provider_retrieval",
    values: {
      ...values,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      provider_object_digest: "c".repeat(64),
    },
  });
  await entitlements.rebuild({
    organizationId: allowanceOrganizationId,
    sourceSubscriptionId: subscriptionId,
    sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
    expectedProjectionRevision: 1,
  });
  await fixture.query(
    `UPDATE subscription_allowance_periods SET subscription_revision=$1,
      period_start=$2,period_end=$3,expires_at=$3 WHERE organization_id=$4`,
    [advanced.subscription.lifecycle_revision, periodStart, periodEnd, allowanceOrganizationId],
  );
}, 120000);

afterAll(async () => {
  await client.closeDatabaseConnectionsForTests();
  await postgresPool?.end();
});

function input(logicalOperationId: string, amount: string) {
  return {
    organizationId,
    logicalOperationId,
    operation: "managed_agent_compute" as const,
    amount,
    description: "Dedicated admission transaction test",
    reservationTtlMs: 3600000,
  };
}

async function state() {
  return (
    await fixture.query<{
      balance: string;
      reservations: number;
      debits: number;
    }>(`SELECT credit_balance::text AS balance,
      (SELECT count(*)::integer FROM billing_funding_reservations) AS reservations,
      (SELECT count(*)::integer FROM credit_transactions) AS debits
      FROM organizations WHERE id='${organizationId}'`)
  ).rows[0];
}

test("a rejected admission rolls back its real credit debit and funding reservation", async () => {
  const before = await state();
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.reserveInTransaction(
        tx,
        input("compute:rejected-admission", "1.000000"),
      );
      expect(result.purchasedCreditDebited).toBe(true);
      const rows = await tx.execute(
        sql`SELECT count(*)::integer AS count FROM billing_funding_reservations`,
      );
      expect(rows.rows[0]?.count).toBe(1);
      throw new Error("Work admission rejected");
    }),
  ).rejects.toThrow("Work admission rejected");
  expect(await state()).toEqual(before);
});

test("concurrent compute admissions reserve once, reject overspending, and replay without another debit", async () => {
  const requests = [
    input("compute:concurrent-first", "6.000000"),
    input("compute:concurrent-second", "6.000000"),
  ];
  const attempts = await Promise.allSettled(
    requests.map((request) =>
      helpers.writeTransaction((tx) =>
        funding.subscriptionFundingService.reserveInTransaction(tx, request),
      ),
    ),
  );
  const winnerIndex = attempts.findIndex((attempt) => attempt.status === "fulfilled");
  expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
  const rejected = attempts.find((attempt) => attempt.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
    code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT,
  });
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
  const replay = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.reserveInTransaction(tx, requests[winnerIndex]!),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.purchasedCreditDebited).toBe(false);
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
  await expect(
    helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.reserveInTransaction(tx, {
        ...requests[winnerIndex]!,
        amount: "2.000000",
      }),
    ),
  ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_REPLAY_CONFLICT });
  expect(await state()).toEqual({ balance: "4.000001", reservations: 1, debits: 1 });
});

test("a rejected mixed-source admission returns both paid allowance and purchased credit atomically", async () => {
  const readPaidState = async () =>
    (
      await fixture.query(
        `SELECT o.credit_balance::text, p.available_amount::text, p.reserved_amount::text,
          (SELECT count(*)::integer FROM billing_funding_reservations WHERE organization_id=$1) AS reservations,
          (SELECT count(*)::integer FROM credit_transactions WHERE organization_id=$1) AS debits
          FROM organizations o JOIN subscription_allowance_periods p ON p.organization_id=o.id
          WHERE o.id=$1`,
        [allowanceOrganizationId],
      )
    ).rows;
  const before = await readPaidState();
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.reserveInTransaction(tx, {
        ...input("compute:mixed-rejected", "30.000000"),
        organizationId: allowanceOrganizationId,
      });
      expect(result.reservation.reserved_amount).toBe("30.000000");
      expect(result.purchasedCreditDebited).toBe(true);
      const allocated = await tx.execute(sql`
        SELECT source, reserved_amount::text FROM billing_funding_allocations
        WHERE reservation_id=${result.reservation.id} ORDER BY source`);
      expect(allocated.rows).toEqual([
        { source: "allowance", reserved_amount: "25.000001" },
        { source: "purchased_credit", reserved_amount: "4.999999" },
      ]);
      throw new Error("Paid work admission rejected");
    }),
  ).rejects.toThrow("Paid work admission rejected");
  expect(await readPaidState()).toEqual(before);
});

test("work-completion failure rolls back the settlement and refund; exact replay never credits twice", async () => {
  const { SUBSCRIPTION_FUNDING_CONFLICT } = await import(
    "../../db/repositories/subscription-funding-reservations"
  );
  const request = input("compute:completion-atomicity", "2.000000");
  await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.reserveInTransaction(tx, request),
  );
  const before = await state();
  const settlement = {
    organizationId,
    logicalOperationId: request.logicalOperationId,
    operation: request.operation,
    actualAmount: "0.750000",
    occurredAt: new Date(),
  };
  await expect(
    helpers.writeTransaction(async (tx) => {
      const result = await funding.subscriptionFundingService.settleInTransaction(tx, settlement);
      expect(result.collectedAmount).toBe("0.750000");
      expect(result.purchasedCreditRefunded).toBe(true);
      throw new Error("Compute receipt rejected");
    }),
  ).rejects.toThrow("Compute receipt rejected");
  expect(await state()).toEqual(before);
  const result = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.settleInTransaction(tx, settlement),
  );
  expect(result.reservation.status).toBe("finalized");
  expect(result.purchasedCreditRefunded).toBe(true);
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
  const replay = await helpers.writeTransaction((tx) =>
    funding.subscriptionFundingService.settleInTransaction(tx, settlement),
  );
  expect(replay.replayed).toBe(true);
  expect(replay.purchasedCreditRefunded).toBe(false);
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
  await expect(
    helpers.writeTransaction((tx) =>
      funding.subscriptionFundingService.settleInTransaction(tx, {
        ...settlement,
        actualAmount: "0.250000",
      }),
    ),
  ).rejects.toMatchObject({ code: SUBSCRIPTION_FUNDING_CONFLICT });
  expect(await state()).toEqual({ balance: "3.250001", reservations: 2, debits: 3 });
});

test("Dedicated funding rolls back with rejected lifecycle admission and binds retries to one container", async () => {
  const { agentComputeFundingService: compute, AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED } =
    await import("./agent-compute-funding");
  const identity = {
    agentId: "63000000-0000-4000-8000-000000000001",
    organizationId,
    lifecycleRevision: 1,
  };
  const before = await state();
  await expect(
    helpers.writeTransaction(async (tx) => {
      await compute.reserveInTransaction(tx, identity);
      throw new Error("Lifecycle admission rejected");
    }),
  ).rejects.toThrow("Lifecycle admission rejected");
  expect(await state()).toEqual(before);
  expect((await fixture.query("SELECT * FROM agent_compute_funding")).rows).toHaveLength(0);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, { ...identity, lifecycleRevision: 2 }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, { ...identity, organizationId: allowanceOrganizationId }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(before);
  const [first, retry] = await Promise.all([
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ]);
  expect(first.window.id).toBe(retry.window.id);
  expect(first.window.hourly_rate).toBe("0.150000");
  expect([first.replayed, retry.replayed].sort()).toEqual([false, true]);
  const fundedState = await state();
  expect(fundedState).toEqual({ balance: "2.950001", reservations: 3, debits: 4 });
  const provider = {
    ...identity,
    fundingId: first.window.id,
    nodeId: "dedicated-test-node",
    containerId: "a".repeat(64),
  };
  const bound = await helpers.writeTransaction((tx) =>
    compute.bindProviderInTransaction(tx, provider),
  );
  expect(bound.provider_container_id).toBe(provider.containerId);
  expect(
    await helpers.writeTransaction((tx) => compute.bindProviderInTransaction(tx, provider)),
  ).toEqual(bound);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.bindProviderInTransaction(tx, { ...provider, containerId: "b".repeat(64) }),
    ),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(fundedState);
  await expect(
    fixture.query("UPDATE agent_compute_funding SET settled_at=now() WHERE id=$1", [bound.id]),
  ).rejects.toThrow("agent_compute_funding_settlement_check");
  await fixture.query("UPDATE organizations SET paid_work_fenced_at=now() WHERE id=$1", [
    organizationId,
  ]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  expect(await state()).toEqual(fundedState);
  await fixture.query("UPDATE organizations SET paid_work_fenced_at=NULL WHERE id=$1", [
    organizationId,
  ]);
});

test("unfunded, Shared and expired Dedicated admissions cannot create another debit", async () => {
  const {
    agentComputeFundingService: compute,
    AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED,
    AGENT_COMPUTE_FUNDING_EXPIRED,
  } = await import("./agent-compute-funding");
  const identity = {
    agentId: "63000000-0000-4000-8000-000000000001",
    organizationId,
    lifecycleRevision: 1,
  };
  const unfundedOrg = "61000000-0000-4000-8000-000000000003";
  const unfundedAgent = "63000000-0000-4000-8000-000000000002";
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES ($1,'0.000000',1,0,'{}',true,false,'active')`,
    [unfundedOrg],
  );
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
    VALUES ($1,$2,'provisioning','dedicated-always',1)`,
    [unfundedAgent, unfundedOrg],
  );
  const before = await state();
  await expect(
    helpers.writeTransaction((tx) =>
      compute.reserveInTransaction(tx, {
        agentId: unfundedAgent,
        organizationId: unfundedOrg,
        lifecycleRevision: 1,
      }),
    ),
  ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT });
  expect(await state()).toEqual(before);
  await fixture.query("UPDATE agent_sandboxes SET execution_tier='shared' WHERE id=$1", [
    identity.agentId,
  ]);
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED });
  await fixture.query("UPDATE agent_sandboxes SET execution_tier='dedicated-always' WHERE id=$1", [
    identity.agentId,
  ]);
  await expect(
    fixture.query("UPDATE agent_compute_funding SET hourly_rate='NaN' WHERE agent_id=$1", [
      identity.agentId,
    ]),
  ).rejects.toThrow("agent_compute_funding_period_check");
  await fixture.query(
    "UPDATE agent_compute_funding SET period_start=now()-interval '2 hours',period_end=now()-interval '1 hour' WHERE agent_id=$1",
    [identity.agentId],
  );
  await expect(
    helpers.writeTransaction((tx) => compute.reserveInTransaction(tx, identity)),
  ).rejects.toMatchObject({ code: AGENT_COMPUTE_FUNDING_EXPIRED });
  expect(await state()).toEqual(before);
});

async function runningFundedAgent(
  org: string,
  agentId: string,
  providerTarget?: { nodeId: string; containerId: string },
) {
  const { agentComputeFundingService: compute } = await import("./agent-compute-funding");
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision)
      VALUES ($1,$2,'provisioning','dedicated-always',1)`,
    [agentId, org],
  );
  const identity = { agentId, organizationId: org, lifecycleRevision: 1 };
  const reserved = await helpers.writeTransaction((tx) =>
    compute.reserveInTransaction(tx, identity),
  );
  const provider = {
    ...identity,
    fundingId: reserved.window.id,
    nodeId: providerTarget?.nodeId ?? "renewal-test-node",
    containerId: providerTarget?.containerId ?? "c".repeat(64),
  };
  await helpers.writeTransaction((tx) => compute.bindProviderInTransaction(tx, provider));
  const authorization = await helpers.writeTransaction((tx) =>
    compute.authorizeHostInTransaction(tx, provider),
  );
  expect(authorization.previousFundingId).toBeNull();
  expect(authorization.containerId).toBe(provider.containerId);
  expect(authorization.paidUntilMs - authorization.paidFromMs).toBe(2 * 60 * 60_000);
  await helpers.writeTransaction((tx) => compute.confirmHostLeaseInTransaction(tx, provider));
  await fixture.query("UPDATE agent_sandboxes SET status='running',node_id=$2 WHERE id=$1", [
    agentId,
    provider.nodeId,
  ]);
  // Advance this fixture's paid interval while retaining a full two-hour hold.
  // The meter supplies one hour of actual usage; no fake provider or credit service is substituted.
  await fixture.query(
    "UPDATE agent_compute_funding SET runtime_ready_at=clock_timestamp(),period_start=clock_timestamp()-interval '1 hour',period_end=clock_timestamp()+interval '1 hour' WHERE id=$1",
    [reserved.window.id],
  );
  return { compute, identity, provider, reserved };
}

async function renewalState(org: string) {
  const [balance, windows, reservations, allocations, ledger] = await Promise.all([
    fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]),
    fixture.query("SELECT * FROM agent_compute_funding WHERE organization_id=$1 ORDER BY id", [
      org,
    ]),
    fixture.query(
      "SELECT * FROM billing_funding_reservations WHERE organization_id=$1 ORDER BY id",
      [org],
    ),
    fixture.query(
      "SELECT * FROM billing_funding_allocations WHERE organization_id=$1 ORDER BY id",
      [org],
    ),
    fixture.query("SELECT * FROM credit_transactions WHERE organization_id=$1 ORDER BY id", [org]),
  ]);
  return {
    balance: balance.rows,
    windows: windows.rows,
    reservations: reservations.rows,
    allocations: allocations.rows,
    ledger: ledger.rows,
  };
}

test("concurrent renewals exchange one hold, preserve source accounting, and require a host acknowledgement", async () => {
  const org = "61000000-0000-4000-8000-000000000004";
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
      VALUES ($1,'1.000000',1,0,'{}',true,false,'active')`,
    [org],
  );
  const { compute, identity, provider, reserved } = await runningFundedAgent(
    org,
    "63000000-0000-4000-8000-000000000004",
  );
  const request = {
    ...identity,
    fundingId: reserved.window.id,
    settledThrough: new Date(),
    actualAmount: "0.150000",
  };
  const [first, replay] = await Promise.all([
    helpers.writeTransaction((tx) => compute.renewInTransaction(tx, request)),
    helpers.writeTransaction((tx) => compute.renewInTransaction(tx, request)),
  ]);
  expect(first.window.id).toBe(replay.window.id);
  expect([first.replayed, replay.replayed].sort()).toEqual([false, true]);
  expect(first.window.previous_funding_id).toBe(reserved.window.id);
  expect(first.window.provider_container_id).toBe(provider.containerId);
  expect(first.window.host_lease_confirmed_at).toBeNull();
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.550000" }]);
  expect(after.windows).toHaveLength(2);
  expect(after.reservations).toHaveLength(2);
  expect(after.ledger).toHaveLength(3);
  expect(
    after.allocations
      .map((row) => ({
        reserved: row.reserved_amount,
        finalized: row.finalized_amount,
        released: row.released_amount,
      }))
      .sort((a, b) => String(a.finalized).localeCompare(String(b.finalized))),
  ).toEqual([
    { reserved: "0.300000", finalized: "0.000000", released: "0.000000" },
    { reserved: "0.300000", finalized: "0.150000", released: "0.150000" },
  ]);
  await helpers.writeTransaction(async (tx) => {
    await expect(
      compute.renewInTransaction(tx, { ...request, actualAmount: "0.009000" }),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_FUNDING_CONFLICT" });
  });
  expect(await renewalState(org)).toEqual(after);
  await expect(
    helpers.writeTransaction((tx) =>
      compute.renewInTransaction(tx, {
        ...request,
        fundingId: first.window.id,
        settledThrough: new Date(),
      }),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_UNCONFIRMED" });
  const newProvider = { ...provider, fundingId: first.window.id };
  const authorization = await helpers.writeTransaction((tx) =>
    compute.authorizeHostInTransaction(tx, newProvider),
  );
  expect(authorization.previousFundingId).toBe(reserved.window.id);
  expect(authorization.paidFromMs).toBe(request.settledThrough.getTime());
  await helpers.writeTransaction((tx) => compute.confirmHostLeaseInTransaction(tx, newProvider));
  await expect(
    helpers.writeTransaction((tx) => compute.authorizeHostInTransaction(tx, provider)),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED" });
});

test("a caught failed renewal rolls back its allowance settlement, cash refund, and successor before the outer transaction commits", async () => {
  // Leave half a cent of paid allowance and 29.5 cents of cash for the 30-cent hold.
  await helpers.writeTransaction(async (tx) => {
    await funding.subscriptionFundingService.reserveInTransaction(tx, {
      ...input("compute:renewal-allowance-buffer", "24.995001"),
      organizationId: allowanceOrganizationId,
    });
    await funding.subscriptionFundingService.reserveInTransaction(tx, {
      ...input("compute:renewal-cash-buffer", "9.705001"),
      organizationId: allowanceOrganizationId,
      operation: "unclassified",
    });
  });
  const { compute, identity, reserved } = await runningFundedAgent(
    allowanceOrganizationId,
    "63000000-0000-4000-8000-000000000005",
  );
  const before = await renewalState(allowanceOrganizationId);
  const allowanceBefore = (
    await fixture.query("SELECT * FROM subscription_allowance_periods WHERE organization_id=$1", [
      allowanceOrganizationId,
    ])
  ).rows;
  expect(before.balance).toEqual([{ credit_balance: "0.000000" }]);
  await helpers.writeTransaction(async (tx) => {
    await expect(
      compute.renewInTransaction(tx, {
        ...identity,
        fundingId: reserved.window.id,
        settledThrough: new Date(),
        actualAmount: "0.150000",
      }),
    ).rejects.toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT });
    // Prove the outer transaction remains usable after the rejected exchange.
    await tx.execute(
      sql`UPDATE organizations SET settings='{"renewal_stop_needed":true}'::jsonb WHERE id=${allowanceOrganizationId}`,
    );
  });
  expect(await renewalState(allowanceOrganizationId)).toEqual(before);
  expect(
    (
      await fixture.query("SELECT * FROM subscription_allowance_periods WHERE organization_id=$1", [
        allowanceOrganizationId,
      ])
    ).rows,
  ).toEqual(allowanceBefore);
  expect(
    (
      await fixture.query("SELECT settings FROM organizations WHERE id=$1", [
        allowanceOrganizationId,
      ])
    ).rows,
  ).toEqual([{ settings: { renewal_stop_needed: true } }]);
});

test.each(["canceled", "expired"] as const)(
  "subscription %s state sends funded billing to the stop path without releasing its existing hold",
  async (state) => {
    const { subscriptionAuthorityRepository: authority } = await import(
      "../../db/repositories/subscription-authority"
    );
    const { subscriptionEntitlementsRepository: entitlements } = await import(
      "../../db/repositories/subscription-entitlements"
    );
    const { agentBillingRepository } = await import("../../db/repositories/agent-billing");
    const current = await authority.findById(allowanceOrganizationId, subscriptionId);
    if (!current) throw new Error("Missing paid subscription fixture");
    const { id, organization_id, lifecycle_revision, created_at, updated_at, ...values } = current;
    const agentId = "63000000-0000-4000-8000-000000000005";
    const before = await renewalState(allowanceOrganizationId);
    const rollback = new Error("Roll back unavailable subscription fixture");
    await expect(
      helpers.writeTransaction(async (tx) => {
        // Cash is sufficient: subscription authority, rather than an empty wallet,
        // must cause this renewal denial. The whole scenario rolls back below.
        await tx.execute(sql`UPDATE organizations SET credit_balance='1.000000'
        WHERE id=${allowanceOrganizationId}`);
        await tx.execute(sql`UPDATE agent_sandboxes SET billing_status='active',total_billed=0,
        last_billed_at=(SELECT period_start FROM agent_compute_funding WHERE agent_id=${agentId} AND settled_at IS NULL)
        WHERE id=${agentId} AND organization_id=${allowanceOrganizationId}`);
        await tx.execute(sql`INSERT INTO compute_billing_rate_segments(id,organization_id,workload_kind,workload_id,lifecycle_revision,billing_state,rate_per_hour,effective_at)
        SELECT gen_random_uuid(),organization_id,'agent',agent_id,1,'running',hourly_rate,period_start
        FROM agent_compute_funding WHERE agent_id=${agentId} AND organization_id=${allowanceOrganizationId} AND settled_at IS NULL`);
        const projection = await tx.execute<{ projection_revision: number }>(sql`
          SELECT projection_revision::integer AS projection_revision FROM organization_entitlements WHERE organization_id=${allowanceOrganizationId}`);
        const advanced = await authority.advanceInTransaction(tx, {
          organizationId: allowanceOrganizationId,
          subscriptionId,
          expectedRevision: lifecycle_revision,
          source: "webhook",
          observation: "authoritative_provider_retrieval",
          values: {
            ...values,
            ...(state === "canceled"
              ? { status: "canceled" as const, canceled_at: new Date(), ended_at: new Date() }
              : { current_period_end: new Date(Date.now() - 1_000) }),
            provider_object_digest: "d".repeat(64),
          },
        });
        await entitlements.rebuildInTransaction(tx, {
          organizationId: allowanceOrganizationId,
          sourceSubscriptionId: subscriptionId,
          sourceSubscriptionRevision: advanced.subscription.lifecycle_revision,
          expectedProjectionRevision: projection.rows[0]!.projection_revision,
        });
        const readHeldFunding = () =>
          tx.execute(sql`SELECT
        (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.id) FROM agent_compute_funding f WHERE organization_id=${allowanceOrganizationId}) AS windows,
        (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM billing_funding_reservations r WHERE organization_id=${allowanceOrganizationId}) AS reservations,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM billing_funding_allocations a WHERE organization_id=${allowanceOrganizationId}) AS allocations,
        (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM credit_transactions c WHERE organization_id=${allowanceOrganizationId}) AS ledger,
        (SELECT credit_balance FROM organizations WHERE id=${allowanceOrganizationId}) AS balance`);
        const held = await readHeldFunding();
        const result =
          await agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
            tx,
            agentId,
            allowanceOrganizationId,
            new Date(),
            "billing_recovery",
          );
        expect(result).toEqual({ status: "insufficient_credits" });
        expect((await readHeldFunding()).rows).toEqual(held.rows);
        const jobs = await tx.execute(sql`SELECT id FROM jobs WHERE agent_id=${agentId}`);
        expect(jobs.rows).toEqual([]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await renewalState(allowanceOrganizationId)).toEqual(before);
    expect(await authority.findById(allowanceOrganizationId, subscriptionId)).toEqual(current);
  },
);

test("a usage receipt must match one finalized funding source, its exact amount, tenant and metered period", async () => {
  const org = "61000000-0000-4000-8000-000000000004";
  const agentId = "63000000-0000-4000-8000-000000000004";
  const windows = (
    await fixture.query<{ id: string; settled_at: Date | null }>(
      "SELECT id,settled_at FROM agent_compute_funding WHERE organization_id=$1",
      [org],
    )
  ).rows;
  const settled = windows.find((window) => window.settled_at !== null);
  const open = windows.find((window) => window.settled_at === null);
  if (!settled || !open) throw new Error("Missing real completed renewal fixture");
  const insert = (fundingId: string, amount: string, receiptOrg = org) =>
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id)
      SELECT $1,$2,'running',date_trunc('milliseconds',period_start),COALESCE(settled_through,period_end),hourly_rate,$3,id
      FROM agent_compute_funding WHERE id=$4`,
      [receiptOrg, agentId, amount, fundingId],
    );
  const before = await renewalState(org);
  await expect(insert(open.id, "0.150000")).rejects.toThrow("agent billing receipt must match");
  await expect(insert(settled.id, "0.009000")).rejects.toThrow("agent billing receipt must match");
  await expect(insert(settled.id, "0.150000", organizationId)).rejects.toThrow(
    "agent billing receipt must match",
  );
  await expect(
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id)
      SELECT organization_id,agent_id,'running',date_trunc('milliseconds',period_start),settled_through+interval '1 second',hourly_rate,'0.150000',id
      FROM agent_compute_funding WHERE id=$1`,
      [settled.id],
    ),
  ).rejects.toThrow("agent billing receipt must match");
  await expect(
    fixture.query(
      `INSERT INTO agent_billing_records(organization_id,sandbox_id,sandbox_status,billing_period_start,billing_period_end,hourly_rate,amount,compute_funding_id,credit_transaction_id)
      SELECT organization_id,agent_id,'running',date_trunc('milliseconds',period_start),settled_through,hourly_rate,'0.150000',id,
        (SELECT id FROM credit_transactions WHERE organization_id=$2 LIMIT 1)
      FROM agent_compute_funding WHERE id=$1`,
      [settled.id, org],
    ),
  ).rejects.toThrow("agent_billing_records_funding_source_check");
  await insert(settled.id, "0.150000");
  await expect(insert(settled.id, "0.150000")).rejects.toThrow(
    "agent_billing_records_compute_funding_idx",
  );
  expect(
    (
      await fixture.query(
        "SELECT amount::text,credit_transaction_id,compute_funding_id FROM agent_billing_records WHERE organization_id=$1",
        [org],
      )
    ).rows,
  ).toEqual([{ amount: "0.150000", credit_transaction_id: null, compute_funding_id: settled.id }]);
  expect(await renewalState(org)).toEqual(before);
});

async function billableFundedAgent(
  suffix: string,
  balance: string,
  providerTarget?: { nodeId: string; containerId: string },
) {
  const org = `61000000-0000-4000-8000-${suffix}`;
  const agentId = `63000000-0000-4000-8000-${suffix}`;
  const userId = `64000000-0000-4000-8000-${suffix}`;
  await fixture.query("INSERT INTO users(id) VALUES($1)", [userId]);
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES ($1,$2,1,0,'{}',true,false,'active')`,
    [org, balance],
  );
  const funded = await runningFundedAgent(org, agentId, providerTarget);
  await fixture.query(
    `UPDATE agent_compute_funding SET period_start=date_trunc('milliseconds',period_start) WHERE id=$1`,
    [funded.provider.fundingId],
  );
  await fixture.query(
    `UPDATE agent_sandboxes SET user_id=$2,agent_name='Funded test',billing_status='active',total_billed=0,
    last_billed_at=(SELECT period_start FROM agent_compute_funding WHERE id=$3),created_at=now()-interval '2 hours' WHERE id=$1`,
    [agentId, userId, funded.provider.fundingId],
  );
  await fixture.query(
    `INSERT INTO compute_billing_rate_segments(id,organization_id,workload_kind,workload_id,lifecycle_revision,billing_state,rate_per_hour,effective_at)
    SELECT gen_random_uuid(),$1,'agent',$2,1,'running',hourly_rate,period_start FROM agent_compute_funding WHERE id=$3`,
    [org, agentId, funded.provider.fundingId],
  );
  const { agentBillingRunRepository } = await import("../../db/repositories/agent-billing-runs");
  const run = await agentBillingRunRepository.startOrLoad({
    invocationKey: `manual:prepaid:${suffix}`,
    triggerKind: "manual",
    schedule: null,
    scheduledAt: null,
    leaseDurationMs: 300_000,
  });
  if (!run.leaseToken) throw new Error("Billing test did not claim its run");
  const { agentBillingRepository } = await import("../../db/repositories/agent-billing");
  const cutoff = await fixture.query<{ cutoff: Date }>(
    "SELECT period_start+interval '1 hour' AS cutoff FROM agent_compute_funding WHERE id=$1",
    [funded.provider.fundingId],
  );
  return {
    ...funded,
    org,
    agentId,
    agentBillingRepository,
    input: {
      runId: run.run.id,
      leaseToken: run.leaseToken,
      sandboxId: agentId,
      organizationId: org,
      userId,
      agentName: "Funded test",
      hourlyRate: 99,
      billingDescription: "Must use the canonical meter",
      lowCreditWarningAmount: 0.1,
      now: cutoff.rows[0]!.cutoff,
    },
  };
}

test("the real hourly biller settles a funded hour once and commits its receipt with one renewal job", async () => {
  const { org, agentId, provider, input, agentBillingRepository } = await billableFundedAgent(
    "000000000010",
    "1.000000",
  );
  const outcomes = await Promise.all([
    agentBillingRepository.recordHourlyBilling(input),
    agentBillingRepository.recordHourlyBilling(input),
  ]);
  expect(outcomes.map((value) => value.status).sort()).toEqual([
    "already_billed_recently",
    "billed",
  ]);
  const billed = outcomes.find((value) => value.status === "billed");
  expect(billed).toMatchObject({
    amountDecimal: "0.150000",
    newBalance: 0.55,
    transactionId: `compute-funding:${provider.fundingId}`,
  });
  const after = await renewalState(org);
  expect(after.ledger).toHaveLength(3); // initial hold, unused remainder refund, replacement hold; no usage cash debit.
  expect(after.windows).toHaveLength(2);
  const receipts = await fixture.query(
    "SELECT compute_funding_id,credit_transaction_id,amount::text FROM agent_billing_records WHERE sandbox_id=$1",
    [agentId],
  );
  expect(receipts.rows).toEqual([
    { compute_funding_id: provider.fundingId, credit_transaction_id: null, amount: "0.150000" },
  ]);
  const jobs = await fixture.query("SELECT * FROM jobs WHERE agent_id=$1", [agentId]);
  expect(jobs.rows).toHaveLength(1);
  const { readAgentComputeLeaseJobData } = await import("./agent-compute-lease-jobs");
  const job = jobs.rows[0] as unknown as import("../../db/schemas/jobs").Job;
  expect(readAgentComputeLeaseJobData(job)).toEqual({
    agentId,
    organizationId: org,
    fundingId: job.id,
    lifecycleRevision: 1,
  });
  expect(job.type).toBe("agent_compute_lease");
  expect(job.status).toBe("pending");
  expect(() => readAgentComputeLeaseJobData({ ...job, organization_id: organizationId })).toThrow(
    "identity changed",
  );
  const runItems = await fixture.query(
    "SELECT action,amount::text,new_balance::text,transaction_id FROM agent_billing_run_items WHERE run_id=$1",
    [input.runId],
  );
  expect(runItems.rows).toEqual([
    {
      action: "billed",
      amount: "0.150000",
      new_balance: "0.550000",
      transaction_id: `compute-funding:${provider.fundingId}`,
    },
  ]);
});

test("failed durable job delivery rolls back the hourly funding exchange, receipt and billing cursor", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000011",
    "1.000000",
  );
  const before = await renewalState(org);
  const cursor = await fixture.query(
    "SELECT last_billed_at,total_billed::text FROM agent_sandboxes WHERE id=$1",
    [agentId],
  );
  // Real database failure after settlement: no service is mocked and the outer transaction must undo every financial write.
  await fixture.exec(`CREATE FUNCTION reject_test_renewal_job() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.agent_id='${agentId}' THEN RAISE EXCEPTION 'test renewal job unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER reject_test_renewal_job BEFORE INSERT ON jobs FOR EACH ROW EXECUTE FUNCTION reject_test_renewal_job();`);
  try {
    await expect(agentBillingRepository.recordHourlyBilling(input)).rejects.toThrow();
    expect(await renewalState(org)).toEqual(before);
    expect(
      (
        await fixture.query(
          "SELECT last_billed_at,total_billed::text FROM agent_sandboxes WHERE id=$1",
          [agentId],
        )
      ).rows,
    ).toEqual(cursor.rows);
    expect(
      (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
        .rows,
    ).toHaveLength(0);
    expect(
      (await fixture.query("SELECT id FROM agent_billing_run_items WHERE run_id=$1", [input.runId]))
        .rows,
    ).toHaveLength(0);
  } finally {
    await fixture.exec(
      "DROP TRIGGER reject_test_renewal_job ON jobs; DROP FUNCTION reject_test_renewal_job();",
    );
  }
  expect(await agentBillingRepository.recordHourlyBilling(input)).toMatchObject({
    status: "billed",
    amountDecimal: "0.150000",
  });
});

test("an unfundable hourly renewal preserves its confirmed paid time and existing hold", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000012",
    "0.300000",
  );
  const before = await renewalState(org);
  const outcome = await agentBillingRepository.recordHourlyBilling(input);
  expect(outcome).toEqual({
    status: "funded_until",
    fundedUntil: expect.any(Date),
    stopAfter: expect.any(Date),
  });
  if (outcome.status !== "funded_until") throw new Error("Existing paid window was not preserved");
  expect(outcome.fundedUntil.getTime() - outcome.stopAfter.getTime()).toBe(120_000);
  expect(outcome.stopAfter.getTime()).toBeGreaterThan(Date.now());
  expect(await renewalState(org)).toEqual(before);
  expect(
    (await fixture.query("SELECT id FROM jobs WHERE agent_id=$1", [agentId])).rows,
  ).toHaveLength(0);
  expect(
    (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
      .rows,
  ).toHaveLength(0);
});

test("a paid-window stop is scheduled once and an explicit user stop makes it immediate", async () => {
  const { org, agentId, input } = await billableFundedAgent("000000000063", "0.300000");
  const migration = (name: string) =>
    readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8");
  const intentDDL = (await migration("0265_compute_billing_recovery.sql")).match(
    /CREATE TABLE agent_compute_stop_intents \([\s\S]*?\n\);/,
  );
  if (!intentDDL) throw new Error("Missing canonical stop intent DDL");
  await fixture.exec(intentDDL[0]);
  try {
    for (const statement of (await migration("0334_billing_cancel_intent_authority.sql")).split(
      "--> statement-breakpoint",
    )) {
      if (statement.includes('"agent_compute_stop_intents"')) await fixture.exec(statement);
    }
    const { enqueueAgentUnfundedStopForRun } = await import("./agent-unfunded-stop");
    const before = await renewalState(org);
    expect(await enqueueAgentUnfundedStopForRun(input)).toMatchObject({
      action: "skipped",
      detail_code: "existing_runtime_funded",
    });
    expect(await renewalState(org)).toEqual(before);
    const readStop = () =>
      fixture.query<{
        id: string;
        scheduled_for: Date;
        authorization: string;
        next_attempt_at: Date;
      }>(
        "SELECT j.id,j.scheduled_for,i.authorization,i.next_attempt_at FROM jobs j JOIN agent_compute_stop_intents i ON i.job_id=j.id WHERE j.agent_id=$1",
        [agentId],
      );
    const pending = (await readStop()).rows;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.scheduled_for.getTime()).toBeGreaterThan(Date.now());
    expect(pending[0]!.scheduled_for).toEqual(pending[0]!.next_attempt_at);
    await enqueueAgentUnfundedStopForRun(input);
    expect((await readStop()).rows).toEqual(pending);
    const { ProvisioningJobService } = await import("./provisioning-jobs");
    const promoted = await new ProvisioningJobService().enqueueAgentSuspendOnce({
      agentId,
      organizationId: org,
      userId: input.userId,
      authorization: "user_request",
    });
    expect(promoted.job.id).toBe(pending[0]!.id);
    const immediate = (await readStop()).rows[0]!;
    expect(immediate.authorization).toBe("user_request");
    expect(immediate.scheduled_for.getTime()).toBeLessThanOrEqual(Date.now());
    const { deferFundedAgentStopInTransaction } = await import("./agent-compute-stop-schedule");
    expect(
      await helpers.writeTransaction((tx) =>
        deferFundedAgentStopInTransaction(tx, {
          agentId,
          organizationId: org,
          jobId: immediate.id,
          stopAfter: pending[0]!.scheduled_for,
        }),
      ),
    ).toBe(false);
    expect((await readStop()).rows[0]!.scheduled_for).toEqual(immediate.scheduled_for);
  } finally {
    await fixture.exec("DROP TABLE agent_compute_stop_intents");
  }
});

async function stopReceiptFor(fundingId: string, stoppedAt: Date) {
  const { rows } = await fixture.query<{
    id: string;
    agent_id: string;
    organization_id: string;
    provider_container_id: string;
    previous_funding_id: string | null;
    period_start: Date;
    period_end: Date;
  }>("SELECT * FROM agent_compute_funding WHERE id=$1", [fundingId]);
  const window = rows[0]!;
  return {
    authorization: {
      agentId: window.agent_id,
      organizationId: window.organization_id,
      containerId: window.provider_container_id,
      fundingId: window.id,
      previousFundingId: window.previous_funding_id,
      issuedAtMs: Date.now(),
      paidFromMs: window.period_start.getTime(),
      paidUntilMs: window.period_end.getTime(),
    },
    bootId: crypto.randomUUID(),
    expired: true,
    stoppedAtMs: stoppedAt.getTime(),
  };
}

test("a successful short activation collects its minimum once and records the usage separately", async () => {
  const { org, agentId, identity, provider } = await billableFundedAgent(
    "000000000060",
    "1.000000",
  );
  const { rows } = await fixture.query<{ period_start: Date }>(
    "SELECT period_start FROM agent_compute_funding WHERE id=$1",
    [provider.fundingId],
  );
  const stoppedAt = new Date(rows[0]!.period_start.getTime() + 60_000);
  const receipt = await stopReceiptFor(provider.fundingId, stoppedAt);
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  const request = { ...identity, fundingId: provider.fundingId };
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: false,
    purchasedCreditRefunded: false,
  });
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.700000" }]);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,minimum_charge_amount::text,total_billed::text FROM agent_billing_records r JOIN agent_sandboxes a ON a.id=r.sandbox_id WHERE a.id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([{ amount: "0.300000", minimum_charge_amount: "0.297500", total_billed: "0.300000" }]);
  const before = await renewalState(org);
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: true,
  });
  expect(await renewalState(org)).toEqual(before);
});

test("hourly renewal carries only the unpaid activation minimum into the stop receipt", async () => {
  const { org, agentId, identity, input, agentBillingRepository } = await billableFundedAgent(
    "000000000061",
    "1.000000",
  );
  expect(await agentBillingRepository.recordHourlyBilling(input)).toMatchObject({
    status: "billed",
    amountDecimal: "0.150000",
  });
  const { rows } = await fixture.query<{ id: string; minimum_charge_remaining: string }>(
    "SELECT id,minimum_charge_remaining::text FROM agent_compute_funding WHERE agent_id=$1 AND settled_at IS NULL",
    [agentId],
  );
  expect(rows[0]!.minimum_charge_remaining).toBe("0.150000");
  const receipt = await stopReceiptFor(rows[0]!.id, new Date(input.now.getTime() + 1_000));
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: rows[0]!.id }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.700000" }]);
  expect(
    (await fixture.query("SELECT total_billed::text FROM agent_sandboxes WHERE id=$1", [agentId]))
      .rows,
  ).toEqual([{ total_billed: "0.300000" }]);
  expect(
    (
      await fixture.query(
        "SELECT sum(amount)::text AS charged FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([{ charged: "0.300000" }]);
});

test("retained restarts use the current tariff while uninterrupted renewals keep the prior rate", async () => {
  for (const restart of [false, true]) {
    const { org, agentId, identity, provider, input, compute } = await billableFundedAgent(
      restart ? "000000000066" : "000000000065",
      "1.000000",
    );
    await fixture.query(
      "UPDATE agent_compute_funding SET hourly_rate='0.010000',minimum_charge_remaining='0.020000' WHERE id=$1",
      [provider.fundingId],
    );
    await fixture.query(
      "UPDATE compute_billing_rate_segments SET rate_per_hour='0.010000' WHERE workload_id=$1 AND billing_state='running'",
      [agentId],
    );
    if (restart) {
      const receipt = await stopReceiptFor(provider.fundingId, input.now);
      const { settleStoppedAgentComputeInTransaction: settle } = await import(
        "./agent-compute-stop"
      );
      await helpers.writeTransaction((tx) =>
        settle(tx, { ...identity, fundingId: provider.fundingId }, receipt),
      );
      await fixture.query("UPDATE agent_sandboxes SET status='stopped' WHERE id=$1", [agentId]);
      const resumed = await helpers.writeTransaction((tx) =>
        compute.reserveRetainedResumeInTransaction(tx, identity),
      );
      expect(resumed?.window.hourly_rate).toBe("0.150000");
      expect(resumed?.window.minimum_charge_remaining).toBe("0.300000");
    } else {
      const renewed = await helpers.writeTransaction((tx) =>
        compute.renewInTransaction(tx, {
          ...identity,
          fundingId: provider.fundingId,
          settledThrough: input.now,
          actualAmount: "0.010000",
        }),
      );
      expect(renewed.window.hourly_rate).toBe("0.010000");
      expect(renewed.window.minimum_charge_remaining).toBe("0.010000");
    }
    expect(
      (
        await fixture.query("SELECT hourly_rate::text FROM agent_compute_funding WHERE id=$1", [
          provider.fundingId,
        ])
      ).rows,
    ).toEqual([{ hourly_rate: "0.010000" }]);
    expect(Number((await renewalState(org)).balance[0]!.credit_balance)).toBeGreaterThanOrEqual(0);
  }
});

test("an activation that never becomes ready does not collect the minimum charge", async () => {
  const { org, agentId, identity, provider, input } = await billableFundedAgent(
    "000000000062",
    "1.000000",
  );
  await fixture.query("UPDATE agent_compute_funding SET runtime_ready_at=NULL WHERE id=$1", [
    provider.fundingId,
  ]);
  const receipt = await stopReceiptFor(provider.fundingId, input.now);
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: provider.fundingId }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.850000" }]);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,minimum_charge_amount::text FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([{ amount: "0.150000", minimum_charge_amount: "0.000000" }]);
});

test("legacy stopped runtime refunds its unused hold atomically, including for an inactive account, without replaying the refund", async () => {
  const { org, agentId, identity, provider, input } = await billableFundedAgent(
    "000000000020",
    "1.000000",
  );
  // Migrated windows retain the original tariff and have no new activation minimum.
  await fixture.query("UPDATE agent_compute_funding SET minimum_charge_remaining=0 WHERE id=$1", [
    provider.fundingId,
  ]);
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  const receipt = await stopReceiptFor(provider.fundingId, input.now);
  const request = { ...identity, fundingId: provider.fundingId };
  const before = await renewalState(org);
  await expect(
    helpers.writeTransaction((tx) => settle(tx, request, { ...receipt, expired: false })),
  ).rejects.toThrow();
  await expect(
    helpers.writeTransaction((tx) =>
      settle(tx, request, {
        ...receipt,
        authorization: { ...receipt.authorization, containerId: "e".repeat(64) },
      }),
    ),
  ).rejects.toThrow();
  expect(await renewalState(org)).toEqual(before);
  await expect(
    helpers.writeTransaction(async (tx) => {
      await settle(tx, request, receipt);
      throw new Error("stop writeback failed");
    }),
  ).rejects.toThrow("stop writeback failed");
  expect(await renewalState(org)).toEqual(before);
  expect(
    (await fixture.query("SELECT id FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
      .rows,
  ).toHaveLength(0);
  await fixture.query(
    "UPDATE organizations SET is_active=false,paid_work_fenced_at=now() WHERE id=$1",
    [org],
  );
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: false,
    purchasedCreditRefunded: true,
  });
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.850000" }]);
  expect(after.ledger).toHaveLength(2);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,compute_funding_id,credit_transaction_id FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([
    { amount: "0.150000", compute_funding_id: provider.fundingId, credit_transaction_id: null },
  ]);
  expect(await helpers.writeTransaction((tx) => settle(tx, request, receipt))).toMatchObject({
    replayed: true,
    purchasedCreditRefunded: false,
  });
  expect(await renewalState(org)).toEqual(after);
  await expect(
    helpers.writeTransaction((tx) =>
      settle(tx, request, { ...receipt, stoppedAtMs: receipt.stoppedAtMs + 1 }),
    ),
  ).rejects.toThrow();
  expect(await renewalState(org)).toEqual(after);
});

test("paid agent deletion retains settled financial history and rejects open funding or identity reuse", async () => {
  const { org, agentId, identity, provider, input } = await billableFundedAgent(
    "000000000050",
    "1.000000",
  );
  const before = await renewalState(org);
  // Reconstruct the populated pre-migration FK, then apply the real backfill.
  const migration = await readFile(
    new URL("../../db/migrations/0391_agent_compute_subjects.sql", import.meta.url),
    "utf8",
  );
  await fixture.exec(`BEGIN;
    ALTER TABLE agent_compute_funding DROP CONSTRAINT agent_compute_funding_agent_tenant_fk;
    ALTER TABLE agent_compute_funding ADD CONSTRAINT agent_compute_funding_agent_tenant_fk FOREIGN KEY(agent_id,organization_id) REFERENCES agent_sandboxes(id,organization_id) ON DELETE RESTRICT;
    DELETE FROM agent_compute_subjects WHERE agent_id='${agentId}';
    ${migration}
    COMMIT;`);
  expect(
    (
      await fixture.query(
        "SELECT organization_id,retired_at FROM agent_compute_subjects WHERE agent_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([{ organization_id: org, retired_at: null }]);
  expect(await renewalState(org)).toEqual(before);
  await expect(fixture.query("DELETE FROM agent_sandboxes WHERE id=$1", [agentId])).rejects.toThrow(
    "Unsettled compute",
  );
  await expect(
    fixture.query("UPDATE agent_sandboxes SET organization_id=$2 WHERE id=$1", [
      agentId,
      organizationId,
    ]),
  ).rejects.toThrow("identity is immutable");
  await expect(
    fixture.query("UPDATE agent_compute_funding SET agent_id=$2 WHERE id=$1", [
      provider.fundingId,
      crypto.randomUUID(),
    ]),
  ).rejects.toThrow("identity is immutable");
  expect(await renewalState(org)).toEqual(before);
  const { settleStoppedAgentComputeInTransaction } = await import("./agent-compute-stop");
  const receipt = await stopReceiptFor(provider.fundingId, input.now);
  await helpers.writeTransaction((tx) =>
    settleStoppedAgentComputeInTransaction(
      tx,
      { ...identity, fundingId: provider.fundingId },
      receipt,
    ),
  );
  const settled = await renewalState(org);
  const receipts = (
    await fixture.query("SELECT * FROM agent_billing_records WHERE sandbox_id=$1", [agentId])
  ).rows;
  expect(receipts).toHaveLength(1);
  // Applying the migration again must preserve the existing funding identities.
  await fixture.exec(
    await readFile(
      new URL("../../db/migrations/0391_agent_compute_subjects.sql", import.meta.url),
      "utf8",
    ),
  );
  await expect(
    helpers.writeTransaction(async (tx) => {
      await tx.execute(sql`DELETE FROM agent_sandboxes WHERE id=${agentId}`);
      throw new Error("delete commit failed");
    }),
  ).rejects.toThrow("delete commit failed");
  expect(
    (
      await fixture.query("SELECT retired_at FROM agent_compute_subjects WHERE agent_id=$1", [
        agentId,
      ])
    ).rows,
  ).toEqual([{ retired_at: null }]);
  await fixture.query("DELETE FROM agent_sandboxes WHERE id=$1", [agentId]);
  expect(
    (await fixture.query("SELECT id FROM agent_sandboxes WHERE id=$1", [agentId])).rows,
  ).toHaveLength(0);
  expect(
    (
      await fixture.query("SELECT retired_at FROM agent_compute_subjects WHERE agent_id=$1", [
        agentId,
      ])
    ).rows,
  ).toEqual([{ retired_at: expect.any(Date) }]);
  expect(await renewalState(org)).toEqual(settled);
  expect(
    (await fixture.query("SELECT * FROM agent_billing_records WHERE sandbox_id=$1", [agentId]))
      .rows,
  ).toEqual(receipts);
  await expect(
    fixture.query(
      "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision) VALUES($1,$2,'provisioning','dedicated-always',1)",
      [agentId, org],
    ),
  ).rejects.toThrow("cannot be reused");
  await expect(
    fixture.query(
      "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision) VALUES($1,$2,'provisioning','dedicated-always',1)",
      [agentId, organizationId],
    ),
  ).rejects.toThrow("cannot be reused");
});

test("paid agent deletion refunds an unallocated hold before removing its operational row", async () => {
  const agentId = crypto.randomUUID();
  await fixture.query(
    "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision) VALUES($1,$2,'provisioning','dedicated-always',1,1)",
    [agentId, organizationId],
  );
  const before = (
    await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
      organizationId,
    ])
  ).rows;
  const { agentComputeFundingService } = await import("./agent-compute-funding");
  const current = (
    await fixture.query("SELECT lifecycle_revision FROM agent_sandboxes WHERE id=$1", [agentId])
  ).rows[0]!;
  const held = await helpers.writeTransaction((tx) =>
    agentComputeFundingService.reserveInTransaction(tx, {
      agentId,
      organizationId,
      lifecycleRevision: Number(current.lifecycle_revision),
    }),
  );
  await fixture.query("UPDATE agent_sandboxes SET status='error' WHERE id=$1", [agentId]);
  const { ElizaSandboxService } = await import("./eliza-sandbox");
  const { SandboxDeletion } = await import("./eliza-sandbox/lifecycle/deletion");
  const deletion = new SandboxDeletion(
    new ElizaSandboxService() as unknown as import("./eliza-sandbox/lifecycle/deletion").SandboxDeletionHost,
  );
  const prepared = await deletion.prepareAgentDelete(agentId, organizationId, "user_request");
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error);
  expect(
    (
      await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
        organizationId,
      ])
    ).rows,
  ).toEqual(before);
  expect(
    (
      await fixture.query(
        "SELECT settled_at,provider_container_id,host_lease_confirmed_at FROM agent_compute_funding WHERE id=$1",
        [held.window.id],
      )
    ).rows,
  ).toEqual([
    { settled_at: expect.any(Date), provider_container_id: null, host_lease_confirmed_at: null },
  ]);
  expect(await deletion.commitAgentRowDelete(agentId, organizationId, prepared)).toMatchObject({
    success: true,
    rowDeleted: true,
  });
  expect(
    (
      await fixture.query("SELECT retired_at FROM agent_compute_subjects WHERE agent_id=$1", [
        agentId,
      ])
    ).rows,
  ).toEqual([{ retired_at: expect.any(Date) }]);
});

test("paid warm retry refunds an unallocated hold before clearing its failed claim", async () => {
  const agentId = crypto.randomUUID();
  await fixture.query(
    "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision) VALUES($1,$2,'provisioning','dedicated-always',1,1)",
    [agentId, organizationId],
  );
  const before = (
    await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
      organizationId,
    ])
  ).rows;
  const { agentComputeFundingService } = await import("./agent-compute-funding");
  const current = (
    await fixture.query("SELECT lifecycle_revision FROM agent_sandboxes WHERE id=$1", [agentId])
  ).rows[0]!;
  const held = await helpers.writeTransaction((tx) =>
    agentComputeFundingService.reserveInTransaction(tx, {
      agentId,
      organizationId,
      lifecycleRevision: Number(current.lifecycle_revision),
    }),
  );
  await fixture.query(
    "UPDATE agent_sandboxes SET status='error',claimed_at=now(),warm_claim_credential_state='failed',warm_claim_cleanup_completed_at=now() WHERE id=$1",
    [agentId],
  );
  const { ElizaSandboxService } = await import("./eliza-sandbox");
  const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
  const service = new ElizaSandboxService(new DockerSandboxProvider()) as unknown as {
    retireFailedWarmClaimForRetry: import("./eliza-sandbox/lifecycle/warm-claim").SandboxWarmClaim["retireFailedWarmClaimForRetry"];
  };
  expect(await service.retireFailedWarmClaimForRetry(agentId, organizationId)).toEqual({
    success: true,
  });
  expect(
    (
      await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
        organizationId,
      ])
    ).rows,
  ).toEqual(before);
  expect(
    (
      await fixture.query(
        "SELECT status,claimed_at,sandbox_id,warm_claim_credential_state FROM agent_sandboxes WHERE id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([
    { status: "stopped", claimed_at: null, sandbox_id: null, warm_claim_credential_state: null },
  ]);
  expect(
    (
      await fixture.query(
        "SELECT settled_at,provider_container_id FROM agent_compute_funding WHERE id=$1",
        [held.window.id],
      )
    ).rows,
  ).toEqual([{ settled_at: expect.any(Date), provider_container_id: null }]);
  expect(await service.retireFailedWarmClaimForRetry(agentId, organizationId)).toMatchObject({
    success: false,
  });
  expect(
    (
      await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [
        organizationId,
      ])
    ).rows,
  ).toEqual(before);
});

test("delayed expiry separates the activation minimum from runtime ending at the durable stop", async () => {
  const { org, agentId, identity, provider } = await billableFundedAgent(
    "000000000021",
    "1.000000",
  );
  await fixture.query(
    `UPDATE agent_compute_funding SET period_end=period_start+interval '30 minutes',
    provider_bound_at=period_start,host_lease_confirmed_at=period_start WHERE id=$1`,
    [provider.fundingId],
  );
  const { rows } = await fixture.query<{ stopped_at: Date }>(
    "SELECT period_end-interval '1 minute' AS stopped_at FROM agent_compute_funding WHERE id=$1",
    [provider.fundingId],
  );
  const receipt = await stopReceiptFor(provider.fundingId, rows[0]!.stopped_at);
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: provider.fundingId }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.700000" }]);
  expect(
    (
      await fixture.query(
        "SELECT amount::text,minimum_charge_amount::text,billing_period_end FROM agent_billing_records WHERE sandbox_id=$1",
        [agentId],
      )
    ).rows,
  ).toEqual([
    {
      amount: "0.300000",
      minimum_charge_amount: "0.227500",
      billing_period_end: rows[0]!.stopped_at,
    },
  ]);
});

test("revoking an undelivered successor after its predecessor stopped releases the whole unused window", async () => {
  const { org, agentId, identity, input, agentBillingRepository } = await billableFundedAgent(
    "000000000022",
    "1.000000",
  );
  await agentBillingRepository.recordHourlyBilling(input);
  const { rows } = await fixture.query<{ id: string; period_start: Date }>(
    "SELECT id,period_start FROM agent_compute_funding WHERE agent_id=$1 AND settled_at IS NULL",
    [agentId],
  );
  const current = rows[0]!;
  const receipt = await stopReceiptFor(current.id, new Date(current.period_start.getTime() - 1));
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: current.id }, receipt),
  );
  expect((await renewalState(org)).balance).toEqual([{ credit_balance: "0.850000" }]);
  expect(
    (
      await fixture.query("SELECT id FROM agent_billing_records WHERE compute_funding_id=$1", [
        current.id,
      ])
    ).rows,
  ).toHaveLength(0);
  const stopped = await fixture.query(
    "SELECT provider_stop_receipt,settled_at IS NOT NULL AS settled FROM agent_compute_funding WHERE id=$1",
    [current.id],
  );
  expect(stopped.rows[0]).toMatchObject({
    settled: true,
    provider_stop_receipt: { fundingId: current.id, stoppedAtMs: receipt.stoppedAtMs },
  });
});

test("paid lease recovery cannot authorize an unreconciled legacy lifecycle transition", async () => {
  const { org, agentId, input, agentBillingRepository } = await billableFundedAgent(
    "000000000031",
    "1.000000",
  );
  const before = await renewalState(org);
  await expect(
    helpers.writeTransaction((tx) =>
      agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
        tx,
        agentId,
        org,
        input.now,
      ),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_BILLING_RECONCILIATION_REQUIRED" });
  expect(await renewalState(org)).toEqual(before);
  expect(
    await helpers.writeTransaction((tx) =>
      agentBillingRepository.settleAccruedBillingBeforeLifecycleInTransaction(
        tx,
        agentId,
        org,
        input.now,
        "billing_recovery",
      ),
    ),
  ).toMatchObject({ status: "billed" });
  const after = await renewalState(org);
  expect(after.balance).toEqual([{ credit_balance: "0.550000" }]);
  expect(after.windows).toHaveLength(2);
  expect(after.reservations).toHaveLength(2);
});

test("real provision rejects zero funds before provider allocation and cancels an unbound admission once", async () => {
  const org = "61000000-0000-4000-8000-000000000032";
  const agentId = "63000000-0000-4000-8000-000000000032";
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES($1,'0.000000',1,0,'{}',true,false,'active')`,
    [org],
  );
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision,agent_config,billing_status,total_billed)
    VALUES($1,$2,'pending','dedicated-always',1,1,'{}','active',0)`,
    [agentId, org],
  );
  const { ElizaSandboxService } = await import("./eliza-sandbox");
  const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
  const service = new ElizaSandboxService(new DockerSandboxProvider());
  const rejected = await service.provision(agentId, org);
  expect(rejected.success).toBe(false);
  expect(rejected.failureCause).toMatchObject({ code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT });
  expect(
    (await fixture.query("SELECT * FROM agent_compute_funding WHERE agent_id=$1", [agentId])).rows,
  ).toHaveLength(0);
  expect(
    (
      await fixture.query(
        "SELECT status,database_uri,node_id,sandbox_id FROM agent_sandboxes WHERE id=$1",
        [agentId],
      )
    ).rows[0],
  ).toEqual({ status: "error", database_uri: null, node_id: null, sandbox_id: null });
  await fixture.query("UPDATE organizations SET credit_balance=1 WHERE id=$1", [org]);
  await fixture.query("UPDATE agent_sandboxes SET status='provisioning' WHERE id=$1", [agentId]);
  const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
  const { reserveProvisionCompute, reconcileFailedProvisionCompute } = await import(
    "./agent-compute-provision"
  );
  const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
  if (!rec) throw new Error("Missing provision fixture");
  const paid = await reserveProvisionCompute(rec);
  expect(paid.window.provider_container_id).toBeNull();
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "0.700000" });
  const { cancelUnboundAgentComputeInTransaction } = await import("./agent-compute-stop");
  const identity = {
    agentId,
    organizationId: org,
    lifecycleRevision: paid.agent.lifecycle_revision,
    fundingId: paid.window.id,
  };
  await expect(
    helpers.writeTransaction(async (tx) => {
      await cancelUnboundAgentComputeInTransaction(tx, identity);
      throw new Error("Rollback unbound refund");
    }),
  ).rejects.toThrow("Rollback unbound refund");
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "0.700000" });
  expect(await reconcileFailedProvisionCompute(agentId, org, paid.window.id)).toMatchObject({
    replayed: false,
    purchasedCreditRefunded: true,
  });
  expect(await reconcileFailedProvisionCompute(agentId, org, paid.window.id)).toBeNull();
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "1.000000" });
  const { agentComputeFundingService: compute } = await import("./agent-compute-funding");
  await expect(
    helpers.writeTransaction((tx) =>
      compute.bindProviderInTransaction(tx, {
        ...identity,
        nodeId: "late-provider",
        containerId: "f".repeat(64),
      }),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_EXPIRED" });
  expect(
    (
      await fixture.query(
        "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
        [org],
      )
    ).rows[0]?.n,
  ).toBe(2);
});

test("expired provisioning survives a lost worker, rolls back refunds atomically and fences stale callbacks", async () => {
  const org = "61000000-0000-4000-8000-000000000033";
  const agentId = "63000000-0000-4000-8000-000000000033";
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES($1,'1.000000',1,0,'{}',true,false,'active')`,
    [org],
  );
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision,billing_status,total_billed)
    VALUES($1,$2,'provisioning','dedicated-always',1,1,'active',0)`,
    [agentId, org],
  );
  const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
  const { reserveProvisionCompute } = await import("./agent-compute-provision");
  const { reconcileExpiredAgentCompute } = await import("./agent-compute-recovery");
  const record = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
  if (!record) throw new Error("Missing expired provision fixture");
  const funded = await reserveProvisionCompute(record);
  const identity = { agentId, organizationId: org, fundingId: funded.window.id };
  expect(await reconcileExpiredAgentCompute(identity)).toBeNull();
  expect(await reconcileExpiredAgentCompute({ ...identity, organizationId })).toBeNull();
  // The worker disappears without entering its finally block. Only persisted
  // funding, not an in-memory job result, is available to the next process.
  await fixture.query("UPDATE agent_compute_funding SET period_end=clock_timestamp() WHERE id=$1", [
    funded.window.id,
  ]);
  await expect(reserveProvisionCompute(funded.agent)).rejects.toMatchObject({
    code: "AGENT_COMPUTE_FUNDING_EXPIRED",
  });
  await fixture.exec(`CREATE FUNCTION reject_expired_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${agentId}' AND NEW.status='error' THEN RAISE EXCEPTION 'forced expired recovery rollback'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_expired_status BEFORE UPDATE ON agent_sandboxes FOR EACH ROW EXECUTE FUNCTION reject_expired_status();`);
  await expect(reconcileExpiredAgentCompute(identity)).rejects.toMatchObject({
    cause: { message: "forced expired recovery rollback" },
  });
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "0.700000" });
  expect(
    (
      await fixture.query("SELECT settled_at FROM agent_compute_funding WHERE id=$1", [
        funded.window.id,
      ])
    ).rows[0],
  ).toEqual({ settled_at: null });
  await fixture.exec(
    "DROP TRIGGER reject_expired_status ON agent_sandboxes; DROP FUNCTION reject_expired_status()",
  );
  expect(await reconcileExpiredAgentCompute(identity)).toMatchObject({
    replayed: false,
    purchasedCreditRefunded: true,
  });
  expect(await reconcileExpiredAgentCompute(identity)).toBeNull();
  expect(
    (await fixture.query("SELECT status FROM agent_sandboxes WHERE id=$1", [agentId])).rows[0],
  ).toEqual({ status: "error" });
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "1.000000" });
  await fixture.query("UPDATE agent_sandboxes SET status='provisioning' WHERE id=$1", [agentId]);
  const retry = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
  if (!retry) throw new Error("Missing expired retry fixture");
  const next = await reserveProvisionCompute(retry);
  expect(next.window.id).not.toBe(funded.window.id);
  expect(await reconcileExpiredAgentCompute(identity)).toBeNull();
  const { agentComputeFundingService } = await import("./agent-compute-funding");
  await expect(
    helpers.writeTransaction((tx) =>
      agentComputeFundingService.bindProviderInTransaction(tx, {
        ...identity,
        lifecycleRevision: next.agent.lifecycle_revision,
        nodeId: "late-provider",
        containerId: "f".repeat(64),
      }),
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_EXPIRED" });
  expect(
    (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
      .rows[0],
  ).toEqual({ credit_balance: "0.700000" });
  expect(
    (
      await fixture.query(
        "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
        [org],
      )
    ).rows[0]?.n,
  ).toBe(3);
});

test("a provision failure cannot overwrite a new execution, tenant, environment or stopped generation", async () => {
  const org = "61000000-0000-4000-8000-000000000034";
  const agentId = "63000000-0000-4000-8000-000000000034";
  const jobId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES($1,1,1,0,'{}',true,false,'active')`,
    [org],
  );
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision,billing_status,total_billed,lifecycle_job_id,lifecycle_execution_generation)
    VALUES($1,$2,'provisioning','dedicated-always',1,1,'active',0,$3,$4)`,
    [agentId, org, jobId, generation],
  );
  const { agentSandboxesRepository: repository } = await import(
    "../../db/repositories/agent-sandboxes"
  );
  const expected = await repository.findByIdAndOrg(agentId, org);
  if (!expected) throw new Error("Missing failure generation fixture");
  expect(
    await repository.markProvisionFailed(
      { ...expected, organization_id: organizationId },
      "foreign",
    ),
  ).toBeUndefined();
  await fixture.query(
    "UPDATE agent_sandboxes SET lifecycle_execution_generation=$2,lifecycle_revision=2 WHERE id=$1",
    [agentId, crypto.randomUUID()],
  );
  expect(await repository.markProvisionFailed(expected, "stale worker")).toBeUndefined();
  await fixture.query(
    "UPDATE agent_sandboxes SET lifecycle_execution_generation=$2,environment_revision=2 WHERE id=$1",
    [agentId, generation],
  );
  expect(await repository.markProvisionFailed(expected, "stale config")).toBeUndefined();
  await fixture.query(
    "UPDATE agent_sandboxes SET environment_revision=1,status='stopped' WHERE id=$1",
    [agentId],
  );
  expect(await repository.markProvisionFailed(expected, "late running failure")).toBeUndefined();
  // Own adoption changed the row revision while retaining the exact job execution.
  await fixture.query(
    "UPDATE agent_sandboxes SET status='running',bridge_url='https://owned.test',health_url='https://owned.test/health' WHERE id=$1",
    [agentId],
  );
  expect(await repository.markProvisionFailed(expected, "restore rejected")).toMatchObject({
    status: "error",
    error_message: "restore rejected",
    error_count: 1,
    bridge_url: null,
    health_url: null,
  });
  await fixture.query(
    "UPDATE agent_sandboxes SET status='provisioning',lifecycle_job_id=NULL,lifecycle_execution_generation=NULL WHERE id=$1",
    [agentId],
  );
  const direct = await repository.findByIdAndOrg(agentId, org);
  if (!direct) throw new Error("Missing direct provision fixture");
  await fixture.query(
    "UPDATE agent_sandboxes SET lifecycle_revision=lifecycle_revision+1 WHERE id=$1",
    [agentId],
  );
  expect(await repository.markProvisionFailed(direct, "unleased stale callback")).toBeUndefined();
  expect(
    (await fixture.query("SELECT status,error_count FROM agent_sandboxes WHERE id=$1", [agentId]))
      .rows[0],
  ).toEqual({ status: "provisioning", error_count: 1 });
});

test("replacement cleanup commits its refund before provider deletion and retries without a second refund", async () => {
  const org = "61000000-0000-4000-8000-000000000035";
  const agentId = "63000000-0000-4000-8000-000000000035";
  const name = `agent-${agentId}`;
  const attemptId = crypto.randomUUID();
  const containerId = "5".repeat(64);
  await fixture.query(
    `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
    VALUES($1,1,1,0,'{}',true,false,'active')`,
    [org],
  );
  await fixture.query(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision,billing_status,total_billed)
    VALUES($1,$2,'provisioning','dedicated-always',1,1,'active',0)`,
    [agentId, org],
  );
  const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
  const { reserveProvisionCompute } = await import("./agent-compute-provision");
  const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
  if (!rec) throw new Error("Missing cleanup fixture");
  const paid = await reserveProvisionCompute(rec);
  await fixture.query(
    `UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id=$2,replacement_cleanup_container_name=$2,replacement_cleanup_node_id='cleanup-test-node',replacement_cleanup_container_id=$3,replacement_cleanup_attempt_id=$4,replacement_cleanup_allocation_counted=false,replacement_cleanup_created_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1`,
    [agentId, name, containerId, attemptId],
  );
  const handle = {
    sandboxId: name,
    bridgeUrl: "http://cleanup.test",
    healthUrl: "http://cleanup.test/health",
    metadata: {
      provider: "docker" as const,
      nodeId: "cleanup-test-node",
      hostname: "cleanup.test",
      containerName: name,
      bridgePort: 2138,
      webUiPort: 2138,
      agentId,
      volumePath: `/data/agents/${agentId}`,
      dockerImage: "fixture",
      imageDigest: "fixture",
      replacementAttemptId: attemptId,
      containerId,
      allocationCounted: false,
    },
  };
  const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
  const provider = new DockerSandboxProvider();
  let deletions = 0;
  // Provider deletion is observed, not simulated as proof of physical removal.
  // The service and its refund/fence transactions use the real database.
  provider.stopOnSpecificNodeForReplacement = async (_node, nameArg, _vpn, identity) => {
    expect(nameArg).toBe(name);
    expect(identity?.containerId).toBe(containerId);
    expect(
      (
        await fixture.query(
          "SELECT settled_at IS NOT NULL AS settled FROM agent_compute_funding WHERE id=$1",
          [paid.window.id],
        )
      ).rows[0]?.settled,
    ).toBe(true);
    expect(
      (await fixture.query("SELECT credit_balance::text FROM organizations WHERE id=$1", [org]))
        .rows[0]?.credit_balance,
    ).toBe("1.000000");
    deletions += 1;
  };
  const { SandboxReplacementCleanup } = await import(
    "./eliza-sandbox/lifecycle/replacement-cleanup"
  );
  const { SandboxLifecycleAuthority } = await import("./eliza-sandbox/lifecycle/authority");
  const authority = new SandboxLifecycleAuthority();
  const cleanup = new SandboxReplacementCleanup({
    lockLifecycle: authority.lockLifecycle.bind(authority),
    getAgentForLifecycleMutation: authority.getAgentForLifecycleMutation.bind(authority),
    hasActiveExclusiveLifecycleJobTx: authority.hasActiveExclusiveLifecycleJobTx.bind(authority),
    isReplacementCleanupSweepEligibleTx:
      authority.isReplacementCleanupSweepEligibleTx.bind(authority),
    getProvider: async () => provider,
  });
  await expect(
    cleanup.retirePersistedReplacementCleanup(agentId, org, undefined, undefined, "lifecycle", {
      ...handle,
      metadata: { ...handle.metadata, containerId: "6".repeat(64) },
    }),
  ).rejects.toThrow(/identity changed/);
  expect(deletions).toBe(0);
  expect(
    (
      await fixture.query("SELECT settled_at FROM agent_compute_funding WHERE id=$1", [
        paid.window.id,
      ])
    ).rows[0],
  ).toEqual({ settled_at: null });
  await fixture.exec(`CREATE FUNCTION reject_cleanup_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${agentId}' AND NEW.replacement_cleanup_node_id IS NULL THEN RAISE EXCEPTION 'forced cleanup release rollback'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_cleanup_release BEFORE UPDATE ON agent_sandboxes FOR EACH ROW EXECUTE FUNCTION reject_cleanup_release();`);
  await expect(
    cleanup.retirePersistedReplacementCleanup(
      agentId,
      org,
      undefined,
      undefined,
      "lifecycle",
      handle,
    ),
  ).rejects.toMatchObject({ cause: { message: "forced cleanup release rollback" } });
  expect(deletions).toBe(1);
  expect(
    (
      await fixture.query(
        "SELECT replacement_cleanup_container_id FROM agent_sandboxes WHERE id=$1",
        [agentId],
      )
    ).rows[0]?.replacement_cleanup_container_id,
  ).toBe(containerId);
  await fixture.exec(
    "DROP TRIGGER reject_cleanup_release ON agent_sandboxes; DROP FUNCTION reject_cleanup_release()",
  );
  expect(
    await cleanup.retirePersistedReplacementCleanup(
      agentId,
      org,
      undefined,
      undefined,
      "lifecycle",
      handle,
    ),
  ).toBe("retired");
  expect(deletions).toBe(2);
  expect(
    (
      await fixture.query(
        "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
        [org],
      )
    ).rows[0]?.n,
  ).toBe(2);
  expect(await cleanup.retirePersistedReplacementCleanup(agentId, org)).toBe("clean");
});

test("failed-restore admission keeps its paid container and requires a verified stop and fresh funds", async () => {
  const { org, agentId, identity, provider, input } = await billableFundedAgent(
    "000000000036",
    "1.000000",
  );
  const { agentSandboxesRepository: agents } = await import(
    "../../db/repositories/agent-sandboxes"
  );
  const { reserveProvisionCompute } = await import("./agent-compute-provision");
  const { settleStoppedAgentComputeInTransaction: settle } = await import("./agent-compute-stop");
  await fixture.query(
    "UPDATE agent_sandboxes SET status='provisioning',sandbox_id=$2,container_name=$2,bridge_port=2138,web_ui_port=2138,bridge_url=NULL,health_url=NULL WHERE id=$1",
    [agentId, `agent-${agentId}`],
  );
  const current = (await agents.findByIdAndOrg(agentId, org))!;
  const existing = await reserveProvisionCompute(current);
  expect(existing.retained).toBe(true);
  expect(existing.window.id).toBe(provider.fundingId);
  const receipt = await stopReceiptFor(provider.fundingId, input.now);
  await helpers.writeTransaction((tx) =>
    settle(tx, { ...identity, fundingId: provider.fundingId }, receipt),
  );
  await fixture.query("UPDATE organizations SET credit_balance=0 WHERE id=$1", [org]);
  const before = await renewalState(org);
  await expect(reserveProvisionCompute(current)).rejects.toMatchObject({
    code: funding.SUBSCRIPTION_FUNDING_INSUFFICIENT,
  });
  expect(await renewalState(org)).toEqual(before);
  await fixture.query("UPDATE organizations SET credit_balance=1 WHERE id=$1", [org]);
  const stopProof = (
    await fixture.query(
      "SELECT provider_stop_receipt,provider_stopped_at FROM agent_compute_funding WHERE id=$1",
      [provider.fundingId],
    )
  ).rows[0]!;
  await fixture.query(
    "UPDATE agent_compute_funding SET provider_stop_receipt=NULL,provider_stopped_at=NULL WHERE id=$1",
    [provider.fundingId],
  );
  await expect(reserveProvisionCompute(current)).rejects.toMatchObject({
    code: "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED",
  });
  await fixture.query(
    "UPDATE agent_compute_funding SET provider_stop_receipt=$2,provider_stopped_at=$3 WHERE id=$1",
    [
      provider.fundingId,
      JSON.stringify(stopProof.provider_stop_receipt),
      stopProof.provider_stopped_at,
    ],
  );
  await fixture.query("UPDATE agent_sandboxes SET node_id='other-node' WHERE id=$1", [agentId]);
  await expect(reserveProvisionCompute(current)).rejects.toMatchObject({
    code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED",
  });
  await fixture.query("UPDATE agent_sandboxes SET node_id=$2 WHERE id=$1", [
    agentId,
    provider.nodeId,
  ]);
  const next = await reserveProvisionCompute(current);
  expect(next.retained).toBe(true);
  expect(next.window.previous_funding_id).toBe(provider.fundingId);
  expect(next.window.provider_container_id).toBe(provider.containerId);
  expect(next.agent.bridge_url).toBeNull();
  const once = await renewalState(org);
  const replay = await reserveProvisionCompute(next.agent);
  expect(replay.window.id).toBe(next.window.id);
  expect(replay.retained).toBe(true);
  expect(await renewalState(org)).toEqual(once);
  const { settleAgentBringUpBilling } = await import("./agent-compute-provision");
  expect(await settleAgentBringUpBilling(replay.agent)).toEqual({
    status: "already_billed_recently",
  });
  expect(await renewalState(org)).toEqual(once);
  await expect(
    settleAgentBringUpBilling({
      ...replay.agent,
      environment_revision: replay.agent.environment_revision + 1,
    }),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED" });
  await expect(
    settleAgentBringUpBilling({
      ...replay.agent,
      lifecycle_execution_generation: crypto.randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED" });
  expect(await renewalState(org)).toEqual(once);
});

test("provision completion commits readiness with running state and rejects stale or rolled-back publication", async () => {
  const { org, agentId, provider } = await billableFundedAgent("000000000037", "1.000000");
  const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
  const { completeProvisionCompute, reserveProvisionCompute } = await import(
    "./agent-compute-provision"
  );
  const name = `agent-${agentId}`;
  const handle = {
    sandboxId: name,
    bridgeUrl: "http://192.0.2.1:2138",
    healthUrl: "http://192.0.2.1:2138/api",
    metadata: {
      provider: "docker",
      nodeId: provider.nodeId,
      containerId: provider.containerId,
      containerName: name,
      hostname: "192.0.2.1",
    },
  };
  await fixture.query(
    "UPDATE agent_sandboxes SET status='provisioning',sandbox_id=$2,container_name=$2,bridge_url=$3,health_url=$4,bridge_port=2138,web_ui_port=2138 WHERE id=$1",
    [agentId, name, handle.bridgeUrl, handle.healthUrl],
  );
  await fixture.query("UPDATE agent_compute_funding SET runtime_ready_at=NULL WHERE id=$1", [
    provider.fundingId,
  ]);
  const capture = (await agentSandboxesRepository.findByIdAndOrg(agentId, org))!;
  const before = await renewalState(org);
  await expect(
    completeProvisionCompute(
      { ...capture, environment_revision: capture.environment_revision + 1 },
      provider.fundingId,
      handle,
    ),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED" });
  await expect(
    completeProvisionCompute(capture, provider.fundingId, {
      ...handle,
      metadata: { ...handle.metadata, containerId: "d".repeat(64) },
    }),
  ).rejects.toMatchObject({ code: "AGENT_COMPUTE_FUNDING_AUTHORITY_CHANGED" });
  expect(await renewalState(org)).toEqual(before);
  await fixture.exec(`CREATE FUNCTION reject_ready_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${agentId}' AND NEW.status='running' THEN RAISE EXCEPTION 'forced readiness publication rollback'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER reject_ready_publication BEFORE UPDATE ON agent_sandboxes FOR EACH ROW EXECUTE FUNCTION reject_ready_publication();`);
  try {
    await expect(
      completeProvisionCompute(capture, provider.fundingId, handle),
    ).rejects.toMatchObject({ cause: { message: "forced readiness publication rollback" } });
    expect(await renewalState(org)).toEqual(before);
    expect((await agentSandboxesRepository.findByIdAndOrg(agentId, org))?.status).toBe(
      "provisioning",
    );
  } finally {
    await fixture.exec(
      "DROP TRIGGER reject_ready_publication ON agent_sandboxes; DROP FUNCTION reject_ready_publication()",
    );
  }
  expect((await completeProvisionCompute(capture, provider.fundingId, handle)).status).toBe(
    "running",
  );
  expect((await renewalState(org)).windows[0]?.runtime_ready_at).toBeInstanceOf(Date);
  await fixture.query("UPDATE agent_sandboxes SET status='provisioning' WHERE id=$1", [agentId]);
  const retry = (await agentSandboxesRepository.findByIdAndOrg(agentId, org))!;
  await reserveProvisionCompute(retry);
  expect((await renewalState(org)).windows[0]?.runtime_ready_at).toBeNull();
  expect((await renewalState(org)).balance).toEqual(before.balance);
});

if (postgresTestUrl) {
  test("paid agent deletion serializes against concurrent funding in both commit orders", async () => {
    if (!postgresPool) throw new Error("PostgreSQL concurrency requires the isolated pool");
    for (const fundingFirst of [true, false]) {
      const agentId = crypto.randomUUID();
      const operation = `compute.concurrent-delete.${agentId}`;
      await fixture.query(
        "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision) VALUES($1,$2,'provisioning','dedicated-always',1)",
        [agentId, organizationId],
      );
      const held = await helpers.writeTransaction((tx) =>
        funding.subscriptionFundingService.reserveInTransaction(tx, input(operation, "0.300000")),
      );
      const first = await postgresPool.connect();
      const second = await postgresPool.connect();
      let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
      try {
        await first.query("BEGIN");
        await second.query("BEGIN");
        const {
          rows: [{ pid }],
        } = await second.query("SELECT pg_backend_pid() AS pid");
        const insert = (connection: typeof first) =>
          connection.query(
            "INSERT INTO agent_compute_funding(id,agent_id,organization_id,funding_reservation_id,period_start,period_end,hourly_rate) VALUES(gen_random_uuid(),$1,$2,$3,now(),now()+interval '2 hours',0.15)",
            [agentId, organizationId, held.reservation.id],
          );
        const remove = (connection: typeof first) =>
          connection.query("DELETE FROM agent_sandboxes WHERE id=$1", [agentId]);
        await (fundingFirst ? insert(first) : remove(first));
        pending = (fundingFirst ? remove(second) : insert(second)).then(
          () => ({ ok: true }),
          (error) => ({ ok: false, error }),
        );
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const activity = await fixture.query(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waiting = true;
            break;
          }
          await Bun.sleep(20);
        }
        expect(waiting).toBe(true);
        await first.query("COMMIT");
        const outcome = await pending;
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toMatchObject({
          message: fundingFirst
            ? "Unsettled compute must be stopped before agent deletion"
            : "Compute funding requires a live tenant agent",
        });
        await second.query("ROLLBACK");
        expect(
          (await fixture.query("SELECT id FROM agent_sandboxes WHERE id=$1", [agentId])).rows,
        ).toHaveLength(fundingFirst ? 1 : 0);
        expect(
          (await fixture.query("SELECT id FROM agent_compute_funding WHERE agent_id=$1", [agentId]))
            .rows,
        ).toHaveLength(fundingFirst ? 1 : 0);
      } finally {
        await first.query("ROLLBACK");
        await second.query("ROLLBACK");
        await pending;
        first.release();
        second.release();
      }
    }
  });
}

if (sshFixturePath) {
  async function runPaidContainerScenario(
    scenario:
      | "worker"
      | "sleep"
      | "billing-sleep"
      | "billing-topup"
      | "billing-held"
      | "billing-stale"
      | "user-suspend"
      | "user-suspend-stale"
      | "user-suspend-backup-failure"
      | "shutdown"
      | "restart"
      | "deletion"
      | "warm",
  ) {
    const billingScenario =
      scenario === "billing-sleep" ||
      scenario === "billing-topup" ||
      scenario === "billing-held" ||
      scenario === "billing-stale";
    const userStopScenario =
      scenario === "user-suspend" ||
      scenario === "user-suspend-stale" ||
      scenario === "user-suspend-backup-failure";
    const stopIntentScenario = billingScenario || userStopScenario;
    const sleepScenario = scenario === "sleep" || stopIntentScenario;
    const target = z
      .object({
        hostname: z.ipv4(),
        port: z.number().int().min(1).max(65535),
        username: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
        hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/),
        image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .parse(JSON.parse(await readFile(sshFixturePath, "utf8")));
    const { DockerSSHClient } = await import("./docker-ssh");
    const { shellQuote } = await import("./docker-sandbox-utils");
    const guard = await import("./docker-compute-lease");
    const { ProvisioningJobService } = await import("./provisioning-jobs");
    const { JOB_TYPES } = await import("./provisioning-job-types");
    const ssh = new DockerSSHClient(target);
    const rootSSH = guard.dockerComputeRootSSH(ssh, target.username);
    const docker = target.username === "root" ? "docker" : "sudo --non-interactive docker";
    const suffix =
      scenario === "user-suspend-backup-failure"
        ? "000000000067"
        : scenario === "user-suspend-stale"
          ? "000000000066"
          : scenario === "user-suspend"
            ? "000000000065"
            : scenario === "billing-held"
              ? "000000000064"
              : scenario === "billing-topup"
                ? "000000000048"
                : scenario === "billing-stale"
                  ? "000000000049"
                  : scenario === "billing-sleep"
                    ? "000000000047"
                    : scenario === "worker"
                      ? "000000000041"
                      : sleepScenario
                        ? "000000000042"
                        : scenario === "shutdown"
                          ? "000000000043"
                          : scenario === "restart"
                            ? "000000000044"
                            : scenario === "deletion"
                              ? "000000000045"
                              : "000000000046";
    const agentId = `63000000-0000-4000-8000-${suffix}`;
    const org = `61000000-0000-4000-8000-${suffix}`;
    const name = `agent-${agentId}`;
    const nodeId = `worker-test-${crypto.randomUUID()}`;
    const backupId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const marker = crypto.randomUUID();
    const token = `test-${crypto.randomUUID()}`;
    const state = {
      memories: [],
      config: { checkpoint: marker },
      workspaceFiles: { "saved.txt": marker },
    };
    const directory = await mkdtemp(join(tmpdir(), "eliza-paid-worker-"));
    const children: ReturnType<typeof Bun.spawn>[] = [];
    let containerId: string | undefined;
    const ownedContainerIds: string[] = [];
    let ownsGuard = false;
    let ownsBillingRevisionTrigger = false;
    let ownsBillingIntentTable = false;
    let originalRunning: string[] = [];
    let releaseRestore = () => {};
    const firstRestoreBlocked = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let sawRestore = () => {};
    const firstRestore = new Promise<void>((resolve) => {
      sawRestore = resolve;
    });
    let restoreRequests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 120,
      async fetch(request) {
        if (request.headers.get("authorization") !== `Bearer ${token}`)
          return new Response("unauthorized", { status: 401 });
        const body = await request.text();
        expect(JSON.parse(body)).toEqual(state);
        restoreRequests++;
        if (scenario === "worker" && restoreRequests === 1) {
          sawRestore();
          await firstRestoreBlocked;
          return Response.json({ ok: true });
        }
        await rootSSH.execStdin(
          `${docker} exec -i ${containerId} node -e ${shellQuote("let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>require('fs').writeFileSync('/tmp/worker-restored-state.json',b))")}`,
          body,
        );
        return Response.json({ ok: true });
      },
    });
    const spawnWorker = async (recover: boolean) => {
      const configPath = join(directory, `${recover ? "replacement" : "initial"}.json`);
      const logPath = join(directory, `${recover ? "replacement" : "initial"}.log`);
      await writeFile(
        configPath,
        JSON.stringify({
          agentId,
          organizationId: org,
          backupId,
          token,
          restoreUrl: server.url.toString(),
          recover,
          state,
        }),
        { mode: 0o600 },
      );
      await writeFile(logPath, "", { mode: 0o600 });
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("./eliza-sandbox/test-support/paid-restore-worker.ts", import.meta.url).pathname,
        ],
        {
          env: { ...process.env, NODE_ENV: "test", COMPUTE_FUNDING_WORKER_FIXTURE: configPath },
          stdout: Bun.file(logPath),
          stderr: Bun.file(logPath),
        },
      );
      children.push(child);
      return { child, logPath };
    };
    const jobState = async () =>
      (
        await fixture.query(
          "SELECT status,execution_generation,execution_interruptions,attempts FROM jobs WHERE id=$1",
          [jobId],
        )
      ).rows[0];
    const readyState = async () =>
      (
        await fixture.query(
          "SELECT a.status,f.runtime_ready_at FROM agent_sandboxes a JOIN agent_compute_funding f ON f.agent_id=a.id AND f.settled_at IS NULL WHERE a.id=$1",
          [agentId],
        )
      ).rows[0];
    await ssh.connect();
    try {
      originalRunning = (await ssh.exec(`${docker} ps -q --no-trunc`))
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      await rootSSH.execStdin(
        "python3 -",
        "from pathlib import Path\nassert not Path('/var/lib/eliza/compute-leases').exists()\nassert not Path('/etc/systemd/system/eliza-compute-guard.service').exists()\n",
      );
      containerId = (
        await ssh.exec(
          [
            `${docker} create --pull=never --network=none --memory=128m --cpus=0.2 --pids-limit=64 --env PORT=2138`,
            `--health-interval=1s --health-timeout=5s --health-retries=10 --health-cmd ${shellQuote(`node -e "fetch('http://127.0.0.1:2138/api/health').then(r=>process.exit(r.ok?0:1))"`)}`,
            "--cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --restart=no",
            `--name ${name} --label ai.elizaos.managed-by=eliza-cloud --label ai.elizaos.container-class=test --label ai.elizaos.agent-id=${agentId} --label ai.elizaos.org-id=${org}`,
            `--entrypoint node ${shellQuote(target.image)} -e ${shellQuote("require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true}))).listen(2138,'127.0.0.1')")}`,
          ].join(" "),
        )
      ).trim();
      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      ownedContainerIds.push(containerId);
      const { dockerNodes } = await import("../../db/schemas/docker-nodes");
      await fixture.exec(
        `CREATE TABLE IF NOT EXISTS docker_nodes (${getTableConfig(dockerNodes)
          .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
          .join(", ")})`,
      );
      await fixture.query(
        "INSERT INTO docker_nodes(id,node_id,hostname,ssh_port,ssh_user,host_key_fingerprint) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)",
        [nodeId, target.hostname, target.port, target.username, target.hostKeyFingerprint],
      );
      const { compute, provider } = await billableFundedAgent(
        suffix,
        billingScenario ? "0.300000" : "1.000000",
        {
          nodeId,
          containerId,
        },
      );
      if (scenario === "billing-sleep" || scenario === "billing-stale") {
        // Start with enough paid time for the real host's admission margin,
        // then let this same lease reach retirement naturally below.
        await fixture.query(
          "UPDATE agent_compute_funding SET period_end=clock_timestamp()+interval '150 seconds' WHERE id=$1",
          [provider.fundingId],
        );
      }
      await fixture.query(
        "UPDATE agent_sandboxes SET status='provisioning',sandbox_id=$2,container_name=$2,bridge_port=2138,web_ui_port=2138,environment_revision=1,database_status='ready',database_uri='postgres://fixture.invalid/retained',environment_vars=$3,quota_admission_scope='trusted_internal' WHERE id=$1",
        [agentId, name, JSON.stringify({ ELIZA_API_TOKEN: token })],
      );
      await fixture.query("UPDATE agent_compute_funding SET runtime_ready_at=NULL WHERE id=$1", [
        provider.fundingId,
      ]);
      const authorization = await helpers.writeTransaction((tx) =>
        compute.authorizeHostInTransaction(tx, provider),
      );
      ownsGuard = true;
      await guard.installDockerComputeGuard(rootSSH);
      await guard.grantDockerComputeLease(rootSSH, authorization);
      await guard.startDockerComputeLease(rootSSH, authorization);
      await ssh.exec(
        `${docker} exec ${containerId} /bin/sh -c ${shellQuote(`printf '%s' '${marker}' > /tmp/worker-marker`)}`,
      );
      const startedAt = (
        await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${containerId}`)
      ).trim();
      if (scenario === "worker") {
        await fixture.query(
          "INSERT INTO jobs(id,type,status,data,organization_id,agent_id,data_storage,result_storage,error_storage,execution_interruptions,retryable_requeues,attempts,max_attempts,scheduled_for) VALUES($1,$2,'pending',$3,$4,$5,'inline','inline','inline',0,0,0,3,now())",
          [
            jobId,
            JOB_TYPES.AGENT_WAKE,
            JSON.stringify({
              agentId,
              organizationId: org,
              userId: "64000000-0000-4000-8000-000000000041",
              restoreBackupId: backupId,
            }),
            org,
            agentId,
          ],
        );
        const initial = await spawnWorker(false);
        // If the worker fails before restore, emit its bounded fixture-only log.
        await Promise.race([
          firstRestore,
          initial.child.exited.then(async () => {
            throw new Error(
              `Worker exited before restore: ${(await readFile(initial.logPath, "utf8")).slice(-8000)}`,
            );
          }),
          Bun.sleep(60_000).then(() => {
            throw new Error("Worker did not reach restore within 60 seconds");
          }),
        ]);
        expect(await readyState()).toEqual({ status: "provisioning", runtime_ready_at: null });
        const claimed = await jobState();
        expect(claimed).toMatchObject({
          status: "in_progress",
          execution_interruptions: 0,
          attempts: 0,
        });
        expect(claimed?.execution_generation).toBeString();
        const paidBeforeKill = await renewalState(org);
        expect(paidBeforeKill.windows).toHaveLength(1);
        expect(paidBeforeKill.reservations).toHaveLength(1);
        initial.child.kill("SIGKILL");
        await initial.child.exited;
        releaseRestore();
        expect(await jobState()).toEqual(claimed);
        expect(await readyState()).toEqual({ status: "provisioning", runtime_ready_at: null });
        expect(await renewalState(org)).toEqual(paidBeforeKill);
        const recovery = new ProvisioningJobService();
        await recovery.recoverInterruptedJobsOnStartup(new Date(), [JOB_TYPES.AGENT_WAKE]);
        expect(await jobState()).toEqual(claimed);
        const lease = (
          await fixture.query<{ wait_ms: number }>(
            "SELECT GREATEST(0, EXTRACT(EPOCH FROM (expires_at+interval '30 seconds'-clock_timestamp()))*1000)::integer AS wait_ms FROM job_execution_leases WHERE job_id=$1",
            [jobId],
          )
        ).rows[0];
        if (!lease) throw new Error("Claimed worker lease is missing");
        expect(lease.wait_ms).toBeGreaterThan(30_000);
        process.stdout.write(
          `Waiting ${lease.wait_ms}ms for actual dead-worker lease expiry and takeover grace\n`,
        );
        await Bun.sleep(lease.wait_ms + 250);
        const replacement = await spawnWorker(true);
        const exit = await replacement.child.exited;
        if (exit !== 0)
          throw new Error(
            `Replacement failed: ${(await readFile(replacement.logPath, "utf8")).slice(-8000)}`,
          );
        expect(exit).toBe(0);
        const completed = await jobState();
        expect(completed).toMatchObject({
          status: "completed",
          execution_interruptions: 1,
          attempts: 0,
        });
        expect(completed?.execution_generation).not.toBe(claimed?.execution_generation);
        expect(await readyState()).toEqual({
          status: "running",
          runtime_ready_at: expect.any(Date),
        });
        const paidAfter = await renewalState(org);
        expect({ ...paidAfter, windows: [] }).toEqual({ ...paidBeforeKill, windows: [] });
        expect(paidAfter.windows).toHaveLength(1);
        expect(paidAfter.windows[0]).toMatchObject({
          id: provider.fundingId,
          provider_container_id: containerId,
        });
        expect({ ...paidAfter.windows[0], runtime_ready_at: null }).toEqual(
          paidBeforeKill.windows[0],
        );
        expect(restoreRequests).toBe(2);
        expect(
          (await ssh.exec(`${docker} exec ${containerId} cat /tmp/worker-marker`)).trim(),
        ).toBe(marker);
        expect(
          JSON.parse(
            await ssh.exec(`${docker} exec ${containerId} cat /tmp/worker-restored-state.json`),
          ),
        ).toEqual(state);
        expect(
          (
            await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${containerId}`)
          ).trim(),
        ).toBe(startedAt);
      } else {
        await fixture.query(
          "UPDATE agent_sandboxes SET status='running',bridge_url=$2,health_url=$3,deletion_previous_status='running',deletion_previous_billing_status='active' WHERE id=$1",
          [agentId, `http://${target.hostname}:2138`, `http://${target.hostname}:2138/api`],
        );
        await fixture.query(
          "UPDATE agent_compute_funding SET runtime_ready_at=clock_timestamp() WHERE id=$1",
          [provider.fundingId],
        );
        const { ElizaSandboxService } = await import("./eliza-sandbox");
        const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
        const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
        const { agentSandboxBackups, agentSandboxes } = await import(
          "../../db/schemas/agent-sandboxes"
        );
        await fixture.exec(
          `CREATE TABLE IF NOT EXISTS agent_sandbox_backups (${getTableConfig(agentSandboxBackups)
            .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
            .join(", ")})`,
        );
        const { containers } = await import("../../db/schemas/containers");
        await fixture.exec(
          `CREATE TABLE IF NOT EXISTS containers (${getTableConfig(containers)
            .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
            .join(", ")})`,
        );
        await fixture.query(
          "INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,node_id) VALUES($3,$1,'running','dedicated-always',1,$2)",
          [org, nodeId, crypto.randomUUID()],
        );
        await fixture.query(
          "UPDATE docker_nodes SET allocated_count=2,capacity=2,enabled=true,placement_state='open',status='healthy' WHERE node_id=$1",
          [nodeId],
        );
        const allocated = async () =>
          (
            await fixture.query("SELECT allocated_count FROM docker_nodes WHERE node_id=$1", [
              nodeId,
            ])
          ).rows[0]?.allocated_count;
        if (scenario === "deletion") {
          const { apiKeys } = await import("../../db/schemas/api-keys");
          await fixture.exec(
            `CREATE TABLE IF NOT EXISTS api_keys (${getTableConfig(apiKeys)
              .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
              .join(", ")})`,
          );
        }
        const sleepProvider = new DockerSandboxProvider();
        const service = new ElizaSandboxService(sleepProvider);
        let billingJobId: string | undefined;
        if (stopIntentScenario) {
          const migration = (name: string) =>
            readFile(new URL(`../../db/migrations/${name}`, import.meta.url), "utf8");
          const recovery = await migration("0265_compute_billing_recovery.sql");
          const intentDDL = recovery.match(
            /CREATE TABLE agent_compute_stop_intents \([\s\S]*?\n\);/,
          );
          if (!intentDDL) throw new Error("Missing canonical stop intent DDL");
          await fixture.exec(intentDDL[0]);
          ownsBillingIntentTable = true;
          for (const statement of (
            await migration("0334_billing_cancel_intent_authority.sql")
          ).split("--> statement-breakpoint")) {
            if (statement.includes('"agent_compute_stop_intents"')) await fixture.exec(statement);
          }
          // Exercise the real revision trigger: this stop changes the generation
          // before the second removal transaction and before a crash retry.
          await fixture.exec(await migration("0189_agent_sandbox_lifecycle_revision_scope.sql"));
          ownsBillingRevisionTrigger = true;
          if (scenario === "billing-sleep" || scenario === "billing-stale") {
            const { AGENT_COMPUTE_RETIREMENT_LEAD_MS } = await import("./agent-compute-policy");
            const { rows } = await fixture.query<{ wait_ms: number }>(
              "SELECT GREATEST(0, EXTRACT(EPOCH FROM (period_end-clock_timestamp()))*1000-$2)::float8 AS wait_ms FROM agent_compute_funding WHERE id=$1",
              [provider.fundingId, AGENT_COMPUTE_RETIREMENT_LEAD_MS],
            );
            const waitMs = rows[0]!.wait_ms;
            expect(waitMs).toBeLessThanOrEqual(30_000);
            await Bun.sleep(Math.ceil(waitMs) + 50);
          }
          const suspended = await new ProvisioningJobService().enqueueAgentSuspendOnce({
            agentId,
            organizationId: org,
            userId: `64000000-0000-4000-8000-${suffix}`,
            authorization: userStopScenario ? "user_request" : "billing_request",
          });
          billingJobId = suspended.job.id;
        }
        const finalStatus = sleepScenario ? "sleeping" : "stopped";
        const retire = async () => {
          if (billingJobId) {
            const { rows } = await fixture.query<{ lifecycle_revision: number }>(
              "SELECT lifecycle_revision FROM agent_compute_stop_intents WHERE job_id=$1",
              [billingJobId],
            );
            const result = await service.executeSuspend(
              agentId,
              org,
              billingJobId,
              // A stale queue hint must not override the persisted user intent.
              "billing_request",
              Number(rows[0]!.lifecycle_revision),
            );
            return { ...result, containerRemoved: result.containerStopped };
          }
          return sleepScenario
            ? service.executeSleep(agentId, org)
            : scenario === "shutdown"
              ? service.shutdown(agentId, org)
              : scenario === "restart"
                ? service.executeRestart(agentId, org)
                : scenario === "deletion"
                  ? service.deleteAgent(agentId, org, { authorization: "user_request" })
                  : (
                      service as unknown as {
                        retireFailedWarmClaimForRetry: import("./eliza-sandbox/lifecycle/warm-claim").SandboxWarmClaim["retireFailedWarmClaimForRetry"];
                      }
                    ).retireFailedWarmClaimForRetry(agentId, org);
        };
        if (scenario === "restart")
          await fixture.query(
            "UPDATE agent_sandboxes SET claimed_at=now(),warm_claim_credential_state='ready' WHERE id=$1",
            [agentId],
          );
        const comparableMoney = (value: Awaited<ReturnType<typeof renewalState>>) => ({
          ...value,
          ledger: value.ledger.filter((entry) => Number(entry.amount) !== 0),
        });
        // Snapshot transport and verified plaintext backup storage are explicit
        // fixtures. Lifecycle transactions, monetary settlement, host stop,
        // provider removal and restore-gate reads remain real.
        const capture = spyOn(
          service as unknown as {
            fetchSnapshotState: () => Promise<{
              stateData: typeof state;
              sizeBytes: number;
              bridgeUrl: string;
            }>;
          },
          "fetchSnapshotState",
        ).mockImplementation(async () => {
          expect(
            (await ssh.exec(`${docker} exec ${containerId} cat /tmp/worker-marker`)).trim(),
          ).toBe(marker);
          if (scenario === "user-suspend-backup-failure") {
            throw new Error("user-stop capture unavailable");
          }
          if (scenario === "billing-topup") {
            await fixture.query(
              "UPDATE organizations SET credit_balance=credit_balance+1 WHERE id=$1",
              [org],
            );
          }
          return {
            stateData: state,
            sizeBytes: JSON.stringify(state).length,
            bridgeUrl: `http://${target.hostname}:2138`,
          };
        });
        const persist = spyOn(
          service as unknown as {
            persistSnapshotWithinTransaction: import("./eliza-sandbox/backup/service").SandboxBackup["persistSnapshotWithinTransaction"];
          },
          "persistSnapshotWithinTransaction",
        ).mockImplementation(async (tx, id, owner, type, data, sizeBytes) => {
          await tx.insert(agentSandboxBackups).values({
            id: backupId,
            sandbox_record_id: id,
            snapshot_type: type,
            state_data: data,
            size_bytes: sizeBytes,
            state_data_storage: "inline",
            backup_kind: "full",
            verification_status: "verified",
            verified_at: new Date(),
            created_at: new Date(),
          });
          await tx
            .update(agentSandboxes)
            .set({ last_backup_at: new Date() })
            .where(sql`id=${id} AND organization_id=${owner}`);
          const saved = await tx
            .select({ lifecycleRevision: agentSandboxes.lifecycle_revision })
            .from(agentSandboxes)
            .where(sql`id=${id} AND organization_id=${owner}`);
          return { backupId, lifecycleRevision: saved[0]!.lifecycleRevision };
        });
        if (scenario === "warm") {
          await fixture.query(
            "UPDATE agent_sandboxes SET status='error',claimed_at=now(),warm_claim_credential_state='failed',warm_claim_cleanup_completed_at=now() WHERE id=$1",
            [agentId],
          );
          // A retained backup is already present; failed-claim cleanup must keep it.
          await helpers.writeTransaction((tx) =>
            (
              service as unknown as {
                persistSnapshotWithinTransaction: import("./eliza-sandbox/backup/service").SandboxBackup["persistSnapshotWithinTransaction"];
              }
            ).persistSnapshotWithinTransaction(
              tx,
              agentId,
              org,
              "pre-shutdown",
              state,
              JSON.stringify(state).length,
            ),
          );
        }
        const remove =
          scenario === "deletion"
            ? spyOn(sleepProvider, "stopForDeletion")
            : spyOn(sleepProvider, "stopForReplacement");
        remove.mockRejectedValueOnce(
          new Error("Removal transport unavailable after committed paid stop"),
        );
        const canonical = async () =>
          (
            await fixture.query(
              "SELECT status,sandbox_id,last_backup_at FROM agent_sandboxes WHERE id=$1",
              [agentId],
            )
          ).rows[0];
        try {
          if (scenario === "user-suspend-backup-failure") {
            const allocationBeforeStop = await allocated();
            expect(await retire()).toMatchObject({
              success: true,
              containerStopped: true,
            });
            expect(remove).not.toHaveBeenCalled();
            expect(persist).not.toHaveBeenCalled();
            expect(
              (
                await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)
              ).trim(),
            ).toBe("false");
            expect(
              (
                await ssh.exec(`${docker} cp ${containerId}:/tmp/worker-marker - | tar -xOf -`)
              ).trim(),
            ).toBe(marker);
            expect(await canonical()).toEqual({
              status: "stopped",
              sandbox_id: name,
              last_backup_at: null,
            });
            expect(await allocated()).toBe(allocationBeforeStop);
            const stopped = await renewalState(org);
            expect(stopped.windows).toHaveLength(1);
            expect(stopped.windows[0]).toMatchObject({
              settled_at: expect.any(Date),
              provider_stop_receipt: expect.any(Object),
              retirement_backup_id: null,
            });
            expect(stopped.reservations[0]?.status).toBe("finalized");
            expect(await retire()).toMatchObject({ success: true, containerStopped: true });
            expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
            expect(remove).not.toHaveBeenCalled();
            return;
          }
          if (scenario === "billing-topup" || scenario === "billing-held") {
            expect(await retire()).toMatchObject({
              success: true,
              skipped: true,
              reason: "billing_recovered",
              containerStopped: false,
            });
            expect(remove).not.toHaveBeenCalled();
            expect(
              (
                await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)
              ).trim(),
            ).toBe("true");
            expect(persist).not.toHaveBeenCalled();
            expect(
              (
                await fixture.query(
                  "SELECT status,last_error FROM agent_compute_stop_intents WHERE job_id=$1",
                  [billingJobId],
                )
              ).rows,
            ).toEqual([
              scenario === "billing-topup"
                ? { status: "superseded", last_error: "billing_recovered" }
                : { status: "retry", last_error: "existing_runtime_funded" },
            ]);
            return;
          }
          expect(await retire()).toMatchObject({
            success: false,
            error:
              scenario === "warm"
                ? "Failed to retire the previous warm-claim container"
                : scenario === "deletion"
                  ? "Failed to delete sandbox"
                  : sleepScenario
                    ? "Removal transport unavailable after committed paid stop"
                    : "Failed to prove the previous sandbox stopped",
          });
          expect(await canonical()).toEqual({
            status: scenario === "deletion" ? "deletion_pending" : "stopped",
            sandbox_id: name,
            last_backup_at: expect.any(Date),
          });
          expect(
            (
              await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)
            ).trim(),
          ).toBe("false");
          expect(
            (
              await fixture.query(
                "SELECT state_data FROM agent_sandbox_backups WHERE sandbox_record_id=$1",
                [agentId],
              )
            ).rows,
          ).toEqual([{ state_data: state }]);
          const stopped = await renewalState(org);
          expect(await allocated()).toBe(scenario === "deletion" ? 2 : 1);
          if (scenario === "deletion") {
            expect(await service.cancelAgentDeletion(agentId, org)).toMatchObject({
              success: false,
              error: "Agent deletion does not have a reversible running-state receipt",
            });
          }
          expect(stopped.windows).toHaveLength(1);
          expect(stopped.windows[0]).toMatchObject({
            settled_at: expect.any(Date),
            provider_stop_receipt: expect.any(Object),
          });
          expect(stopped.reservations[0]?.status).toBe("finalized");
          if (scenario === "billing-stale" || scenario === "user-suspend-stale") {
            const removals = remove.mock.calls.length;
            await fixture.query(
              "UPDATE agent_sandboxes SET environment_revision=environment_revision+1 WHERE id=$1",
              [agentId],
            );
            expect(await retire()).toMatchObject({
              success: true,
              skipped: true,
              reason: "lifecycle_changed",
              containerStopped: false,
            });
            expect(remove.mock.calls).toHaveLength(removals);
            expect(
              (
                await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)
              ).trim(),
            ).toBe("false");
            expect((await agentSandboxesRepository.getBackupById(backupId))?.state_data).toEqual(
              state,
            );
            return;
          }
          if (sleepScenario) {
            // A restorable backup alone cannot authorize deleting a retained
            // container: its latest writes may have happened after that backup.
            const removals = remove.mock.calls.length;
            await fixture.query(
              "UPDATE agent_compute_funding SET retirement_backup_id=NULL WHERE id=$1",
              [provider.fundingId],
            );
            expect(await retire()).toMatchObject({
              success: false,
              containerRemoved: false,
              error: "Stopped Dedicated state has no backup bound to its paid stop",
            });
            expect(remove.mock.calls).toHaveLength(removals);
            expect(
              (
                await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)
              ).trim(),
            ).toBe("false");
            // Restore the exact attestation originally committed with this stop;
            // a later invocation must recover without another live capture.
            await fixture.query(
              "UPDATE agent_compute_funding SET retirement_backup_id=$2 WHERE id=$1",
              [provider.fundingId, backupId],
            );
          }
          expect(
            (
              await fixture.query(
                "SELECT o.credit_balance+a.total_billed=$2::numeric AS reconciled FROM organizations o JOIN agent_sandboxes a ON a.organization_id=o.id WHERE a.id=$1",
                [agentId, billingScenario ? "0.300000" : "1.000000"],
              )
            ).rows[0]?.reconciled,
          ).toBe(true);
          // Fail after Docker deletion, in the second transaction. The first
          // transaction's refund and backup must remain committed and retryable.
          await fixture.exec(
            scenario === "deletion"
              ? `CREATE FUNCTION reject_sleep_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced final sleep rollback'; END $$; CREATE TRIGGER reject_sleep_fixture BEFORE DELETE ON agent_sandboxes FOR EACH ROW EXECUTE FUNCTION reject_sleep_fixture()`
              : `CREATE FUNCTION reject_sleep_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='${finalStatus}' AND NEW.sandbox_id IS NULL THEN RAISE EXCEPTION 'forced final sleep rollback'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_sleep_fixture BEFORE UPDATE ON agent_sandboxes FOR EACH ROW EXECUTE FUNCTION reject_sleep_fixture()`,
          );
          const finalFailure = await retire().then(
            () => null,
            (error: unknown) => error,
          );
          expect(finalFailure).toBeInstanceOf(Error);
          expect((finalFailure as Error).cause).toMatchObject({
            message: "forced final sleep rollback",
          });
          expect(
            (await ssh.exec(`${docker} ps -aq --no-trunc --filter id=${containerId}`)).trim(),
          ).toBe("");
          expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
          expect(await allocated()).toBe(1);
          expect(await canonical()).toEqual({
            status: scenario === "deletion" ? "deletion_pending" : "stopped",
            sandbox_id: name,
            last_backup_at: expect.any(Date),
          });
          await fixture.exec(
            "DROP TRIGGER reject_sleep_fixture ON agent_sandboxes; DROP FUNCTION reject_sleep_fixture()",
          );
          if (scenario === "deletion") {
            expect(await retire()).toMatchObject({ success: true, rowDeleted: true });
            expect(await canonical()).toBeUndefined();
            expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
            expect(await allocated()).toBe(1);
            expect(
              (
                await fixture.query(
                  "SELECT sandbox_record_id,recovery_organization_id,state_data FROM agent_sandbox_backups WHERE id=$1",
                  [backupId],
                )
              ).rows,
            ).toEqual([
              { sandbox_record_id: null, recovery_organization_id: org, state_data: state },
            ]);
            expect(
              (
                await fixture.query(
                  "SELECT retired_at FROM agent_compute_subjects WHERE agent_id=$1",
                  [agentId],
                )
              ).rows,
            ).toEqual([{ retired_at: expect.any(Date) }]);
            expect(await retire()).toMatchObject({ success: false });
            expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
            expect(await allocated()).toBe(1);
          } else if (scenario === "restart") {
            const { SandboxTransport } = await import("./eliza-sandbox/bridge/transport");
            const endpoint = spyOn(
              SandboxTransport.prototype,
              "getSafeBridgeEndpoint",
            ).mockImplementation(async (_target, path) => {
              expect(path).toBe("/api/restore");
              return new URL(path, server.url).toString();
            });
            const ensure = spyOn(
              service as unknown as { ensureRuntimeAgentStarted: () => Promise<null> },
              "ensureRuntimeAgentStarted",
            ).mockResolvedValue(null);
            const create = spyOn(sleepProvider, "create").mockImplementation(async (config) => {
              const paid = await renewalState(org);
              expect(paid.windows).toHaveLength(2);
              expect(paid.reservations.filter((entry) => entry.status === "reserved")).toHaveLength(
                1,
              );
              expect(paid.windows.filter((entry) => entry.settled_at === null)).toHaveLength(1);
              const attemptId = crypto.randomUUID();
              const handle: import("./sandbox-provider-types").SandboxHandle = {
                sandboxId: name,
                bridgeUrl: `http://${target.hostname}:2138`,
                healthUrl: `http://${target.hostname}:2138/api`,
                metadata: {
                  provider: "docker",
                  nodeId,
                  hostname: target.hostname,
                  nodeSshPort: target.port,
                  nodeSshUser: target.username,
                  nodeHostKeyFingerprint: target.hostKeyFingerprint,
                  containerName: name,
                  bridgePort: 2138,
                  webUiPort: 2138,
                  agentId,
                  volumePath: `/data/agents/${agentId}`,
                  dockerImage: target.image,
                  imageDigest: target.image,
                  replacementAttemptId: attemptId,
                  allocationCounted: true,
                },
              };
              if (
                !config.onReplacementCreateIntent ||
                !config.onReplacementCreated ||
                !config.startFundedContainer
              )
                throw new Error("Paid restart omitted durable create/start callbacks");
              await config.onReplacementCreateIntent(handle);
              expect(await allocated()).toBe(2);
              containerId = (
                await ssh.exec(
                  [
                    `${docker} create --pull=never --network=none --memory=128m --cpus=0.2 --pids-limit=64 --env PORT=2138`,
                    `--health-interval=1s --health-timeout=5s --health-retries=10 --health-cmd ${shellQuote(`node -e "fetch('http://127.0.0.1:2138/api/health').then(r=>process.exit(r.ok?0:1))"`)}`,
                    "--cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --restart=no",
                    `--label ai.elizaos.replacement-attempt=${attemptId} --name ${name} --label ai.elizaos.managed-by=eliza-cloud --label ai.elizaos.container-class=test --label ai.elizaos.agent-id=${agentId} --label ai.elizaos.org-id=${org}`,
                    `--entrypoint node ${shellQuote(target.image)} -e ${shellQuote("require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true}))).listen(2138,'127.0.0.1')")}`,
                  ].join(" "),
                )
              ).trim();
              expect(containerId).toMatch(/^[a-f0-9]{64}$/);
              ownedContainerIds.push(containerId);

              handle.metadata = { ...handle.metadata, containerId };
              await config.onReplacementCreated(handle);
              await config.startFundedContainer(handle);
              return handle;
            });
            try {
              // An isolated zero-balance account cannot buy replacement CPU.
              // Restore only this fixture's previous balance for the paid leg.
              await fixture.query("UPDATE organizations SET credit_balance=0 WHERE id=$1", [org]);
              const unpaid = await retire();
              expect(unpaid).toMatchObject({ success: false, containerStarted: false });
              expect(create).not.toHaveBeenCalled();
              const denied = await renewalState(org);
              expect(denied.balance).toEqual([{ credit_balance: "0.000000" }]);
              expect(denied.windows).toEqual(stopped.windows);
              expect(denied.reservations).toEqual(stopped.reservations);
              expect(await allocated()).toBe(1);
              expect((await agentSandboxesRepository.getBackupById(backupId))?.state_data).toEqual(
                state,
              );
              await fixture.query("UPDATE organizations SET credit_balance=$2 WHERE id=$1", [
                org,
                stopped.balance[0]!.credit_balance,
              ]);
              const restarted = await retire();
              expect(restarted).toMatchObject({
                success: true,
                containerStopped: true,
                containerStarted: true,
              });
              expect(create).toHaveBeenCalledTimes(1);
              expect(await canonical()).toEqual({
                status: "running",
                sandbox_id: name,
                last_backup_at: expect.any(Date),
              });
              const renewed = await renewalState(org);
              expect(renewed.windows).toHaveLength(2);
              expect(renewed.windows.find((entry) => entry.settled_at === null)).toMatchObject({
                provider_container_id: containerId,
                runtime_ready_at: expect.any(Date),
              });
              expect(
                (
                  await fixture.query(
                    "SELECT o.credit_balance+a.total_billed+(SELECT COALESCE(sum(r.reserved_amount),0) FROM billing_funding_reservations r WHERE r.organization_id=o.id AND r.status='reserved')=1.000000 AS reconciled FROM organizations o JOIN agent_sandboxes a ON a.organization_id=o.id WHERE a.id=$1",
                    [agentId],
                  )
                ).rows[0]?.reconciled,
              ).toBe(true);
              expect(await allocated()).toBe(2);
              expect(
                JSON.parse(
                  await ssh.exec(
                    `${docker} exec ${containerId} cat /tmp/worker-restored-state.json`,
                  ),
                ),
              ).toEqual(state);
              expect((await agentSandboxesRepository.getBackupById(backupId))?.state_data).toEqual(
                state,
              );
            } finally {
              endpoint.mockRestore();
              ensure.mockRestore();
              create.mockRestore();
            }
          } else {
            expect(await retire()).toMatchObject(
              sleepScenario
                ? { success: true, containerRemoved: true, backupId }
                : { success: true },
            );
            expect(await canonical()).toEqual({
              status: finalStatus,
              sandbox_id: null,
              last_backup_at: expect.any(Date),
            });
            expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
            expect(await allocated()).toBe(1);
            expect((await agentSandboxesRepository.getBackupById(backupId))?.state_data).toEqual(
              state,
            );
            expect(await retire()).toMatchObject({ success: scenario !== "warm" });
            if (scenario === "warm") {
              expect(
                (
                  await fixture.query(
                    "SELECT claimed_at,warm_claim_credential_state,warm_claim_cleanup_completed_at FROM agent_sandboxes WHERE id=$1",
                    [agentId],
                  )
                ).rows,
              ).toEqual([
                {
                  claimed_at: null,
                  warm_claim_credential_state: null,
                  warm_claim_cleanup_completed_at: null,
                },
              ]);
              expect(capture).not.toHaveBeenCalled();
            }
            expect(comparableMoney(await renewalState(org))).toEqual(comparableMoney(stopped));
            expect(await allocated()).toBe(1);
          }
        } finally {
          capture.mockRestore();
          persist.mockRestore();
          remove.mockRestore();
        }
      }
    } finally {
      releaseRestore();
      for (const child of children) {
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }
      await server.stop(true);
      try {
        for (const owned of ownedContainerIds)
          await ssh.exec(`${docker} rm -f ${shellQuote(owned)}`);
        if (ownsGuard) {
          const digest = createHash("sha256")
            .update(guard.DOCKER_COMPUTE_GUARD_PROGRAM)
            .digest("hex");
          await rootSSH.execStdin(
            "python3 -",
            `import json, pathlib, shutil, subprocess\nroot=pathlib.Path('/var/lib/eliza/compute-leases')\nunit=pathlib.Path('/etc/systemd/system/eliza-compute-guard.service')\nif unit.exists():\n assert 'guard-${digest}.py' in unit.read_text(), 'foreign_guard_preserved'\nif root.exists():\n for p in root.glob('*.json'):\n  assert json.loads(p.read_text())['authorization']['containerId'] in ${JSON.stringify(ownedContainerIds)}, 'foreign_lease_preserved'\nif unit.exists():\n subprocess.run(['systemctl','disable','--now',unit.name],check=True,capture_output=True)\n unit.unlink()\n subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)\nif root.exists(): shutil.rmtree(root)\nassert not root.exists() and not unit.exists()\n`,
          );
        }
        expect(
          (await ssh.exec(`${docker} ps -q --no-trunc`)).trim().split("\n").filter(Boolean).sort(),
        ).toEqual(originalRunning);
      } finally {
        await ssh.disconnect();
        await DockerSSHClient.disconnectAll();
        await rm(directory, { recursive: true, force: true });
        if (ownsBillingRevisionTrigger) {
          await fixture.exec(
            'DROP TRIGGER agent_sandboxes_lifecycle_revision_trigger ON "agent_sandboxes"',
          );
        }
        if (ownsBillingIntentTable) await fixture.exec("DROP TABLE agent_compute_stop_intents");
      }
    }
  }
  test(
    "worker death during restore retains paid state and a restarted worker completes the same job",
    () => runPaidContainerScenario("worker"),
    300_000,
  );
  test(
    "billing retirement preserves confirmed paid runtime when only renewal cash is exhausted",
    () => runPaidContainerScenario("billing-held"),
    180_000,
  );
  test(
    "billing retirement preserves runtime when a top-up wins the locked recheck",
    () => runPaidContainerScenario("billing-topup"),
    180_000,
  );
  test(
    "billing retirement cannot delete a later configuration generation",
    () => runPaidContainerScenario("billing-stale"),
    180_000,
  );

  test(
    "funded user suspension releases compute with a current backup and one refund across retries",
    () => runPaidContainerScenario("user-suspend"),
    180_000,
  );

  test(
    "funded user suspension preserves a later configuration generation",
    () => runPaidContainerScenario("user-suspend-stale"),
    180_000,
  );

  test(
    "funded user suspension settles stopped compute and retains current data when backup capture fails",
    () => runPaidContainerScenario("user-suspend-backup-failure"),
    180_000,
  );

  test(
    "unfunded Dedicated suspension reclaims compute from its bound backup across removal failure and rollback",
    () => runPaidContainerScenario("billing-sleep"),
    180_000,
  );

  test(
    "paid sleep commits backup and refund before removal and retries a post-removal database rollback",
    () => runPaidContainerScenario("sleep"),
    180_000,
  );

  test(
    "paid shutdown commits backup and refund before removal and retries a post-removal database rollback",
    () => runPaidContainerScenario("shutdown"),
    180_000,
  );

  test(
    "paid restart commits the old refund then funds and restores a new container",
    () => runPaidContainerScenario("restart"),
    180_000,
  );

  test(
    "paid deletion commits stop and refund before removal and retains recovery and financial history across retries",
    () => runPaidContainerScenario("deletion"),
    180_000,
  );

  test(
    "paid warm retry commits refund before removal and preserves backup and sibling capacity across rollback",
    () => runPaidContainerScenario("warm"),
    180_000,
  );

  test("real Docker stop survives a PostgreSQL rollback and app suspension refunds once", async () => {
    const target = z
      .object({
        hostname: z.ipv4(),
        port: z.number().int().min(1).max(65535),
        username: z.string().regex(/^[a-z_][a-z0-9_-]*$/),
        hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]+$/),
        image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      })
      .strict()
      .parse(JSON.parse(await readFile(sshFixturePath, "utf8")));
    const { DockerSSHClient } = await import("./docker-ssh");
    const { shellQuote } = await import("./docker-sandbox-utils");
    const guard = await import("./docker-compute-lease");
    const { stopFundedAgentInTransaction, settleStoppedAgentComputeInTransaction } = await import(
      "./agent-compute-stop"
    );
    const ssh = new DockerSSHClient(target);
    const rootSSH = guard.dockerComputeRootSSH(ssh, target.username);
    const name = "agent-63000000-0000-4000-8000-000000000030";
    const nodeId = `stop-test-${crypto.randomUUID()}`;
    const org = "61000000-0000-4000-8000-000000000030";
    const agentId = "63000000-0000-4000-8000-000000000030";
    const marker = crypto.randomUUID();
    const cleanupAttemptId = crypto.randomUUID();
    let containerId: string | undefined;
    let initialContainerId: string | undefined;
    let ownsGuard = false;
    let originalRunning: string[] = [];
    const docker = target.username === "root" ? "docker" : "sudo --non-interactive docker";
    await ssh.connect();
    try {
      originalRunning = (await ssh.exec(`${docker} ps -q --no-trunc`))
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort();
      await rootSSH.execStdin(
        "python3 -",
        `from pathlib import Path\nassert not Path('/var/lib/eliza/compute-leases').exists()\nassert not Path('/etc/systemd/system/eliza-compute-guard.service').exists()\n`,
      );
      containerId = (
        await ssh.exec(
          [
            `${docker} create --pull=never --network=none --memory=128m --cpus=0.2 --pids-limit=64 --env PORT=2138`,
            `--health-interval=1s --health-timeout=5s --health-retries=10 --health-cmd ${shellQuote(`node -e "fetch('http://127.0.0.1:2138/api/health').then(r=>process.exit(r.ok?0:1))"`)}`,
            "--cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --restart=no",
            `--name ${shellQuote(name)} --label ai.elizaos.managed-by=eliza-cloud --label ai.elizaos.container-class=test`,
            `--label ai.elizaos.replacement-attempt=${cleanupAttemptId}`,
            `--label ai.elizaos.agent-id=${agentId} --label ai.elizaos.org-id=${org}`,
            `--entrypoint node ${shellQuote(target.image)} -e ${shellQuote("require('http').createServer((q,r)=>r.end(JSON.stringify({ok:true}))).listen(2138,'127.0.0.1')")}`,
          ].join(" "),
        )
      ).trim();
      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      const { dockerNodes } = await import("../../db/schemas/docker-nodes");
      const columns = getTableConfig(dockerNodes).columns.map(
        (column) => `"${column.name}" ${column.getSQLType()}`,
      );
      await fixture.exec(`CREATE TABLE IF NOT EXISTS docker_nodes (${columns.join(", ")})`);
      await fixture.query(
        "INSERT INTO docker_nodes(id,node_id,hostname,ssh_port,ssh_user,host_key_fingerprint) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)",
        [nodeId, target.hostname, target.port, target.username, target.hostKeyFingerprint],
      );
      const initialOrg = "61000000-0000-4000-8000-000000000040";
      const initialAgent = "63000000-0000-4000-8000-000000000040";
      const initialName = `agent-${initialAgent}`;
      await fixture.query(
        `INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,auto_top_up_enabled,account_lifecycle_state)
        VALUES($1,'1.000000',1,0,'{}',true,false,'active')`,
        [initialOrg],
      );
      await fixture.query(
        `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,lifecycle_revision,environment_revision,billing_status,total_billed)
        VALUES($1,$2,'provisioning','dedicated-always',1,1,'active',0)`,
        [initialAgent, initialOrg],
      );
      const { agentSandboxesRepository } = await import("../../db/repositories/agent-sandboxes");
      const { reserveProvisionCompute, startProvisionCompute } = await import(
        "./agent-compute-provision"
      );
      const initialRecord = await agentSandboxesRepository.findByIdAndOrg(initialAgent, initialOrg);
      if (!initialRecord) throw new Error("Missing initial provision fixture");
      const initialFunding = await reserveProvisionCompute(initialRecord);
      // Shorten the paid fixture BEFORE any host grant, retaining the full hold.
      // This exercises real expiry without changing the database or host clock.
      const initialExpiry = new Date(Date.now() + 180_000);
      await fixture.query("UPDATE agent_compute_funding SET period_end=$2 WHERE id=$1", [
        initialFunding.window.id,
        initialExpiry,
      ]);
      // Real provider allocation is downstream of the committed purchase hold.
      initialContainerId = (
        await ssh.exec(
          [
            `${docker} create --pull=never --network=none --memory=128m --cpus=0.2 --pids-limit=64 --env PORT=2138`,
            "--cap-drop=ALL --security-opt=no-new-privileges --user=65534:65534 --restart=no",
            `--name ${initialName} --label ai.elizaos.managed-by=eliza-cloud --label ai.elizaos.container-class=test`,
            `--label ai.elizaos.agent-id=${initialAgent} --label ai.elizaos.org-id=${initialOrg}`,
            `--entrypoint node ${shellQuote(target.image)} -e ${shellQuote("require('http').createServer((q,r)=>r.end('{}')).listen(2138,'127.0.0.1')")}`,
          ].join(" "),
        )
      ).trim();
      expect(initialContainerId).toMatch(/^[a-f0-9]{64}$/);
      const attemptId = crypto.randomUUID();
      await fixture.query(
        `UPDATE agent_sandboxes SET replacement_cleanup_sandbox_id=$2,replacement_cleanup_container_name=$2,
        replacement_cleanup_node_id=$3,replacement_cleanup_container_id=$4,replacement_cleanup_attempt_id=$5 WHERE id=$1`,
        [initialAgent, initialName, nodeId, initialContainerId, attemptId],
      );
      await fixture.query(
        `INSERT INTO compute_billing_rate_segments(id,organization_id,workload_kind,workload_id,lifecycle_revision,billing_state,rate_per_hour,effective_at)
        VALUES(gen_random_uuid(),$1,'agent',$2,1,'not_billable',0,$3)`,
        [initialOrg, initialAgent, initialFunding.window.period_start],
      );
      const initialHandle = {
        sandboxId: initialName,
        bridgeUrl: `http://${target.hostname}:2138`,
        healthUrl: `http://${target.hostname}:2138/api`,
        metadata: {
          provider: "docker" as const,
          nodeId,
          hostname: target.hostname,
          containerName: initialName,
          bridgePort: 2138,
          webUiPort: 2138,
          agentId: initialAgent,
          volumePath: `/data/agents/${initialAgent}`,
          dockerImage: target.image,
          imageDigest: target.image,
          replacementAttemptId: attemptId,
          containerId: initialContainerId,
        },
      };
      await expect(
        startProvisionCompute(initialRecord, initialFunding.window.id, {
          ...initialHandle,
          metadata: { ...initialHandle.metadata, replacementAttemptId: crypto.randomUUID() },
        }),
      ).rejects.toMatchObject({ code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED" });
      expect(
        (
          await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${initialContainerId}`)
        ).trim(),
      ).toBe("false");
      await fixture.exec(`CREATE FUNCTION reject_initial_start_meter() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.workload_id='${initialAgent}' AND NEW.billing_state='running' THEN RAISE EXCEPTION 'forced initial start writeback rollback'; END IF;
        RETURN NEW; END $$;
        CREATE TRIGGER reject_initial_start_meter BEFORE INSERT ON compute_billing_rate_segments FOR EACH ROW EXECUTE FUNCTION reject_initial_start_meter();`);
      ownsGuard = true;
      await expect(
        startProvisionCompute(initialRecord, initialFunding.window.id, initialHandle),
      ).rejects.toMatchObject({ cause: { message: "forced initial start writeback rollback" } });
      expect(
        (
          await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${initialContainerId}`)
        ).trim(),
      ).toBe("true");
      expect(
        (
          await fixture.query(
            "SELECT provider_container_id,host_lease_confirmed_at FROM agent_compute_funding WHERE id=$1",
            [initialFunding.window.id],
          )
        ).rows[0],
      ).toEqual({ provider_container_id: initialContainerId, host_lease_confirmed_at: null });
      await fixture.exec(
        "DROP TRIGGER reject_initial_start_meter ON compute_billing_rate_segments; DROP FUNCTION reject_initial_start_meter()",
      );
      const initialStart = (
        await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${initialContainerId}`)
      ).trim();
      await startProvisionCompute(initialRecord, initialFunding.window.id, initialHandle);
      expect(
        (
          await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${initialContainerId}`)
        ).trim(),
      ).toBe(initialStart);
      expect(
        (
          await fixture.query(
            "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
            [initialOrg],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await fixture.query(
            "SELECT count(*)::int AS n FROM compute_billing_rate_segments WHERE workload_id=$1 AND billing_state='running'",
            [initialAgent],
          )
        ).rows[0]?.n,
      ).toBe(1);
      const { reconcileExpiredAgentCompute } = await import("./agent-compute-recovery");
      const expiredIdentity = {
        agentId: initialAgent,
        organizationId: initialOrg,
        fundingId: initialFunding.window.id,
      };
      expect(await reconcileExpiredAgentCompute(expiredIdentity)).toBeNull();
      await Bun.sleep(Math.max(0, initialExpiry.getTime() - Date.now() + 100));
      // Host expiry must stop compute even while no control-plane reconciliation runs.
      expect(
        (
          await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${initialContainerId}`)
        ).trim(),
      ).toBe("false");
      expect(await reconcileExpiredAgentCompute(expiredIdentity)).toMatchObject({
        replayed: false,
        purchasedCreditRefunded: true,
      });
      expect(await reconcileExpiredAgentCompute(expiredIdentity)).toBeNull();
      expect(
        (
          await fixture.query(
            "SELECT status,replacement_cleanup_container_id FROM agent_sandboxes WHERE id=$1",
            [initialAgent],
          )
        ).rows[0],
      ).toEqual({ status: "error", replacement_cleanup_container_id: initialContainerId });
      expect(
        (
          await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${initialContainerId}`)
        ).trim(),
      ).toBe("false");
      expect(
        (
          await fixture.query(
            "SELECT o.credit_balance+a.total_billed=1.000000 AS reconciled FROM organizations o JOIN agent_sandboxes a ON a.organization_id=o.id WHERE a.id=$1",
            [initialAgent],
          )
        ).rows[0]?.reconciled,
      ).toBe(true);
      const { compute, identity, provider } = await billableFundedAgent(
        "000000000030",
        "1.000000",
        { nodeId, containerId },
      );
      await fixture.query(
        "UPDATE agent_sandboxes SET sandbox_id=$2,container_name=$2,bridge_port=2138,web_ui_port=2138 WHERE id=$1",
        [agentId, name],
      );
      const authorization = await helpers.writeTransaction((tx) =>
        compute.authorizeHostInTransaction(tx, provider),
      );
      ownsGuard = true;
      await guard.installDockerComputeGuard(rootSSH);
      await guard.grantDockerComputeLease(rootSSH, authorization);
      await guard.startDockerComputeLease(rootSSH, authorization);
      await ssh.exec(
        `${docker} exec ${containerId} /bin/sh -c ${shellQuote(`printf '%s' '${marker}' > /tmp/stop-marker`)}`,
      );
      const before = await renewalState(org);
      await expect(
        helpers.writeTransaction(async (tx) => {
          await stopFundedAgentInTransaction(tx, identity);
          throw new Error("Forced outer PostgreSQL rollback after real Docker stop");
        }),
      ).rejects.toThrow("Forced outer PostgreSQL rollback");
      expect(await renewalState(org)).toEqual(before);
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("false");
      const { elizaSandboxService } = await import("./eliza-sandbox");
      expect(
        await elizaSandboxService.executeSuspend(agentId, org, crypto.randomUUID(), "user_request"),
      ).toMatchObject({ success: true, containerStopped: true });
      const settled = await fixture.query<{
        provider_stop_receipt: { bootId: string; stoppedAtMs: number };
        settled: boolean;
      }>(
        "SELECT provider_stop_receipt,settled_at IS NOT NULL AS settled FROM agent_compute_funding WHERE id=$1",
        [provider.fundingId],
      );
      expect(settled.rows[0]?.settled).toBe(true);
      const totals = await fixture.query(
        `SELECT a.status,a.sandbox_id,a.billing_status,
        (SELECT count(*)::int FROM credit_transactions WHERE organization_id=$2) AS ledger_count,
        (SELECT count(*)::int FROM agent_billing_records WHERE sandbox_id=$1) AS receipt_count,
        (o.credit_balance+a.total_billed)=1.000000 AS reconciled
        FROM agent_sandboxes a JOIN organizations o ON o.id=a.organization_id WHERE a.id=$1`,
        [agentId, org],
      );
      expect(totals.rows[0]).toMatchObject({
        status: "stopped",
        sandbox_id: name,
        ledger_count: 2,
        receipt_count: 1,
        reconciled: true,
      });
      const after = await renewalState(org);
      const receipt = {
        authorization,
        expired: true as const,
        ...settled.rows[0]!.provider_stop_receipt,
      };
      expect(
        await helpers.writeTransaction((tx) =>
          settleStoppedAgentComputeInTransaction(
            tx,
            { ...identity, fundingId: provider.fundingId },
            receipt,
          ),
        ),
      ).toMatchObject({ replayed: true, purchasedCreditRefunded: false });
      expect(await renewalState(org)).toEqual(after);
      expect(
        (await ssh.exec(`${docker} cp ${containerId}:/tmp/stop-marker - | tar -xO`)).trim(),
      ).toBe(marker);
      await expect(
        guard.grantDockerComputeLease(rootSSH, { ...authorization, issuedAtMs: Date.now() }),
      ).rejects.toThrow("funding_revoked");
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("false");
      await fixture.query("UPDATE organizations SET credit_balance=0 WHERE id=$1", [org]);
      const unfunded = await renewalState(org);
      expect(await elizaSandboxService.executeResume(agentId, org)).toMatchObject({
        success: false,
        containerStarted: false,
        reprovisioned: false,
      });
      expect(await renewalState(org)).toEqual(unfunded);
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("false");
      await fixture.query("UPDATE organizations SET credit_balance=1 WHERE id=$1", [org]);
      const admitted = await helpers.writeTransaction(async (tx) => {
        const next = await compute.reserveRetainedResumeInTransaction(tx, identity);
        if (!next) throw new Error("Retained funding fixture disappeared");
        await tx.execute(
          sql`UPDATE agent_sandboxes SET status='provisioning',last_billed_at=${next.window.period_start} WHERE id=${agentId}`,
        );
        return { ...identity, fundingId: next.window.id, nodeId, containerId: containerId! };
      });
      const reservedResume = await renewalState(org);
      const { startFundedAgentInTransaction } = await import("./agent-compute-start");
      await expect(
        helpers.writeTransaction(async (tx) => {
          await startFundedAgentInTransaction(tx, admitted);
          throw new Error("Forced rollback after real paid start");
        }),
      ).rejects.toThrow("Forced rollback after real paid start");
      expect(await renewalState(org)).toEqual(reservedResume);
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("true");
      const firstPaidStart = (
        await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${containerId}`)
      ).trim();
      expect(await elizaSandboxService.executeResume(agentId, org)).toMatchObject({
        success: true,
        containerStarted: true,
        reprovisioned: false,
      });
      expect((await ssh.exec(`${docker} exec ${containerId} cat /tmp/stop-marker`)).trim()).toBe(
        marker,
      );
      const resumed = await renewalState(org);
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.StartedAt}}' ${containerId}`)).trim(),
      ).toBe(firstPaidStart);
      const runningStart = await fixture.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM compute_billing_rate_segments
        WHERE organization_id=$1 AND workload_id=$2 AND billing_state='running' AND effective_at=$3`,
        [org, agentId, new Date(firstPaidStart)],
      );
      expect(runningStart.rows[0]?.count).toBe(1);
      expect(resumed.windows).toHaveLength(2);
      expect(resumed.reservations).toHaveLength(2);
      expect(await elizaSandboxService.executeResume(agentId, org)).toMatchObject({
        success: true,
        containerStarted: true,
        reprovisioned: false,
      });
      expect(await renewalState(org)).toEqual(resumed);
      expect(
        (
          await fixture.query(
            "SELECT status,sandbox_id,bridge_url,health_url FROM agent_sandboxes WHERE id=$1",
            [agentId],
          )
        ).rows[0],
      ).toEqual({
        status: "running",
        sandbox_id: name,
        bridge_url: `http://${target.hostname}:2138`,
        health_url: `http://${target.hostname}:2138/api`,
      });
      // Exercise the actual provision/restore tail against this same paid
      // container. The tiny fixture image has no Eliza restore API, so a
      // loopback transport fixture validates auth and writes the received
      // snapshot into the real container. Backup selection is a fixed fixture;
      // funding, admission, adoption, failure CAS and host stop/start are real.
      const { ElizaSandboxService } = await import("./eliza-sandbox");
      const { DockerSandboxProvider: RetryProvider } = await import("./docker-sandbox-provider");
      const retryProvider = new RetryProvider();
      let creates = 0;
      retryProvider.create = async () => {
        creates++;
        throw new Error("Retained retry attempted a new container");
      };
      const retryService = new ElizaSandboxService(retryProvider);
      const retryToken = `test-${crypto.randomUUID()}`;
      const restorePayload = {
        memories: [],
        config: { checkpoint: marker },
        workspaceFiles: { "saved.txt": marker },
      };
      let restoreRequests = 0;
      const restoreServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.headers.get("authorization") !== `Bearer ${retryToken}`)
            return new Response("unauthorized", { status: 401 });
          const body = await request.text();
          expect(JSON.parse(body)).toEqual(restorePayload);
          const restoring = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
          expect(restoring?.status).toBe("provisioning");
          const pendingFunding = await fixture.query(
            "SELECT runtime_ready_at FROM agent_compute_funding WHERE agent_id=$1 AND settled_at IS NULL",
            [agentId],
          );
          expect(pendingFunding.rows).toEqual([{ runtime_ready_at: null }]);
          expect(await retryService.reconcileStuckProvisioning(agentId, org)).toBe("unresolved");
          restoreRequests++;
          if (restoreRequests === 1)
            return new Response("transient restore failure", { status: 500 });
          await rootSSH.execStdin(
            `${docker} exec -i ${containerId} node -e ${shellQuote("let b='';process.stdin.on('data',x=>b+=x);process.stdin.on('end',()=>require('fs').writeFileSync('/tmp/restored-state.json',b))")}`,
            body,
          );
          return Response.json({ ok: true });
        },
      });
      const { SandboxTransport } = await import("./eliza-sandbox/bridge/transport");
      const endpoint = spyOn(
        SandboxTransport.prototype,
        "getSafeBridgeEndpoint",
      ).mockImplementation(async (_target, path) => {
        expect(path).toBe("/api/restore");
        return new URL(path, restoreServer.url).toString();
      });
      const ensure = spyOn(
        retryService as unknown as { ensureRuntimeAgentStarted: () => Promise<null> },
        "ensureRuntimeAgentStarted",
      ).mockResolvedValue(null);
      const backupId = "65000000-0000-4000-8000-000000000030";
      const backupRow = {
        id: backupId,
        sandbox_record_id: agentId,
        snapshot_type: "pre-shutdown" as const,
        state_data: restorePayload,
        state_data_storage: "inline" as const,
        state_data_key: null,
        size_bytes: JSON.stringify(restorePayload).length,
        backup_kind: "full" as const,
        parent_backup_id: null,
        content_hash: null,
        created_at: new Date(),
      };
      const backup = spyOn(agentSandboxesRepository, "getBackupById").mockResolvedValue(backupRow);
      // The stored backup is a fixed, freshly verified fixture. The real wake
      // gate must select it; the test does not claim cryptographic verification.
      const stored = {
        ...backupRow,
        verification_status: "verified",
        verified_at: new Date(),
        verification_error: null,
      } as import("../../db/schemas/agent-sandboxes").StoredAgentSandboxBackup;
      const storedById = spyOn(agentSandboxesRepository, "getStoredBackupById").mockResolvedValue(
        stored,
      );
      const storedLatest = spyOn(
        agentSandboxesRepository,
        "getLatestStoredBackup",
      ).mockResolvedValue(stored);
      const reconstruct = spyOn(
        agentSandboxesRepository,
        "getReconstructedBackupState",
      ).mockResolvedValue(restorePayload);
      try {
        await fixture.query(
          "UPDATE agent_sandboxes SET status='provisioning',environment_revision=1,database_status='ready',database_uri='postgres://fixture.invalid/retained',environment_vars=$2,quota_admission_scope='trusted_internal' WHERE id=$1",
          [agentId, JSON.stringify({ ELIZA_API_TOKEN: retryToken })],
        );
        const failed = await retryService.executeWake(agentId, org, { restoreBackupId: backupId });
        expect(failed.success).toBe(false);
        expect(failed.error).toContain("State restore failed: HTTP 500");
        const failedRec = (await agentSandboxesRepository.findByIdAndOrg(agentId, org))!;
        expect(failedRec.status).toBe("error");
        expect(failedRec.sandbox_id).toBe(name);
        expect(failedRec.bridge_url).toBeNull();
        expect(
          (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
        ).toBe("false");
        expect(
          (await ssh.exec(`${docker} cp ${containerId}:/tmp/stop-marker - | tar -xO`)).trim(),
        ).toBe(marker);
        // A reconciler may leave an interrupted restore stopped. Its durable
        // readiness remains absent, so resume must restore the same placement.
        await fixture.query("UPDATE agent_sandboxes SET status='stopped' WHERE id=$1", [agentId]);
        const beforeRejectedBackup = await renewalState(org);
        storedById.mockResolvedValueOnce(undefined);
        const rejectedBackup = await retryService.executeWake(agentId, org, {
          restoreBackupId: crypto.randomUUID(),
        });
        expect(rejectedBackup.success).toBe(false);
        expect(rejectedBackup.integrityFailure?.kind).toBe("backup-not-found");
        expect(await renewalState(org)).toEqual(beforeRejectedBackup);
        expect((await agentSandboxesRepository.findByIdAndOrg(agentId, org))?.status).toBe(
          "stopped",
        );
        expect(restoreRequests).toBe(1);
        await fixture.query("UPDATE organizations SET credit_balance=0 WHERE id=$1", [org]);
        const unpaidBefore = await renewalState(org);
        expect((await retryService.executeResume(agentId, org)).success).toBe(false);
        const unpaidAfter = await renewalState(org);
        // Accrued-debt settlement can append a zero-dollar audit entry even
        // when new admission is denied. No funds or funding windows may change.
        expect({ ...unpaidAfter, ledger: [] }).toEqual({ ...unpaidBefore, ledger: [] });
        const priorLedgerIds = new Set(unpaidBefore.ledger.map((entry) => entry.id));
        for (const entry of unpaidAfter.ledger) {
          if (!priorLedgerIds.has(entry.id)) expect(Number(entry.amount)).toBe(0);
        }
        expect(restoreRequests).toBe(1);
        expect(
          (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
        ).toBe("false");
        await fixture.query("UPDATE agent_sandboxes SET status='stopped' WHERE id=$1", [agentId]);
        await fixture.query("UPDATE organizations SET credit_balance=1 WHERE id=$1", [org]);
        expect((await retryService.executeResume(agentId, org)).success).toBe(true);
        expect(creates).toBe(0);
        expect(restoreRequests).toBe(2);
        expect(
          JSON.parse(await ssh.exec(`${docker} exec ${containerId} cat /tmp/restored-state.json`)),
        ).toEqual(restorePayload);
        expect((await ssh.exec(`${docker} exec ${containerId} cat /tmp/stop-marker`)).trim()).toBe(
          marker,
        );
        const restoredRec = (await agentSandboxesRepository.findByIdAndOrg(agentId, org))!;
        expect(restoredRec.status).toBe("running");
        expect(restoredRec.environment_vars).toEqual({ ELIZA_API_TOKEN: retryToken });
        expect(restoredRec.container_name).toBe(name);
        const restoredFunding = (await renewalState(org)).windows;
        expect(restoredFunding).toHaveLength(3);
        const readyFunding = restoredFunding.find((window) => window.settled_at === null);
        expect(readyFunding?.runtime_ready_at).toBeInstanceOf(Date);
      } finally {
        endpoint.mockRestore();
        ensure.mockRestore();
        backup.mockRestore();
        reconstruct.mockRestore();
        storedById.mockRestore();
        storedLatest.mockRestore();
        await restoreServer.stop(true);
      }
      const runningRecord = await agentSandboxesRepository.findByIdAndOrg(agentId, org);
      if (!runningRecord) throw new Error("Missing running cleanup fixture");
      const [activeWindow] = (
        await fixture.query<{ id: string }>(
          "SELECT id FROM agent_compute_funding WHERE agent_id=$1 AND settled_at IS NULL",
          [agentId],
        )
      ).rows;
      if (!activeWindow) throw new Error("Missing paid cleanup window");
      const cleanupHandle = {
        ...initialHandle,
        sandboxId: name,
        metadata: {
          ...initialHandle.metadata,
          agentId,
          containerName: name,
          containerId,
          replacementAttemptId: cleanupAttemptId,
          allocationCounted: false,
          volumePath: `/data/agents/${agentId}`,
        },
      };
      const { reconcileFailedProvisionCompute } = await import("./agent-compute-provision");
      await expect(
        reconcileFailedProvisionCompute(agentId, org, activeWindow.id, {
          expected: { ...runningRecord, lifecycle_execution_generation: crypto.randomUUID() },
          handle: cleanupHandle,
        }),
      ).rejects.toMatchObject({ code: "AGENT_COMPUTE_PROVISION_AUTHORITY_CHANGED" });
      expect(
        (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
      ).toBe("true");
      expect(
        (await ssh.exec(`${docker} cp ${containerId}:/tmp/stop-marker - | tar -xO`)).trim(),
      ).toBe(marker);

      // Model the durable pre-adoption candidate that a crashed/failed provision
      // leaves behind. The paid container and its host lease remain real.
      await fixture.query(
        `UPDATE agent_sandboxes SET status='provisioning',replacement_cleanup_sandbox_id=$2,replacement_cleanup_container_name=$2,replacement_cleanup_node_id=$3,replacement_cleanup_container_id=$4,replacement_cleanup_attempt_id=$5,replacement_cleanup_allocation_counted=false,replacement_cleanup_created_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1`,
        [agentId, name, nodeId, containerId, cleanupAttemptId],
      );
      const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
      const cleanupProvider = new DockerSandboxProvider();
      const removeExact = cleanupProvider.stopOnSpecificNodeForReplacement.bind(cleanupProvider);
      cleanupProvider.stopOnSpecificNodeForReplacement = async (...args) => {
        expect(
          (
            await fixture.query(
              "SELECT settled_at IS NOT NULL AS settled,provider_stop_receipt IS NOT NULL AS stopped FROM agent_compute_funding WHERE id=$1",
              [activeWindow.id],
            )
          ).rows[0],
        ).toEqual({ settled: true, stopped: true });
        expect(
          (await ssh.exec(`${docker} inspect --format '{{.State.Running}}' ${containerId}`)).trim(),
        ).toBe("false");
        await removeExact(...args);
      };
      const { SandboxReplacementCleanup } = await import(
        "./eliza-sandbox/lifecycle/replacement-cleanup"
      );
      const { SandboxLifecycleAuthority } = await import("./eliza-sandbox/lifecycle/authority");
      const authority = new SandboxLifecycleAuthority();
      const cleanup = new SandboxReplacementCleanup({
        lockLifecycle: authority.lockLifecycle.bind(authority),
        getAgentForLifecycleMutation: authority.getAgentForLifecycleMutation.bind(authority),
        hasActiveExclusiveLifecycleJobTx:
          authority.hasActiveExclusiveLifecycleJobTx.bind(authority),
        isReplacementCleanupSweepEligibleTx:
          authority.isReplacementCleanupSweepEligibleTx.bind(authority),
        getProvider: async () => cleanupProvider,
      });
      expect(
        await cleanup.retirePersistedReplacementCleanup(
          agentId,
          org,
          undefined,
          undefined,
          "lifecycle",
          cleanupHandle,
        ),
      ).toBe("retired");
      expect(
        (await ssh.exec(`${docker} ps -aq --no-trunc --filter id=${containerId}`)).trim(),
      ).toBe("");
      expect(
        (
          await fixture.query(
            "SELECT replacement_cleanup_container_id FROM agent_sandboxes WHERE id=$1",
            [agentId],
          )
        ).rows[0],
      ).toEqual({ replacement_cleanup_container_id: null });
      const transactionsAfterCleanup = (
        await fixture.query(
          "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
          [org],
        )
      ).rows[0]?.n;
      expect(await cleanup.retirePersistedReplacementCleanup(agentId, org)).toBe("clean");
      expect(
        (
          await fixture.query(
            "SELECT count(*)::int AS n FROM credit_transactions WHERE organization_id=$1",
            [org],
          )
        ).rows[0]?.n,
      ).toBe(transactionsAfterCleanup);
    } finally {
      try {
        if (initialContainerId) await ssh.exec(`${docker} rm -f ${shellQuote(initialContainerId)}`);
        if (containerId) await ssh.exec(`${docker} rm -f ${shellQuote(containerId)}`);
        if (ownsGuard) {
          const digest = createHash("sha256")
            .update(guard.DOCKER_COMPUTE_GUARD_PROGRAM)
            .digest("hex");
          await rootSSH.execStdin(
            "python3 -",
            `import json, pathlib, shutil, subprocess\nroot=pathlib.Path('/var/lib/eliza/compute-leases')\nunit=pathlib.Path('/etc/systemd/system/eliza-compute-guard.service')\nif unit.exists():\n assert 'guard-${digest}.py' in unit.read_text(), 'foreign_guard_preserved'\nif root.exists():\n for p in root.glob('*.json'):\n  assert json.loads(p.read_text())['authorization']['containerId'] in ${JSON.stringify([containerId, initialContainerId ?? ""])}, 'foreign_lease_preserved'\nif unit.exists():\n subprocess.run(['systemctl','disable','--now',unit.name],check=True,capture_output=True)\n unit.unlink()\n subprocess.run(['systemctl','daemon-reload'],check=True,capture_output=True)\nif root.exists(): shutil.rmtree(root)\nassert not root.exists() and not unit.exists()\n`,
          );
        }
        expect(
          (
            await ssh.exec(`${docker} ps -a --filter name=${shellQuote(name)} --format '{{.ID}}'`)
          ).trim(),
        ).toBe("");
        expect(
          (await ssh.exec(`${docker} ps -q --no-trunc`)).trim().split("\n").filter(Boolean).sort(),
        ).toEqual(originalRunning);
      } finally {
        await ssh.disconnect();
        await DockerSSHClient.disconnectAll();
      }
    }
  }, 360_000);
}
