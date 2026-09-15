/** Exercises transaction-current quota policy, real override mutations and storage reservations against migrated PGlite rows. */
import { afterAll, beforeAll, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import type { OrganizationInferenceAdmissionParams } from "../../lib/services/organization-inference-admission";
import { createBillingSnapshotFixture } from "./account-billing-snapshot-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.CACHE_ENABLED = "true";
setDefaultTimeout(120_000);
const ORG = "61000000-0000-4000-8000-000000000001";
const LEGACY = "61000000-0000-4000-8000-000000000002";
const SUB = "62000000-0000-4000-8000-000000000001";
let database: typeof import("../client");
let policy: typeof import("../../lib/services/organization-quota-policy");
let overrides: typeof import("./org-rate-limit-overrides");
let storage: typeof import("./org-storage-quota");
let admission: typeof import("../../lib/services/organization-policy-admission");
beforeAll(async () => {
  database = await import("../client");
  const pg = database.getPgliteClientForTests();
  await createBillingSnapshotFixture((query) => pg.exec(query), "");
  await pg.exec(`ALTER TABLE org_storage_quota ADD PRIMARY KEY(organization_id);
    DROP VIEW org_rate_limit_overrides;
    CREATE TABLE org_rate_limit_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid UNIQUE REFERENCES organizations(id), completions_rpm integer, embeddings_rpm integer, standard_rpm integer, strict_rpm integer, note text, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now());`);
  await pg.exec(`ALTER TABLE billing_subscription_revisions DISABLE TRIGGER billing_subscription_revisions_immutable_guard;
    UPDATE billing_subscriptions SET current_period_start = now()-interval '1 day', current_period_end=now()+interval '1 day';
    UPDATE billing_subscription_revisions SET current_period_start=(SELECT current_period_start FROM billing_subscriptions LIMIT 1), current_period_end=(SELECT current_period_end FROM billing_subscriptions LIMIT 1);
    ALTER TABLE billing_subscription_revisions ENABLE TRIGGER billing_subscription_revisions_immutable_guard;
    DELETE FROM organization_entitlements WHERE organization_id='${ORG}';
    INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state) VALUES('${LEGACY}',100,1,0,'{}',true,'active');
    INSERT INTO credit_transactions(id,organization_id,amount,type,metadata) VALUES(gen_random_uuid(),'${LEGACY}',100,'credit','{}');`);
  const { subscriptionEntitlementsRepository } = await import("./subscription-entitlements");
  await subscriptionEntitlementsRepository.rebuild({
    organizationId: ORG,
    sourceSubscriptionId: SUB,
    sourceSubscriptionRevision: 1,
    expectedProjectionRevision: null,
  });
  policy = await import("../../lib/services/organization-quota-policy");
  overrides = await import("./org-rate-limit-overrides");
  storage = await import("./org-storage-quota");
  admission = await import("../../lib/services/organization-policy-admission");
});
afterAll(async () => {
  await database.closeDatabaseConnectionsForTests();
});
test("legacy policy returns a database observation without a separate clock round trip", async () => {
  const pg = database.getPgliteClientForTests();
  const before = await pg.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  const result = await database.dbWrite.transaction(async (tx) => {
    const selects = spyOn(tx, "select");
    try {
      const value = await policy.readOrganizationQuotaPolicyInTransaction(tx, LEGACY);
      expect(selects).toHaveBeenCalledTimes(1);
      return value;
    } finally {
      selects.mockRestore();
    }
  });
  const after = await pg.query<{ now: Date }>("SELECT clock_timestamp() AS now");
  expect(result.authority?.source).toBe("legacy");
  expect(policy.requireOrganizationPolicyBalance(result).balanceUsd).toBe(100);
  expect(new Date(result.observedAt).getTime()).toBeGreaterThanOrEqual(
    new Date(before.rows[0].now).getTime(),
  );
  expect(new Date(result.observedAt).getTime()).toBeLessThanOrEqual(
    new Date(after.rows[0].now).getTime(),
  );
  const requestedObservation = new Date("2025-01-01T00:00:00.000Z");
  const overridden = await database.dbWrite.transaction((tx) =>
    policy.readOrganizationQuotaPolicyInTransaction(tx, LEGACY, requestedObservation),
  );
  expect(overridden.observedAt).toBe(requestedObservation.toISOString());
});
test("subscription admission still rejects an observation at its expiry boundary", async () => {
  const current = await policy.readOrganizationQuotaPolicy(ORG);
  expect(current.authority.source).toBe("subscription");
  expect(current.authority.effectiveUntil).not.toBeNull();
  const expiry = new Date(current.authority.effectiveUntil!);
  await expect(
    database.dbWrite.transaction((tx) =>
      policy.readOrganizationQuotaPolicyInTransaction(tx, ORG, expiry),
    ),
  ).rejects.toMatchObject({
    code: "ORGANIZATION_POLICY_UNAVAILABLE",
    context: { organizationId: ORG, reason: "entitlement_not_effective" },
  });
});
test("optional policy rows stay tenant-scoped and missing authority fails closed", async () => {
  const pg = database.getPgliteClientForTests();
  const target = "61000000-0000-4000-8000-000000000003";
  const other = "61000000-0000-4000-8000-000000000004";
  await pg.exec(`
    INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state)
    VALUES('${target}',100,1,0,'{}',true,'active'),('${other}',100,1,0,'{}',true,'active');
    INSERT INTO credit_transactions(id,organization_id,amount,type,metadata)
    VALUES(gen_random_uuid(),'${target}',100,'credit','{}'),(gen_random_uuid(),'${other}',100,'credit','{}');
  `);
  const before = await policy.readOrganizationQuotaPolicy(target);
  await pg.exec(`
    INSERT INTO org_rate_limit_overrides(organization_id,completions_rpm) VALUES('${other}',71);
    INSERT INTO organization_config(organization_id,settings) VALUES('${other}','{"max_containers":3}');
    INSERT INTO org_storage_quota(organization_id,bytes_used,bytes_limit,limit_override_authorized)
    VALUES('${other}',0,13,true);
  `);
  const after = await policy.readOrganizationQuotaPolicy(target);
  expect(after).toEqual({ ...before, observedAt: after.observedAt });
  const overridden = await policy.readOrganizationQuotaPolicy(other);
  expect(policy.requireOrganizationRateTier(overridden).completionsRpm).toBe(71);
  expect(policy.requireOrganizationResourceLimit(overridden, "containers")).toBe(3n);
  expect(policy.requireOrganizationResourceLimit(overridden, "storage")).toBe(13n);
  await pg.exec(
    `DELETE FROM organization_subscription_authorities WHERE organization_id='${other}'`,
  );
  await expect(policy.readOrganizationQuotaPolicy(other)).rejects.toMatchObject({
    code: "ORGANIZATION_POLICY_UNAVAILABLE",
    context: { organizationId: other, reason: "missing_account_authority" },
  });
});
test("subscriber RPM survives balance spending and unapproved resource ceilings remain unavailable", async () => {
  const before = await policy.readOrganizationQuotaPolicy(ORG);
  await database
    .getPgliteClientForTests()
    .exec(`UPDATE organizations SET credit_balance=0,balance_revision=2 WHERE id='${ORG}'`);
  const after = await policy.readOrganizationQuotaPolicy(ORG);
  expect(after.tier).toEqual(before.tier);
  expect(after.authority).toEqual(before.authority);
  expect(policy.requireOrganizationPolicyBalance(after).balanceUsd).toBe(0);
  for (const resource of ["characters", "sandboxes", "containers", "apps", "storage"] as const) {
    expect(() => policy.requireOrganizationResourceLimit(after, resource)).toThrow(
      "Resource ceiling has not been approved",
    );
  }
});
test("canonical legacy accounts keep purchased-credit RPM and distinct eager/non-eager resource policy", async () => {
  const before = await policy.readOrganizationQuotaPolicy(LEGACY);
  await database
    .getPgliteClientForTests()
    .exec(`UPDATE organizations SET credit_balance=0,balance_revision=2 WHERE id='${LEGACY}'`);
  const after = await policy.readOrganizationQuotaPolicy(LEGACY);
  expect(after.tier).toEqual(before.tier);
  expect(policy.requireOrganizationResourceLimit(before, "sandboxes")).toBeGreaterThan(
    policy.requireOrganizationResourceLimit(after, "sandboxes"),
  );
  expect(policy.requireOrganizationResourceLimit(before, "nonEagerSandboxes")).toEqual(
    policy.requireOrganizationResourceLimit(after, "nonEagerSandboxes"),
  );
});
test("legacy credit selection excludes grants, debits and other tenants while retaining empty-credit policy", async () => {
  const pg = database.getPgliteClientForTests();
  const target = crypto.randomUUID();
  const other = crypto.randomUUID();
  await pg.exec(`
    INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state)
    VALUES('${target}',100,1,0,'{}',true,'active'),('${other}',100,1,0,'{}',true,'active');
  `);
  const empty = await policy.readOrganizationQuotaPolicy(target);
  expect(Number(empty.tierSourceCreditTotal)).toBe(0);
  await pg.exec(`
    INSERT INTO credit_transactions(id,organization_id,amount,type,metadata) VALUES
    (gen_random_uuid(),'${target}',1000,'credit','{"type":"initial_free_credits"}'),
    (gen_random_uuid(),'${target}',1000,'credit','{"type":"wallet_signup"}'),
    (gen_random_uuid(),'${target}',1000,'credit','{"type":"signup_code_bonus"}'),
    (gen_random_uuid(),'${target}',-7,'debit','{}'),
    (gen_random_uuid(),'${other}',999999,'credit','{}');
  `);
  const excluded = await policy.readOrganizationQuotaPolicy(target);
  expect(excluded.tier).toEqual(empty.tier);
  expect(Number(excluded.tierSourceCreditTotal)).toBe(0);
  await pg.exec(`
    INSERT INTO credit_transactions(id,organization_id,amount,type,metadata) VALUES
    (gen_random_uuid(),'${target}',6,'credit','{}'),
    (gen_random_uuid(),'${target}',4,'credit','{"type":null}');
  `);
  const funded = await policy.readOrganizationQuotaPolicy(target);
  expect(Number(funded.tierSourceCreditTotal)).toBe(10);
  expect(policy.requireOrganizationRateTier(funded).completionsRpm).toBeGreaterThan(
    policy.requireOrganizationRateTier(empty).completionsRpm,
  );
});
test("a missing subscription association cannot admit a subscriber as a legacy account", async () => {
  const pg = database.getPgliteClientForTests();
  await pg.exec(`UPDATE organization_subscription_authorities
    SET state='none',subscription_id=NULL WHERE organization_id='${ORG}'`);
  try {
    await expect(policy.readOrganizationQuotaPolicy(ORG)).rejects.toMatchObject({
      code: "ORGANIZATION_POLICY_UNAVAILABLE",
      context: { organizationId: ORG, reason: "legacy_association_conflict" },
    });
  } finally {
    await pg.exec(`UPDATE organization_subscription_authorities
      SET state='current',subscription_id='${SUB}' WHERE organization_id='${ORG}'`);
  }
});
test("corrupt purchased balance does not erase independently valid subscriber rate policy", async () => {
  const pg = database.getPgliteClientForTests();
  const before = await policy.readOrganizationQuotaPolicy(ORG);
  await pg.exec(`UPDATE organizations SET credit_balance='NaN' WHERE id='${ORG}'`);
  try {
    const current = await policy.readOrganizationQuotaPolicy(ORG);
    expect(current.balance.status).toBe("unavailable");
    expect(current.tier).toEqual(before.tier);
    expect(current.authority).toEqual(before.authority);
    expect(current.subscriptionFunded).toBe(true);
    expect(() => policy.requireOrganizationPolicyBalance(current)).toThrow();
  } finally {
    await pg.exec(`UPDATE organizations SET credit_balance=0 WHERE id='${ORG}'`);
  }
});
test("override deletion retains a durable fence and rejects delayed cached admission", async () => {
  const original = await policy.readOrganizationQuotaPolicy(ORG);
  await overrides.orgRateLimitOverridesRepository.upsert(
    { organization_id: ORG, completions_rpm: 7 },
    "admin:test",
  );
  const overridden = await policy.readOrganizationQuotaPolicy(ORG);
  expect(policy.requireOrganizationRateTier(overridden).completionsRpm).toBe(7);
  expect(overridden.authority.generation).not.toBe(original.authority.generation);
  await overrides.orgRateLimitOverridesRepository.deleteByOrganizationId(ORG, "admin:test");
  const deleted = await policy.readOrganizationQuotaPolicy(ORG);
  expect(deleted.tier).toEqual(original.tier);
  let dispatched = false;
  await expect(
    admission.withOrganizationPolicyAdmission(ORG, overridden.authority, async () => {
      dispatched = true;
    }),
  ).rejects.toThrow("Organization policy changed");
  expect(dispatched).toBe(false);
  const replay = deleted.authority.generation;
  await overrides.orgRateLimitOverridesRepository.deleteByOrganizationId(ORG, "admin:test");
  expect((await policy.readOrganizationQuotaPolicy(ORG)).authority.generation).toBe(replay);
  expect((await policy.readOrganizationQuotaPolicy(LEGACY)).authority.generation).toBe("0");
});
test("paid storage requires explicit override provenance and reserves atomically", async () => {
  await database
    .getPgliteClientForTests()
    .exec(
      `INSERT INTO org_storage_quota(organization_id,bytes_used,bytes_limit,limit_override_authorized) VALUES('${ORG}',0,999999,false)`,
    );
  await expect(storage.orgStorageQuotaRepository.tryReserveBytes(ORG, 1n)).rejects.toThrow(
    "Resource ceiling has not been approved",
  );
  await storage.orgStorageQuotaRepository.setBytesLimit(ORG, 10n, "admin:test");
  expect(await storage.orgStorageQuotaRepository.tryReserveBytes(ORG, 7n)).toBe(7n);
  expect(await storage.orgStorageQuotaRepository.tryReserveBytes(ORG, 4n)).toBeNull();
  expect((await storage.orgStorageQuotaRepository.findByOrganization(ORG))?.bytes_used).toBe(7n);
});
test("a policy change after a real allowance reservation blocks dispatch and releases the reservation", async () => {
  const pg = database.getPgliteClientForTests();
  await pg.exec(
    `UPDATE subscription_allowance_periods SET period_start=(SELECT current_period_start FROM billing_subscriptions WHERE id='${SUB}'), period_end=(SELECT current_period_end FROM billing_subscriptions WHERE id='${SUB}'), expires_at=(SELECT current_period_end FROM billing_subscriptions WHERE id='${SUB}');`,
  );
  const { admitOrganizationInference } = await import(
    "../../lib/services/organization-inference-admission"
  );
  const before = await pg.query<{ available_amount: string }>(
    `SELECT available_amount FROM subscription_allowance_periods WHERE organization_id='${ORG}'`,
  );
  const funding = await admitOrganizationInference({
    context: {
      organizationId: ORG,
      userId: "63000000-0000-4000-8000-000000000001",
      requestId: "policy-refund",
      model: "test-model",
      provider: "openai",
      billingSource: "openai",
    },
    flatCost: { totalCost: 1, baseTotalCost: 1, platformMarkup: 0 },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
  });
  const held = await pg.query<{ available_amount: string }>(
    `SELECT available_amount FROM subscription_allowance_periods WHERE organization_id='${ORG}'`,
  );
  expect(Number(held.rows[0].available_amount)).toBeLessThan(
    Number(before.rows[0].available_amount),
  );
  await overrides.orgRateLimitOverridesRepository.upsert(
    { organization_id: ORG, completions_rpm: 11 },
    "admin:test",
  );
  let providerCalls = 0;
  await expect(
    (async () => {
      await funding.markProviderDispatched?.();
      providerCalls++;
    })(),
  ).rejects.toThrow("Organization policy changed");
  await funding.settle(0);
  expect(providerCalls).toBe(0);
  const after = await pg.query<{ available_amount: string }>(
    `SELECT available_amount FROM subscription_allowance_periods WHERE organization_id='${ORG}'`,
  );
  expect(after.rows[0].available_amount).toBe(before.rows[0].available_amount);
  await overrides.orgRateLimitOverridesRepository.deleteByOrganizationId(ORG, "admin:test");
});
test("a completed dispatch marker remains replayable after override changes and settles real allowance", async () => {
  const { admitOrganizationInference } = await import(
    "../../lib/services/organization-inference-admission"
  );
  const request = await admitOrganizationInference({
    context: {
      organizationId: ORG,
      userId: "63000000-0000-4000-8000-000000000001",
      requestId: "policy-started",
      model: "test-model",
      provider: "openai",
      billingSource: "openai",
    },
    flatCost: { totalCost: 1, baseTotalCost: 1, platformMarkup: 0 },
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
  });
  await request.markProviderDispatched?.();
  await overrides.orgRateLimitOverridesRepository.upsert(
    { organization_id: ORG, completions_rpm: 12 },
    "admin:test",
  );
  await request.markProviderDispatched?.();
  const settled = await request.settle(0.5);
  expect(settled?.collectedAmount).toBe(0.5);
  await overrides.orgRateLimitOverridesRepository.deleteByOrganizationId(ORG, "admin:test");
});
test("actual character, sandbox, app and container admission deny missing paid ceilings before insertion", async () => {
  const { charactersService } = await import("../../lib/services/characters/characters");
  const { assertOrgAgentQuota } = await import("../../lib/services/eliza-sandbox");
  const { appsRepository } = await import("./apps");
  const { containersRepository } = await import("./containers");
  const userId = "63000000-0000-4000-8000-000000000001";
  await expect(
    charactersService.create(
      {
        organization_id: ORG,
        user_id: userId,
        name: "quota denied",
        username: "quota-denied",
        source: "cloud",
        bio: [],
        character_data: {},
      },
      { policy: { mode: "metered" } },
    ),
  ).rejects.toThrow("Resource ceiling has not been approved");
  await expect(
    database.dbWrite.transaction((tx) => assertOrgAgentQuota(tx, ORG, 99999)),
  ).rejects.toThrow("Resource ceiling has not been approved");
  await expect(
    database.dbWrite.transaction((tx) =>
      appsRepository.createIfOrganizationBelowLimit(
        {
          organization_id: ORG,
          created_by_user_id: userId,
          name: "quota denied",
          slug: "quota-denied",
          app_url: "https://example.test",
        },
        99999,
        tx,
      ),
    ),
  ).rejects.toThrow("Resource ceiling has not been approved");
  await expect(
    containersRepository.createWithQuotaCheck({
      organization_id: ORG,
      user_id: userId,
      name: "quota denied",
      image_tag: "example.invalid/image",
      project_name: "quota-denied",
    }),
  ).rejects.toThrow("Resource ceiling has not been approved");
  expect((await containersRepository.checkQuota(ORG)).availability).toBe("unavailable");
  for (const table of ["user_characters", "agent_sandboxes", "apps", "containers"]) {
    const rows = await database
      .getPgliteClientForTests()
      .query<{ count: number }>(
        `SELECT count(*)::int count FROM ${table} WHERE organization_id='${ORG}'`,
      );
    expect(rows.rows[0].count).toBe(0);
  }
});
test("delayed queued provisioning rechecks paid authority while explicit trusted provenance is preserved", async () => {
  process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";
  const { agentSandboxesRepository } = await import("./agent-sandboxes");
  const pg = database.getPgliteClientForTests();
  const userAgent = "64000000-0000-4000-8000-000000000001";
  const trustedAgent = "64000000-0000-4000-8000-000000000002";
  await pg.exec(
    `INSERT INTO agent_sandboxes(id,organization_id,status,execution_tier,quota_admission_scope) VALUES('${userAgent}','${ORG}','stopped','dedicated-always','organization'),('${trustedAgent}','${ORG}','pending','dedicated-always','trusted_internal')`,
  );
  await expect(agentSandboxesRepository.trySetProvisioning(userAgent)).rejects.toThrow(
    "Resource ceiling has not been approved",
  );
  const unchanged = await pg.query<{ status: string }>(
    `SELECT status FROM agent_sandboxes WHERE id='${userAgent}'`,
  );
  expect(unchanged.rows[0].status).toBe("stopped");
  expect((await agentSandboxesRepository.trySetProvisioning(trustedAgent))?.status).toBe(
    "provisioning",
  );
  await pg.exec(
    `UPDATE agent_sandboxes SET status='running',container_name='existing-container',sandbox_id='existing-provider' WHERE id='${userAgent}'`,
  );
  await expect(agentSandboxesRepository.trySetProvisioning(userAgent)).resolves.toBeUndefined();
  expect(
    (
      await pg.query<{ status: string }>(
        `SELECT status FROM agent_sandboxes WHERE id='${userAgent}'`,
      )
    ).rows[0].status,
  ).toBe("running");
});
test("container restart rechecks current paid ceilings while an existing project intent remains reusable", async () => {
  const { containersRepository } = await import("./containers");
  const id = "65000000-0000-4000-8000-000000000001";
  const pg = database.getPgliteClientForTests();
  await pg.exec(
    `INSERT INTO containers(id,organization_id,user_id,name,project_name,status,image_tag,metadata) VALUES('${id}','${ORG}','63000000-0000-4000-8000-000000000001','existing','existing-project','running','image','{}');`,
  );
  const reused = await containersRepository.createWithProjectIntentAndQuotaCheck({
    organization_id: ORG,
    user_id: "63000000-0000-4000-8000-000000000001",
    name: "existing",
    project_name: "existing-project",
    image_tag: "image",
  });
  expect(reused.container.id).toBe(id);
  await pg.exec(`UPDATE containers SET status='stopped' WHERE id='${id}'`);
  await expect(containersRepository.prepareFundedRestart(id, ORG, new Date())).rejects.toThrow(
    "Resource ceiling has not been approved",
  );
  expect(
    (await pg.query<{ status: string }>(`SELECT status FROM containers WHERE id='${id}'`)).rows[0]
      .status,
  ).toBe("stopped");
});
test("the primary limiter converts a stale embedded policy to warming and consumes the refreshed limit on retry", async () => {
  const { warmInferenceAdmissionSnapshot, inferenceRateLimitConfig } = await import(
    "../../lib/services/inference-admission-snapshot"
  );
  const { enforceOrgRateLimit, OrgRateLimitCacheNotReadyError } = await import(
    "../../lib/middleware/rate-limit"
  );
  const gate = await import("../../lib/services/inference-admission-gate");
  const consume = spyOn(gate, "consumeInferenceRateLimit").mockResolvedValue({
    allowed: true,
    remaining: 6,
    resetAt: Date.now() + 60000,
  });
  const background: Promise<unknown>[] = [];
  try {
    const old = await warmInferenceAdmissionSnapshot(ORG);
    await overrides.orgRateLimitOverridesRepository.upsert(
      { organization_id: ORG, embeddings_rpm: 7 },
      "admin:test",
    );
    await expect(
      enforceOrgRateLimit(ORG, "embeddings", {
        cacheOnly: true,
        config: inferenceRateLimitConfig(old, "embeddings"),
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).rejects.toBeInstanceOf(OrgRateLimitCacheNotReadyError);
    expect(consume).not.toHaveBeenCalled();
    await Promise.all(background);
    const current = await warmInferenceAdmissionSnapshot(ORG);
    expect(current.authority.generation).not.toBe(old.authority.generation);
    await expect(
      enforceOrgRateLimit(ORG, "embeddings", {
        cacheOnly: true,
        config: inferenceRateLimitConfig(current, "embeddings"),
      }),
    ).resolves.toBeNull();
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, maxRequests: 7 }),
    );
  } finally {
    consume.mockRestore();
  }
});
test("a stale standalone tier cache cannot delay or override the locked primary rate policy", async () => {
  const { recalculateOrgTier } = await import("../../lib/services/org-rate-limits");
  const { enforceOrgRateLimit } = await import("../../lib/middleware/rate-limit");
  const gate = await import("../../lib/services/inference-admission-gate");
  const consume = spyOn(gate, "consumeInferenceRateLimit").mockResolvedValue({
    allowed: true,
    remaining: 2,
    resetAt: Date.now() + 60000,
  });
  const background: Promise<unknown>[] = [];
  try {
    await recalculateOrgTier(ORG);
    await overrides.orgRateLimitOverridesRepository.upsert(
      { organization_id: ORG, standard_rpm: 3 },
      "admin:test",
    );
    await expect(
      enforceOrgRateLimit(ORG, "standard", {
        cacheOnly: true,
        executionCtx: { waitUntil: (promise) => background.push(promise) },
      }),
    ).resolves.toBeNull();
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, endpointType: "standard", maxRequests: 3 }),
    );
  } finally {
    await Promise.all(background);
    consume.mockRestore();
  }
});
test("Worker funding uses the primary balance when its projection is absent or overstated", async () => {
  const { runWithCloudBindingsAsync } = await import("../../lib/runtime/cloud-bindings");
  const { readOrgBalanceHint, writeOrgBalanceHint } = await import(
    "../../lib/services/inference-auth-cache"
  );
  const { admitOrganizationInference } = await import(
    "../../lib/services/organization-inference-admission"
  );
  const organizationId = "61000000-0000-4000-8000-000000000005";
  const pg = database.getPgliteClientForTests();
  await pg.exec(`
    INSERT INTO organizations(id,credit_balance,balance_revision,balance_decrease_revision,settings,is_active,account_lifecycle_state)
    VALUES('${organizationId}',2,9,0,'{}',true,'active');
    INSERT INTO credit_transactions(id,organization_id,amount,type,metadata)
    VALUES(gen_random_uuid(),'${organizationId}',2,'credit','{}');
  `);
  expect(await readOrgBalanceHint(organizationId)).toBeNull();
  const dispatched: Array<{ balanceUsd: number; balanceRevision: string }> = [];
  const background: Promise<unknown>[] = [];
  try {
    await runWithCloudBindingsAsync(
      {
        INFERENCE_OPTIMISTIC_BILLING: "true",
        INFERENCE_DEFERRED_ADMISSION: "true",
        INFERENCE_BILLING_LEDGER: "db",
        INFERENCE_ADMISSION_GATES: {
          getByName: (name: string) => {
            expect(name).toBe(organizationId);
            return {
              fetch: async (request: Request) => {
                const body = (await request.json()) as {
                  balanceUsd: number;
                  balanceRevision: string;
                  estimatedCostUsd: number;
                };
                dispatched.push(body);
                return Response.json({
                  admitted: true,
                  dispatched: true,
                  availableUsd: body.balanceUsd,
                  requiredUsd: body.estimatedCostUsd,
                });
              },
            };
          },
        },
      },
      async () => {
        const params: OrganizationInferenceAdmissionParams = {
          context: {
            organizationId,
            userId: "63000000-0000-4000-8000-000000000001",
            requestId: "cold-primary-balance",
            model: "test-model",
            provider: "openai",
            billingSource: "openai",
          },
          flatCost: { totalCost: 0.25, baseTotalCost: 0.25, platformMarkup: 0 },
          estimatedInputTokens: 0,
          estimatedOutputTokens: 0,
          executionCtx: { waitUntil: (work: Promise<unknown>) => background.push(work) },
          atomicProviderBoundary: true,
        };
        const funded = await admitOrganizationInference(params);
        await funded.markProviderDispatched?.();
        expect(dispatched).toEqual([
          expect.objectContaining({ balanceUsd: 2, balanceRevision: "9" }),
        ]);
        await writeOrgBalanceHint(organizationId, 100, Date.now(), "9");
        await pg.exec(
          `UPDATE organizations SET credit_balance=0,balance_revision=10 WHERE id='${organizationId}'`,
        );
        await expect(
          admitOrganizationInference({
            ...params,
            context: { ...params.context, requestId: "overstated-cached-balance" },
          }),
        ).rejects.toMatchObject({ name: "InsufficientCreditsError", available: 0 });
        expect(dispatched).toHaveLength(1);
      },
    );
  } finally {
    await Promise.all(background);
  }
});
test("same-revision projection corruption cannot grant policy", async () => {
  await database
    .getPgliteClientForTests()
    .exec(
      `UPDATE organization_entitlements SET completions_rpm=completions_rpm+1 WHERE organization_id='${ORG}'`,
    );
  await expect(policy.readOrganizationQuotaPolicy(ORG)).rejects.toThrow(
    "Organization policy is unavailable",
  );
});
