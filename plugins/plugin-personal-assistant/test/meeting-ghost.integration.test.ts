/**
 * Meeting-ghost consumer integration test.
 *
 * Drives `runMeetingGhostForTranscript` against the REAL `PgApprovalQueue` on a
 * PGlite-backed runtime (same harness as approval-queue.integration.test.ts) —
 * no mocked queue. Proves the dead-code gap is closed: a realistic diarized
 * `TranscriptSegment[]` flows through the pure analyzer and every derived
 * follow-up/calendar approval lands as a real, resolvable `pending` row the
 * owner can approve.
 *
 * Run: bunx vitest run plugins/plugin-personal-assistant/test/meeting-ghost.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { AgentEventService, getConnectorAccountManager } from "@elizaos/core";
import { schedulingPlugin } from "@elizaos/plugin-scheduling";
import type { TranscriptSegment } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { createApprovalQueue } from "../src/lifeops/approval-queue.js";
import type { ApprovalQueue } from "../src/lifeops/approval-queue.types.js";
import { runMeetingGhostForTranscript } from "../src/lifeops/meeting-ghost/consumer.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { personalAssistantPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;
let queue: ApprovalQueue;
let isolatedStateDir: string;
let isolatedConfigPath: string;
let senderGrantId: string;
let senderAccountId: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "meeting-ghost-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );
  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
}

function restoreEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function seg(
  speakerLabel: string,
  startMs: number,
  text: string,
): TranscriptSegment {
  return {
    id: `${speakerLabel}-${startMs}`,
    speakerLabel,
    startMs,
    endMs: startMs + 8_000,
    text,
    words: [],
  };
}

beforeAll(async () => {
  setIsolatedEnv();
  const result = await createRealTestRuntime({
    plugins: [schedulingPlugin, personalAssistantPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
  if (!runtime.getService(AgentEventService.serviceType)) {
    await runtime.registerService(AgentEventService);
    await runtime.getServiceLoadPromise(AgentEventService.serviceType);
  }
  queue = createApprovalQueue(runtime, { agentId: runtime.agentId });
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreEnv();
  rmSync(isolatedStateDir, { recursive: true, force: true });
});

describe("meeting-ghost consumer (real approval queue)", () => {
  it("leaves approvals and commitments untouched when no email sender is connected", async () => {
    await expect(
      runMeetingGhostForTranscript(runtime, {
        agentId: runtime.agentId,
        owner: {
          ownerUserId: "owner-mtg-unconnected",
          ownerDisplayName: "Synthetic owner",
          requestedBy: "meeting-ghost",
          careAbouts: [],
          approvalExpiresAt: new Date(Date.now() + 86_400_000),
        },
        transcript: {
          meetingId: "unconnected-meeting",
          title: "Synthetic planning",
          startedAt: "2026-09-11T16:00:00.000Z",
          attendees: [{ name: "Ava", email: "ava@example.test" }],
          segments: [
            seg("Mira", 0, "Ava will send the school schedule by 2026-09-15."),
          ],
        },
      }),
    ).rejects.toThrow();
    expect(
      await queue.list({
        subjectUserId: "owner-mtg-unconnected",
        state: null,
        action: null,
      }),
    ).toEqual([]);
    const records = await new LifeOpsRepository(
      runtime,
    ).listCommitmentLedgerRecords(runtime.agentId, { source: "transcript" });
    expect(
      records.filter((record) =>
        record.sourceKey.startsWith("unconnected-meeting:"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("enqueues follow-up + calendar approvals from a diarized transcript, resolvable by the owner", async () => {
    const manager = getConnectorAccountManager(runtime);
    if (!manager.getProvider("google"))
      manager.registerProvider({ provider: "google" });
    const sender = await manager.upsertAccount("google", {
      id: "meeting-owner",
      provider: "google",
      role: "OWNER",
      purpose: ["messaging"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: "meeting-owner@example.test",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
      },
    });
    senderAccountId = sender.id;
    senderGrantId = `connector-account:${sender.id}`;
    const approvalExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const result = await runMeetingGhostForTranscript(runtime, {
      agentId: runtime.agentId,
      owner: {
        ownerUserId: "owner-mtg-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "ops-sync-integration",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        attendees: [
          { name: "Ava", email: "ava@example.com" },
          { name: "Ben", email: "ben@example.com" },
        ],
        segments: [
          seg("Ava", 0, "Morning, nothing blocking on my side."),
          seg(
            "Mira",
            60_000,
            "Ava will send the launch-date rollback plan by 2026-07-10.",
          ),
          seg(
            "Mira",
            120_000,
            "Ben is going to update the public calendar by 2026-07-10.",
          ),
        ],
      },
    });

    // Two commitments → two follow-up emails + two dated calendar deadlines.
    expect(result.analysis.commitments).toHaveLength(2);
    expect(result.enqueued).toHaveLength(4);
    expect(result.commitmentLedgerIds).toHaveLength(2);
    expect(result.enqueued.every((r) => r.state === "pending")).toBe(true);

    const actions = result.enqueued.map((r) => r.action).sort();
    expect(actions).toEqual([
      "schedule_event",
      "schedule_event",
      "send_email",
      "send_email",
    ]);

    // The rows are real, listable, and resolvable — not a fire-and-forget stub.
    const pending = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: "pending",
      action: null,
      limit: 20,
    });
    expect(pending.length).toBeGreaterThanOrEqual(4);

    const repo = new LifeOpsRepository(runtime);
    const ledgerRows = await repo.listCommitmentLedgerRecords(runtime.agentId, {
      source: "transcript",
    });
    const meetingRows = ledgerRows.filter((row) =>
      row.sourceKey.startsWith("ops-sync-integration:"),
    );
    expect(meetingRows).toHaveLength(2);
    expect(meetingRows.map((row) => row.summary).sort()).toEqual([
      "send the launch-date rollback plan",
      "update the public calendar",
    ]);
    expect(meetingRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          counterparty: "Ava",
          dueAt: "2026-07-10T17:00:00.000Z",
          status: "open",
          metadata: expect.objectContaining({
            meetingId: "ops-sync-integration",
            meetingTitle: "Ops Sync",
            sourceText:
              "Ava will send the launch-date rollback plan by 2026-07-10.",
          }),
        }),
      ]),
    );

    const rerun = await runMeetingGhostForTranscript(runtime, {
      agentId: runtime.agentId,
      owner: {
        ownerUserId: "owner-mtg-1",
        ownerDisplayName: "Shaw",
        requestedBy: "meeting-ghost",
        careAbouts: ["launch date"],
        calendarId: "primary",
        approvalExpiresAt,
      },
      transcript: {
        meetingId: "ops-sync-integration",
        title: "Ops Sync",
        startedAt: "2026-07-06T16:00:00.000Z",
        attendees: [
          { name: "Ava", email: "ava@example.com" },
          { name: "Ben", email: "ben@example.com" },
        ],
        segments: [
          seg("Ava", 0, "Morning, nothing blocking on my side."),
          seg(
            "Mira",
            60_000,
            "Ava will send the launch-date rollback plan by 2026-07-10.",
          ),
          seg(
            "Mira",
            120_000,
            "Ben is going to update the public calendar by 2026-07-10.",
          ),
        ],
      },
    });
    expect(rerun.enqueued.map((request) => request.id).sort()).toEqual(
      result.enqueued.map((request) => request.id).sort(),
    );
    const pendingAfterRerun = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: "pending",
      action: null,
      limit: 20,
    });
    expect(pendingAfterRerun).toHaveLength(pending.length);
    const ledgerRowsAfterRerun = await repo.listCommitmentLedgerRecords(
      runtime.agentId,
      {
        source: "transcript",
      },
    );
    expect(
      ledgerRowsAfterRerun.filter((row) =>
        row.sourceKey.startsWith("ops-sync-integration:"),
      ),
    ).toHaveLength(2);

    const firstEmail = result.enqueued.find((r) => r.action === "send_email");
    if (!firstEmail) throw new Error("expected a send_email approval");
    const approved = await queue.approve(
      firstEmail.id,
      firstEmail.subjectUserId,
      {
        resolvedBy: "owner-mtg-1",
        resolutionReason: "send it",
      },
    );
    expect(approved.state).toBe("approved");
    if (approved.payload.action !== "send_email") {
      throw new Error("expected send_email payload");
    }
    expect(approved.payload.to).toEqual(["ava@example.com"]);
    expect(approved.payload.grantId).toBe(senderGrantId);
    expect(approved.reason).toContain("From: meeting-owner@example.test");
    for (const approval of result.analysis.followUpApprovals) {
      expect(approval.payload).toMatchObject({ grantId: senderGrantId });
      expect(approval.reason).toContain("From: meeting-owner@example.test");
    }
  }, 60_000);
  it("rejects revoked send permission before creating follow-ups and preserves existing sender bindings", async () => {
    const manager = getConnectorAccountManager(runtime);
    const sender = await manager.getAccount("google", senderAccountId);
    if (!sender) throw new Error("Fixture sender missing");
    await manager.upsertAccount("google", {
      ...sender,
      metadata: {
        grantedScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      },
    });
    await expect(
      runMeetingGhostForTranscript(runtime, {
        agentId: runtime.agentId,
        owner: {
          ownerUserId: "owner-mtg-revoked",
          ownerDisplayName: "Synthetic owner",
          requestedBy: "meeting-ghost",
          careAbouts: [],
          approvalExpiresAt: new Date(Date.now() + 86_400_000),
        },
        transcript: {
          meetingId: "revoked-sender-meeting",
          title: "School planning",
          startedAt: "2026-09-11T16:00:00.000Z",
          attendees: [{ name: "Ava", email: "ava@example.test" }],
          segments: [
            seg("Mira", 0, "Ava will send the school schedule by 2026-09-15."),
          ],
        },
      }),
    ).rejects.toThrow();
    expect(
      await queue.list({
        subjectUserId: "owner-mtg-revoked",
        state: null,
        action: null,
      }),
    ).toEqual([]);
    const previous = await queue.list({
      subjectUserId: "owner-mtg-1",
      state: null,
      action: "send_email",
    });
    expect(previous).not.toHaveLength(0);
    for (const request of previous)
      expect(request.payload).toMatchObject({ grantId: senderGrantId });
  }, 60_000);
});
