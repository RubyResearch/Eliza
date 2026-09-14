/**
 * Route-level contract for POST /api/v1/eliza/agents/:agentId/wake (#15804).
 *
 * The wake boundary landed in #15789 with service-level coverage only; this
 * suite proves the public HTTP contract through the REAL route module with
 * NOTHING mocked: real API-key authentication (seeded sha256 hashes resolved
 * by `requireAuthOrApiKeyWithOrg` against the DB), real `elizaSandboxService`
 * agent
 * and backup-metadata lookups, the real credit gate reading
 * `organizations.credit_balance`, the real provisioning-worker health check
 * against the process-global MOCK_REDIS store, and the real
 * `enqueueAgentWakeOnce` Drizzle transaction (advisory lock, reuse lookup,
 * jobs insert) — all on in-process PGlite via drizzle-kit `pushSchema`.
 *
 * Covers: authentication, tenant isolation, malformed / unknown / invalid
 * JSON bodies, restoreBackupId⊕forceFreshBoot mutual exclusion, cross-org
 * backup ownership (no existence oracle), the failed-verification-backup 409,
 * the credit and worker gates, in-flight-job param conflicts, and the
 * shared-tier / already-running short-circuits. Job rows are asserted in the
 * database, not inferred from the response.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORG_POOR = "33333333-3333-4333-8333-333333333333";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
const USER_POOR = "cccccccc-3333-4333-8333-333333333333";
const AGENT_A = "dddddddd-1111-4111-8111-111111111111";
const AGENT_B = "dddddddd-2222-4222-8222-222222222222";
const AGENT_POOR = "dddddddd-3333-4333-8333-333333333333";
const AGENT_SHARED = "dddddddd-4444-4444-8444-444444444444";
const AGENT_RUNNING = "dddddddd-5555-4555-8555-555555555555";
const BACKUP_A_OK = "eeeeeeee-1111-4111-8111-111111111111";
const BACKUP_A_FAILED = "eeeeeeee-2222-4222-8222-222222222222";
const BACKUP_B = "eeeeeeee-3333-4333-8333-333333333333";
const MISSING_BACKUP = "eeeeeeee-9999-4999-8999-999999999999";

// Plaintext API keys; only their sha256 hashes are stored, exactly as the
// production key-mint path does, so `requireAuthOrApiKey` resolves them for real.
const KEY_A = "eliza_wake_route_test_org_a";
const KEY_B = "eliza_wake_route_test_org_b";
const KEY_POOR = "eliza_wake_route_test_org_poor";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Response DTO schemas — strict runtime validation instead of `as` casts, so a
// drifted wire shape fails the suite instead of silently passing vacuous asserts.
const errorBody = z.object({
  success: z.literal(false),
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

const zodRejectionBody = z.object({
  success: z.literal(false),
  error: z.literal("Invalid request"),
  details: z.array(z.object({ code: z.string(), message: z.string() })),
});

const wakeEnqueuedBody = z.object({
  success: z.literal(true),
  created: z.boolean(),
  alreadyInProgress: z.boolean(),
  data: z.object({
    agentId: z.string(),
    action: z.literal("wake"),
    jobId: z.string(),
    status: z.string(),
    previousStatus: z.string(),
    restoreBackupId: z.string().nullable(),
    forceFreshBoot: z.boolean(),
    message: z.string(),
  }),
  polling: z.object({
    endpoint: z.string(),
    intervalMs: z.number(),
    expectedDurationMs: z.number(),
  }),
});

const conflictDetails = z.object({
  conflictingJobId: z.string(),
  activeRestoreBackupId: z.string().nullable(),
  activeForceFreshBoot: z.boolean(),
  requestedRestoreBackupId: z.string().nullable(),
  requestedForceFreshBoot: z.boolean(),
});

const sharedRuntimeBody = z.object({
  success: z.literal(true),
  source: z.literal("shared_runtime"),
  data: z.object({
    agentId: z.string(),
    action: z.literal("wake"),
    message: z.string(),
    status: z.string(),
    executionTier: z.string(),
  }),
});

const alreadyRunningBody = z.object({
  success: z.literal(true),
  data: z.object({
    agentId: z.string(),
    action: z.literal("wake"),
    message: z.literal("Agent is already running"),
    status: z.literal("running"),
  }),
});

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let clearJobs: (() => Promise<void>) | undefined;
let countWakeJobs: ((agentId: string) => Promise<number>) | undefined;
let publishHeartbeat: (() => Promise<boolean>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const {
      agentSandboxes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
    } = await import("@/db/schemas/agent-sandboxes");
    const { agentBackupObjects } = await import(
      "@/db/schemas/agent-backup-catalog"
    );
    const { agentNodeIncarnationHistories } = await import(
      "@/db/schemas/agent-node-incarnation-histories"
    );
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { generations } = await import("@/db/schemas/generations");
    const { jobs } = await import("@/db/schemas/jobs");
    const { usageRecords } = await import("@/db/schemas/usage-records");
    const { pushSchemaToTestDb } = await import("@/db/push-schema-for-tests");
    const { eq, and } = await import("drizzle-orm");

    await pushSchemaToTestDb({
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentNodeIncarnationHistories,
      agentBackupObjects,
      apiKeys,
      generations,
      jobs,
      usageRecords,
    });

    clearJobs = async () => {
      await dbWrite.delete(jobs);
    };
    countWakeJobs = async (agentId: string) => {
      const rows = await dbWrite
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.type, "agent_wake"), eq(jobs.agent_id, agentId)));
      return rows.length;
    };

    const { publishProvisioningWorkerHeartbeat } = await import(
      "@/lib/services/provisioning-worker-health"
    );
    publishHeartbeat = () => publishProvisioningWorkerHeartbeat();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "wake-org-a", credit_balance: "25" },
      { id: ORG_B, name: "Org B", slug: "wake-org-b", credit_balance: "25" },
      // Exactly the MINIMUM_DEPOSIT boundary: the gate requires balance to
      // EXCEED the minimum, so 0.1 is denied.
      {
        id: ORG_POOR,
        name: "Org Poor",
        slug: "wake-org-poor",
        credit_balance: "0.1",
      },
    ]);
    await dbWrite.insert(users).values([
      {
        id: USER_A,
        email: "wake-owner-a@test.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${USER_A}`,
      },
      {
        id: USER_B,
        email: "wake-owner-b@test.test",
        organization_id: ORG_B,
        role: "owner",
        steward_user_id: `steward-${USER_B}`,
      },
      {
        id: USER_POOR,
        email: "wake-owner-poor@test.test",
        organization_id: ORG_POOR,
        role: "owner",
        steward_user_id: `steward-${USER_POOR}`,
      },
    ]);
    await dbWrite.insert(apiKeys).values([
      {
        name: "wake test key org A",
        key_hash: sha256Hex(KEY_A),
        key_prefix: KEY_A.slice(0, 8),
        organization_id: ORG_A,
        user_id: USER_A,
      },
      {
        name: "wake test key org B",
        key_hash: sha256Hex(KEY_B),
        key_prefix: KEY_B.slice(0, 8),
        organization_id: ORG_B,
        user_id: USER_B,
      },
      {
        name: "wake test key org POOR",
        key_hash: sha256Hex(KEY_POOR),
        key_prefix: KEY_POOR.slice(0, 8),
        organization_id: ORG_POOR,
        user_id: USER_POOR,
      },
    ]);

    await dbWrite.insert(agentSandboxes).values([
      {
        id: AGENT_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Wake Agent A",
        execution_tier: "dedicated-lazy",
        status: "sleeping",
      },
      {
        id: AGENT_B,
        organization_id: ORG_B,
        user_id: USER_B,
        agent_name: "Wake Agent B",
        execution_tier: "dedicated-lazy",
        status: "sleeping",
      },
      {
        id: AGENT_POOR,
        organization_id: ORG_POOR,
        user_id: USER_POOR,
        agent_name: "Wake Agent Poor",
        execution_tier: "dedicated-lazy",
        status: "sleeping",
      },
      {
        id: AGENT_SHARED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Wake Agent Shared",
        execution_tier: "shared",
        status: "running",
      },
      {
        id: AGENT_RUNNING,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Wake Agent Running",
        execution_tier: "dedicated-always",
        status: "running",
        bridge_url: "http://bridge.test.internal",
        health_url: "http://health.test.internal",
      },
    ]);

    await dbWrite.insert(agentSandboxBackups).values([
      {
        id: BACKUP_A_OK,
        sandbox_record_id: AGENT_A,
        snapshot_type: "manual",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
      },
      {
        id: BACKUP_A_FAILED,
        sandbox_record_id: AGENT_A,
        snapshot_type: "pre-shutdown",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
        verification_status: "failed",
        verified_at: new Date("2026-07-09T00:00:00.000Z"),
        verification_error: "decrypt-failed: AEAD decrypt failed",
      },
      {
        id: BACKUP_B,
        sandbox_record_id: AGENT_B,
        snapshot_type: "manual",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
      },
    ]);

    const wakeRoute = (await import("../v1/eliza/agents/[agentId]/wake/route"))
      .default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId/wake", wakeRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-wake-route.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  if (!clearJobs) throw new Error("harness not initialized");
  // Each test starts with an empty job queue so enqueue/conflict outcomes are
  // its own, not residue from a previous case.
  await clearJobs();
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

async function wake(
  agentId: string,
  init: { key?: string; body?: BodyInit; acceptance?: string | null } = {},
): Promise<Response> {
  const headers = new Headers();
  if (init.acceptance !== null)
    headers.set(
      "X-Eliza-Dedicated-Price",
      init.acceptance ?? "dedicated-compute-v1:USD:0.150000:0.300000",
    );
  if (init.key !== undefined) headers.set("X-API-Key", init.key);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(`/api/v1/eliza/agents/${agentId}/wake`, {
    method: "POST",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

describe("Dedicated price acceptance", () => {
  test.each([AGENT_SHARED, AGENT_RUNNING])(
    "keeps the no-op path for %s without new acceptance",
    async (agentId) => {
      const res = await wake(agentId, { key: KEY_A, acceptance: null });
      expect(res.status).toBe(200);
      if (!countWakeJobs) throw new Error("harness not initialized");
      expect(await countWakeJobs(agentId)).toBe(0);
    },
  );

  test.each([null, "dedicated-compute-v1:USD:0.010000:0.020000", "invalid"])(
    "rejects %s without creating a paid job",
    async (acceptance) => {
      const res = await wake(AGENT_A, { key: KEY_A, acceptance });
      expect(res.status).toBe(428);
      expect(await res.json()).toMatchObject({
        code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
      });
      if (!countWakeJobs) throw new Error("harness not initialized");
      expect(await countWakeJobs(AGENT_A)).toBe(0);
    },
  );
});

describe("authentication", () => {
  test("no credentials at all is a 401, not an enqueued job", async () => {
    const res = await wake(AGENT_A);
    expect(res.status).toBe(401);
    const body = errorBody.parse(await res.json());
    expect(body.error).toBe("Authentication required");
    if (!countWakeJobs) throw new Error("harness not initialized");
    expect(await countWakeJobs(AGENT_A)).toBe(0);
  });

  test("an unknown API key is a 401", async () => {
    const res = await wake(AGENT_A, { key: "eliza_wake_route_test_bogus" });
    expect(res.status).toBe(401);
    const body = errorBody.parse(await res.json());
    expect(body.error).toBe("Invalid or expired API key");
  });
});

describe("tenant isolation", () => {
  test("another org's key cannot wake the agent — 404, indistinguishable from missing", async () => {
    const crossOrg = await wake(AGENT_A, { key: KEY_B });
    expect(crossOrg.status).toBe(404);
    expect(errorBody.parse(await crossOrg.json()).error).toBe(
      "Agent not found",
    );

    const missing = await wake("99999999-9999-4999-8999-999999999999", {
      key: KEY_B,
    });
    expect(missing.status).toBe(404);
    expect(errorBody.parse(await missing.json()).error).toBe("Agent not found");

    if (!countWakeJobs) throw new Error("harness not initialized");
    expect(await countWakeJobs(AGENT_A)).toBe(0);
  });
});

describe("request body validation", () => {
  test("malformed JSON is a typed 400, not a 500", async () => {
    const res = await wake(AGENT_A, { key: KEY_A, body: "{nope" });
    expect(res.status).toBe(400);
    expect(errorBody.parse(await res.json()).error).toBe("Invalid JSON body");
  });

  test("unknown JSON fields are rejected, not silently dropped", async () => {
    // A typo'd restore field silently ignored would turn an explicit
    // restore-point choice into a default latest-backup wake.
    const res = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupID: BACKUP_A_OK }),
    });
    expect(res.status).toBe(400);
    const body = zodRejectionBody.parse(await res.json());
    expect(body.details.map((issue) => issue.code)).toContain(
      "unrecognized_keys",
    );
    if (!countWakeJobs) throw new Error("harness not initialized");
    expect(await countWakeJobs(AGENT_A)).toBe(0);
  });

  test("non-uuid restoreBackupId is a 400", async () => {
    const res = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupId: "latest" }),
    });
    expect(res.status).toBe(400);
    zodRejectionBody.parse(await res.json());
  });

  test("restoreBackupId and forceFreshBoot are mutually exclusive", async () => {
    const res = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({
        restoreBackupId: BACKUP_A_OK,
        forceFreshBoot: true,
      }),
    });
    expect(res.status).toBe(400);
    expect(errorBody.parse(await res.json()).error).toBe(
      "restoreBackupId and forceFreshBoot are mutually exclusive",
    );
  });
});

describe("backup ownership", () => {
  test("another agent's backupId and a nonexistent one are the same 404 (no existence oracle)", async () => {
    const foreign = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupId: BACKUP_B }),
    });
    expect(foreign.status).toBe(404);
    const foreignBody = errorBody.parse(await foreign.json());

    const missing = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupId: MISSING_BACKUP }),
    });
    expect(missing.status).toBe(404);
    const missingBody = errorBody.parse(await missing.json());

    expect(foreignBody.error).toBe("No backup found");
    expect(missingBody.error).toBe(foreignBody.error);
  });

  test("a backup stamped failed is refused up front with the escape hatches named", async () => {
    const res = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupId: BACKUP_A_FAILED }),
    });
    expect(res.status).toBe(409);
    const body = errorBody.parse(await res.json());
    expect(body.error).toContain("previously failed restore-integrity");
    expect(body.error).toContain("AEAD decrypt failed");
    expect(body.error).toContain("forceFreshBoot");
  });
});

describe("credit gate", () => {
  test("an org at the minimum deposit boundary is denied with the canonical 402 body", async () => {
    const res = await wake(AGENT_POOR, { key: KEY_POOR });
    expect(res.status).toBe(402);
    const body = z
      .object({
        success: z.literal(false),
        code: z.literal("insufficient_credits"),
        error: z.string(),
        requiredBalance: z.number(),
        currentBalance: z.number(),
      })
      .parse(await res.json());
    expect(body.currentBalance).toBe(0.1);
    if (!countWakeJobs) throw new Error("harness not initialized");
    expect(await countWakeJobs(AGENT_POOR)).toBe(0);
  });
});

describe("provisioning worker gate", () => {
  test("when the worker is required, wake fails closed on a missing heartbeat and opens on a fresh one", async () => {
    if (!publishHeartbeat || !countWakeJobs)
      throw new Error("harness not initialized");
    process.env.REQUIRE_PROVISIONING_WORKER = "true";
    try {
      const blocked = await wake(AGENT_A, { key: KEY_A });
      expect(blocked.status).toBe(503);
      const blockedBody = z
        .object({
          success: z.literal(false),
          code: z.literal("PROVISIONING_WORKER_UNHEALTHY"),
          error: z.string(),
          retryable: z.literal(true),
        })
        .parse(await blocked.json());
      expect(blockedBody.error).toContain("heartbeat");
      expect(await countWakeJobs(AGENT_A)).toBe(0);

      // The daemon's real heartbeat publisher writes to the same MOCK_REDIS
      // store the health check reads — the gate opens without any stubbing.
      expect(await publishHeartbeat()).toBe(true);
      const allowed = await wake(AGENT_A, { key: KEY_A });
      expect(allowed.status).toBe(202);
      wakeEnqueuedBody.parse(await allowed.json());
      expect(await countWakeJobs(AGENT_A)).toBe(1);
    } finally {
      delete process.env.REQUIRE_PROVISIONING_WORKER;
    }
  });
});

describe("enqueue and in-flight conflicts", () => {
  test("bodyless wake enqueues a real job; a bare retry reuses it as a 409 already-in-progress", async () => {
    if (!countWakeJobs) throw new Error("harness not initialized");

    const first = await wake(AGENT_A, { key: KEY_A });
    expect(first.status).toBe(202);
    const firstBody = wakeEnqueuedBody.parse(await first.json());
    expect(firstBody.created).toBe(true);
    expect(firstBody.alreadyInProgress).toBe(false);
    expect(firstBody.data.agentId).toBe(AGENT_A);
    expect(firstBody.data.previousStatus).toBe("sleeping");
    expect(firstBody.data.restoreBackupId).toBeNull();
    expect(firstBody.data.forceFreshBoot).toBe(false);
    expect(firstBody.polling.endpoint).toBe(
      `/api/v1/jobs/${firstBody.data.jobId}`,
    );
    expect(await countWakeJobs(AGENT_A)).toBe(1);

    const retry = await wake(AGENT_A, { key: KEY_A });
    expect(retry.status).toBe(409);
    const retryBody = wakeEnqueuedBody.parse(await retry.json());
    expect(retryBody.created).toBe(false);
    expect(retryBody.alreadyInProgress).toBe(true);
    expect(retryBody.data.jobId).toBe(firstBody.data.jobId);
    // Still exactly one job row: the retry reused, not duplicated.
    expect(await countWakeJobs(AGENT_A)).toBe(1);
  });

  test("a param-bearing request conflicting with the in-flight job is a typed 409 naming that job", async () => {
    if (!countWakeJobs) throw new Error("harness not initialized");

    const first = await wake(AGENT_A, { key: KEY_A });
    expect(first.status).toBe(202);
    const firstBody = wakeEnqueuedBody.parse(await first.json());

    const conflicting = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ forceFreshBoot: true }),
    });
    expect(conflicting.status).toBe(409);
    const conflictBody = errorBody.parse(await conflicting.json());
    expect(conflictBody.error).toContain("different restore parameters");
    const details = conflictDetails.parse(conflictBody.details);
    expect(details.conflictingJobId).toBe(firstBody.data.jobId);
    expect(details.activeForceFreshBoot).toBe(false);
    expect(details.requestedForceFreshBoot).toBe(true);
    expect(await countWakeJobs(AGENT_A)).toBe(1);
  });

  test("a bare retry over a param-bearing in-flight job echoes the params the job will ACTUALLY apply", async () => {
    const first = await wake(AGENT_A, {
      key: KEY_A,
      body: JSON.stringify({ restoreBackupId: BACKUP_A_OK }),
    });
    expect(first.status).toBe(202);
    const firstBody = wakeEnqueuedBody.parse(await first.json());
    expect(firstBody.data.restoreBackupId).toBe(BACKUP_A_OK);

    // The bare retry rides the active job; the response must report the
    // active job's restore point, never the caller's unapplied defaults.
    const retry = await wake(AGENT_A, { key: KEY_A });
    expect(retry.status).toBe(409);
    const retryBody = wakeEnqueuedBody.parse(await retry.json());
    expect(retryBody.alreadyInProgress).toBe(true);
    expect(retryBody.data.jobId).toBe(firstBody.data.jobId);
    expect(retryBody.data.restoreBackupId).toBe(BACKUP_A_OK);
  });
});

describe("short-circuits", () => {
  test("a shared-tier agent needs no wake job", async () => {
    if (!countWakeJobs) throw new Error("harness not initialized");
    const res = await wake(AGENT_SHARED, { key: KEY_A });
    expect(res.status).toBe(200);
    const body = sharedRuntimeBody.parse(await res.json());
    expect(body.data.executionTier).toBe("shared");
    expect(await countWakeJobs(AGENT_SHARED)).toBe(0);
  });

  test("an already-running dedicated agent needs no wake job", async () => {
    if (!countWakeJobs) throw new Error("harness not initialized");
    const res = await wake(AGENT_RUNNING, { key: KEY_A });
    expect(res.status).toBe(200);
    alreadyRunningBody.parse(await res.json());
    expect(await countWakeJobs(AGENT_RUNNING)).toBe(0);
  });
});

describe("CORS preflight", () => {
  test("OPTIONS answers 204 with the route's method allowlist", async () => {
    const res = await app.request(`/api/v1/eliza/agents/${AGENT_A}/wake`, {
      method: "OPTIONS",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "X-Eliza-Dedicated-Price",
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe(
      "POST, OPTIONS",
    );
  });
});
