/**
 * Exercises live restore authority against real PGlite rows. Backup selection,
 * reconstruction, lifecycle/advisory locks, row locks, and durable fencing use
 * the production service and repositories; only runtime HTTP is deterministic.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import {
  type AgentSandbox,
  type AgentSandboxBackup,
  agentSandboxesRepository,
  type ProvisioningAdmissionCapture,
} from "../../db/repositories/agent-sandboxes";
import { installOrganizationPolicyTestSchema } from "../../db/repositories/organization-policy-test-fixture";
import {
  type AgentBackupDeltaData,
  type AgentBackupStateData,
  agentSandboxBackups,
  agentSandboxes,
  type StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { organizations } from "../../db/schemas/organizations";
import { personalDedicatedAdoptionSelections } from "../../db/schemas/personal-dedicated-adoption-selections";
import { users } from "../../db/schemas/users";
import { PROVISIONING_JOB_TEST_TABLES } from "./__tests__/tier-upgrade-pglite-schema";
import { applyBackupDelta, computeStateHash } from "./agent-backup-diff";
import { apiKeysService } from "./api-keys";
import { ElizaSandboxService, type ProvisionRestoreOverride } from "./eliza-sandbox";
import type { PersonalDedicatedReviewedBackupChainEntry } from "./personal-dedicated-adoption-provenance";
import { JOB_TYPES } from "./provisioning-job-types";
import { resolveReviewedProvisionRestoreDirectiveForExecution } from "./provisioning-jobs";
import type { SandboxProvider } from "./sandbox-provider";

const AMBIENT_DATABASE_URL_VALUE = process.env.DATABASE_URL;
const AMBIENT_DATABASE_URL = AMBIENT_DATABASE_URL_VALUE ?? "";
const AMBIENT_NODE_ENV = process.env.NODE_ENV;
const AMBIENT_MOCK_REDIS = process.env.MOCK_REDIS;
const AMBIENT_SKIP_AGENT_SANDBOX_ENSURE = process.env.SKIP_AGENT_SANDBOX_ENSURE;
const AMBIENT_HEAVY_PAYLOAD_STORAGE = process.env.SQL_HEAVY_PAYLOAD_STORAGE;
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL === "pglite://memory";
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

const PGLITE_TIMEOUT = 300_000;
const API_TOKEN = "restore-authority-token";
const DELETION_ATTEMPT_ID = "00000000-0000-4000-8000-000000229472";
const ORIGINAL_FETCH = globalThis.fetch;
const AUTHORITY_CHANGED = "Sandbox changed while restore was being prepared";
const BACKUP_CHANGED = "Backup changed while restore was being prepared";
const TIER_REJECTION = "Agent restore requires a container-backed execution tier";
const POOL_REJECTION = "Agent restore cannot target pool-owned capacity";
const DELETED_REJECTION = "Agent restore cannot target a deleted agent";
const DELETION_REJECTION = "Agent restore cannot start while agent deletion is in progress";

let pgliteReady = true;
let sequence = 0;

function restoreProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function unique(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 8)}`;
}

function state(label: string): AgentBackupStateData {
  return {
    memories: [],
    config: { restoreAuthority: label },
    workspaceFiles: { [`${label}.txt`]: label },
  };
}

function provisioningAdmissionCapture(sandbox: AgentSandbox): ProvisioningAdmissionCapture {
  return {
    id: sandbox.id,
    organization_id: sandbox.organization_id,
    status: sandbox.status,
    lifecycle_job_id: sandbox.lifecycle_job_id,
    lifecycle_execution_generation: sandbox.lifecycle_execution_generation,
    execution_tier: sandbox.execution_tier,
    pool_status: sandbox.pool_status,
    deleted_at: sandbox.deleted_at,
    deletion_attempt_id: sandbox.deletion_attempt_id,
    lifecycle_revision: sandbox.lifecycle_revision,
  };
}

async function seedOwner(): Promise<{ organizationId: string; userId: string }> {
  const [organization] = await dbWrite
    .insert(organizations)
    .values({ name: "Restore Authority", slug: unique("restore-authority") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ organization_id: organization.id, steward_user_id: unique("steward") })
    .returning();
  if (!organization || !user) throw new Error("Restore authority owner seed failed");
  return { organizationId: organization.id, userId: user.id };
}

async function seedSandbox(overrides: Partial<AgentSandbox> = {}): Promise<AgentSandbox> {
  const owner = await seedOwner();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: owner.organizationId,
      user_id: owner.userId,
      agent_name: unique("restore-agent"),
      execution_tier: "dedicated-lazy",
      status: "running",
      sandbox_id: unique("sandbox"),
      node_id: unique("node"),
      container_name: unique("container"),
      bridge_url: "http://127.0.0.1:21060",
      health_url: "http://127.0.0.1:3000/health",
      bridge_port: 21060,
      web_ui_port: 3000,
      headscale_ip: "100.64.0.20",
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
  if (!sandbox) throw new Error("Restore authority sandbox seed failed");
  return sandbox;
}

async function seedBackup(
  sandboxRecordId: string,
  label: string,
  createdAt = new Date("2026-08-22T01:00:00.000Z"),
): Promise<StoredAgentSandboxBackup> {
  const payload = state(label);
  const [backup] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "manual",
      state_data: payload,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
      backup_kind: "full",
      created_at: createdAt,
    })
    .returning();
  if (!backup) throw new Error("Restore authority backup seed failed");
  return backup;
}

async function seedIncrementalBackup(
  parent: StoredAgentSandboxBackup,
  label: string,
  createdAt = new Date("2026-08-22T02:00:00.000Z"),
): Promise<StoredAgentSandboxBackup> {
  if (!parent.sandbox_record_id) throw new Error("Incremental parent is detached");
  const delta: AgentBackupDeltaData = {
    filesChanged: { [`${label}.txt`]: label },
    filesRemoved: [],
    configChanged: { restoreAuthority: label },
    configRemoved: [],
    memoriesBaseCount: 0,
    memoriesAppended: [],
  };
  const [backup] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: parent.sandbox_record_id,
      snapshot_type: "manual",
      state_data: delta,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(delta), "utf8"),
      backup_kind: "incremental",
      parent_backup_id: parent.id,
      base_backup_id: parent.backup_kind === "full" ? parent.id : parent.base_backup_id,
      created_at: createdAt,
    })
    .returning();
  if (!backup) throw new Error("Restore authority incremental seed failed");
  return backup;
}

async function seedReviewedIncrementalChain(sandboxRecordId: string): Promise<{
  parent: StoredAgentSandboxBackup;
  target: StoredAgentSandboxBackup;
  state: AgentBackupStateData;
  directive: Extract<ProvisionRestoreOverride, { kind: "from-reviewed-backup" }>;
}> {
  const parentState = state(unique("reviewed-parent"));
  const parentVerifiedAt = new Date("2026-08-25T10:00:00.000Z");
  const [parent] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "manual",
      state_data: parentState,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(parentState), "utf8"),
      backup_kind: "full",
      content_hash: computeStateHash(parentState),
      verification_status: "verified",
      verified_at: parentVerifiedAt,
      created_at: new Date("2026-08-25T10:00:00.000Z"),
    })
    .returning();
  if (!parent) throw new Error("Reviewed parent seed failed");

  const delta: AgentBackupDeltaData = {
    filesChanged: { "reviewed-target.txt": "target" },
    filesRemoved: [],
    configChanged: { restoreAuthority: "reviewed-target" },
    configRemoved: [],
    memoriesBaseCount: 0,
    memoriesAppended: [],
  };
  const targetState = applyBackupDelta(parentState, delta);
  const targetVerifiedAt = new Date("2026-08-25T11:00:00.000Z");
  const [target] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      sandbox_record_id: sandboxRecordId,
      snapshot_type: "manual",
      state_data: delta,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(delta), "utf8"),
      backup_kind: "incremental",
      parent_backup_id: parent.id,
      base_backup_id: parent.id,
      content_hash: computeStateHash(targetState),
      verification_status: "verified",
      verified_at: targetVerifiedAt,
      created_at: new Date("2026-08-25T11:00:00.000Z"),
    })
    .returning();
  if (!target) throw new Error("Reviewed target seed failed");

  const expectedBackupChain: PersonalDedicatedReviewedBackupChainEntry[] = [
    {
      backupId: target.id,
      backupKind: "incremental",
      parentBackupId: parent.id,
      contentHash: target.content_hash!,
      catalogVersion: null,
      catalogState: null,
    },
    {
      backupId: parent.id,
      backupKind: "full",
      parentBackupId: null,
      contentHash: parent.content_hash!,
      catalogVersion: null,
      catalogState: null,
    },
  ];
  const [sandbox] = await dbWrite
    .select({ organizationId: agentSandboxes.organization_id, userId: agentSandboxes.user_id })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, sandboxRecordId))
    .limit(1);
  if (!sandbox) throw new Error("Reviewed selection sandbox missing");
  const [selection] = await dbWrite
    .insert(personalDedicatedAdoptionSelections)
    .values({
      organization_id: sandbox.organizationId,
      user_id: sandbox.userId,
      source_agent_id: unique("reviewed-source"),
      dedicated_agent_id: sandboxRecordId,
      selection_reason: "duplicate_owned_dedicated_inventory",
      state_disposition: "verified_backup_present",
      activation_kind: "legacy_backup",
      activation_backup_id: target.id,
      activation_backup_hash: target.content_hash!,
      activation_backup_chain: expectedBackupChain,
      inventory_fingerprint: "a".repeat(64),
      candidate_count: 2,
    })
    .returning({ id: personalDedicatedAdoptionSelections.id });
  if (!selection) throw new Error("Reviewed selection seed failed");
  return {
    parent,
    target,
    state: targetState,
    directive: {
      kind: "from-reviewed-backup",
      selectionId: selection.id,
      backupId: target.id,
      expectedContentHash: target.content_hash!,
      expectedBackupChain,
    },
  };
}

async function seedReviewedFreshBootDirective(
  sandbox: AgentSandbox,
): Promise<Extract<ProvisionRestoreOverride, { kind: "reviewed-fresh-boot" }>> {
  const [selection] = await dbWrite
    .insert(personalDedicatedAdoptionSelections)
    .values({
      organization_id: sandbox.organization_id,
      user_id: sandbox.user_id,
      source_agent_id: unique("fresh-source"),
      dedicated_agent_id: sandbox.id,
      selection_reason: "duplicate_owned_dedicated_inventory",
      state_disposition: "fresh_boot_no_verified_backup",
      activation_kind: "fresh_boot",
      inventory_fingerprint: "b".repeat(64),
      candidate_count: 2,
    })
    .returning({ id: personalDedicatedAdoptionSelections.id });
  if (!selection) throw new Error("Fresh-boot selection seed failed");
  return { kind: "reviewed-fresh-boot", selectionId: selection.id };
}

async function durableGeneration(agentId: string): Promise<{
  lifecycleRevision: number | null;
  lastHeartbeatAt: Date | null;
}> {
  const [row] = await dbWrite
    .select({
      lifecycleRevision: agentSandboxes.lifecycle_revision,
      lastHeartbeatAt: agentSandboxes.last_heartbeat_at,
    })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  return {
    lifecycleRevision: row?.lifecycleRevision ?? null,
    lastHeartbeatAt: row?.lastHeartbeatAt ?? null,
  };
}

function installRestoreFetch(
  options: {
    expectedState?: AgentBackupStateData;
    status?: number;
    body?: string;
    beforeResponse?: () => Promise<void> | void;
  } = {},
) {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    expect(url).toBe("http://127.0.0.1:3000/api/restore");
    expect(init?.method).toBe("POST");
    if (options.expectedState) {
      expect(JSON.parse(String(init?.body))).toEqual(options.expectedState);
    }
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_TOKEN}`);
    expect(headers.get("x-api-key")).toBe(API_TOKEN);
    expect(headers.get("x-eliza-token")).toBe(API_TOKEN);
    await options.beforeResponse?.();
    const status = options.status ?? 204;
    return new Response(status === 204 ? null : (options.body ?? "restore failure"), { status });
  });
}

async function expectInitialRefusal(
  overrides: Partial<AgentSandbox>,
  expectedError: string,
): Promise<void> {
  const sandbox = await seedSandbox(overrides);
  await seedBackup(sandbox.id, "initial-refusal");
  const getStoredById = spyOn(agentSandboxesRepository, "getStoredBackupById");
  const getLatestStored = spyOn(agentSandboxesRepository, "getLatestStoredBackup");
  const reconstruct = spyOn(agentSandboxesRepository, "getReconstructedBackupState");
  const fetchMock = installRestoreFetch();
  globalThis.fetch = fetchMock;

  await expect(
    new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id),
  ).resolves.toEqual({
    success: false,
    error: expectedError,
  });

  expect(getStoredById).not.toHaveBeenCalled();
  expect(getLatestStored).not.toHaveBeenCalled();
  expect(reconstruct).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
}

async function expectPostReconstructRefusal(
  mutate: (sandbox: AgentSandbox, backup: StoredAgentSandboxBackup) => Promise<void>,
  expectedError: string,
): Promise<void> {
  const sandbox = await seedSandbox();
  const backup = await seedBackup(sandbox.id, "post-reconstruct");
  const originalReconstruct =
    agentSandboxesRepository.getReconstructedBackupState.bind(agentSandboxesRepository);
  const reconstruct = spyOn(
    agentSandboxesRepository,
    "getReconstructedBackupState",
  ).mockImplementation(async (backupId) => {
    const reconstructed = await originalReconstruct(backupId);
    await mutate(sandbox, backup);
    return reconstructed;
  });
  const fetchMock = installRestoreFetch();
  globalThis.fetch = fetchMock;

  await expect(
    new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
  ).resolves.toEqual({ success: false, error: expectedError });

  expect(reconstruct).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
}

async function installHeartbeatRevisionMigration(): Promise<void> {
  const migration = readFileSync(
    new URL("../../db/migrations/0386_agent_heartbeat_lifecycle_revision.sql", import.meta.url),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) await dbWrite.execute(sql.raw(statement));
  }
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
    await installHeartbeatRevisionMigration();
    const { getPgliteClientForTests } = await import("../../db/client");
    await installOrganizationPolicyTestSchema((query) => getPgliteClientForTests().exec(query));
  } catch {
    pgliteReady = false;
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  process.env.SQL_HEAVY_PAYLOAD_STORAGE = "inline";
  await dbWrite.execute(sql.raw('DELETE FROM "jobs"'));
  await dbWrite.delete(personalDedicatedAdoptionSelections);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  mock.restore();
});

afterAll(async () => {
  globalThis.fetch = ORIGINAL_FETCH;
  try {
    await closeDatabaseConnectionsForTests();
  } finally {
    restoreProcessEnv("DATABASE_URL", AMBIENT_DATABASE_URL_VALUE);
    restoreProcessEnv("NODE_ENV", AMBIENT_NODE_ENV);
    restoreProcessEnv("MOCK_REDIS", AMBIENT_MOCK_REDIS);
    restoreProcessEnv("SKIP_AGENT_SANDBOX_ENSURE", AMBIENT_SKIP_AGENT_SANDBOX_ENSURE);
    restoreProcessEnv("SQL_HEAVY_PAYLOAD_STORAGE", AMBIENT_HEAVY_PAYLOAD_STORAGE);
  }
});

describe("ElizaSandboxService restore initial authority", () => {
  test("keeps missing and foreign-tenant rows indistinguishable before backup access", async () => {
    const sandbox = await seedSandbox();
    const foreignOwner = await seedOwner();
    const getStoredById = spyOn(agentSandboxesRepository, "getStoredBackupById");
    const getLatestStored = spyOn(agentSandboxesRepository, "getLatestStoredBackup");
    const reconstruct = spyOn(agentSandboxesRepository, "getReconstructedBackupState");

    await expect(
      new ElizaSandboxService().restore(sandbox.id, foreignOwner.organizationId),
    ).resolves.toEqual({ success: false, error: "Agent not found" });
    await expect(
      new ElizaSandboxService().restore(crypto.randomUUID(), sandbox.organization_id),
    ).resolves.toEqual({ success: false, error: "Agent not found" });

    expect(getStoredById).not.toHaveBeenCalled();
    expect(getLatestStored).not.toHaveBeenCalled();
    expect(reconstruct).not.toHaveBeenCalled();
  });

  test("rejects a non-container tier before backup access", async () => {
    await expectInitialRefusal({ execution_tier: "shared", status: "stopped" }, TIER_REJECTION);
  });

  test("rejects pool ownership before deleted and deletion-attempt fields", async () => {
    await expectInitialRefusal(
      {
        status: "stopped",
        pool_status: "unclaimed",
        deleted_at: new Date("2026-08-22T02:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      },
      POOL_REJECTION,
    );
  });

  test("rejects a deleted row before its deletion-attempt field", async () => {
    await expectInitialRefusal(
      {
        status: "stopped",
        deleted_at: new Date("2026-08-22T02:00:00.000Z"),
        deletion_attempt_id: DELETION_ATTEMPT_ID,
      },
      DELETED_REJECTION,
    );
  });

  test("rejects deletion ownership before backup access", async () => {
    await expectInitialRefusal(
      { status: "deletion_pending", deletion_attempt_id: DELETION_ATTEMPT_ID },
      DELETION_REJECTION,
    );
  });

  test("rejects a running row without its canonical bridge before backup access", async () => {
    await expectInitialRefusal(
      { bridge_url: null },
      "Running agent is missing its restore endpoint",
    );
  });

  test("rejects initial replacement-cleanup ownership before backup access", async () => {
    await expectInitialRefusal(
      {
        replacement_cleanup_sandbox_id: unique("retired-sandbox"),
        replacement_cleanup_node_id: unique("retired-node"),
        replacement_cleanup_container_name: unique("retired-container"),
        replacement_cleanup_allocation_counted: true,
        replacement_cleanup_created_at: new Date("2026-08-22T02:00:00.000Z"),
      },
      "Agent restore cannot start while replacement cleanup is pending",
    );
  });

  test("keeps a foreign explicit backup indistinguishable and never hydrates it", async () => {
    const sandbox = await seedSandbox();
    const foreign = await seedSandbox();
    const foreignBackup = await seedBackup(foreign.id, "foreign");
    await dbWrite
      .update(agentSandboxBackups)
      .set({
        state_data_storage: "r2",
        state_data_key: "foreign-tenant/restore-authority-must-not-hydrate.json",
      })
      .where(eq(agentSandboxBackups.id, foreignBackup.id));
    const reconstruct = spyOn(agentSandboxesRepository, "getReconstructedBackupState");
    const fetchMock = installRestoreFetch();
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, foreignBackup.id),
    ).resolves.toEqual({ success: false, error: "No backup found" });

    expect(reconstruct).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ElizaSandboxService stopped restore-point pinning", () => {
  async function armStoppedExactRestore(
    label: string,
    reconstructedState: AgentBackupStateData | undefined,
  ) {
    const sandbox = await seedSandbox({
      status: "stopped",
      execution_tier: "custom",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/agent",
    });
    const storedBackup = await seedBackup(sandbox.id, label);
    const backup = storedBackup as AgentSandboxBackup;
    const provisioning: AgentSandbox = { ...sandbox, status: "provisioning" };
    const running: AgentSandbox = {
      ...provisioning,
      status: "running",
      sandbox_id: "restored-custom-sandbox",
      bridge_url: "http://127.0.0.1:3000",
      health_url: "http://127.0.0.1:3000/health",
    };
    const stopForReplacement = mock(async () => {});
    const provider: SandboxProvider = {
      create: mock(async () => ({
        sandboxId: running.sandbox_id!,
        bridgeUrl: running.bridge_url!,
        healthUrl: running.health_url!,
        metadata: {},
      })),
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement,
      checkHealth: mock(async () => true),
    };
    const service = new ElizaSandboxService(provider);
    const buildProvisioningRetryHandle = spyOn(
      service as unknown as {
        buildProvisioningRetryHandle(rec: AgentSandbox): unknown;
      },
      "buildProvisioningRetryHandle",
    );

    spyOn(agentSandboxesRepository, "findByIdAndOrgForWrite").mockResolvedValue(sandbox);
    spyOn(agentSandboxesRepository, "getStoredBackupById").mockResolvedValue(storedBackup);
    spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockResolvedValue(storedBackup);
    spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(sandbox);
    spyOn(agentSandboxesRepository, "findById").mockResolvedValue(sandbox);
    spyOn(agentSandboxesRepository, "trySetProvisioningFromRestoreCapture").mockResolvedValue(
      provisioning,
    );
    spyOn(agentSandboxesRepository, "getBackupById").mockResolvedValue(backup);
    spyOn(agentSandboxesRepository, "getReconstructedBackupState").mockResolvedValue(
      reconstructedState,
    );
    spyOn(agentSandboxesRepository, "update").mockImplementation(async (_id, data) => ({
      ...sandbox,
      ...data,
    }));
    spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      plainKey: "eliza_restore_authority_key",
      prefix: "eliza_restore",
    });
    spyOn(agentBillingRepository, "reactivateSandboxBillingAfterFunding").mockResolvedValue(
      undefined,
    );
    spyOn(
      service as unknown as {
        ensureRuntimeAgentStarted(rec: AgentSandbox): Promise<unknown>;
      },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    spyOn(
      service as unknown as {
        transferReplacementToPrimary(
          agentId: string,
          orgId: string,
          handle: unknown,
          expectedEnvironmentRevision: number,
          updateData: Partial<AgentSandbox>,
        ): Promise<AgentSandbox>;
      },
      "transferReplacementToPrimary",
    ).mockResolvedValue(running);

    return {
      sandbox,
      storedBackup,
      running,
      service,
      stopForReplacement,
      buildProvisioningRetryHandle,
    };
  }

  test("rejects an explicitly selected older backup", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    const oldBackup = await seedBackup(sandbox.id, "old", new Date("2026-08-22T01:00:00.000Z"));
    await seedBackup(sandbox.id, "latest", new Date("2026-08-22T02:00:00.000Z"));
    const service = new ElizaSandboxService();
    const provision = spyOn(service, "provision");

    await expect(
      service.restore(sandbox.id, sandbox.organization_id, oldBackup.id),
    ).resolves.toEqual({
      success: false,
      error: "Stopped agents can only restore the latest backup",
    });
    expect(provision).not.toHaveBeenCalled();
  });

  test("pins explicit and implicit latest restores to the exact from-backup id", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    await seedBackup(sandbox.id, "old", new Date("2026-08-22T01:00:00.000Z"));
    const latest = await seedBackup(sandbox.id, "latest", new Date("2026-08-22T02:00:00.000Z"));
    const service = new ElizaSandboxService();
    const provision = spyOn(service, "provision").mockImplementation(
      async (_agentId: string, _orgId: string, _restoreOverride?: ProvisionRestoreOverride) => ({
        success: true,
        sandboxRecord: sandbox,
        bridgeUrl: sandbox.bridge_url ?? "",
        healthUrl: sandbox.health_url ?? "",
      }),
    );

    await expect(
      service.restore(sandbox.id, sandbox.organization_id, latest.id),
    ).resolves.toMatchObject({ success: true, backup: { id: latest.id } });
    await expect(service.restore(sandbox.id, sandbox.organization_id)).resolves.toMatchObject({
      success: true,
      backup: { id: latest.id },
    });
    expect(provision).toHaveBeenCalledTimes(2);
    expect(provision).toHaveBeenNthCalledWith(1, sandbox.id, sandbox.organization_id, {
      kind: "from-backup",
      backupId: latest.id,
      requireRestoreEndpoint: true,
      expectedAdmission: provisioningAdmissionCapture(sandbox),
    });
    expect(provision).toHaveBeenNthCalledWith(2, sandbox.id, sandbox.organization_id, {
      kind: "from-backup",
      backupId: latest.id,
      requireRestoreEndpoint: true,
      expectedAdmission: provisioningAdmissionCapture(sandbox),
    });
  });

  test("keeps the selected point pinned when a newer head arrives during provision", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    const selected = await seedBackup(sandbox.id, "selected", new Date("2026-08-22T01:00:00.000Z"));
    const service = new ElizaSandboxService();
    const provision = spyOn(service, "provision").mockImplementation(
      async (_agentId: string, _orgId: string, _restoreOverride?: ProvisionRestoreOverride) => {
        await seedBackup(sandbox.id, "new-head", new Date("2026-08-22T02:00:00.000Z"));
        return {
          success: true,
          sandboxRecord: sandbox,
          bridgeUrl: sandbox.bridge_url ?? "",
          healthUrl: sandbox.health_url ?? "",
        };
      },
    );

    await expect(service.restore(sandbox.id, sandbox.organization_id)).resolves.toMatchObject({
      success: true,
      backup: { id: selected.id },
    });
    expect(provision).toHaveBeenCalledWith(sandbox.id, sandbox.organization_id, {
      kind: "from-backup",
      backupId: selected.id,
      requireRestoreEndpoint: true,
      expectedAdmission: provisioningAdmissionCapture(sandbox),
    });
  });

  test("loses exact admission to a concurrent running generation without reporting the backup applied", async () => {
    const sandbox = await seedSandbox({
      status: "stopped",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/admission-loss",
    });
    await seedBackup(sandbox.id, "admission-loss");
    const create = mock(async () => ({
      sandboxId: "must-not-create",
      bridgeUrl: "http://127.0.0.1:3000",
      healthUrl: "http://127.0.0.1:3000/health",
      metadata: {},
    }));
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });
    const originalLatest =
      agentSandboxesRepository.getLatestStoredBackup.bind(agentSandboxesRepository);
    let installedWinner = false;
    spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockImplementation(async (agentId) => {
      const latest = await originalLatest(agentId);
      if (!installedWinner) {
        installedWinner = true;
        await dbWrite
          .update(agentSandboxes)
          .set({
            status: "running",
            sandbox_id: "concurrent-running-sandbox",
            node_id: "concurrent-running-node",
            container_name: "concurrent-running-container",
            bridge_url: "http://127.0.0.1:22060",
            health_url: "http://127.0.0.1:33000/health",
          })
          .where(eq(agentSandboxes.id, sandbox.id));
      }
      return latest;
    });
    const exactAdmission = spyOn(agentSandboxesRepository, "trySetProvisioningFromRestoreCapture");
    const genericRead = spyOn(agentSandboxesRepository, "findByIdAndOrg");
    const genericAdmission = spyOn(agentSandboxesRepository, "trySetProvisioning");
    const createKey = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      plainKey: "must_not_create_restore_key",
      prefix: "must_not_create",
    });
    const reactivateBilling = spyOn(
      agentBillingRepository,
      "reactivateSandboxBillingAfterFunding",
    ).mockResolvedValue(undefined);
    const provisionDatabase = spyOn(
      service as unknown as {
        provisionAgentDatabase(rec: AgentSandbox): Promise<unknown>;
      },
      "provisionAgentDatabase",
    );
    const failedWarmCleanup = spyOn(
      service as unknown as {
        retireFailedWarmClaimForRetry(
          agentId: string,
          orgId: string,
        ): Promise<{ success: boolean }>;
      },
      "retireFailedWarmClaimForRetry",
    );
    const replacementCleanup = spyOn(
      service as unknown as {
        retirePersistedReplacementCleanup(agentId: string, orgId: string): Promise<unknown>;
      },
      "retirePersistedReplacementCleanup",
    );

    await expect(service.restore(sandbox.id, sandbox.organization_id)).resolves.toEqual({
      success: false,
      error: AUTHORITY_CHANGED,
    });

    expect(exactAdmission).toHaveBeenCalledWith(provisioningAdmissionCapture(sandbox));
    expect(genericRead).not.toHaveBeenCalled();
    expect(genericAdmission).not.toHaveBeenCalled();
    expect(failedWarmCleanup).not.toHaveBeenCalled();
    expect(replacementCleanup).not.toHaveBeenCalled();
    expect(provisionDatabase).not.toHaveBeenCalled();
    expect(createKey).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(reactivateBilling).not.toHaveBeenCalled();

    const [winner] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(winner).toMatchObject({
      status: "running",
      sandbox_id: "concurrent-running-sandbox",
      container_name: "concurrent-running-container",
      environment_vars: sandbox.environment_vars,
      database_uri: sandbox.database_uri,
    });
    expect(winner?.lifecycle_revision).toBe(sandbox.lifecycle_revision + 1);
  });

  test("fails closed when a wake from-backup provision loses generic admission to a running generation", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    const running: AgentSandbox = {
      ...sandbox,
      status: "running",
      bridge_url: "http://127.0.0.1:21060",
      health_url: "http://127.0.0.1:3000/health",
    };
    const fetchMock = installRestoreFetch();
    globalThis.fetch = fetchMock;
    spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(running);
    const genericAdmission = spyOn(
      agentSandboxesRepository,
      "trySetProvisioning",
    ).mockResolvedValue(undefined);
    const exactAdmission = spyOn(agentSandboxesRepository, "trySetProvisioningFromRestoreCapture");

    await expect(
      new ElizaSandboxService().provision(sandbox.id, sandbox.organization_id, {
        kind: "from-backup",
        backupId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({
      success: false,
      sandboxRecord: running,
      error: AUTHORITY_CHANGED,
    });

    expect(genericAdmission).toHaveBeenCalledWith(sandbox.id);
    expect(exactAdmission).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("carries a canonical reviewed incremental payload through the final locked restore", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "custom",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/reviewed",
    });
    const chain = await seedReviewedIncrementalChain(sandbox.id);
    const provisioning: AgentSandbox = { ...sandbox, status: "provisioning" };
    const running: AgentSandbox = {
      ...provisioning,
      status: "running",
      sandbox_id: "reviewed-restored-sandbox",
      bridge_url: "http://127.0.0.1:3000",
      health_url: "http://127.0.0.1:3000/health",
    };
    const create = mock(async () => ({
      sandboxId: running.sandbox_id!,
      bridgeUrl: running.bridge_url!,
      healthUrl: running.health_url!,
      metadata: {},
    }));
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });
    spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(sandbox);
    spyOn(agentSandboxesRepository, "findById").mockResolvedValue(sandbox);
    spyOn(agentSandboxesRepository, "trySetProvisioning").mockResolvedValue(provisioning);
    spyOn(agentSandboxesRepository, "update").mockImplementation(async (_id, data) => ({
      ...sandbox,
      ...data,
    }));
    spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      plainKey: "eliza_reviewed_restore_key",
      prefix: "eliza_reviewed",
    });
    spyOn(agentBillingRepository, "reactivateSandboxBillingAfterFunding").mockResolvedValue(
      undefined,
    );
    spyOn(
      service as unknown as { ensureRuntimeAgentStarted(rec: AgentSandbox): Promise<unknown> },
      "ensureRuntimeAgentStarted",
    ).mockResolvedValue(null);
    spyOn(
      service as unknown as {
        transferReplacementToPrimary(
          agentId: string,
          orgId: string,
          handle: unknown,
          expectedEnvironmentRevision: number,
          updateData: Partial<AgentSandbox>,
        ): Promise<AgentSandbox>;
      },
      "transferReplacementToPrimary",
    ).mockResolvedValue(running);
    const fetchMock = installRestoreFetch({ expectedState: chain.state });
    globalThis.fetch = fetchMock;

    const result = await service.provision(sandbox.id, sandbox.organization_id, chain.directive);

    expect(result).toMatchObject({ success: true, sandboxRecord: { id: sandbox.id } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects drift after service preflight before provider or billing admission", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "dedicated-always",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/preflight-race",
    });
    const chain = await seedReviewedIncrementalChain(sandbox.id);
    const create = mock(async () => {
      throw new Error("provider create must not run after post-preflight drift");
    });
    const reactivateBilling = spyOn(
      agentBillingRepository,
      "reactivateSandboxBillingAfterFunding",
    ).mockResolvedValue(undefined);
    const service = new ElizaSandboxService(
      {
        create,
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
        stopForReplacement: mock(async () => {}),
        checkHealth: mock(async () => true),
      },
      {
        afterReviewedRestorePreflight: async () => {
          await dbWrite
            .update(agentSandboxBackups)
            .set({ content_hash: "f".repeat(64) })
            .where(eq(agentSandboxBackups.id, chain.target.id));
        },
      },
    );

    await expect(
      service.provision(sandbox.id, sandbox.organization_id, chain.directive),
    ).resolves.toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
    expect(reactivateBilling).not.toHaveBeenCalled();
  });

  test("rejects a newer verified backup after worker review before provider or billing admission", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "dedicated-always",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/newer-backup-race",
    });
    const chain = await seedReviewedIncrementalChain(sandbox.id);
    await expect(
      resolveReviewedProvisionRestoreDirectiveForExecution({
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
        agentName: sandbox.agent_name ?? sandbox.id,
        restoreDirective: chain.directive,
      }),
    ).resolves.toEqual(chain.directive);
    const newerState = state("newer-reviewed-state");
    await dbWrite.insert(agentSandboxBackups).values({
      sandbox_record_id: sandbox.id,
      snapshot_type: "auto",
      state_data: newerState,
      state_data_storage: "inline",
      size_bytes: Buffer.byteLength(JSON.stringify(newerState), "utf8"),
      backup_kind: "full",
      content_hash: computeStateHash(newerState),
      verification_status: "verified",
      verified_at: new Date("2026-08-25T13:00:00.000Z"),
      created_at: new Date("2026-08-25T13:00:00.000Z"),
    });
    const create = mock(async () => {
      throw new Error("provider create must not restore an obsolete reviewed backup");
    });
    const reactivateBilling = spyOn(
      agentBillingRepository,
      "reactivateSandboxBillingAfterFunding",
    ).mockResolvedValue(undefined);
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });

    await expect(
      service.provision(sandbox.id, sandbox.organization_id, chain.directive),
    ).resolves.toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
    expect(reactivateBilling).not.toHaveBeenCalled();
  });

  test("the durable fence blocks backup mutation through provider and billing admission", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "dedicated-always",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/fenced-race",
    });
    const chain = await seedReviewedIncrementalChain(sandbox.id);
    const create = mock(async () => {
      throw new Error("provider create must not run after fenced mutation");
    });
    const reactivateBilling = spyOn(
      agentBillingRepository,
      "reactivateSandboxBillingAfterFunding",
    ).mockResolvedValue(undefined);
    const service = new ElizaSandboxService(
      {
        create,
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
        stopForReplacement: mock(async () => {}),
        checkHealth: mock(async () => true),
      },
      {
        afterReviewedRestoreFence: async () => {
          await dbWrite
            .update(agentSandboxBackups)
            .set({ verification_status: "failed" })
            .where(eq(agentSandboxBackups.id, chain.parent.id));
        },
      },
    );

    await expect(
      service.provision(sandbox.id, sandbox.organization_id, chain.directive),
    ).resolves.toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
    expect(reactivateBilling).not.toHaveBeenCalled();
    const [selection] = await dbWrite
      .select({ hash: personalDedicatedAdoptionSelections.restore_fence_hash })
      .from(personalDedicatedAdoptionSelections)
      .where(eq(personalDedicatedAdoptionSelections.id, chain.directive.selectionId));
    expect(selection?.hash).toBeNull();
  });

  test("fresh-boot authority fails when a verified backup appears before provider admission", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "dedicated-always",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/fresh-race",
    });
    const directive = await seedReviewedFreshBootDirective(sandbox);
    await expect(
      resolveReviewedProvisionRestoreDirectiveForExecution({
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
        agentName: sandbox.agent_name ?? sandbox.id,
        restoreDirective: directive,
      }),
    ).resolves.toEqual(directive);
    const create = mock(async () => {
      throw new Error("provider create must not run after recoverable state appears");
    });
    const reactivateBilling = spyOn(
      agentBillingRepository,
      "reactivateSandboxBillingAfterFunding",
    ).mockResolvedValue(undefined);
    const service = new ElizaSandboxService(
      {
        create,
        stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
        stopForReplacement: mock(async () => {}),
        checkHealth: mock(async () => true),
      },
      {
        afterReviewedRestorePreflight: async () => {
          const payload = state("newly-verified");
          await dbWrite.insert(agentSandboxBackups).values({
            sandbox_record_id: sandbox.id,
            snapshot_type: "manual",
            state_data: payload,
            state_data_storage: "inline",
            size_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
            backup_kind: "full",
            content_hash: computeStateHash(payload),
            verification_status: "verified",
            verified_at: new Date(),
          });
        },
      },
    );

    await expect(
      service.provision(sandbox.id, sandbox.organization_id, directive),
    ).resolves.toMatchObject({ success: false });
    expect(create).not.toHaveBeenCalled();
    expect(reactivateBilling).not.toHaveBeenCalled();
  });

  test("reviewed incremental authority rejects every selected and ancestor drift before provider compute", async () => {
    const create = mock(async () => {
      throw new Error("provider create must not run after reviewed-backup drift");
    });
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });
    const driftCases = [
      {
        name: "content hash",
        mutate: async (id: string) => {
          await dbWrite
            .update(agentSandboxBackups)
            .set({ content_hash: "f".repeat(64) })
            .where(eq(agentSandboxBackups.id, id));
        },
      },
      {
        name: "verification status",
        mutate: async (id: string) => {
          await dbWrite
            .update(agentSandboxBackups)
            .set({ verification_status: "failed" })
            .where(eq(agentSandboxBackups.id, id));
        },
      },
      {
        name: "sandbox reassignment",
        mutate: async (id: string) => {
          const foreign = await seedSandbox({ status: "error" });
          await dbWrite
            .update(agentSandboxBackups)
            .set({ sandbox_record_id: foreign.id })
            .where(eq(agentSandboxBackups.id, id));
        },
      },
      {
        name: "row deletion",
        mutate: async (id: string) => {
          await dbWrite.delete(agentSandboxBackups).where(eq(agentSandboxBackups.id, id));
        },
      },
      {
        name: "catalogue state",
        mutate: async (id: string) => {
          await dbWrite
            .update(agentSandboxBackups)
            .set({ catalog_state: "legacy_unmigrated" })
            .where(eq(agentSandboxBackups.id, id));
        },
      },
    ];

    for (const position of ["target", "parent"] as const) {
      for (const drift of driftCases) {
        const sandbox = await seedSandbox({
          status: "error",
          execution_tier: "dedicated-always",
          sandbox_id: null,
          node_id: null,
          container_name: null,
          bridge_url: null,
          health_url: null,
          headscale_ip: null,
        });
        const chain = await seedReviewedIncrementalChain(sandbox.id);
        await drift.mutate(chain[position].id);
        const result = await service.provision(
          sandbox.id,
          sandbox.organization_id,
          chain.directive,
        );
        expect(result, `${position} ${drift.name}`).toMatchObject({
          success: false,
          error: "Reviewed backup authority changed before Dedicated provisioning",
        });
      }
    }
    expect(create).not.toHaveBeenCalled();
  });

  test("rechecks reviewed chain after the worker check so a check-to-consume race spends nothing", async () => {
    const sandbox = await seedSandbox({
      status: "error",
      execution_tier: "dedicated-always",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      headscale_ip: null,
    });
    const chain = await seedReviewedIncrementalChain(sandbox.id);
    const jobData = {
      agentId: sandbox.id,
      organizationId: sandbox.organization_id,
      userId: sandbox.user_id,
      agentName: sandbox.agent_name ?? sandbox.id,
      restoreDirective: chain.directive,
    };
    const checked = await resolveReviewedProvisionRestoreDirectiveForExecution(jobData);
    expect(checked).toEqual(chain.directive);

    await dbWrite
      .update(agentSandboxBackups)
      .set({ content_hash: "e".repeat(64) })
      .where(eq(agentSandboxBackups.id, chain.parent.id));
    const create = mock(async () => {
      throw new Error("provider create must not run after check-to-consume drift");
    });
    const result = await new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    }).provision(sandbox.id, sandbox.organization_id, checked);

    expect(result).toMatchObject({
      success: false,
      error: "Reviewed backup authority changed before Dedicated provisioning",
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects every captured authority dimension changed before stopped admission", async () => {
    const mutations = new Map<string, Partial<AgentSandbox>>();
    const originalLatest =
      agentSandboxesRepository.getLatestStoredBackup.bind(agentSandboxesRepository);
    spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockImplementation(async (agentId) => {
      const latest = await originalLatest(agentId);
      const mutation = mutations.get(agentId);
      if (mutation) {
        await dbWrite.update(agentSandboxes).set(mutation).where(eq(agentSandboxes.id, agentId));
      }
      return latest;
    });
    const create = mock(async () => {
      throw new Error("provider create must not run after restore admission loss");
    });
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });
    const createKey = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      plainKey: "must_not_create_restore_key",
      prefix: "must_not_create",
    });
    const exactAdmission = spyOn(agentSandboxesRepository, "trySetProvisioningFromRestoreCapture");
    const genericAdmission = spyOn(agentSandboxesRepository, "trySetProvisioning");

    const cases: Array<{ name: string; mutation: Partial<AgentSandbox> }> = [
      { name: "status", mutation: { status: "provisioning" } },
      { name: "tier", mutation: { execution_tier: "shared" } },
      { name: "pool ownership", mutation: { pool_status: "unclaimed" } },
      {
        name: "soft deletion",
        mutation: { deleted_at: new Date("2026-08-23T00:10:00.000Z") },
      },
      {
        name: "deletion ownership",
        mutation: {
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-23T00:20:00.000Z"),
        },
      },
      {
        name: "lifecycle execution ownership",
        mutation: {
          lifecycle_job_id: "a75a32be-2058-4faa-86e5-c0716ae4c6ef",
          lifecycle_execution_generation: "16b85cea-37d7-4e4c-8a8a-e2d176dce41a",
        },
      },
      { name: "lifecycle revision", mutation: { agent_name: unique("renamed-before-cas") } },
      {
        name: "replacement cleanup ownership",
        mutation: {
          replacement_cleanup_sandbox_id: unique("replacement-sandbox"),
          replacement_cleanup_node_id: unique("replacement-node"),
          replacement_cleanup_container_name: unique("replacement-container"),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date("2026-08-23T00:30:00.000Z"),
        },
      },
      {
        name: "failed warm-claim cleanup",
        mutation: {
          claimed_at: new Date("2026-08-23T00:35:00.000Z"),
          warm_claim_credential_state: "failed",
          warm_claim_cleanup_completed_at: new Date("2026-08-23T00:40:00.000Z"),
        },
      },
    ];

    for (const { name, mutation } of cases) {
      const sandbox = await seedSandbox({
        status: "stopped",
        sandbox_id: null,
        node_id: null,
        container_name: null,
        bridge_url: null,
        health_url: null,
        bridge_port: null,
        web_ui_port: null,
        headscale_ip: null,
        database_status: "ready",
        database_uri: `postgres://restore-authority.example/${name.replaceAll(" ", "-")}`,
      });
      await seedBackup(sandbox.id, `admission-${name}`);
      mutations.set(sandbox.id, mutation);

      await expect(service.restore(sandbox.id, sandbox.organization_id)).resolves.toEqual({
        success: false,
        error: AUTHORITY_CHANGED,
      });
      expect(exactAdmission).toHaveBeenLastCalledWith(provisioningAdmissionCapture(sandbox));
    }

    expect(exactAdmission).toHaveBeenCalledTimes(cases.length);
    expect(genericAdmission).not.toHaveBeenCalled();
    expect(createKey).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects a committed exclusive lifecycle job acquired before stopped admission", async () => {
    const sandbox = await seedSandbox({
      status: "stopped",
      sandbox_id: null,
      node_id: null,
      container_name: null,
      bridge_url: null,
      health_url: null,
      bridge_port: null,
      web_ui_port: null,
      headscale_ip: null,
      database_status: "ready",
      database_uri: "postgres://restore-authority.example/committed-job",
    });
    await seedBackup(sandbox.id, "committed-job");
    const originalLatest =
      agentSandboxesRepository.getLatestStoredBackup.bind(agentSandboxesRepository);
    let inserted = false;
    spyOn(agentSandboxesRepository, "getLatestStoredBackup").mockImplementation(async (agentId) => {
      const latest = await originalLatest(agentId);
      if (!inserted) {
        inserted = true;
        await dbWrite.insert(jobs).values({
          type: JOB_TYPES.AGENT_RESTART,
          status: "pending",
          data: {
            agentId: sandbox.id,
            organizationId: sandbox.organization_id,
            userId: sandbox.user_id,
          },
          agent_id: sandbox.id,
          organization_id: sandbox.organization_id,
          user_id: sandbox.user_id,
        });
      }
      return latest;
    });
    const create = mock(async () => {
      throw new Error("provider create must not run while a lifecycle job owns admission");
    });
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });

    await expect(service.restore(sandbox.id, sandbox.organization_id)).resolves.toEqual({
      success: false,
      error: AUTHORITY_CHANGED,
    });
    expect(create).not.toHaveBeenCalled();

    const [current] = await dbWrite
      .select({ status: agentSandboxes.status })
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(current?.status).toBe("stopped");
  });

  test("allows exactly one exact-CAS winner from one stopped generation", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    const capture = provisioningAdmissionCapture(sandbox);

    const results = await Promise.all([
      agentSandboxesRepository.trySetProvisioningFromRestoreCapture(capture),
      agentSandboxesRepository.trySetProvisioningFromRestoreCapture(capture),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === undefined)).toHaveLength(1);
    const [current] = await dbWrite
      .select()
      .from(agentSandboxes)
      .where(eq(agentSandboxes.id, sandbox.id));
    expect(current).toMatchObject({
      status: "provisioning",
      organization_id: sandbox.organization_id,
      execution_tier: sandbox.execution_tier,
    });
    expect(current?.lifecycle_revision).toBe(sandbox.lifecycle_revision + 1);
  });

  test("rejects a mismatched expected tenant identity before the exact CAS", async () => {
    const sandbox = await seedSandbox({ status: "stopped" });
    const create = mock(async () => ({
      sandboxId: "must-not-create",
      bridgeUrl: "http://127.0.0.1:3000",
      healthUrl: "http://127.0.0.1:3000/health",
      metadata: {},
    }));
    const service = new ElizaSandboxService({
      create,
      stopForDeletion: mock(async () => ({ kind: "not-running-proven" as const })),
      stopForReplacement: mock(async () => {}),
      checkHealth: mock(async () => true),
    });
    const exactAdmission = spyOn(agentSandboxesRepository, "trySetProvisioningFromRestoreCapture");

    await expect(
      service.provision(sandbox.id, sandbox.organization_id, {
        kind: "from-backup",
        backupId: crypto.randomUUID(),
        requireRestoreEndpoint: true,
        expectedAdmission: {
          ...provisioningAdmissionCapture(sandbox),
          organization_id: crypto.randomUUID(),
        },
      }),
    ).resolves.toEqual({ success: false, error: AUTHORITY_CHANGED });

    expect(exactAdmission).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  test("fails a stopped custom restore when the exact backup endpoint returns 404", async () => {
    const {
      sandbox,
      storedBackup,
      running,
      service,
      stopForReplacement,
      buildProvisioningRetryHandle,
    } = await armStoppedExactRestore("stopped-custom-404", state("stopped-custom-404"));
    const fetchMock = installRestoreFetch({ status: 404, body: "restore endpoint missing" });
    globalThis.fetch = fetchMock;

    await expect(
      service.restore(sandbox.id, sandbox.organization_id, storedBackup.id),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("State restore failed: HTTP 404"),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(stopForReplacement).toHaveBeenCalledWith(running.sandbox_id);
    expect(buildProvisioningRetryHandle).not.toHaveBeenCalled();
  });

  test("fails a stopped exact restore when its selected chain disappears", async () => {
    const {
      sandbox,
      storedBackup,
      running,
      service,
      stopForReplacement,
      buildProvisioningRetryHandle,
    } = await armStoppedExactRestore("stopped-missing-chain", undefined);
    const fetchMock = installRestoreFetch();
    globalThis.fetch = fetchMock;

    await expect(
      service.restore(sandbox.id, sandbox.organization_id, storedBackup.id),
    ).resolves.toEqual({
      success: false,
      error: `Restore backup ${storedBackup.id} could not be reconstructed`,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(stopForReplacement).toHaveBeenCalledWith(running.sandbox_id);
    expect(buildProvisioningRetryHandle).not.toHaveBeenCalled();
  });
});

describe("ElizaSandboxService running restore authority", () => {
  test("pushes the exact state, then commits a fresh completion heartbeat", async () => {
    const sandbox = await seedSandbox();
    const expectedState = state("canonical");
    const backup = await seedBackup(sandbox.id, "canonical");
    let runtimeCompletedAt = 0;
    const fetchMock = installRestoreFetch({
      expectedState,
      beforeResponse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        runtimeCompletedAt = Date.now();
      },
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
    ).resolves.toMatchObject({ success: true, backup: { id: backup.id } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const after = await durableGeneration(sandbox.id);
    expect(after.lifecycleRevision).toBe(13);
    expect(after.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(after.lastHeartbeatAt!.getTime()).toBeGreaterThanOrEqual(runtimeCompletedAt);
  });

  test("rejects a locator loss after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ bridge_url: "http://127.0.0.1:22060" })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("rejects a lifecycle-generation loss after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ agent_name: unique("renamed-after-reconstruct") })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("rejects tier loss after reconstruction before later authority fields", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
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

  test("rejects pool ownership acquired after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ pool_status: "unclaimed" })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, POOL_REJECTION);
  });

  test("rejects soft deletion acquired after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ deleted_at: new Date("2026-08-22T02:00:00.000Z") })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, DELETED_REJECTION);
  });

  test("rejects deletion ownership acquired after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          deletion_attempt_id: DELETION_ATTEMPT_ID,
          deletion_started_at: new Date("2026-08-22T01:30:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, DELETION_REJECTION);
  });

  test("rejects a stopped transition after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("rejects an environment-generation change after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({ environment_revision: sandbox.environment_revision + 1 })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("rejects row loss after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, sandbox.id));
    }, AUTHORITY_CHANGED);
  });

  test("rejects replacement-cleanup ownership acquired after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite
        .update(agentSandboxes)
        .set({
          replacement_cleanup_sandbox_id: unique("retired-sandbox"),
          replacement_cleanup_node_id: unique("retired-node"),
          replacement_cleanup_container_name: unique("retired-container"),
          replacement_cleanup_allocation_counted: true,
          replacement_cleanup_created_at: new Date("2026-08-22T02:00:00.000Z"),
        })
        .where(eq(agentSandboxes.id, sandbox.id));
    }, "Agent restore cannot start while replacement cleanup is pending");
  });

  test("rejects an exclusive lifecycle job acquired after reconstruction", async () => {
    await expectPostReconstructRefusal(async (sandbox) => {
      await dbWrite.insert(jobs).values({
        type: JOB_TYPES.AGENT_RESTART,
        status: "pending",
        data: {
          agentId: sandbox.id,
          organizationId: sandbox.organization_id,
          userId: sandbox.user_id,
        },
        agent_id: sandbox.id,
        organization_id: sandbox.organization_id,
        user_id: sandbox.user_id,
      });
    }, "Agent restore cannot start while an exclusive lifecycle job is active");
  });

  test("rejects deletion of the selected backup after reconstruction", async () => {
    await expectPostReconstructRefusal(async (_sandbox, backup) => {
      await dbWrite.delete(agentSandboxBackups).where(eq(agentSandboxBackups.id, backup.id));
    }, BACKUP_CHANGED);
  });

  test("restores a canonical incremental chain", async () => {
    const sandbox = await seedSandbox();
    const base = await seedBackup(
      sandbox.id,
      "incremental-base",
      new Date("2026-08-22T01:00:00.000Z"),
    );
    const target = await seedIncrementalBackup(base, "incremental-target");
    const fetchMock = installRestoreFetch({
      expectedState: {
        memories: [],
        config: { restoreAuthority: "incremental-target" },
        workspaceFiles: {
          "incremental-base.txt": "incremental-base",
          "incremental-target.txt": "incremental-target",
        },
      },
    });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, target.id),
    ).resolves.toMatchObject({ success: true, backup: { id: target.id } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await durableGeneration(sandbox.id)).toMatchObject({ lifecycleRevision: 13 });
  });

  test("rejects deletion of an incremental ancestor after the confirmed capture", async () => {
    const sandbox = await seedSandbox();
    const base = await seedBackup(
      sandbox.id,
      "incremental-base",
      new Date("2026-08-22T01:00:00.000Z"),
    );
    const target = await seedIncrementalBackup(base, "incremental-target");
    const originalGetStoredById =
      agentSandboxesRepository.getStoredBackupById.bind(agentSandboxesRepository);
    let baseCaptureReads = 0;
    const getStoredById = spyOn(agentSandboxesRepository, "getStoredBackupById").mockImplementation(
      async (backupId) => {
        const stored = await originalGetStoredById(backupId);
        if (backupId === base.id) {
          baseCaptureReads += 1;
          if (baseCaptureReads === 2) {
            await dbWrite.delete(agentSandboxBackups).where(eq(agentSandboxBackups.id, base.id));
          }
        }
        return stored;
      },
    );
    const reconstruct = spyOn(agentSandboxesRepository, "getReconstructedBackupState");
    const fetchMock = installRestoreFetch();
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, target.id),
    ).resolves.toEqual({ success: false, error: BACKUP_CHANGED });

    expect(baseCaptureReads).toBe(2);
    expect(getStoredById).toHaveBeenCalledTimes(5);
    expect(reconstruct).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects an in-place payload change after reconstruction", async () => {
    await expectPostReconstructRefusal(async (_sandbox, backup) => {
      await dbWrite
        .update(agentSandboxBackups)
        .set({ state_data: state("mutated-after-reconstruct") })
        .where(eq(agentSandboxBackups.id, backup.id));
    }, BACKUP_CHANGED);
  });

  test("rejects an R2 payload-locator change after reconstruction", async () => {
    await expectPostReconstructRefusal(async (_sandbox, backup) => {
      await dbWrite
        .update(agentSandboxBackups)
        .set({
          state_data_storage: "r2",
          state_data_key: "changed-after-reconstruct/backup.json",
        })
        .where(eq(agentSandboxBackups.id, backup.id));
    }, BACKUP_CHANGED);
  });

  test("rejects a selected row that becomes invisible to the legacy restore lane", async () => {
    await expectPostReconstructRefusal(async (_sandbox, backup) => {
      await dbWrite
        .update(agentSandboxBackups)
        .set({ catalog_state: "protected" })
        .where(eq(agentSandboxBackups.id, backup.id));
    }, BACKUP_CHANGED);
  });

  test("keeps an implicit latest restore pinned when a newer head arrives", async () => {
    const sandbox = await seedSandbox();
    const selected = await seedBackup(
      sandbox.id,
      "selected-live",
      new Date("2026-08-22T01:00:00.000Z"),
    );
    const originalReconstruct =
      agentSandboxesRepository.getReconstructedBackupState.bind(agentSandboxesRepository);
    const reconstruct = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockImplementation(async (backupId) => {
      const reconstructed = await originalReconstruct(backupId);
      await seedBackup(sandbox.id, "new-live-head", new Date("2026-08-22T02:00:00.000Z"));
      return reconstructed;
    });
    const fetchMock = installRestoreFetch({ expectedState: state("selected-live") });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id),
    ).resolves.toMatchObject({ success: true, backup: { id: selected.id } });
    expect(reconstruct).toHaveBeenCalledWith(selected.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  for (const executionTier of ["dedicated-always", "custom"] as const) {
    test(`preserves canonical success for ${executionTier}`, async () => {
      const sandbox = await seedSandbox({ execution_tier: executionTier });
      const backup = await seedBackup(sandbox.id, executionTier);
      const fetchMock = installRestoreFetch({ expectedState: state(executionTier) });
      globalThis.fetch = fetchMock;

      await expect(
        new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
      ).resolves.toMatchObject({ success: true, backup: { id: backup.id } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await durableGeneration(sandbox.id)).toMatchObject({ lifecycleRevision: 13 });
    });
  }

  test("refuses before runtime mutation when the lifecycle trigger is missing", async () => {
    const sandbox = await seedSandbox();
    const backup = await seedBackup(sandbox.id, "missing-trigger");
    const before = await durableGeneration(sandbox.id);
    const fetchMock = installRestoreFetch({ expectedState: state("missing-trigger") });
    globalThis.fetch = fetchMock;

    await dbWrite.execute(
      sql.raw(
        'DROP TRIGGER IF EXISTS agent_sandboxes_lifecycle_revision_trigger ON "agent_sandboxes"',
      ),
    );
    try {
      await expect(
        new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
      ).rejects.toThrow("Restore lifecycle fence did not advance the generation");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(await durableGeneration(sandbox.id)).toEqual(before);
    } finally {
      await installHeartbeatRevisionMigration();
    }
  });

  test("rolls the lifecycle bump back when the runtime push fails", async () => {
    const sandbox = await seedSandbox();
    const backup = await seedBackup(sandbox.id, "push-failure");
    const before = await durableGeneration(sandbox.id);
    const fetchMock = installRestoreFetch({ status: 503, body: "runtime unavailable" });
    globalThis.fetch = fetchMock;

    await expect(
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
    ).rejects.toThrow("State restore failed: HTTP 503 runtime unavailable");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await durableGeneration(sandbox.id)).toEqual(before);
  });

  test("serializes two restores captured from one generation and pushes only once", async () => {
    const sandbox = await seedSandbox();
    const backup = await seedBackup(sandbox.id, "concurrent");
    const originalReconstruct =
      agentSandboxesRepository.getReconstructedBackupState.bind(agentSandboxesRepository);
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothReconstructed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconstruct = spyOn(
      agentSandboxesRepository,
      "getReconstructedBackupState",
    ).mockImplementation(async (backupId) => {
      const reconstructed = await originalReconstruct(backupId);
      arrivals += 1;
      if (arrivals === 2) release?.();
      await bothReconstructed;
      return reconstructed;
    });
    const fetchMock = installRestoreFetch({ expectedState: state("concurrent") });
    globalThis.fetch = fetchMock;

    const results = await Promise.all([
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
      new ElizaSandboxService().restore(sandbox.id, sandbox.organization_id, backup.id),
    ]);

    expect(reconstruct).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results.filter(({ success }) => success)).toHaveLength(1);
    expect(results.filter(({ error }) => error === AUTHORITY_CHANGED)).toHaveLength(1);
    expect(await durableGeneration(sandbox.id)).toMatchObject({ lifecycleRevision: 13 });
  });
});
