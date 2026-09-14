/**
 * Wake restore-integrity gate (#15603 B6) against the REAL pipeline: the real
 * Drizzle schema on in-process PGlite, the real memory KMS encrypting through
 * `prepareAgentBackupInsertData`, real AEAD decryption via the shared B5
 * verification primitives, and the real `executeWake` wiring (with only
 * `provision()` spied at its seam — the container build is the one surface not
 * under test here). Corruption cases tamper with actual stored envelopes and
 * actual key state, reproducing the #15310 failure mode; sandbox rows are real
 * DB rows so "stays sleeping" is asserted against the database, not a mock.
 *
 * Harness mirrors `agent-backup-verifier.test.ts`: drizzle-kit `pushSchema`
 * applies the real DDL to the PGlite connection the service queries through;
 * fails LOUDLY when the ambient DATABASE_URL is a shared non-PGlite Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { resetKmsClientForTests } from "../../db/crypto/kms-client";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { agentBackupObjects } from "../../db/schemas/agent-backup-catalog";
import { agentComputeFunding } from "../../db/schemas/agent-compute-funding";
import { agentNodeIncarnationHistories } from "../../db/schemas/agent-node-incarnation-histories";
import {
  type AgentBackupStateData,
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
  type EncryptedAgentBackupStateData,
} from "../../db/schemas/agent-sandboxes";
import { billingFundingReservations } from "../../db/schemas/billing-funding-reservations";
import { organizations } from "../../db/schemas/organizations";
import { userCharacters } from "../../db/schemas/user-characters";
import { users } from "../../db/schemas/users";
import { setRuntimeR2Bucket } from "../storage/r2-runtime-binding";
import { computeStateHash } from "./agent-backup-diff";
import { ElizaSandboxService, type ProvisionRestoreOverride } from "./eliza-sandbox";
import type { DaemonHealthAlert } from "./provisioning-worker-health-monitor";
import {
  formatWakeRestoreIntegrityError,
  readWakeRestoreGateConfig,
  runWakeRestoreIntegrityGate,
  type WakeRestoreGateConfig,
  WakeRestoreIntegrityError,
} from "./wake-restore-integrity";

const PGLITE_TIMEOUT = 60_000;
let pgliteReady = true;

let seq = 0;
function uniq(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
}

const NOW = new Date("2026-07-09T12:00:00.000Z");

const GATE_CONFIG: WakeRestoreGateConfig = {
  enabled: true,
  verifiedFreshnessMs: 24 * 3_600_000,
  alternativeScanLimit: 25,
};

function makeAlertSpy(): { alerts: DaemonHealthAlert[]; alert: (a: DaemonHealthAlert) => void } {
  const alerts: DaemonHealthAlert[] = [];
  return { alerts, alert: (a) => alerts.push(a) };
}

async function seedSandbox(status: "sleeping" | "running" = "sleeping"): Promise<{
  sandboxId: string;
  orgId: string;
}> {
  const [org] = await dbWrite
    .insert(organizations)
    .values({ name: "Wake Gate Org", slug: uniq("org") })
    .returning();
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: uniq("steward"), organization_id: org.id })
    .returning();
  const [sandbox] = await dbWrite
    .insert(agentSandboxes)
    .values({
      organization_id: org.id,
      user_id: user.id,
      agent_name: uniq("agent"),
      status,
      execution_tier: "dedicated-lazy",
    })
    .returning();
  return { sandboxId: sandbox.id, orgId: org.id };
}

function sampleState(marker: string): AgentBackupStateData {
  return {
    memories: [{ role: "user", text: `remember ${marker}`, timestamp: 1_700_000_000_000 }],
    config: { marker },
    workspaceFiles: { "notes.txt": `notes for ${marker}` },
  };
}

async function seedFullBackup(
  sandboxRecordId: string,
  state: AgentBackupStateData,
  createdAt: Date,
): Promise<string> {
  const backup = await agentSandboxesRepository.createBackup({
    sandbox_record_id: sandboxRecordId,
    snapshot_type: "pre-shutdown",
    state_data: state,
    size_bytes: 1024,
    backup_kind: "full",
    content_hash: computeStateHash(state),
    created_at: createdAt,
  });
  return backup.id;
}

/** Bit-rot the stored AEAD envelope in place: same shape, tampered ciphertext. */
async function corruptBackupCiphertext(backupId: string): Promise<void> {
  const [stored] = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, backupId))
    .limit(1);
  const envelope = stored.state_data as EncryptedAgentBackupStateData;
  expect(envelope.kind).toBe("encrypted-agent-backup-state");
  const tampered =
    (envelope.ciphertext.startsWith("AAAAAAAA") ? "BBBBBBBB" : "AAAAAAAA") +
    envelope.ciphertext.slice(8);
  await dbWrite
    .update(agentSandboxBackups)
    .set({ state_data: { ...envelope, ciphertext: tampered } })
    .where(eq(agentSandboxBackups.id, backupId));
}

