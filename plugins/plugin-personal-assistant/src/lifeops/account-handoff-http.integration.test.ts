/** Real loopback HTTP, owner gate and PGlite review round-trip; Google discovery is deterministic and no provider mutation or message occurs. */

import { once } from "node:events";
import { ElizaClient } from "@elizaos/ui/api/client-base";
import "../api/client-lifeops.js";
import { createServer, type Server } from "node:http";
import {
  createApprovalQueue,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { getConnectorAccountManager, stringToUuid } from "@elizaos/core";
import { CalendarService } from "@elizaos/plugin-calendar";
import { LinkedCalendarRepository } from "@elizaos/plugin-calendar/service/linked-calendar-sync";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { personalAssistantRoutesPlugin } from "../routes/plugin.js";
import { AccountHandoffStore } from "./account-handoff-store.js";
import { LifeOpsService } from "./service.js";

// The package harness aliases UI modules to inert controls. Restore the real
// client for this transport test; requests still cross the actual HTTP socket.
vi.mock("@elizaos/ui/api/client-base", async () => ({
  ...(await vi.importActual<typeof import("../../test/stubs/ui.js")>(
    "../../test/stubs/ui.js",
  )),
  ...(await import("../../../../packages/ui/src/api/client-base.js")),
}));

let host: RealTestRuntimeResult;
let server: Server;
let baseUrl: string;
const owner = stringToUuid("handoff-http-owner");
const otherOwner = stringToUuid("handoff-http-other-owner");
const token = "synthetic-handoff-http-owner-token";
const serverErrors: Error[] = [];
const choices = {
  operationId: "http-review",
  previousGrantId: "connector-account:http-old",
  replacementGrantId: "connector-account:http-new",
  readCalendarIds: ["reviewed-calendar"],
  writeCalendarId: null,
  calendarLinks: [],
  messageDestinations: [
    {
      channel: "email" as const,
      connectorAccountId: "http-new",
      recipientId: "recipient@example.test",
      recipientEntityId: owner,
    },
  ],
  importedData: "retain" as const,
  retireApprovalIds: [],
};

beforeAll(async () => {
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  host = await createLifeOpsTestRuntime();
  host.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
  await host.runtime.registerService(GoogleWorkspaceTestService);
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, {
    listCalendars: async () => [googleHandoffFixture().entry],
  });
  const manager = getConnectorAccountManager(host.runtime);
  manager.registerProvider({ provider: "google" });
  for (const id of ["http-old", "http-new"]) {
    const saved = await manager.upsertAccount("google", {
      id,
      provider: "google",
      role: "OWNER",
      purpose: ["reading"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: `${id}@example.test`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    });
    if (id === "http-old")
      choices.previousGrantId = `connector-account:${saved.id}`;
    else {
      choices.replacementGrantId = `connector-account:${saved.id}`;
      const destination = choices.messageDestinations[0];
      if (!destination) throw new Error("Fixture recipient missing");
      destination.connectorAccountId = saved.id;
    }
  }
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture graph missing");
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
        evidence: ["Synthetic confirmation"],
      },
    ],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const path =
      pathname === "/api/lifeops/account-handoffs" ||
      pathname.endsWith("/active") ||
      pathname.endsWith("/retirement-candidates") ||
      pathname.endsWith("/calendar-entries")
        ? pathname
        : pathname.endsWith("/cancel")
          ? "/api/lifeops/account-handoffs/:operationId/cancel"
          : "/api/lifeops/account-handoffs/:operationId";
    const route = personalAssistantRoutesPlugin.routes?.find(
      (item) => item.type === req.method && item.path === path,
    );
    if (!route?.handler) {
      res.writeHead(404).end();
      return;
    }
    Promise.resolve(
      route.handler(req as never, res as never, host.runtime as never),
    ).catch((error) => {
      // error-policy:J1 Test HTTP boundary records unexpected failures before closing the response.
      serverErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
      res.writeHead(500).end("Unexpected test server failure");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server address missing");
  baseUrl = `http://127.0.0.1:${address.port}/api/lifeops/account-handoffs`;
}, 60_000);
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (host) await host.cleanup();
  vi.unstubAllEnvs();
});

