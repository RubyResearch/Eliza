/**
 * Exercises snapshot lifecycle authority and atomic persistence against real
 * PGlite rows. Network capture is deterministic, while admission, advisory
 * locking, row locking, backup planning, catalogue writes, metadata CAS, and
 * pruning use the production service and repositories.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { type AgentSandbox, agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";
import {
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
} from "../../db/schemas/agent-sandboxes";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import {
  ElizaSandboxService,
  SNAPSHOT_CAPTURE_TRANSIENT,
  SNAPSHOT_ENDPOINT_UNSUPPORTED,
} from "./eliza-sandbox";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const AMBIENT_HEAVY_PAYLOAD_STORAGE = process.env.SQL_HEAVY_PAYLOAD_STORAGE;
const AMBIENT_HEAVY_PAYLOAD_MIN_BYTES = process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES;
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 300_000;
const API_TOKEN = "snapshot-authority-token";
const DELETION_ATTEMPT_ID = "00000000-0000-4000-8000-000000229471";
const ORIGINAL_FETCH = globalThis.fetch;
const AUTHORITY_CHANGED = "Sandbox changed while snapshot was being captured";
const TIER_REJECTION = "Agent snapshot requires a container-backed execution tier";
const POOL_REJECTION = "Agent snapshot cannot target pool-owned capacity";
const DELETED_REJECTION = "Agent snapshot cannot target a deleted agent";
const DELETION_REJECTION = "Agent snapshot cannot start while agent deletion is in progress";

let pgliteReady = true;
let sequence = 0;

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function state(overrides: Partial<AgentBackupStateData> = {}): AgentBackupStateData {
  return {
    memories: [],
    config: { source: "snapshot-authority" },
    workspaceFiles: {},
    ...overrides,
  };
}

function fullManifest(agentId: string): NonNullable<AgentBackupStateData["manifest"]> {
  return {
    schemaVersion: 1,
    format: "elizaos.agent-backup",
    createdAt: "2026-08-22T00:00:00.000Z",
    agentId,
    components: {
      database: { kind: "none", reason: "fixture", sha256: "database" },
      media: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "media" },
      vault: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "vault" },
      character: { runtimeCharacter: { name: "Snapshot Agent" }, sha256: "character" },
      stateFiles: { kind: "file-set", rootLabel: "state-dir", files: [], sha256: "state" },
    },
    integrity: { componentHashes: {} },
  };
}

async function seedOwner(): Promise<{ organizationId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Snapshot Authority", slug: unique("snapshot-authority") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: organization.id, steward_user_id: unique("steward") })
    .returning();
  if (!organization || !user) throw new Error("Snapshot authority owner seed failed");
  return { organizationId: organization.id, userId: user.id };
}

async function seedSandbox(overrides: Partial<AgentSandbox> = {}): Promise<AgentSandbox> {
  const owner = await seedOwner();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: owner.organizationId,
      user_id: owner.userId,
      agent_name: unique("snapshot-agent"),
      execution_tier: "dedicated-lazy",
      status: "running",
      sandbox_id: unique("sandbox"),
      node_id: unique("node"),
      container_name: unique("container"),
      bridge_url: "http://127.0.0.1:21060",
      health_url: "http://127.0.0.1:3000/health",
      bridge_port: 21060,
      web_ui_port: 3000,
      headscale_ip: "100.64.0.10",
      environment_vars: { ELIZA_API_TOKEN: API_TOKEN },
      environment_revision: 7,
      lifecycle_revision: 11,
      pool_status: null,
      deleted_at: null,
      deletion_attempt_id: null,
      ...overrides,
      deletion_started_at:
        overrides.deletion_attempt_id != null && overrides.deletion_started_at === undefined
          ? new Date("2026-08-22T00:30:00.000Z")
          : (overrides.deletion_started_at ?? null),
    })
    .returning();
  if (!sandbox) throw new Error("Snapshot authority sandbox seed failed");
  return sandbox;
}

async function seedLegacyBackups(agentId: string, count = 11): Promise<void> {
  if (count === 0) return;
  await dbWrite.insert(agentSandboxBackups).values(
    Array.from({ length: count }, (_, index) => ({
      sandbox_record_id: agentId,
      snapshot_type: "manual" as const,
      state_data: state({ config: { index } }),
      state_data_storage: "inline" as const,
      size_bytes: 64,
      backup_kind: "full" as const,
      created_at: new Date(Date.UTC(2026, 7, 1, 0, 0, index)),
    })),
  );
}

async function backupCount(agentId: string): Promise<number> {
  const rows = await dbWrite
    .select({ id: agentSandboxBackups.id })
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.sandbox_record_id, agentId));
  return rows.length;
}

async function durableState(agentId: string): Promise<{
  backups: number;
  lastBackupAt: Date | null;
  lifecycleRevision: number | null;
}> {
  const [sandbox] = await dbWrite
    .select({
      lastBackupAt: agentSandboxes.last_backup_at,
      lifecycleRevision: agentSandboxes.lifecycle_revision,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return {
    backups: await backupCount(agentId),
    lastBackupAt: sandbox?.lastBackupAt ?? null,
    lifecycleRevision: sandbox?.lifecycleRevision ?? null,
  };
}

function installSnapshotFetch(
  options: {
    responseState?: AgentBackupStateData;
    status?: number;
    body?: string;
    beforeResponse?: () => Promise<void>;
  } = {},
) {
  return mock(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toEndWith("/api/snapshot");
    await options.beforeResponse?.();
    if (options.status !== undefined && options.status !== 200) {
      return new Response(options.body ?? "snapshot failure", {
        status: options.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Response.json(options.responseState ?? state());
  });
}

async function expectInitialRefusal(sandbox: AgentSandbox, expectedError: string): Promise<void> {
  await seedLegacyBackups(sandbox.id);
  const before = await durableState(sandbox.id);
  const fetchMock = installSnapshotFetch();
  globalThis.fetch = fetchMock;

  await expect(
    new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
  ).resolves.toEqual({ success: false, error: expectedError });

  expect(fetchMock).not.toHaveBeenCalled();
  expect(await durableState(sandbox.id)).toEqual(before);
}

async function expectPostFetchRefusal(
  mutate: (sandbox: AgentSandbox) => Promise<void>,
  expectedError: string,
): Promise<void> {
  const sandbox = await seedSandbox();
  await seedLegacyBackups(sandbox.id);
  const fetchMock = installSnapshotFetch({
    beforeResponse: async () => mutate(sandbox),
  });
  globalThis.fetch = fetchMock;

  await expect(
    new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
  ).resolves.toEqual({ success: false, error: expectedError });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await backupCount(sandbox.id)).toBe(11);
  const [after] = await dbWrite
    .select({ lastBackupAt: agentSandboxes.last_backup_at })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, sandbox.id));
  expect(after?.lastBackupAt ?? null).toBeNull();
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    return;
  }
  try {
    for (const ddl of PROVISIONING_JOB_TEST_TABLES) {
      await dbWrite.execute(sql.raw(ddl));
    }
    const heartbeatMigration = readFileSync(
      new URL("../../db/migrations/0386_agent_heartbeat_lifecycle_revision.sql", import.meta.url),
      "utf8",
    );
    for (const statement of heartbeatMigration.split("--> statement-breakpoint")) {
      if (statement.trim()) await dbWrite.execute(sql.raw(statement));
    }
    const { getPgliteClientForTests } = await import("../../db/client");
    await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
  delete process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES;
  await dbWrite.execute(
    sql.raw('DROP TRIGGER IF EXISTS "snapshot_metadata_block" ON "agent_sandboxes"'),
  );
  await dbWrite.execute(
    sql.raw('DROP TRIGGER IF EXISTS "snapshot_backup_insert_block" ON "agent_sandbox_backups"'),
  );
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (pgliteReady) {
    await dbWrite.execute(
      sql.raw('DROP TRIGGER IF EXISTS "snapshot_metadata_block" ON "agent_sandboxes"'),
    );
    await dbWrite.execute(
      sql.raw('DROP TRIGGER IF EXISTS "snapshot_backup_insert_block" ON "agent_sandbox_backups"'),
    );
  }
});

afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (AMBIENT_HEAVY_PAYLOAD_STORAGE === undefined) {
    delete process.env.SQL_HEAVY_PAYLOAD_STORAGE;
  } else {
    process.env.SQL_HEAVY_PAYLOAD_STORAGE = AMBIENT_HEAVY_PAYLOAD_STORAGE;
  }
  if (AMBIENT_HEAVY_PAYLOAD_MIN_BYTES === undefined) {
    delete process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES;
  } else {
    process.env.SQL_HEAVY_PAYLOAD_MIN_BYTES = AMBIENT_HEAVY_PAYLOAD_MIN_BYTES;
  }
  await closeDatabaseConnectionsForTests();
});

describe("ElizaSandboxService snapshot initial authority", () => {
  test("missing and foreign-tenant rows remain indistinguishable with zero effects", async () => {
    const sandbox = await seedSandbox();
    await seedLegacyBackups(sandbox.id);
    const before = await durableState(sandbox.id);
    const fetchMock = installSnapshotFetch();
    globalThis.fetch = fetchMock;

    const service = new ElizaSandboxService();
    await expect(service.snapshot(crypto.randomUUID(), sandbox.organization_id)).resolves.toEqual({
      success: false,
      error: "Sandbox is not running",
    });
    await expect(service.snapshot(sandbox.id, crypto.randomUUID())).resolves.toEqual({
      success: false,
      error: "Sandbox is not running",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await durableState(sandbox.id)).toEqual(before);
  });

  test("Shared stopped rows reject on tier before status or bridge work", async () => {
    await expectInitialRefusal(
      await seedSandbox({ execution_tier: "shared", status: "stopped" }),
      TIER_REJECTION,
    );
  });

  test("unknown stopped rows with every bad field reject on tier first", async () => {
    await expectInitialRefusal(
      await seedSandbox({
        execution_tier: "future-tier" as never,
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T01:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      TIER_REJECTION,
    );
  });

  test("pool-owned stopped rows reject before deleted and deletion-attempt fields", async () => {
    await expectInitialRefusal(
      await seedSandbox({
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T01:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      POOL_REJECTION,
    );
  });

  test("deleted stopped rows reject before a deletion-attempt field", async () => {
    await expectInitialRefusal(
      await seedSandbox({
        status: "stopped",
        deleted_at: new Date("2026-08-22T01:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      DELETED_REJECTION,
    );
  });

  test("deletion-owned rows reject before the preserved status check", async () => {
    await expectInitialRefusal(
      await seedSandbox({
        status: "deletion_pending",
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      }),
      DELETION_REJECTION,
    );
  });

  test("a canonical stopped row keeps the existing not-running result", async () => {
    await expectInitialRefusal(await seedSandbox({ status: "stopped" }), "Sandbox is not running");
  });
});

describe("ElizaSandboxService snapshot post-capture authority", () => {
  test("a heartbeat during capture preserves the backup and its metadata", async () => {
    const sandbox = await seedSandbox();
    const capturedState = state({ config: { heartbeatDuringCapture: true } });
    const heartbeatAt = new Date("2026-09-13T00:01:00Z");
    globalThis.fetch = installSnapshotFetch({
      responseState: capturedState,
      beforeResponse: async () => {
        await dbWrite
          .update(agentSandboxes)
          .set({ last_heartbeat_at: heartbeatAt, updated_at: heartbeatAt })
          .where(eq(agentSandboxes.id, sandbox.id));
      },
    });
    const result = await new ElizaSandboxService().snapshot(
      sandbox.id,
      sandbox.organization_id,
      "manual",
    );
    expect(result).toMatchObject({ success: true, backup: { state_data: capturedState } });
    expect(await backupCount(sandbox.id)).toBe(1);
    const [after] = await dbWrite
      .select({
        heartbeatAt: agentSandboxes.last_heartbeat_at,
        backupAt: agentSandboxes.last_backup_at,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(after.heartbeatAt).toEqual(heartbeatAt);
    expect(after.backupAt).toBeInstanceOf(Date);
  });

  test("tier loss after fetch wins over every later authority field", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          execution_tier: "shared",
          pool_status: "unclaimed",
          deleted_at: new Date("2026-08-22T02:00:00.000Z"),
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-22T01:30:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, TIER_REJECTION);
  });

  test("pool ownership acquired after fetch wins over deleted and deletion-attempt fields", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          pool_status: "unclaimed",
          deleted_at: new Date("2026-08-22T02:00:00.000Z"),
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-22T01:30:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, POOL_REJECTION);
  });

  test("deletion after fetch wins over a deletion-attempt field", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          deleted_at: new Date("2026-08-22T02:00:00.000Z"),
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-22T01:30:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, DELETED_REJECTION);
  });

  test("a deletion attempt acquired after fetch prevents persistence", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-22T01:30:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, DELETION_REJECTION);
  });

  test("a stopped transition after fetch prevents persistence", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, "Sandbox is not running");
  });

  test("a lifecycle-generation change after fetch prevents persistence", async () => {
    await expectPostFetchRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ agent_name: unique("renamed") })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("authority loss prevents oversized backup preparation before its inline-storage refusal", async () => {
    const sandbox = await seedSandbox();
    const fetchMock = installSnapshotFetch({
      responseState: state({ workspaceFiles: { "oversized.bin": "x".repeat(1_100_000) } }),
      beforeResponse: async () => {
        await dbWrite
          .update(agentSandboxes)
          .set({ agent_name: unique("renamed-before-preparation") })
          .where(eq(agentSandboxes.id, sandbox.id));
      },
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).resolves.toEqual({ success: false, error: AUTHORITY_CHANGED });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await backupCount(sandbox.id)).toBe(0);
    const [after] = await dbWrite
      .select({ lastBackupAt: agentSandboxes.last_backup_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(after?.lastBackupAt).toBeNull();
  });

  test("a bridge or locator change after fetch prevents persistence", async () => {
    for (const update of [
      { bridge_url: "http://127.0.0.1:22060" },
      { health_url: "http://127.0.0.1:3100/health" },
      { sandbox_id: unique("replacement-sandbox") },
      { node_id: unique("replacement-node") },
      { container_name: unique("replacement-container") },
      { bridge_port: 22060 },
      { web_ui_port: 3100 },
      { headscale_ip: "100.64.0.11" },
      { environment_revision: 8 },
    ] satisfies Array<Partial<AgentSandbox>>) {
      await expectPostFetchRefusal(async (sandbox) => {
        await dbWrite.update(agentSandboxes).set(update).where(eq(agentSandboxes.id, sandbox.id));
      }, AUTHORITY_CHANGED);
    }
  });

  test("row loss after fetch prevents an orphan backup", async () => {
    const sandbox = await seedSandbox();
    const fetchMock = installSnapshotFetch({
      beforeResponse: async () => {
        await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, sandbox.id));
      },
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).resolves.toEqual({ success: false, error: AUTHORITY_CHANGED });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await backupCount(sandbox.id)).toBe(0);
  });

  test("an ABA locator change is fenced by the lifecycle generation", async () => {
    const sandbox = await seedSandbox();
    const originalBridge = sandbox.bridge_url;
    const fetchMock = installSnapshotFetch({
      beforeResponse: async () => {
        await dbWrite
          .update(agentSandboxes)
          .set({ bridge_url: "http://127.0.0.1:22060" })
          .where(eq(agentSandboxes.id, sandbox.id));
        await dbWrite
          .update(agentSandboxes)
          .set({ bridge_url: originalBridge })
          .where(eq(agentSandboxes.id, sandbox.id));
      },
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).resolves.toEqual({ success: false, error: AUTHORITY_CHANGED });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await backupCount(sandbox.id)).toBe(0);
    const [after] = await dbWrite
      .select({ bridgeUrl: agentSandboxes.bridge_url, lastBackupAt: agentSandboxes.last_backup_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(after).toEqual({ bridgeUrl: originalBridge, lastBackupAt: null });
  });
});

describe("ElizaSandboxService snapshot atomic persistence", () => {
  test("lost metadata CAS prevents backup preparation and insert", async () => {
    const sandbox = await seedSandbox();
    await dbWrite.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION block_snapshot_metadata_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.last_backup_at IS DISTINCT FROM OLD.last_backup_at THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER snapshot_metadata_block
      BEFORE UPDATE ON agent_sandboxes
      FOR EACH ROW EXECUTE FUNCTION block_snapshot_metadata_update()
    `),
    );
    const fetchMock = installSnapshotFetch({
      responseState: state({ workspaceFiles: { "oversized.bin": "x".repeat(1_100_000) } }),
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).rejects.toThrow("Backup metadata update lost its sandbox row");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await backupCount(sandbox.id)).toBe(0);
    const [after] = await dbWrite
      .select({
        lastBackupAt: agentSandboxes.last_backup_at,
        lifecycleRevision: agentSandboxes.lifecycle_revision,
      })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(after).toEqual({ lastBackupAt: null, lifecycleRevision: 11 });
  });

  test("rolls the metadata update back when the backup insert fails", async () => {
    const sandbox = await seedSandbox();
    await dbWrite.execute(
      sql.raw(`
        CREATE OR REPLACE FUNCTION block_snapshot_backup_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'snapshot backup insert blocked';
        END;
        $$
      `),
    );
    await dbWrite.execute(
      sql.raw(`
        CREATE TRIGGER snapshot_backup_insert_block
        BEFORE INSERT ON agent_sandbox_backups
        FOR EACH ROW EXECUTE FUNCTION block_snapshot_backup_insert()
      `),
    );
    const before = await durableState(sandbox.id);
    const fetchMock = installSnapshotFetch();
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).rejects.toThrow('Failed query: insert into "agent_sandbox_backups"');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await durableState(sandbox.id)).toEqual(before);
  });

  test("two captures of one generation serialize and only one commits", async () => {
    const sandbox = await seedSandbox();
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothCaptured = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = mock(async () => {
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothCaptured;
      return Response.json(state());
    });
    globalThis.fetch = fetchMock;

    const results = await Promise.all([
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results.filter(({ success }) => success)).toHaveLength(1);
    expect(results.filter(({ error }) => error === AUTHORITY_CHANGED)).toHaveLength(1);
    expect(await backupCount(sandbox.id)).toBe(1);
    const [after] = await dbWrite
      .select({ lastBackupAt: agentSandboxes.last_backup_at })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(after?.lastBackupAt).toBeInstanceOf(Date);
  });

  test.each([...CONTAINER_BACKED_EXECUTION_TIERS])(
    "commits one backup and its timestamp atomically for canonical %s",
    async (executionTier) => {
      const sandbox = await seedSandbox({
        execution_tier: executionTier,
        pool_status: null,
        deleted_at: null,
        deletion_attempt_id: null,
      });
      const capturedState = state({ config: { executionTier } });
      const fetchMock = installSnapshotFetch({ responseState: capturedState });
      globalThis.fetch = fetchMock;

      const result = await new ElizaSandboxService().snapshot(
        sandbox.id,
        sandbox.organization_id,
        "manual",
      );

      expect(result).toMatchObject({
        success: true,
        backup: {
          sandbox_record_id: sandbox.id,
          snapshot_type: "manual",
          backup_kind: "full",
          state_data: capturedState,
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await backupCount(sandbox.id)).toBe(1);
      const [after] = await dbWrite
        .select({ lastBackupAt: agentSandboxes.last_backup_at })
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, sandbox.id));
      expect(after?.lastBackupAt).toBeInstanceOf(Date);
    },
  );

  test("preserves bounded chain-safe pruning after commit", async () => {
    const sandbox = await seedSandbox();
    await seedLegacyBackups(sandbox.id);
    globalThis.fetch = installSnapshotFetch({
      responseState: state({ workspaceFiles: { replacement: "y".repeat(2_000) } }),
    });

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "manual"),
    ).resolves.toMatchObject({ success: true });

    expect(await backupCount(sandbox.id)).toBe(10);
  });
});

describe("ElizaSandboxService snapshot preserved capture and planning semantics", () => {
  test("keeps endpoint-unsupported and structured transient results free of durable writes", async () => {
    const unsupported = await seedSandbox();
    globalThis.fetch = installSnapshotFetch({ status: 404, body: "not found" });
    await expect(
      new ElizaSandboxService().snapshot(unsupported.id, unsupported.organization_id, "auto"),
    ).resolves.toEqual({ success: false, error: SNAPSHOT_ENDPOINT_UNSUPPORTED });
    expect(await durableState(unsupported.id)).toMatchObject({ backups: 0, lastBackupAt: null });

    const transient = await seedSandbox();
    globalThis.fetch = installSnapshotFetch({
      status: 503,
      body: JSON.stringify({ code: "PGLITE_SNAPSHOT_UNAVAILABLE_TRANSIENT" }),
    });
    await expect(
      new ElizaSandboxService().snapshot(transient.id, transient.organization_id, "auto"),
    ).resolves.toEqual({
      success: false,
      error: SNAPSHOT_CAPTURE_TRANSIENT,
      retryable: true,
    });
    expect(await durableState(transient.id)).toMatchObject({ backups: 0, lastBackupAt: null });
  });

  test("keeps the full-manifest requirement before durable writes", async () => {
    const sandbox = await seedSandbox();
    globalThis.fetch = installSnapshotFetch();

    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "pre-move"),
    ).resolves.toEqual({
      success: false,
      error: "pre-move snapshot did not include a full-agent manifest",
    });
    expect(await durableState(sandbox.id)).toMatchObject({ backups: 0, lastBackupAt: null });

    const manifestState = state({ manifest: fullManifest(sandbox.id) });
    globalThis.fetch = installSnapshotFetch({ responseState: manifestState });
    await expect(
      new ElizaSandboxService().snapshot(sandbox.id, sandbox.organization_id, "pre-move"),
    ).resolves.toMatchObject({
      success: true,
      backup: { snapshot_type: "pre-move", backup_kind: "full" },
    });
  });

  test("preserves incremental and full backup planning", async () => {
    const incrementalSandbox = await seedSandbox();
    const large = "x".repeat(50_000);
    const base = await agentSandboxesRepository.createBackup({
      sandbox_record_id: incrementalSandbox.id,
      snapshot_type: "manual",
      state_data: state({ workspaceFiles: { "large.bin": large } }),
      size_bytes: large.length,
      backup_kind: "full",
    });
    const incrementalState = state({
      workspaceFiles: { "large.bin": large, "note.txt": "small" },
    });
    globalThis.fetch = installSnapshotFetch({ responseState: incrementalState });

    const incremental = await new ElizaSandboxService().snapshot(
      incrementalSandbox.id,
      incrementalSandbox.organization_id,
      "manual",
    );
    expect(incremental).toMatchObject({
      success: true,
      backup: {
        backup_kind: "incremental",
        parent_backup_id: base.id,
        content_hash: expect.any(String),
        size_bytes: expect.any(Number),
      },
    });
    if (!incremental.backup) throw new Error("Incremental snapshot did not return its backup");
    expect(
      await agentSandboxesRepository.getReconstructedBackupState(incremental.backup.id),
    ).toEqual(incrementalState);

    const fullSandbox = await seedSandbox();
    await agentSandboxesRepository.createBackup({
      sandbox_record_id: fullSandbox.id,
      snapshot_type: "manual",
      state_data: state({ workspaceFiles: { a: "x".repeat(1_000) } }),
      size_bytes: 1_000,
      backup_kind: "full",
    });
    const fullState = state({
      workspaceFiles: { a: "y".repeat(1_000), b: "z".repeat(1_000) },
    });
    globalThis.fetch = installSnapshotFetch({ responseState: fullState });
    const full = await new ElizaSandboxService().snapshot(
      fullSandbox.id,
      fullSandbox.organization_id,
      "manual",
    );
    expect(full).toMatchObject({
      success: true,
      backup: { backup_kind: "full", content_hash: expect.any(String) },
    });
    if (!full.backup) throw new Error("Full snapshot did not return its backup");
    expect(await agentSandboxesRepository.getReconstructedBackupState(full.backup.id)).toEqual(
      fullState,
    );
  });
});