async function stampRow(
  backupId: string,
  status: "verified" | "failed" | null,
  verifiedAt: Date | null,
  error: string | null = null,
): Promise<void> {
  await dbWrite
    .update(agentSandboxBackups)
    .set({ verification_status: status, verified_at: verifiedAt, verification_error: error })
    .where(eq(agentSandboxBackups.id, backupId));
}

async function readBackupRow(backupId: string) {
  const [row] = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, backupId))
    .limit(1);
  if (!row) throw new Error(`backup row ${backupId} not found`);
  return row;
}

async function readSandboxStatus(sandboxId: string): Promise<string> {
  const [row] = await dbWrite
    .select({ status: agentSandboxes.status })
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, sandboxId))
    .limit(1);
  if (!row) throw new Error(`sandbox row ${sandboxId} not found`);
  return row.status;
}

beforeAll(async () => {
  if (!CAN_USE_ISOLATED_PGLITE) {
    pgliteReady = false;
    console.warn(
      "[wake-restore-integrity.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); this in-process-PGlite isolation suite fails — drizzle-kit pushSchema against a shared connection crashes the bun runner and would mutate the shared schema.",
    );
    return;
  }
  try {
    const schema = {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentNodeIncarnationHistories,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentBackupObjects,
      billingFundingReservations,
      agentComputeFunding,
    };
    const { statementsToExecute } = await pushSchema(schema as never, dbWrite as never);
    // Drizzle push emits cross-table FKs before unique indexes on newly
    // created tables. Install the referenced indexes before adding those FKs.
    const isForeignKey = (statement: string) =>
      /^ALTER TABLE .* ADD CONSTRAINT .* FOREIGN KEY/s.test(statement);
    for (const statement of [
      ...statementsToExecute.filter((statement) => !isForeignKey(statement)),
      ...statementsToExecute.filter(isForeignKey),
    ])
      await dbWrite.execute(sql.raw(statement));
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[wake-restore-integrity.test] PGlite/pushSchema unavailable — cannot drive the wake gate against a real DB. Failing all cases.",
      error,
    );
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(pgliteReady).toBe(true);
  setRuntimeR2Bucket(null);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
});

afterAll(async () => {
  setRuntimeR2Bucket(null);
  await closeDatabaseConnectionsForTests();
});