it("rejects unauthenticated requests and malformed approval IDs before a saved review exists", async () => {
  const denied = await fetch(`${baseUrl}/active`, {
    headers: { "x-eliza-entity-id": owner },
  });
  expect(denied.status).toBe(401);
  const invalid = await fetch(baseUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...choices, retireApprovalIds: ["invalid-id"] }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: "ACCOUNT_HANDOFF_INVALID_REVIEW",
  });
  expect(
    await new AccountHandoffStore(host.runtime, owner).active(),
  ).toBeNull();
});

it("creates and replays a review through canonical services and ignores forged owner headers during readback", async () => {
  const client = new ElizaClient(new URL(baseUrl).origin, token);
  const payload = await client.createLifeOpsAccountHandoff(choices);
  expect(payload.handoff.review.replacement.email).toBe(
    "http-new@example.test",
  );
  expect(payload.handoff.phase).toBe("reviewed");
  expect(await client.createLifeOpsAccountHandoff(choices)).toEqual(payload);
  expect(await client.getActiveLifeOpsAccountHandoff()).toEqual(payload);
  expect(await client.getLifeOpsAccountHandoff(choices.operationId)).toEqual(
    payload,
  );
  const active = await fetch(`${baseUrl}/active`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-eliza-entity-id": otherOwner,
    },
  });
  expect(active.status).toBe(200);
  expect(await active.json()).toEqual(payload);
  const read = await fetch(`${baseUrl}/http-review`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await read.json()).toEqual(payload);
  expect(
    await new AccountHandoffStore(host.runtime, otherOwner).read("http-review"),
  ).toBeNull();
  expect(serverErrors).toEqual([]);
});

