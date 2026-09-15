/** Real PGlite cleanup and checkpoint recovery with deterministic connector operations; no provider account is disconnected or messaged. */

import { randomUUID } from "node:crypto";
import {
  ApprovalDispatchControlStore,
  type ApprovalEnqueueInput,
  createApprovalQueue,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import {
  CalendarService,
  createDefaultCalendarHostGate,
} from "@elizaos/plugin-calendar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffCalendarMappings } from "./account-handoff-calendar-mappings.js";
import { AccountHandoffDataDisposition } from "./account-handoff-data-disposition.js";
import { AccountHandoffDisconnect } from "./account-handoff-disconnect.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import { AccountHandoffResume } from "./account-handoff-resume.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { AccountHandoffVerification } from "./account-handoff-verification.js";
import { lifeOpsGmailMessageFromGoogle } from "./google-plugin-delegates.js";
import { LifeOpsRepository } from "./repository.js";
import type { LifeOpsGoogleService } from "./service-mixin-google.js";
import { executeRawSql, sqlJson, sqlText } from "./sql.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
  await host.runtime.registerService(GoogleWorkspaceTestService);
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

async function setRecipient(entityId: string, verified: boolean) {
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture identity service missing");
  await graph.getEntityStore(host.runtime.agentId).upsert({
    entityId,
    type: "person",
    preferredName: entityId,
    identities: [
      {
        platform: "email",
        handle: "self@example.test",
        connectorAccountId: "default",
        verified,
        confidence: 1,
        addedAt: "2026-09-01T00:00:00Z",
        addedVia: "user_chat",
        evidence: ["Synthetic owner confirmation"],
      },
    ],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
}

async function prepared(
  owner: string,
  remove = true,
  performDisconnect = true,
  withWriteCalendar = false,
  withReadCalendar = false,
) {
  const f = googleHandoffFixture();
  f.grant.agentId = host.runtime.agentId;
  if (!withReadCalendar) f.review.readCalendars = [];
  if (!withWriteCalendar) f.review.writeCalendar = null;
  f.review.importedData = remove ? "remove_previous_account_imports" : "retain";
  const previousGrant = {
    ...f.grant,
    id: f.review.previous.grantId,
    connectorAccountId: f.review.previous.connectorAccountId,
    identityEmail: f.review.previous.email,
  };
  const statuses = [f.status, { ...f.status, grant: previousGrant }];
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, { listCalendars: f.google.listCalendars });
  const calendar = new CalendarService(host.runtime);
  calendar.setGate({
    ...createDefaultCalendarHostGate(host.runtime),
    getGoogleConnectorAccounts: async () => statuses,
  });
  if (withWriteCalendar) {
    let control = await calendar.getLinkedCalendarControl();
    if (!control.paused)
      control = await calendar.executeLinkedCalendarControl(
        new URL("http://localhost"),
        {
          operation: "pause",
          expectedRevision: control.revision,
          idempotencyKey: `fixture:${owner}:pause`,
        },
      );
    control = await calendar.executeLinkedCalendarControl(
      new URL("http://localhost"),
      {
        operation: "select",
        expectedRevision: control.revision,
        idempotencyKey: `fixture:${owner}:select`,
        destination: {
          connectorAccountId: previousGrant.connectorAccountId,
          providerCalendarId: f.entry.calendarId,
        },
      },
    );
    await calendar.executeLinkedCalendarControl(new URL("http://localhost"), {
      operation: "resume",
      expectedRevision: control.revision,
      idempotencyKey: `fixture:${owner}:resume`,
    });
  }
  const store = new AccountHandoffStore(host.runtime, owner);
  const url = new URL("http://localhost");
  let state = await store.review(owner, f.review);
  await setRecipient(owner, true);
  state = await new AccountHandoffRecipients(host.runtime, owner).capture(
    state.operationId,
    state.revision,
    [owner],
  );
  const admission = new AccountHandoffAdmission(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await admission.begin(state.operationId, state.revision);
  state = await admission.pause(state.operationId, state.revision);
  state = await admission.drain(state.operationId, state.revision);
  state = await admission.retireApprovals(state.operationId, state.revision);
  const mappings = new AccountHandoffCalendarMappings(
    host.runtime,
    owner,
    calendar,
    url,
  );
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await mappings.applyNext(state.operationId, state.revision);
  state = await new AccountHandoffVerification(
    host.runtime,
    owner,
    calendar,
    f.accounts,
    f.google,
    url,
  ).verifyGoogle(state.operationId, state.revision);
  // Destination verification before this phase is a fixture boundary. The
  // connector port below is deterministic, not evidence of a live disconnect.
  state = await store.advance({
    operationId: state.operationId,
    expectedRevision: state.revision,
    expectedPhase: "verifying_replacement",
    phase: "disconnecting_previous",
    receipt: {},
  });
  const disconnectCalls: Array<
    Parameters<LifeOpsGoogleService["disconnectGoogleConnector"]>[0]
  > = [];
  const accounts: Pick<
    LifeOpsGoogleService,
    | "getGoogleConnectorStatus"
    | "getGoogleConnectorAccounts"
    | "disconnectGoogleConnector"
  > = {
    ...f.accounts,
    getGoogleConnectorAccounts: async () => statuses,
    disconnectGoogleConnector: async (request) => {
      disconnectCalls.push(request);
      const index = statuses.findIndex(
        ({ grant }) => grant?.id === request.grantId,
      );
      if (index < 0) throw new Error("The fixture account was already removed");
      statuses.splice(index, 1);
      return f.status;
    },
  };
  const disconnect = () =>
    new AccountHandoffDisconnect(
      host.runtime,
      owner,
      calendar,
      accounts,
      f.google,
      url,
    );
  if (performDisconnect)
    state = await disconnect().apply(state.operationId, state.revision);
  const service = () =>
    new AccountHandoffDataDisposition(
      host.runtime,
      owner,
      calendar,
      accounts,
      url,
    );
  const repo = new LifeOpsRepository(host.runtime);
  const message = {
    externalId: owner,
    threadId: owner,
    subject: "Synthetic handoff fixture",
    from: "Fixture",
    fromEmail: "fixture@example.test",
    replyTo: null,
    to: [],
    cc: [],
    snippet: "Fixture",
    receivedAt: "2026-09-01T00:00:00Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: false,
    triageScore: 0,
    triageReason: "Fixture",
    labels: [],
    htmlLink: null,
    metadata: {},
  };
  const previousMessage = lifeOpsGmailMessageFromGoogle({
    agentId: host.runtime.agentId,
    grant: previousGrant,
    message,
    syncedAt: "2026-09-01T00:00:00Z",
  });
  const replacementMessage = lifeOpsGmailMessageFromGoogle({
    agentId: host.runtime.agentId,
    grant: f.grant,
    message,
    syncedAt: "2026-09-01T00:00:00Z",
  });
  await repo.upsertGmailMessage(previousMessage);
  await repo.upsertGmailMessage(replacementMessage);
  const previousSnapshot = await repo.getGmailMessage(
    host.runtime.agentId,
    "google",
    previousMessage.id,
  );
  const replacementSnapshot = await repo.getGmailMessage(
    host.runtime.agentId,
    "google",
    replacementMessage.id,
  );
  if (!previousSnapshot || !replacementSnapshot)
    throw new Error("Fixture messages were not persisted");
  const read = () =>
    repo.listGmailMessages(
      host.runtime.agentId,
      "google",
      { grantId: previousGrant.id },
      "owner",
    );
  return {
    f,
    calendar,
    store,
    state,
    statuses,
    accounts,
    service,
    repo,
    read,
    previousMessage,
    replacementMessage,
    previousSnapshot,
    replacementSnapshot,
    disconnect,
    disconnectCalls,
    previousGrant,
    resume: () =>
      new AccountHandoffResume(
        host.runtime,
        owner,
        calendar,
        accounts,
        f.google,
        url,
      ),
  };
}

async function setReplacementSource(
  p: Awaited<ReturnType<typeof prepared>>,
  included: boolean,
) {
  const url = new URL("http://localhost");
  const [source] = await p.calendar.listCalendars(url, {
    mode: "local",
    side: "owner",
    grantId: p.f.grant.id,
  });
  if (!source) throw new Error("Replacement fixture calendar missing");
  return p.calendar.setCalendarIncluded(url, {
    provider: "google",
    mode: "local",
    side: "owner",
    grantId: p.f.grant.id,
    connectorAccountId: p.f.grant.connectorAccountId,
    calendarId: source.calendarId,
    includeInFeed: included,
    expectedVersion: source.selectionVersion,
  });
}

describe("handoff imported-data disposition", () => {
  it("recovers after deletion but before checkpoint, retaining replacement mail and paused controls", async () => {
    const p = await prepared("remove-owner");
    const control = await p.calendar.getLinkedCalendarControl();
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_disposition_checkpoint CHECK (NOT (receipt_json::jsonb ? 'importedDataDisposition'))",
    );
    try {
      await expect(
        p.service().apply(p.state.operationId, p.state.revision),
      ).rejects.toThrow();
      expect(await p.read()).toEqual([]);
      expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_disposition_checkpoint",
      );
    }
    const completed = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    expect(completed.phase).toBe("resuming");
    expect(completed.receipt.importedDataDisposition).toMatchObject({
      disposition: "remove_previous_account_imports",
      grantId: p.f.review.previous.grantId,
      providerMutation: false,
    });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.replacementMessage.id,
      ),
    ).toEqual(p.replacementSnapshot);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
  });

  it("preserves imported data when the saved decision is retain", async () => {
    const p = await prepared("retain-owner", false);
    await p.service().apply(p.state.operationId, p.state.revision);
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
  });

  it("rejects changed ownership, accounts, and pause state before deletion", async () => {
    const p = await prepared("guard-owner");
    const unrelated = new AccountHandoffDataDisposition(
      host.runtime,
      "unrelated",
      p.calendar,
      p.accounts,
      new URL("http://localhost"),
    );
    await expect(
      unrelated.apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.statuses.push({
      ...p.f.status,
      grant: {
        ...p.f.grant,
        id: p.f.review.previous.grantId,
        connectorAccountId: p.f.review.previous.connectorAccountId,
      },
    });
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    p.statuses.pop();
    p.f.status.connected = false;
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.f.status.connected = true;
    const control = await p.calendar.getLinkedCalendarControl();
    await p.calendar.executeLinkedCalendarControl(new URL("http://localhost"), {
      operation: "pause",
      expectedRevision: control.revision,
      idempotencyKey: "intervening-disposition-pause",
    });
    await expect(
      p.service().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
  it("keeps the old account connected when the reviewed recipient is revoked", async () => {
    const owner = "disconnect-revoked-recipient-owner";
    const p = await prepared(owner, true, false);
    const approval = await new ApprovalDispatchControlStore(host.runtime).read(
      owner,
    );
    const calendar = await p.calendar.getLinkedCalendarControl();
    const accounts = p.statuses.map(({ grant }) => grant?.id);
    await setRecipient(owner, false);
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    expect(p.disconnectCalls).toEqual([]);
    expect(p.statuses.map(({ grant }) => grant?.id)).toEqual(accounts);
    expect(
      await new ApprovalDispatchControlStore(host.runtime).read(owner),
    ).toEqual(approval);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(calendar);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });

  it("does not repeat account removal after its checkpoint failed", async () => {
    const p = await prepared("disconnect-retry-owner", true, false);
    const control = await p.calendar.getLinkedCalendarControl();
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_disconnect_checkpoint CHECK (NOT (receipt_json::jsonb ? 'previousDisconnected')) NOT VALID",
    );
    try {
      await expect(
        p.disconnect().apply(p.state.operationId, p.state.revision),
      ).rejects.toThrow();
      expect(p.statuses.map(({ grant }) => grant?.id)).toEqual([
        p.f.review.replacement.grantId,
      ]);
      expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_disconnect_checkpoint",
      );
    }
    const saved = await p
      .disconnect()
      .apply(p.state.operationId, p.state.revision);
    expect(saved.phase).toBe("disposing_imports");
    expect(saved.receipt.previousDisconnected).toEqual(p.f.review.previous);
    expect(p.disconnectCalls).toEqual([
      {
        mode: "local",
        side: "owner",
        grantId: p.f.review.previous.grantId,
        purgeImportedData: false,
      },
    ]);
    expect(
      await p.repo.getGmailMessage(
        host.runtime.agentId,
        "google",
        p.previousMessage.id,
      ),
    ).toEqual(p.previousSnapshot);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
  });

  it("does not remove a changed old identity or a replacement without current provider access", async () => {
    const p = await prepared("disconnect-guard-owner", true, false);
    p.previousGrant.identityEmail = "unexpected@example.test";
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    p.previousGrant.identityEmail = p.f.review.previous.email;
    p.f.status.connected = false;
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({
      code: "ACCOUNT_HANDOFF_REPLACEMENT_UNAVAILABLE",
    });
    expect(p.disconnectCalls).toEqual([]);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
  });
  it("keeps delivery and calendar paused when the reviewed recipient is revoked", async () => {
    const owner = "revoked-recipient-owner";
    const p = await prepared(owner, true, true, true);
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const controls = new ApprovalDispatchControlStore(host.runtime);
    const approval = await controls.read(owner);
    const calendar = await p.calendar.getLinkedCalendarControl();
    await setRecipient(owner, false);
    await setRecipient("same-handle-other-entity", true);
    await expect(
      p.resume().apply(ready.operationId, ready.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    expect(await controls.read(owner)).toEqual(approval);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(calendar);
    expect(await p.store.read(ready.operationId)).toEqual(ready);
    await setRecipient(owner, true);
    expect(
      (await p.resume().apply(ready.operationId, ready.revision)).phase,
    ).toBe("completed");
  });

  it.each(["unbound", "previous"] as const)(
    "rejects new %s approvals and keeps handoff paused for an unfenced legacy writer",
    async (binding) => {
      const owner = `late-${binding}-approval-owner`;
      const p = await prepared(owner);
      const ready = await p
        .service()
        .apply(p.state.operationId, p.state.revision);
      const queue = createApprovalQueue(host.runtime, {
        agentId: host.runtime.agentId,
      });
      const input: ApprovalEnqueueInput = {
        requestedBy: owner,
        subjectUserId: owner,
        action: "send_email",
        channel: "email",
        reason: "Synthetic email approval arriving after handoff retirement",
        expiresAt: new Date(Date.now() + 86_400_000),
        payload: {
          action: "send_email",
          to: ["self@example.test"],
          cc: [],
          bcc: [],
          subject: "Synthetic late approval",
          body: "Synthetic test only",
          threadId: null,
          replyToMessageId: null,
          ...(binding === "previous" ? { grantId: p.previousGrant.id } : {}),
        },
      };
      await expect(queue.enqueue(input)).rejects.toMatchObject({
        code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED",
      });
      const late = { id: randomUUID(), payload: input.payload };
      // An older process can still insert without the new admission column during a rolling upgrade.
      await executeRawSql(
        host.runtime,
        `INSERT INTO approval_requests
        (id, agent_id, requested_by, subject_user_id, state, action, channel, payload, reason, expires_at)
        VALUES (${sqlText(late.id)}, ${sqlText(host.runtime.agentId)}, ${sqlText(owner)}, ${sqlText(owner)},
          'pending', 'send_email', 'email', ${sqlJson(input.payload)}, ${sqlText(input.reason)},
          ${sqlText(input.expiresAt.toISOString())})`,
      );
      await queue.approve(late.id, owner, {
        resolvedBy: owner,
        resolutionReason: "Synthetic approval",
      });
      const calendar = await p.calendar.getLinkedCalendarControl();
      await expect(
        p.resume().apply(ready.operationId, ready.revision),
      ).rejects.toMatchObject({
        code: "ACCOUNT_HANDOFF_APPROVAL_REVIEW_INCOMPLETE",
      });
      expect(
        (await new ApprovalDispatchControlStore(host.runtime).read(owner))
          .paused,
      ).toBe(true);
      expect(await p.calendar.getLinkedCalendarControl()).toEqual(calendar);
      expect((await p.store.read(ready.operationId))?.phase).toBe("resuming");
      await queue.markExpired(late.id, owner);
      const other = await queue.enqueue({
        requestedBy: owner,
        subjectUserId: owner,
        action: "send_email",
        channel: "email",
        reason: "Synthetic explicitly bound unrelated-account approval",
        expiresAt: new Date(Date.now() + 86_400_000),
        payload: { ...late.payload, grantId: "unrelated-account-grant" },
      });
      expect(
        (await p.resume().apply(ready.operationId, ready.revision)).phase,
      ).toBe("completed");
      expect(
        (
          await queue.list({
            subjectUserId: owner,
            state: "pending",
            action: null,
          })
        ).map((request) => request.id),
      ).toContain(other.id);
    },
  );

  it("fences an in-progress handoff created before account admission fencing existed", async () => {
    const owner = "upgrade-resume-owner";
    const p = await prepared(owner);
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    // The additive migration initializes these fields this way for an older paused operation.
    await executeRawSql(
      host.runtime,
      `UPDATE approval_dispatch_controls
      SET google_binding_required = FALSE, retired_google_grants = '{}'::jsonb
      WHERE agent_id = ${sqlText(host.runtime.agentId)} AND subject_user_id = ${sqlText(owner)}`,
    );
    expect(
      (await p.resume().apply(ready.operationId, ready.revision)).phase,
    ).toBe("completed");
    const queue = createApprovalQueue(host.runtime, {
      agentId: host.runtime.agentId,
    });
    await expect(
      queue.enqueue({
        requestedBy: owner,
        subjectUserId: owner,
        action: "send_email",
        channel: "email",
        reason: "Synthetic legacy approval after upgrade",
        expiresAt: new Date(Date.now() + 86_400_000),
        payload: {
          action: "send_email",
          to: ["self@example.test"],
          cc: [],
          bcc: [],
          subject: "Synthetic legacy draft",
          body: "No provider send",
          threadId: null,
          replyToMessageId: null,
        },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED" });
  });

  it("recovers a released approval pause after the completion checkpoint failed", async () => {
    const p = await prepared("resume-retry-owner");
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const controls = new ApprovalDispatchControlStore(host.runtime);
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_resume_checkpoint CHECK (NOT (receipt_json::jsonb ? 'resumed')) NOT VALID",
    );
    try {
      await expect(
        p.resume().apply(ready.operationId, ready.revision),
      ).rejects.toThrow();
      expect((await controls.read("resume-retry-owner")).paused).toBe(false);
      expect(await p.store.read(ready.operationId)).toEqual(ready);
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_resume_checkpoint",
      );
    }
    const released = await controls.read("resume-retry-owner");
    const complete = await p.resume().apply(ready.operationId, ready.revision);
    expect(complete.phase).toBe("completed");
    expect(await controls.read("resume-retry-owner")).toEqual(released);
    expect((await p.calendar.getLinkedCalendarControl()).paused).toBe(true);
  });

  it("rejects an unfenced release from an older interrupted handoff", async () => {
    const owner = "unfenced-released-owner";
    const p = await prepared(owner);
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const controls = new ApprovalDispatchControlStore(host.runtime);
    const paused = await controls.read(owner);
    if (!paused.operationId) throw new Error("Expected an owned pause");
    await controls.resume({
      subjectUserId: owner,
      operationId: paused.operationId,
      expectedRevision: paused.revision,
    });
    await executeRawSql(
      host.runtime,
      `UPDATE approval_dispatch_controls
      SET google_binding_required = FALSE, retired_google_grants = '{}'::jsonb
      WHERE agent_id = ${sqlText(host.runtime.agentId)} AND subject_user_id = ${sqlText(owner)}`,
    );
    const released = await controls.read(owner);
    await expect(
      p.resume().apply(ready.operationId, ready.revision),
    ).rejects.toMatchObject({ code: "APPROVAL_DISPATCH_CONTROL_CONFLICT" });
    expect(await p.store.read(ready.operationId)).toEqual(ready);
    expect(await controls.read(owner)).toEqual(released);
    expect((await p.calendar.getLinkedCalendarControl()).paused).toBe(true);
  });

  it("preserves an approval pause that existed before the handoff", async () => {
    const controls = new ApprovalDispatchControlStore(host.runtime);
    const original = await controls.pause({
      subjectUserId: "prepaused-owner",
      operationId: "manual-pause",
      expectedRevision: 0,
    });
    const p = await prepared("prepaused-owner");
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const complete = await p.resume().apply(ready.operationId, ready.revision);
    expect(complete.phase).toBe("completed");
    expect(await controls.read("prepaused-owner")).toEqual(original);
  });

  it("releases the canonical calendar control with its reviewed replacement destination", async () => {
    const p = await prepared("calendar-resume-owner", true, true, true);
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    expect((await p.calendar.getLinkedCalendarControl()).paused).toBe(true);
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_calendar_resume_checkpoint CHECK (NOT (receipt_json::jsonb ? 'resumed')) NOT VALID",
    );
    try {
      await expect(
        p.resume().apply(ready.operationId, ready.revision),
      ).rejects.toThrow();
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_calendar_resume_checkpoint",
      );
    }
    const activated = await p.calendar.getLinkedCalendarControl();
    expect(activated.paused).toBe(false);
    const complete = await p.resume().apply(ready.operationId, ready.revision);
    expect(await p.calendar.getLinkedCalendarControl()).toEqual(activated);
    expect(complete.phase).toBe("completed");
    expect(await p.calendar.getLinkedCalendarControl()).toMatchObject({
      paused: false,
      destination: {
        connectorAccountId: p.f.review.replacement.connectorAccountId,
        providerCalendarId: p.f.entry.calendarId,
      },
    });
    expect(
      (
        await new ApprovalDispatchControlStore(host.runtime).read(
          "calendar-resume-owner",
        )
      ).paused,
    ).toBe(false);
  });
  it("does not overwrite a later owner pause after an interrupted release", async () => {
    const p = await prepared("later-pause-owner");
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const approvals = new ApprovalDispatchControlStore(host.runtime);
    await executeRawSql(
      host.runtime,
      "ALTER TABLE app_lifeops.life_account_handoffs ADD CONSTRAINT reject_later_pause_checkpoint CHECK (NOT (receipt_json::jsonb ? 'resumed')) NOT VALID",
    );
    try {
      await expect(
        p.resume().apply(ready.operationId, ready.revision),
      ).rejects.toThrow();
    } finally {
      await executeRawSql(
        host.runtime,
        "ALTER TABLE app_lifeops.life_account_handoffs DROP CONSTRAINT reject_later_pause_checkpoint",
      );
    }
    const released = await approvals.read("later-pause-owner");
    const manual = await approvals.pause({
      subjectUserId: "later-pause-owner",
      operationId: "later-owner-pause",
      expectedRevision: released.revision,
    });
    await expect(
      p.resume().apply(ready.operationId, ready.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_CONFLICT" });
    expect(await approvals.read("later-pause-owner")).toEqual(manual);
    expect(await p.store.read(ready.operationId)).toEqual(ready);
  });
  it("requires the reviewed read source before removing the old account", async () => {
    const p = await prepared(
      "missing-read-source-owner",
      true,
      false,
      false,
      true,
    );
    await expect(
      p.disconnect().apply(p.state.operationId, p.state.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_READ_SOURCES_CHANGED" });
    expect(p.disconnectCalls).toEqual([]);
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    await setReplacementSource(p, true);
    try {
      const disconnected = await p
        .disconnect()
        .apply(p.state.operationId, p.state.revision);
      expect(disconnected.phase).toBe("disposing_imports");
      expect(p.disconnectCalls).toHaveLength(1);
    } finally {
      await setReplacementSource(p, false);
    }
  });

  it("blocks resume if an unreviewed replacement source becomes included", async () => {
    const p = await prepared("extra-read-source-owner");
    const ready = await p
      .service()
      .apply(p.state.operationId, p.state.revision);
    const approval = await new ApprovalDispatchControlStore(host.runtime).read(
      "extra-read-source-owner",
    );
    const control = await p.calendar.getLinkedCalendarControl();
    await setReplacementSource(p, true);
    try {
      await expect(
        p.resume().apply(ready.operationId, ready.revision),
      ).rejects.toMatchObject({
        code: "ACCOUNT_HANDOFF_READ_SOURCES_CHANGED",
      });
      expect(
        await new ApprovalDispatchControlStore(host.runtime).read(
          "extra-read-source-owner",
        ),
      ).toEqual(approval);
      expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
      expect(await p.store.read(ready.operationId)).toEqual(ready);
    } finally {
      await setReplacementSource(p, false);
    }
    expect(
      (await p.resume().apply(ready.operationId, ready.revision)).phase,
    ).toBe("completed");
  });
  it("does not treat failed provider discovery as an empty reviewed selection", async () => {
    const p = await prepared("unavailable-read-source-owner", true, false);
    const provider = await host.runtime.getServiceLoadPromise("google");
    Object.assign(provider, {
      listCalendars: async () => {
        throw new Error("Synthetic calendar discovery outage");
      },
    });
    try {
      await expect(
        p.disconnect().apply(p.state.operationId, p.state.revision),
      ).rejects.toMatchObject({
        code: "CALENDAR_SOURCES_UNAVAILABLE",
      });
      expect(p.disconnectCalls).toEqual([]);
      expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    } finally {
      Object.assign(provider, { listCalendars: p.f.google.listCalendars });
    }
    expect(
      (await p.disconnect().apply(p.state.operationId, p.state.revision)).phase,
    ).toBe("disposing_imports");
  });
});
