/** Real PGlite review assembly and recipient preflight with deterministic provider discovery; no external changes or messages. */
import {
  createApprovalQueue,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import {
  CalendarService,
  createDefaultCalendarHostGate,
} from "@elizaos/plugin-calendar";
import { afterAll, beforeAll, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { AccountHandoffAdmission } from "./account-handoff-admission.js";
import { AccountHandoffReviewService } from "./account-handoff-review.js";
import { AccountHandoffStore } from "./account-handoff-store.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
  await host.runtime.registerService(GoogleWorkspaceTestService);
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

async function fixture(owner: string) {
  const f = googleHandoffFixture();
  f.grant.agentId = host.runtime.agentId;
  const accounts = {
    getGoogleConnectorAccounts: async () => [
      f.status,
      {
        ...f.status,
        grant: {
          ...f.grant,
          id: f.review.previous.grantId,
          connectorAccountId: f.review.previous.connectorAccountId,
          identityEmail: f.review.previous.email,
        },
      },
    ],
  };
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, { listCalendars: f.google.listCalendars });
  const calendar = new CalendarService(host.runtime);
  calendar.setGate({
    ...createDefaultCalendarHostGate(host.runtime),
    ...accounts,
  });
  const url = new URL("http://localhost");
  const choices = {
    operationId: owner,
    previousGrantId: f.review.previous.grantId,
    replacementGrantId: f.grant.id,
    readCalendarIds: [f.entry.calendarId],
    writeCalendarId: null,
    calendarLinks: [],
    importedData: "retain" as const,
    messageDestinations: [
      {
        channel: "email" as const,
        connectorAccountId: "replacement",
        recipientId: "recipient@example.test",
        recipientEntityId: owner,
      },
    ],
    retireApprovalIds: [] as string[],
  };
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture identity service missing");
  await graph.getEntityStore(host.runtime.agentId).upsert({
    entityId: owner,
    type: "person",
    preferredName: "Synthetic recipient",
    identities: [
      {
        platform: "email",
        handle: "recipient@example.test",
        connectorAccountId: "default",
        verified: true,
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
  const service = () =>
    new AccountHandoffReviewService(
      host.runtime,
      owner,
      accounts,
      calendar,
      url,
    );
  const store = new AccountHandoffStore(host.runtime, owner);
  return { choices, service, store, calendar, f };
}

it("saves server-derived facts and immutable checkpoints without changing calendar controls; retries read the same review", async () => {
  const p = await fixture("review-success");
  const control = await p.calendar.getLinkedCalendarControl();
  const result = await p.service().create(p.choices);
  expect(result.review.previous).toEqual(p.f.review.previous);
  expect(result.review.replacement).toEqual(p.f.review.replacement);
  expect(result.receipt.recipientReview).toEqual([
    {
      channel: "email",
      connectorAccountId: "replacement",
      recipientId: "recipient@example.test",
      recipientEntityId: "review-success",
      identityPlatform: "email",
      identityHandle: "recipient@example.test",
      identityConnectorAccountId: "default",
    },
  ]);
  expect(await p.service().create(p.choices)).toEqual(result);
  expect(await p.calendar.getLinkedCalendarControl()).toEqual(control);
  expect(
    await new AccountHandoffStore(host.runtime, "another-owner").read(
      result.operationId,
    ),
  ).toBeNull();
});

it("rejects missing recipient identity or unavailable approvals before creating an active review", async () => {
  const p = await fixture("review-invalid-recipient");
  const choices = {
    ...p.choices,
    messageDestinations: [
      {
        ...p.choices.messageDestinations[0],
        recipientEntityId: "missing-contact",
      },
    ],
  };
  await expect(p.service().create(choices)).rejects.toMatchObject({
    code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED",
  });
  expect(await p.store.active()).toBeNull();
  await expect(
    p.service().create({
      ...p.choices,
      retireApprovalIds: ["afdd3dfe-52e6-4a20-a0ca-45c5e8f41b9a"],
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_APPROVAL_UNAVAILABLE" });
  expect(await p.store.active()).toBeNull();
});

it("rejects client-supplied review facts and email routing to the previous account", async () => {
  const p = await fixture("review-forged-input");
  await expect(
    p.service().create({ ...p.choices, retireApprovalIds: ["invalid-uuid"] }),
  ).rejects.toMatchObject({ name: "ZodError" });
  expect(await p.store.active()).toBeNull();
  const forged = { ...p.choices, replacement: p.f.review.previous };
  await expect(p.service().create(forged)).rejects.toThrow();
  await expect(
    p.service().create({
      ...p.choices,
      messageDestinations: [
        { ...p.choices.messageDestinations[0], connectorAccountId: "old" },
      ],
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_REVIEW_CHANGED" });
  expect(await p.store.active()).toBeNull();
});

it("requires old-account and unbound email approvals in review and rechecks newly queued work before retirement", async () => {
  const owner = "review-approval-inventory";
  const p = await fixture(owner);
  const queue = createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  });
  const enqueue = (grantId?: string) =>
    queue.enqueue({
      requestedBy: owner,
      subjectUserId: owner,
      action: "send_email",
      payload: {
        action: "send_email",
        ...(grantId ? { grantId } : {}),
        to: ["synthetic@example.test"],
        cc: [],
        bcc: [],
        subject: "Synthetic handoff",
        body: "No provider used",
        threadId: null,
      },
      channel: "email",
      reason: "Synthetic retirement proof",
      expiresAt: new Date(Date.now() + 600_000),
    });
  const old = await enqueue(p.f.review.previous.grantId);
  const legacy = await enqueue();
  const replacement = await enqueue(p.f.grant.id);
  const cancel = (expectedProvider: "google" | "eliza") =>
    queue.enqueue({
      requestedBy: owner,
      subjectUserId: owner,
      action: "cancel_event",
      payload: {
        action: "cancel_event",
        calendarId: "family",
        eventId: "synthetic-event",
        expectedProvider,
        notifyAttendees: false,
      },
      channel: "browser",
      reason: "Synthetic calendar approval",
      expiresAt: new Date(Date.now() + 600_000),
    });
  const unboundCalendar = await cancel("google");
  const localCalendar = await cancel("eliza");
  await expect(p.service().create(p.choices)).rejects.toMatchObject({
    code: "ACCOUNT_HANDOFF_APPROVAL_REVIEW_INCOMPLETE",
  });
  expect(await p.store.active()).toBeNull();
  await expect(
    p.service().create({ ...p.choices, retireApprovalIds: [old.id] }),
  ).rejects.toMatchObject({
    code: "ACCOUNT_HANDOFF_APPROVAL_REVIEW_INCOMPLETE",
  });
  let state = await p.service().create({
    ...p.choices,
    retireApprovalIds: [old.id, legacy.id, unboundCalendar.id],
  });
  const late = await enqueue(p.f.review.previous.grantId);
  const admission = new AccountHandoffAdmission(
    host.runtime,
    owner,
    p.calendar,
    new URL("http://localhost"),
  );
  state = await admission.begin(state.operationId, state.revision);
  state = await admission.pause(state.operationId, state.revision);
  state = await admission.drain(state.operationId, state.revision);
  await expect(
    admission.retireApprovals(state.operationId, state.revision),
  ).rejects.toMatchObject({
    code: "ACCOUNT_HANDOFF_APPROVAL_REVIEW_INCOMPLETE",
  });
  expect((await queue.byId(old.id, owner))?.state).toBe("pending");
  expect((await queue.byId(legacy.id, owner))?.state).toBe("pending");
  expect((await p.store.read(state.operationId))?.phase).toBe(
    "retiring_approvals",
  );
  expect(await p.calendar.getLinkedCalendarControl()).toMatchObject({
    paused: true,
  });
  // A separately resolved late request no longer blocks the frozen review.
  await queue.markExpired(late.id, owner);
  state = await admission.retireApprovals(state.operationId, state.revision);
  expect(state.phase).toBe("applying_mappings");
  expect((await queue.byId(old.id, owner))?.state).toBe("expired");
  expect((await queue.byId(legacy.id, owner))?.state).toBe("expired");
  expect((await queue.byId(replacement.id, owner))?.state).toBe("pending");
  expect((await queue.byId(unboundCalendar.id, owner))?.state).toBe("expired");
  expect((await queue.byId(localCalendar.id, owner))?.state).toBe("pending");
});