describe("readWakeRestoreGateConfig", () => {
  test("defaults: enabled, 24h verified freshness, scan limit 25", () => {
    const config = readWakeRestoreGateConfig({} as NodeJS.ProcessEnv);
    expect(config.enabled).toBe(true);
    expect(config.verifiedFreshnessMs).toBe(24 * 3_600_000);
    expect(config.alternativeScanLimit).toBe(25);
  });

  test("kill switch and tunables parse", () => {
    expect(
      readWakeRestoreGateConfig({ WAKE_RESTORE_INTEGRITY_ENABLED: "0" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    expect(
      readWakeRestoreGateConfig({ WAKE_RESTORE_INTEGRITY_ENABLED: "false" } as NodeJS.ProcessEnv)
        .enabled,
    ).toBe(false);
    const tuned = readWakeRestoreGateConfig({
      WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS: "6",
      WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT: "5",
    } as NodeJS.ProcessEnv);
    expect(tuned.verifiedFreshnessMs).toBe(6 * 3_600_000);
    expect(tuned.alternativeScanLimit).toBe(5);
  });

  test.each([
    ["WAKE_RESTORE_INTEGRITY_ENABLED", "sometimes"],
    ["WAKE_RESTORE_INTEGRITY_ENABLED", ""],
    ["WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS", "-3"],
    ["WAKE_RESTORE_VERIFIED_FRESHNESS_HOURS", "1.5"],
    ["WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT", "banana"],
    ["WAKE_RESTORE_ALTERNATIVE_SCAN_LIMIT", "0"],
  ])("present invalid config %s=%j fails fast", (name, value) => {
    expect(() => readWakeRestoreGateConfig({ [name]: value } as NodeJS.ProcessEnv)).toThrow(
      /Invalid WAKE_RESTORE_/,
    );
  });
});

describe("runWakeRestoreIntegrityGate", () => {
  test("healthy encrypted backup verifies for real and is stamped verified", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("healthy"), NOW);

    const { alerts, alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result).toEqual({ ok: true, backupId, verification: "verified" });
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("verified");
    expect(row.verified_at?.toISOString()).toBe(NOW.toISOString());
    expect(row.verification_error).toBeNull();
    expect(alerts).toEqual([]);
  });

  test("no backups at all: wake may proceed fresh — there is no durable state to discard", async () => {
    const { sandboxId } = await seedSandbox();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId: null, verification: "no-backup" });
  });

  test("fresh 'verified' stamp skips re-verification: corrupted-after-stamp ciphertext still wakes", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("stamped"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() - 3_600_000));
    // Tampering AFTER the stamp proves the freshness shortcut never touches
    // the payload — a re-decrypt would fail on this envelope.
    await corruptBackupCiphertext(backupId);

    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId, verification: "fresh-stamp" });
  });

  test("stale 'verified' stamp re-verifies for real and catches corruption", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("stale-stamp"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() - 25 * 3_600_000));
    await corruptBackupCiphertext(backupId);

    const { alerts, alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("decrypt-failed");
    expect(result.failure.backupId).toBe(backupId);
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("failed");
    expect(alerts.map((a) => a.dedupKey)).toEqual(["agent-wake-restore-integrity"]);
  });

  test("a future 'verified' stamp re-verifies for real and catches corruption", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("future-stamp"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() + 60_000));
    await corruptBackupCiphertext(backupId);

    const { alerts, alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("decrypt-failed");
    expect((await readBackupRow(backupId)).verification_status).toBe("failed");
    expect(alerts.map((entry) => entry.dedupKey)).toEqual(["agent-wake-restore-integrity"]);
  });

  // The freshness contract has zero clock-skew tolerance: `0 <= age <=
  // freshnessMs` is fresh, anything outside re-verifies. Each edge case below
  // corrupts the ciphertext AFTER stamping, so the outcome proves which path
  // ran: `fresh-stamp` means the stamp was trusted (payload never touched);
  // `decrypt-failed` means the gate re-decrypted for real.
  test("freshness edge: a stamp at exactly `now` (age 0) is fresh — the stamp is trusted", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("edge-age-zero"), NOW);
    await stampRow(backupId, "verified", NOW);
    await corruptBackupCiphertext(backupId);

    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId, verification: "fresh-stamp" });
  });

  test("freshness edge: a stamp aged exactly freshnessMs is still fresh (inclusive window)", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("edge-window"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() - GATE_CONFIG.verifiedFreshnessMs));
    await corruptBackupCiphertext(backupId);

    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId, verification: "fresh-stamp" });
  });

  test("freshness edge: a stamp aged freshnessMs + 1ms re-verifies and catches corruption", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("edge-window-past"), NOW);
    await stampRow(
      backupId,
      "verified",
      new Date(NOW.getTime() - GATE_CONFIG.verifiedFreshnessMs - 1),
    );
    await corruptBackupCiphertext(backupId);

    const { alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("decrypt-failed");
    expect((await readBackupRow(backupId)).verification_status).toBe("failed");
  });

  test("freshness edge: a stamp 1ms in the FUTURE re-verifies — zero skew tolerance", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("edge-future-1ms"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() + 1));
    await corruptBackupCiphertext(backupId);

    const { alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("decrypt-failed");
    expect((await readBackupRow(backupId)).verification_status).toBe("failed");
  });

  test("freshness window is tunable: a 1h window re-verifies a 2h-old stamp", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("tight-window"), NOW);
    await stampRow(backupId, "verified", new Date(NOW.getTime() - 2 * 3_600_000));
    await corruptBackupCiphertext(backupId);

    const { alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: { ...GATE_CONFIG, verifiedFreshnessMs: 3_600_000 }, now: () => NOW, alert },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("decrypt-failed");
  });

  test("'failed' stamp hard-fails immediately without re-decrypt (healthy payload stays blocked)", async () => {
    const { sandboxId } = await seedSandbox();
    // The payload is genuinely healthy — if the gate re-verified it, the wake
    // would pass. Failing proves the stamp short-circuits before any decrypt.
    const backupId = await seedFullBackup(sandboxId, sampleState("stamped-failed"), NOW);
    await stampRow(
      backupId,
      "failed",
      new Date(NOW.getTime() - 3_600_000),
      "decrypt-failed: AEAD decrypt failed",
    );

    const { alerts, alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("previously-failed");
    expect(result.failure.message).toContain("AEAD decrypt failed");
    // The stamp is untouched — no re-verification overwrote it.
    const row = await readBackupRow(backupId);
    expect(row.verification_status).toBe("failed");
    expect(row.verified_at?.toISOString()).toBe(new Date(NOW.getTime() - 3_600_000).toISOString());
    expect(alerts.map((a) => a.dedupKey)).toEqual(["agent-wake-restore-integrity"]);
  });

  test("corrupted latest with an older valid backup: failure names the alternative and stamps both rows", async () => {
    const { sandboxId } = await seedSandbox();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("older-good"),
      new Date(NOW.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("latest-bad"), NOW);
    await corruptBackupCiphertext(latestId);

    const { alerts, alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.backupId).toBe(latestId);
    expect(result.failure.kind).toBe("decrypt-failed");
    expect(result.failure.alternativeBackupId).toBe(olderId);
    expect(result.failure.alternativeBackupCreatedAt).toBe(
      new Date(NOW.getTime() - 6 * 3_600_000).toISOString(),
    );
    expect((await readBackupRow(latestId)).verification_status).toBe("failed");
    // The alternative scan verified the older row for real and stamped it, so
    // the retry wake (restoreBackupId) rides the fresh stamp.
    expect((await readBackupRow(olderId)).verification_status).toBe("verified");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].details.alternativeBackupId).toBe(olderId);

    const message = formatWakeRestoreIntegrityError(result.failure);
    expect(message).toContain(latestId);
    expect(message).toContain("decrypt-failed");
    expect(message).toContain(olderId);
    expect(message).toContain("restoreBackupId");
    expect(message).toContain("forceFreshBoot");
    expect(message).toContain("left sleeping");
  });

  test("corrupted latest with NO valid alternative: failure says so", async () => {
    const { sandboxId } = await seedSandbox();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("older-bad"),
      new Date(NOW.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("latest-bad-2"), NOW);
    await corruptBackupCiphertext(olderId);
    await corruptBackupCiphertext(latestId);

    const { alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.alternativeBackupId).toBeUndefined();
    expect(formatWakeRestoreIntegrityError(result.failure)).toContain(
      "No older retained backup passed validation",
    );
  });

  test("wrong KMS key (#15310 signature): key-unavailable, wake blocked", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("kms-rotated"), NOW);
    // The memory backend "restarts": ciphertext intact, keys gone.
    resetKmsClientForTests();

    const { alert } = makeAlertSpy();
    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: GATE_CONFIG, now: () => NOW, alert },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("key-unavailable");
    expect(result.failure.backupId).toBe(backupId);
  });

  test("requestedBackupId: an older valid backup validates and is the wake's restore point", async () => {
    const { sandboxId } = await seedSandbox();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("explicit-older"),
      new Date(NOW.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("latest-corrupt"), NOW);
    await corruptBackupCiphertext(latestId);

    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId, requestedBackupId: olderId },
      { config: GATE_CONFIG, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId: olderId, verification: "verified" });
  });

  test("requestedBackupId owned by ANOTHER sandbox is indistinguishable from missing (no existence oracle)", async () => {
    const victim = await seedSandbox();
    const attacker = await seedSandbox();
    const victimBackup = await seedFullBackup(victim.sandboxId, sampleState("victim"), NOW);

    const crossSandbox = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: attacker.sandboxId, requestedBackupId: victimBackup },
      { config: GATE_CONFIG, now: () => NOW },
    );
    const missing = await runWakeRestoreIntegrityGate(
      {
        sandboxRecordId: attacker.sandboxId,
        requestedBackupId: "99999999-9999-4999-8999-999999999999",
      },
      { config: GATE_CONFIG, now: () => NOW },
    );

    for (const result of [crossSandbox, missing]) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.failure.kind).toBe("backup-not-found");
      expect(result.failure.message).toBe("requested backup does not exist for this agent");
    }
  });

  test("kill switch: gate disabled passes a corrupt latest through (legacy behavior, loudly logged)", async () => {
    const { sandboxId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("disabled"), NOW);
    await corruptBackupCiphertext(backupId);

    const result = await runWakeRestoreIntegrityGate(
      { sandboxRecordId: sandboxId },
      { config: { ...GATE_CONFIG, enabled: false }, now: () => NOW },
    );
    expect(result).toEqual({ ok: true, backupId: null, verification: "disabled" });
  });
});