it("cancels only an unchanged unstarted review and permits replay without another transition", async () => {
  const store = new AccountHandoffStore(host.runtime, owner);
  const review = await store.read("http-review");
  if (!review) throw new Error("Fixture review missing");
  const cancel = (expectedRevision: number) =>
    fetch(`${baseUrl}/http-review/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision }),
    });
  expect((await cancel(review.revision - 1)).status).toBe(409);
  expect(await store.read(review.operationId)).toEqual(review);
  const client = new ElizaClient(new URL(baseUrl).origin, token);
  const cancelled = await client.cancelLifeOpsAccountHandoff(
    review.operationId,
    review.revision,
  );
  expect(cancelled.handoff.phase).toBe("cancelled");
  expect(await store.active()).toBeNull();
  expect(await (await cancel(review.revision)).json()).toEqual(cancelled);
  const next = await store.review("http-started", review.review);
  const started = await store.advance({
    operationId: next.operationId,
    expectedRevision: next.revision,
    expectedPhase: "reviewed",
    phase: "pausing",
    receipt: {},
  });
  const refused = await fetch(`${baseUrl}/http-started/cancel`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: started.revision }),
  });
  expect(refused.status).toBe(409);
  expect(await store.read(started.operationId)).toEqual(started);
  expect(serverErrors).toEqual([]);
});

it("returns exact owner retirement candidates through the app client and denies foreign, unknown-account and unauthenticated reads", async () => {
  const queue = createApprovalQueue(host.runtime, {
    agentId: host.runtime.agentId,
  });
  const enqueue = (subjectUserId: string, grantId: string) =>
    queue.enqueue({
      requestedBy: subjectUserId,
      subjectUserId,
      action: "send_email",
      payload: {
        action: "send_email",
        grantId,
        to: ["synthetic@example.test"],
        cc: [],
        bcc: [],
        subject: "École 📅 reviewed mail",
        body: "Exact synthetic content for owner review.",
        threadId: null,
      },
      channel: "email",
      reason: "Synthetic candidate inventory",
      expiresAt: new Date(Date.now() + 600_000),
    });
  const old = await enqueue(owner, choices.previousGrantId);
  await enqueue("foreign-candidate-owner", choices.previousGrantId);
  await enqueue(owner, choices.replacementGrantId);
  const client = new ElizaClient(new URL(baseUrl).origin, token);
  const result = await client.getLifeOpsHandoffRetirementCandidates(
    choices.previousGrantId,
  );
  expect(result.candidates.map((candidate) => candidate.id)).toEqual([old.id]);
  expect(result.candidates[0]?.payload).toEqual(old.payload);
  expect((await queue.byId(old.id, owner))?.state).toBe("pending");
  const denied = await fetch(
    `${baseUrl}/retirement-candidates?${new URLSearchParams({ previousGrantId: choices.previousGrantId })}`,
    {
      headers: { "x-eliza-entity-id": owner },
    },
  );
  expect(denied.status).toBe(401);
  const unknown = await fetch(
    `${baseUrl}/retirement-candidates?previousGrantId=unavailable`,
    {
      headers: { authorization: `Bearer ${token}` },
    },
  );
  expect(unknown.status).toBe(409);
  expect(await unknown.json()).toMatchObject({
    code: "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
  });
  const malformed = await fetch(`${baseUrl}/retirement-candidates`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(malformed.status).toBe(400);
  expect(serverErrors).toEqual([]);
});

it("returns the selected account's real event details and explicit missing-event state through the client", async () => {
  const calendar = await host.runtime.getServiceLoadPromise(
    CalendarService.serviceType,
  );
  if (!(calendar instanceof CalendarService))
    throw new Error("Fixture calendar unavailable");
  const accounts = await new LifeOpsService(host.runtime, {
    ownerEntityId: owner,
  }).getGoogleConnectorAccounts(new URL(baseUrl), "owner");
  const previousId = accounts.find(
    (account) => account.grant?.id === choices.previousGrantId,
  )?.grant?.connectorAccountId;
  const replacementId = accounts.find(
    (account) => account.grant?.id === choices.replacementGrantId,
  )?.grant?.connectorAccountId;
  if (!previousId || !replacementId)
    throw new Error("Fixture account identity unavailable");
  const created = await calendar.createCalendarEventMutation(new URL(baseUrl), {
    calendarId: "primary",
    title: "Synthetic school pickup",
    description: "Owner review details",
    startAt: "2026-10-01T19:00:00.000Z",
    endAt: "2026-10-01T19:30:00.000Z",
    timeZone: "America/New_York",
    idempotencyKey: "handoff-calendar-inventory-event",
  });
  if (!created.event) throw new Error("Fixture event not persisted");
  const links = new LinkedCalendarRepository(host.runtime);
  const mapped = await links.create({
    agentId: host.runtime.agentId,
    localEventId: created.event.id,
    connectorAccountId: previousId,
    providerCalendarId: "old-family",
    localRevision: 1,
  });
  const missing = await links.create({
    agentId: host.runtime.agentId,
    localEventId: "missing-local-event",
    connectorAccountId: previousId,
    providerCalendarId: "old-family",
    localRevision: 1,
  });
  const foreign = await links.create({
    agentId: host.runtime.agentId,
    localEventId: "unrelated-local-event",
    connectorAccountId: replacementId,
    providerCalendarId: "new-family",
    localRevision: 1,
  });
  const client = new ElizaClient(new URL(baseUrl).origin, token);
  const result = await client.getLifeOpsHandoffCalendarEntries(
    choices.previousGrantId,
  );
  expect(
    result.entries.find((entry) => entry.link.id === mapped.id)?.event,
  ).toMatchObject({
    id: created.event.id,
    title: "Synthetic school pickup",
    startAt: "2026-10-01T19:00:00.000Z",
    description: "Owner review details",
  });
  expect(
    result.entries.find((entry) => entry.link.id === missing.id)?.event,
  ).toBeNull();
  expect(result.entries.some((entry) => entry.link.id === foreign.id)).toBe(
    false,
  );
  const denied = await fetch(
    `${baseUrl}/calendar-entries?${new URLSearchParams({ previousGrantId: choices.previousGrantId })}`,
  );
  expect(denied.status).toBe(401);
  const unknown = await fetch(
    `${baseUrl}/calendar-entries?previousGrantId=unavailable`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(unknown.status).toBe(409);
  await links.markLocalDirty({
    agentId: host.runtime.agentId,
    localEventId: created.event.id,
    localRevision: 2,
  });
  const staleReview = await fetch(baseUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...choices,
      operationId: "stale-calendar-review",
      calendarLinks: result.entries.map(({ link }) => ({
        linkId: link.id,
        expectedLocalRevision: link.localRevision,
        expectedUpdatedAt: link.updatedAt,
        disposition: "retain_local",
      })),
    }),
  });
  expect(staleReview.status).toBe(409);
  expect(JSON.stringify(await staleReview.json())).toContain(
    "ACCOUNT_HANDOFF_GOOGLE_REVIEW_CHANGED",
  );
  expect(
    await new AccountHandoffStore(host.runtime, owner).read(
      "stale-calendar-review",
    ),
  ).toBeNull();
  expect(await calendar.getCalendarEventById(created.event.id)).toEqual(
    created.event,
  );
});
