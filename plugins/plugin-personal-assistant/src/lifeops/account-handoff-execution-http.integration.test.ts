/** Real loopback HTTP and PGlite execute the saved Google account switch; provider probes are deterministic and no external message or account mutation occurs. */

import { once } from "node:events";
import { ElizaClient } from "@elizaos/ui/api/client-base";
import "../api/client-lifeops.js";
import { createServer, type Server } from "node:http";
import {
  ApprovalDispatchControlStore,
  resolveKnowledgeGraphService,
} from "@elizaos/agent";
import { getConnectorAccountManager, stringToUuid } from "@elizaos/core";
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
          "https://www.googleapis.com/auth/gmail.readonly",
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
      pathname.endsWith("/retirement-candidates")
        ? pathname
        : pathname.endsWith("/cancel")
          ? "/api/lifeops/account-handoffs/:operationId/cancel"
          : pathname.endsWith("/advance")
            ? "/api/lifeops/account-handoffs/:operationId/advance"
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

it("advances the saved Google review over authenticated HTTP and recovers provider failure without dropping the old account", async () => {
  host.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", otherOwner);
  const service = new LifeOpsService(host.runtime, {
    ownerEntityId: otherOwner,
  });
  const provider = await host.runtime.getServiceLoadPromise("google");
  let failProbe = true;
  const probedAccounts: string[] = [];
  Object.assign(provider, {
    getGmailHistoryId: async ({ accountId }: { accountId: string }) => {
      probedAccounts.push(accountId);
      if (failProbe) throw new Error("Synthetic provider outage");
      return "synthetic-history-id";
    },
  });
  try {
    const client = new ElizaClient(new URL(baseUrl).origin, token);
    let { handoff } = await client.createLifeOpsAccountHandoff({
      ...choices,
      operationId: "http-execution",
    });
    const denied = await fetch(`${baseUrl}/${handoff.operationId}/advance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: handoff.revision }),
    });
    expect(denied.status).toBe(401);
    const forged = await fetch(`${baseUrl}/${handoff.operationId}/advance`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: handoff.revision,
        replacementGrantId: "forged",
      }),
    });
    expect(forged.status).toBe(400);
    expect(
      (await client.getLifeOpsAccountHandoff(handoff.operationId)).handoff,
    ).toEqual(handoff);
    const initialRevision = handoff.revision;
    const beforeControls = await new ApprovalDispatchControlStore(
      host.runtime,
    ).read(otherOwner);
    const manager = getConnectorAccountManager(host.runtime);
    const replacement = await manager.getAccount(
      "google",
      choices.messageDestinations[0].connectorAccountId,
    );
    if (!replacement) throw new Error("Replacement fixture missing");
    await manager.upsertAccount("google", {
      ...replacement,
      metadata: {
        ...replacement.metadata,
        grantedScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    });
    try {
      await expect(
        client.advanceLifeOpsAccountHandoff(
          handoff.operationId,
          handoff.revision,
        ),
      ).rejects.toThrow("Gmail reading");
      expect(probedAccounts).toEqual([]);
      expect(
        (await client.getLifeOpsAccountHandoff(handoff.operationId)).handoff,
      ).toEqual(handoff);
      expect(
        await new ApprovalDispatchControlStore(host.runtime).read(otherOwner),
      ).toEqual(beforeControls);
    } finally {
      await manager.upsertAccount("google", replacement);
    }
    await expect(
      client.advanceLifeOpsAccountHandoff(
        handoff.operationId,
        handoff.revision,
      ),
    ).rejects.toThrow();
    expect(
      (await client.getLifeOpsAccountHandoff(handoff.operationId)).handoff,
    ).toEqual(handoff);
    expect(
      await new ApprovalDispatchControlStore(host.runtime).read(otherOwner),
    ).toEqual(beforeControls);
    expect(
      (
        await service.getGoogleConnectorAccounts(new URL(baseUrl), "owner")
      ).some((account) => account.grant?.id === choices.previousGrantId),
    ).toBe(true);
    failProbe = false;
    const observedPhases = new Set([handoff.phase]);
    const simultaneous = await Promise.allSettled([
      client.advanceLifeOpsAccountHandoff(
        handoff.operationId,
        handoff.revision,
      ),
      new ElizaClient(
        new URL(baseUrl).origin,
        token,
      ).advanceLifeOpsAccountHandoff(handoff.operationId, handoff.revision),
    ]);
    expect(
      simultaneous.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      simultaneous.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    handoff = (await client.getLifeOpsAccountHandoff(handoff.operationId))
      .handoff;
    expect(handoff.phase).toBe("pausing");
    // A later outage still blocks the fresh verification after admission pauses.
    failProbe = true;
    observedPhases.add(handoff.phase);
    let recoveredOutage = false;
    for (
      let checkpoint = 0;
      checkpoint < 30 && handoff.phase !== "completed";
      checkpoint++
    ) {
      const reopened = new ElizaClient(new URL(baseUrl).origin, token);
      const saved = await reopened.getLifeOpsAccountHandoff(
        handoff.operationId,
      );
      expect(saved.handoff).toEqual(handoff);
      try {
        const next = await reopened.advanceLifeOpsAccountHandoff(
          handoff.operationId,
          handoff.revision,
        );
        expect(next.handoff.revision).toBeGreaterThan(handoff.revision);
        handoff = next.handoff;
        observedPhases.add(handoff.phase);
      } catch (error) {
        // error-policy:J1 The HTTP test observes a deliberate provider failure and verifies persistent recovery state.
        if (!failProbe || handoff.phase !== "verifying_replacement")
          throw error;
        expect(probedAccounts.length).toBeGreaterThan(0);
        expect(
          (await reopened.getLifeOpsAccountHandoff(handoff.operationId))
            .handoff,
        ).toEqual(handoff);
        expect(
          (
            await service.getGoogleConnectorAccounts(new URL(baseUrl), "owner")
          ).some((account) => account.grant?.id === choices.previousGrantId),
        ).toBe(true);
        expect(
          (
            await new ApprovalDispatchControlStore(host.runtime).read(
              otherOwner,
            )
          ).paused,
        ).toBe(true);
        failProbe = false;
        recoveredOutage = true;
      }
    }
    expect(recoveredOutage).toBe(true);
    expect(handoff.phase).toBe("completed");
    expect(observedPhases.has("disconnecting_previous")).toBe(true);
    expect(
      (await service.getGoogleConnectorAccounts(new URL(baseUrl), "owner")).map(
        (account) => account.grant?.id,
      ),
    ).toEqual([choices.replacementGrantId]);
    expect(
      (await new ApprovalDispatchControlStore(host.runtime).read(otherOwner))
        .paused,
    ).toBe(false);
    expect(
      probedAccounts.every(
        (account) =>
          account === choices.messageDestinations[0].connectorAccountId,
      ),
    ).toBe(true);
    expect(
      await client.advanceLifeOpsAccountHandoff(
        handoff.operationId,
        handoff.revision,
      ),
    ).toEqual({ handoff });
    const stale = await fetch(`${baseUrl}/${handoff.operationId}/advance`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: initialRevision }),
    });
    expect(stale.status).toBe(409);
    expect(
      (await client.getLifeOpsAccountHandoff(handoff.operationId)).handoff,
    ).toEqual(handoff);
    expect(
      await new AccountHandoffStore(host.runtime, otherOwner).active(),
    ).toBeNull();
    expect(serverErrors).toEqual([]);
  } finally {
    host.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
  }
}, 60_000);

it("does not pause or disconnect when a saved switch includes an unverified messaging channel", async () => {
  const prior = await new AccountHandoffStore(host.runtime, otherOwner).read(
    "http-execution",
  );
  if (!prior) throw new Error("Completed fixture review missing");
  const store = new AccountHandoffStore(host.runtime, owner);
  const saved = await store.review("channel-verification-required", {
    ...prior.review,
    messageDestinations: [
      {
        channel: "telegram",
        connectorAccountId: "synthetic-telegram",
        recipientId: "synthetic-chat",
      },
    ],
  });
  const controls = new ApprovalDispatchControlStore(host.runtime);
  const before = await controls.read(owner);
  const accounts = new LifeOpsService(host.runtime, { ownerEntityId: owner });
  const beforeAccounts = await accounts.getGoogleConnectorAccounts(
    new URL(baseUrl),
    "owner",
  );
  const response = await fetch(`${baseUrl}/${saved.operationId}/advance`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: saved.revision }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "ACCOUNT_HANDOFF_CHANNEL_VERIFICATION_REQUIRED",
  });
  expect(await store.read(saved.operationId)).toEqual(saved);
  expect(await controls.read(owner)).toEqual(before);
  expect(
    await accounts.getGoogleConnectorAccounts(new URL(baseUrl), "owner"),
  ).toEqual(beforeAccounts);
});