describe("executeWake with the restore-integrity gate", () => {
  function makeService(): {
    svc: ElizaSandboxService;
    provisionCalls: Array<ProvisionRestoreOverride | undefined>;
  } {
    const svc = new ElizaSandboxService();
    const provisionCalls: Array<ProvisionRestoreOverride | undefined> = [];
    spyOn(agentBillingRepository, "settleAccruedBillingBeforeLifecycle").mockResolvedValue({
      status: "already_billed_recently",
    });
    spyOn(
      agentBillingRepository,
      "settleAccruedBillingBeforeLifecycleInTransaction",
    ).mockResolvedValue({ status: "already_billed_recently" });
    spyOn(svc, "provision").mockImplementation(
      async (_agentId: string, _orgId: string, restoreOverride?: ProvisionRestoreOverride) => {
        provisionCalls.push(restoreOverride);
        return {
          success: true as const,
          sandboxRecord: {} as never,
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
        };
      },
    );
    return { svc, provisionCalls };
  }

  test.each([
    "environment_revision",
    "lifecycle_execution_generation",
    "lifecycle_job_id",
  ] as const)(
    "wake rejects a changed %s after backup validation before settlement",
    async (field) => {
      const { sandboxId, orgId } = await seedSandbox();
      await dbWrite
        .update(agentSandboxes)
        .set({
          lifecycle_job_id: crypto.randomUUID(),
          lifecycle_execution_generation: crypto.randomUUID(),
        })
        .where(eq(agentSandboxes.id, sandboxId));
      await seedFullBackup(sandboxId, sampleState("wake-authority-race"), NOW);
      const { svc, provisionCalls } = makeService();
      const settle = spyOn(
        agentBillingRepository,
        "settleAccruedBillingBeforeLifecycleInTransaction",
      );
      const original = agentSandboxesRepository.getLatestStoredBackup;
      const readBackup = spyOn(
        agentSandboxesRepository,
        "getLatestStoredBackup",
      ).mockImplementation(async (...args) => {
        const backup = await original.apply(agentSandboxesRepository, args);
        await dbWrite
          .update(agentSandboxes)
          .set(
            field === "environment_revision"
              ? { environment_revision: 99 }
              : field === "lifecycle_execution_generation"
                ? { lifecycle_execution_generation: crypto.randomUUID() }
                : { lifecycle_job_id: crypto.randomUUID() },
          )
          .where(eq(agentSandboxes.id, sandboxId));
        return backup;
      });
      try {
        const result = await svc.executeWake(sandboxId, orgId);
        expect(result.success).toBe(false);
        expect(result.error).toBe("Agent lifecycle changed before wake billing settlement");
        expect(provisionCalls).toEqual([]);
        expect(settle).not.toHaveBeenCalled();
        expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
      } finally {
        readBackup.mockRestore();
      }
    },
  );

  test("healthy latest backup: wake proceeds and restores it", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("wake-healthy"), NOW);
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId);

    expect(result).toEqual({
      success: true,
      reprovisioned: true,
      restoredBackupId: backupId,
    });
    // The default wake restores through provision's explicit from-backup path:
    // the override pins the restore to the gate-validated backup AND disables
    // provision's unrecoverable-snapshot degrade, so a restore failure fails
    // the provision instead of booting empty and pruning the chain.
    expect(provisionCalls).toEqual([{ kind: "from-backup", backupId }]);
    expect((await readBackupRow(backupId)).verification_status).toBe("verified");
  });

  test("no backups at all: wake boots fresh with no restore override and reports no restored backup", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId);

    expect(result).toEqual({ success: true, reprovisioned: true });
    expect(provisionCalls).toEqual([undefined]);
  });

  test("gate pass on a fresh stamp cannot boot empty: a failed restore fails the wake, sandbox stays sleeping, chain is NOT pruned", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const wakeNow = new Date();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("wake-restore-fail-older"),
      new Date(wakeNow.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("wake-restore-fail"), wakeNow);
    await stampRow(latestId, "verified", new Date(wakeNow.getTime() - 3_600_000));
    // Rot AFTER the stamp: the gate passes on the stamp alone (never touches
    // bytes), so provision's restore is the FIRST real read of this envelope —
    // exactly the path where an ungated default wake degraded to a fresh boot
    // and pruned every backup.
    await corruptBackupCiphertext(latestId);

    const svc = new ElizaSandboxService();
    const provisionCalls: Array<ProvisionRestoreOverride | undefined> = [];
    const pruneSpy = spyOn(agentSandboxesRepository, "pruneBackups");
    const provisionSpy = spyOn(svc, "provision").mockImplementation(
      async (_agentId: string, _orgId: string, restoreOverride?: ProvisionRestoreOverride) => {
        provisionCalls.push(restoreOverride);
        // The real from-backup contract (locked by the provision-level suite in
        // eliza-sandbox.test.ts): the restore failure fails the provision —
        // retryable by the wake job — and never degrades or prunes.
        return {
          success: false as const,
          error: "Failed to decrypt backup state: AEAD decrypt failed",
        };
      },
    );

    try {
      const result = await svc.executeWake(sandboxId, orgId);

      // The daemon handler throws on success:false, so the wake JOB fails.
      expect(result.success).toBe(false);
      expect(result.reprovisioned).toBe(true);
      expect(result.error).toContain("AEAD decrypt failed");
      expect(provisionCalls).toEqual([{ kind: "from-backup", backupId: latestId }]);
      expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
      expect(pruneSpy).not.toHaveBeenCalled();
      // The whole retention set survives for the restoreBackupId retry.
      await readBackupRow(latestId);
      await readBackupRow(olderId);

      // A provision that THROWS mid-restore propagates — the wake job fails
      // loudly rather than fabricating a wake result.
      provisionSpy.mockImplementation(async () => {
        throw new Error("Failed to decrypt backup state: AEAD decrypt failed");
      });
      await expect(svc.executeWake(sandboxId, orgId)).rejects.toThrow("AEAD decrypt failed");
      expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
      expect(pruneSpy).not.toHaveBeenCalled();
      await readBackupRow(latestId);
      await readBackupRow(olderId);
    } finally {
      pruneSpy.mockRestore();
      provisionSpy.mockRestore();
    }
  });

  test("kill switch: wake reverts to the ungated legacy restore and still reports the latest backup id", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("wake-kill-switch"), NOW);
    // Corrupt bytes prove the disabled path touches NOTHING: no verification,
    // and the reported id comes from stored metadata, never an eager decrypt.
    await corruptBackupCiphertext(backupId);
    const { svc, provisionCalls } = makeService();

    const prevEnv = process.env.WAKE_RESTORE_INTEGRITY_ENABLED;
    process.env.WAKE_RESTORE_INTEGRITY_ENABLED = "0";
    try {
      const result = await svc.executeWake(sandboxId, orgId);

      // Pre-gate report shape: the legacy wake always named the latest backup.
      expect(result).toEqual({
        success: true,
        reprovisioned: true,
        restoredBackupId: backupId,
      });
      // No override: provision keeps its own latest-backup auto-restore with
      // the designed degrade — the kill switch restores legacy behavior whole.
      expect(provisionCalls).toEqual([undefined]);
      expect((await readBackupRow(backupId)).verification_status).toBeNull();
    } finally {
      if (prevEnv === undefined) delete process.env.WAKE_RESTORE_INTEGRITY_ENABLED;
      else process.env.WAKE_RESTORE_INTEGRITY_ENABLED = prevEnv;
    }
  });

  test("corrupted latest: wake FAILS, provision never runs, sandbox stays sleeping, error names the older valid backup", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("wake-older-good"),
      new Date(NOW.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("wake-latest-bad"), NOW);
    await corruptBackupCiphertext(latestId);
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId);

    expect(result.success).toBe(false);
    expect(result.reprovisioned).toBe(false);
    expect(result.integrityFailure).toMatchObject({
      backupId: latestId,
      kind: "decrypt-failed",
      alternativeBackupId: olderId,
    });
    expect(result.error).toContain(latestId);
    expect(result.error).toContain(olderId);
    expect(result.error).toContain("forceFreshBoot");
    // Nothing was provisioned or torn down: the compute-discarding step never ran.
    expect(provisionCalls).toEqual([]);
    expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
    // The typed job error the daemon throws carries the same structure.
    const typed = new WakeRestoreIntegrityError(result.integrityFailure!);
    expect(typed.name).toBe("WakeRestoreIntegrityError");
    expect(typed.message).toBe(result.error!);
  });

  test("restoreBackupId: wake succeeds from the validated older backup via the provision override", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const olderId = await seedFullBackup(
      sandboxId,
      sampleState("wake-explicit-older"),
      new Date(NOW.getTime() - 6 * 3_600_000),
    );
    const latestId = await seedFullBackup(sandboxId, sampleState("wake-latest-bad-2"), NOW);
    await corruptBackupCiphertext(latestId);
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId, { restoreBackupId: olderId });

    expect(result).toEqual({
      success: true,
      reprovisioned: true,
      restoredBackupId: olderId,
    });
    expect(provisionCalls).toEqual([{ kind: "from-backup", backupId: olderId }]);
  });

  test("restoreBackupId from another sandbox: wake fails as backup-not-found, provision never runs", async () => {
    const victim = await seedSandbox();
    const attacker = await seedSandbox();
    const victimBackup = await seedFullBackup(victim.sandboxId, sampleState("wake-victim"), NOW);
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(attacker.sandboxId, attacker.orgId, {
      restoreBackupId: victimBackup,
    });

    expect(result.success).toBe(false);
    expect(result.integrityFailure?.kind).toBe("backup-not-found");
    expect(provisionCalls).toEqual([]);
    expect(await readSandboxStatus(attacker.sandboxId)).toBe("sleeping");
  });

  test("forceFreshBoot: fresh boot happens ONLY with the flag — same corrupt backup blocks the flagless wake", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const latestId = await seedFullBackup(sandboxId, sampleState("wake-force"), NOW);
    await corruptBackupCiphertext(latestId);
    const { svc, provisionCalls } = makeService();

    const blocked = await svc.executeWake(sandboxId, orgId);
    expect(blocked.success).toBe(false);
    expect(blocked.freshBoot).toBeUndefined();
    expect(provisionCalls).toEqual([]);
    expect(await readSandboxStatus(sandboxId)).toBe("sleeping");

    const forced = await svc.executeWake(sandboxId, orgId, { forceFreshBoot: true });
    expect(forced).toEqual({ success: true, reprovisioned: true, freshBoot: true });
    expect(provisionCalls).toEqual([{ kind: "fresh-boot" }]);
  });

  test("restoreBackupId and forceFreshBoot together are rejected before any side effect", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    const backupId = await seedFullBackup(sandboxId, sampleState("wake-both"), NOW);
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId, {
      restoreBackupId: backupId,
      forceFreshBoot: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("restoreBackupId and forceFreshBoot are mutually exclusive");
    expect(provisionCalls).toEqual([]);
    expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
  });

  test("'failed'-stamped latest short-circuits the wake without re-decrypt", async () => {
    const { sandboxId, orgId } = await seedSandbox();
    // Healthy payload deliberately stamped failed: a re-verification would
    // pass, so the wake failing proves the stamp short-circuit (no decrypt).
    const backupId = await seedFullBackup(sandboxId, sampleState("wake-stamped-failed"), NOW);
    await stampRow(backupId, "failed", NOW, "key-unavailable: key not found");
    const { svc, provisionCalls } = makeService();

    const result = await svc.executeWake(sandboxId, orgId);

    expect(result.success).toBe(false);
    expect(result.integrityFailure).toMatchObject({
      backupId,
      kind: "previously-failed",
    });
    expect(result.error).toContain("key not found");
    expect(provisionCalls).toEqual([]);
    expect(await readSandboxStatus(sandboxId)).toBe("sleeping");
  });
});
