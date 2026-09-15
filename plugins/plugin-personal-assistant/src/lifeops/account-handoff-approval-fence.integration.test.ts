/** Exercises durable account retirement through the real approval queue and PGlite migrations; no provider calls occur. */

import type { ApprovalEnqueueInput, ApprovalPayload } from "@elizaos/agent";
import {
  ApprovalDispatchControlStore,
  createApprovalQueue,
} from "@elizaos/agent";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { executeRawSql, sqlText } from "./sql.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});

function email(owner: string, grantId?: string): ApprovalEnqueueInput {
  return {
    requestedBy: owner,
    subjectUserId: owner,
    action: "send_email",
    channel: "email",
    reason: "Synthetic reviewed sender",
    expiresAt: new Date(Date.now() + 86_400_000),
    payload: {
      action: "send_email",
      to: ["self@example.test"],
      cc: [],
      bcc: [],
      subject: "Synthetic handoff",
      body: "No provider dispatch",
      threadId: null,
      replyToMessageId: null,
      ...(grantId ? { grantId } : {}),
    },
  };
}

it("fences old and legacy approvals while allowing fresh reviewed approvals after reconnect", async () => {
  const owner = "fenced-owner";
  const queue = createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  });
  const controls = new ApprovalDispatchControlStore(host.runtime);
  const old = await queue.enqueue(email(owner, "retiring-grant"));
  const legacy = await queue.enqueue(email(owner));
  const migrated = await queue.enqueue(email(owner, "retiring-grant"));
  await executeRawSql(
    host.runtime,
    `UPDATE approval_requests SET admission_revision = NULL WHERE id = ${sqlText(migrated.id)}`,
  );
  for (const request of [old, legacy, migrated]) {
    await queue.approve(request.id, owner, {
      resolvedBy: owner,
      resolutionReason: "Synthetic review",
    });
  }
  const paused = await controls.pause({
    subjectUserId: owner,
    operationId: "switch",
    expectedRevision: 0,
  });
  const fence = {
    subjectUserId: owner,
    operationId: "switch",
    expectedRevision: paused.revision,
    grantId: "retiring-grant",
  };
  await controls.fenceGoogleAccount(fence);
  await new ApprovalDispatchControlStore(host.runtime).fenceGoogleAccount(
    fence,
  );
  for (const input of [email(owner), email(owner, "retiring-grant")]) {
    await expect(queue.enqueue(input)).rejects.toMatchObject({
      code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED",
    });
  }
  const unrelated = await queue.enqueue(email(owner, "unrelated-grant"));
  const otherOwner = await queue.enqueue(email("unaffected-owner"));
  expect(otherOwner.state).toBe("pending");
  await controls.resume({
    subjectUserId: owner,
    operationId: "switch",
    expectedRevision: paused.revision,
  });
  for (const request of [old, legacy, migrated]) {
    await expect(
      queue.claimExecution({
        requestId: request.id,
        subjectUserId: owner,
        provider: "gmail",
        providerIdempotencyKey: request.id,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED" });
    expect((await queue.byId(request.id, owner))?.state).toBe("approved");
  }
  await expect(queue.enqueue(email(owner))).rejects.toMatchObject({
    code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED",
  });
  const fresh = await queue.enqueue(email(owner, "retiring-grant"));
  for (const request of [fresh, unrelated]) {
    await queue.approve(request.id, owner, {
      resolvedBy: owner,
      resolutionReason: "Synthetic exact sender review",
    });
    expect(
      (
        await queue.claimExecution({
          requestId: request.id,
          subjectUserId: owner,
          provider: "gmail",
          providerIdempotencyKey: request.id,
        })
      ).state,
    ).toBe("executing");
  }
});

it("requires account review for Google calendar mutations while preserving local and other-provider work", async () => {
  const owner = "calendar-fenced-owner";
  const queue = createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  });
  const controls = new ApprovalDispatchControlStore(host.runtime);
  const paused = await controls.pause({
    subjectUserId: owner,
    operationId: "calendar-switch",
    expectedRevision: 0,
  });
  await controls.fenceGoogleAccount({
    subjectUserId: owner,
    operationId: "calendar-switch",
    expectedRevision: paused.revision,
    grantId: "old-calendar-grant",
  });
  const blocked: ApprovalPayload[] = [
    {
      action: "schedule_event",
      calendarId: "family",
      title: "Synthetic event",
      startsAtMs: 1_800_000_000_000,
      endsAtMs: 1_800_003_600_000,
      attendees: [],
      location: null,
      description: null,
    },
    {
      action: "modify_event",
      calendarId: "family",
      eventId: "synthetic",
      expectedProvider: "google",
      patch: {
        title: "Synthetic change",
        startsAtMs: null,
        endsAtMs: null,
        attendees: null,
        location: null,
        description: null,
      },
    },
    {
      action: "cancel_event",
      calendarId: "family",
      eventId: "synthetic",
      notifyAttendees: false,
      grantId: "old-calendar-grant",
    },
  ];
  for (const payload of blocked) {
    await expect(
      queue.enqueue({
        ...email(owner),
        action: payload.action,
        channel: "google_calendar",
        payload,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_ACCOUNT_REVIEW_REQUIRED" });
  }
  const local: ApprovalPayload = {
    action: "cancel_event",
    calendarId: "local",
    eventId: "synthetic",
    notifyAttendees: false,
    side: "agent",
  };
  const microsoft: ApprovalPayload = {
    action: "cancel_event",
    calendarId: "work",
    eventId: "synthetic",
    notifyAttendees: false,
    expectedProvider: "microsoft",
  };
  for (const payload of [local, microsoft]) {
    const request = await queue.enqueue({
      ...email(owner),
      action: payload.action,
      channel: "internal",
      payload,
    });
    await queue.approve(request.id, owner, {
      resolvedBy: owner,
      resolutionReason: "Synthetic unaffected calendar",
    });
  }
  await expect(
    controls.fenceGoogleAccount({
      subjectUserId: owner,
      operationId: "different-operation",
      expectedRevision: paused.revision,
      grantId: "unrelated-grant",
    }),
  ).rejects.toMatchObject({ code: "APPROVAL_DISPATCH_CONTROL_CONFLICT" });
  await controls.resume({
    subjectUserId: owner,
    operationId: "calendar-switch",
    expectedRevision: paused.revision,
  });
  for (const request of await queue.list({
    subjectUserId: owner,
    state: "approved",
    action: null,
  })) {
    expect(
      (
        await queue.claimExecution({
          requestId: request.id,
          subjectUserId: owner,
          provider: "calendar",
          providerIdempotencyKey: request.id,
        })
      ).state,
    ).toBe("executing");
  }
});
