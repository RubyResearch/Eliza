/**
 * Real PGlite migration and guarded-write tests for Dedicated backup capture.
 * Heartbeats preserve capture authority; lifecycle mutations and revision forgery
 * still fence out stale persistence, including after migration replay.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = (name: string) =>
  readFileSync(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
const fix = migration("0386_agent_heartbeat_lifecycle_revision");

async function setup(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE agent_sandboxes (
      id integer PRIMARY KEY, organization_id text NOT NULL,
      status text, node_id text, environment_revision bigint,
      lifecycle_revision bigint NOT NULL DEFAULT 0,
      last_heartbeat_at timestamptz, updated_at timestamptz,
      deleted_at timestamptz, container_name text,
      billing_status text, last_backup_at timestamptz,
      future_lifecycle_field text
    );
    INSERT INTO agent_sandboxes (id,organization_id,status,node_id,environment_revision,
      last_heartbeat_at,updated_at,container_name)
    VALUES (1,'owner-a','running','node-a',1,'2026-09-13T00:00:00Z',
      '2026-09-13T00:00:00Z','agent-a');
    CREATE TABLE persisted_captures (agent_id integer, captured_revision bigint);
  `);
  await db.exec(migration("0189_agent_sandbox_lifecycle_revision_scope"));
  await db.exec(migration("0235_agent_backup_rpo_scheduler"));
  await db.exec(fix);
  return db;
}

async function revision(db: PGlite): Promise<number> {
  const result = await db.query<{ lifecycle_revision: number }>(
    "SELECT lifecycle_revision FROM agent_sandboxes WHERE id=1",
  );
  return Number(result.rows[0].lifecycle_revision);
}

async function persistCapturedRevision(db: PGlite, captured: number): Promise<number> {
  const result = await db.query(
    `
    INSERT INTO persisted_captures (agent_id,captured_revision)
    SELECT id,lifecycle_revision FROM agent_sandboxes
    WHERE id=1 AND lifecycle_revision=$1 RETURNING agent_id
  `,
    [captured],
  );
  return result.rows.length;
}

describe("Dedicated heartbeat lifecycle migration", () => {
  test("a heartbeat during capture preserves the guarded persistence after replay", async () => {
    const db = await setup();
    try {
      await db.exec(fix);
      const captured = await revision(db);
      await db.exec(`UPDATE agent_sandboxes SET
        last_heartbeat_at='2026-09-13T00:01:00Z',updated_at='2026-09-13T00:01:00Z'
        WHERE id=1`);
      expect(await revision(db)).toBe(captured);
      expect(await persistCapturedRevision(db, captured)).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);

  test("lifecycle and mixed heartbeat mutations reject stale capture persistence", async () => {
    const db = await setup();
    try {
      for (const assignment of [
        "status='sleeping'",
        "node_id='node-b'",
        "environment_revision=2",
        "organization_id='owner-b'",
        "container_name='agent-b'",
        "deleted_at='2026-09-13T00:02:00Z'",
        "future_lifecycle_field='new-state'",
        "status='running',last_heartbeat_at='2026-09-13T00:03:00Z'",
      ]) {
        const captured = await revision(db);
        await db.exec(`UPDATE agent_sandboxes SET ${assignment} WHERE id=1`);
        expect(await revision(db)).toBe(captured + 1);
        expect(await persistCapturedRevision(db, captured)).toBe(0);
      }
    } finally {
      await db.close();
    }
  }, 60_000);

  test("a heartbeat cannot smuggle a caller-selected lifecycle revision", async () => {
    const db = await setup();
    try {
      const captured = await revision(db);
      await db.exec(`UPDATE agent_sandboxes SET lifecycle_revision=-100,
        last_heartbeat_at='2026-09-13T00:01:00Z' WHERE id=1`);
      expect(await revision(db)).toBe(captured + 1);
      expect(await persistCapturedRevision(db, captured)).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);

  test("existing billing and scheduler exclusions remain effective", async () => {
    const db = await setup();
    try {
      const captured = await revision(db);
      await db.exec(`UPDATE agent_sandboxes SET billing_status='suspended',
        next_backup_at='2026-09-13T00:05:00Z',backup_schedule_attempts=1 WHERE id=1`);
      expect(await revision(db)).toBe(captured);
      expect(await persistCapturedRevision(db, captured)).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);
});
