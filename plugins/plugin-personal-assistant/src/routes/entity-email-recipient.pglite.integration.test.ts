/**
 * Exercises owner contact creation through registered HTTP routes and the real
 * family email consumer against PGlite, with distinct actor and agent identities.
 * Contacts and co-parent edges must reach the same agent graph; legacy actor
 * records remain preserved and are never implicitly copied across agents.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { FamilyWorkflowRuntimeService } from "../lifeops/family-workflows/runtime.js";

it("makes owner-created contacts available to family email without crossing agent partitions", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  expect(resolveOwnerEntityIdOrDefault(runtime)).not.toBe(runtime.agentId);
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) throw new Error("Knowledge graph did not initialize");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => req.headers.authorization === "Bearer owner-test",
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server did not bind TCP");
    const base = `http://127.0.0.1:${address.port}/api/lifeops`;
    const headers = {
      authorization: "Bearer owner-test",
      "content-type": "application/json",
    };
    const payload = {
      type: "person",
      preferredName: "Synthetic email recipient",
      visibility: "owner_only",
      identities: [
        {
          platform: "email",
          handle: "owner@example.test",
          verified: true,
          confidence: 1,
          addedAt: new Date().toISOString(),
          addedVia: "user_chat",
          evidence: [],
        },
      ],
    };
    const legacyStore = graph.getEntityStore(
      resolveOwnerEntityIdOrDefault(runtime),
    );
    const legacy = await legacyStore.upsert({
      type: "person",
      preferredName: "Legacy owner contact requiring review",
      identities: [],
      tags: [],
      state: {},
      visibility: "owner_only",
    });
    const denied = await fetch(`${base}/entities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(denied.status).toBe(401);
    const created = await fetch(`${base}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(200);
    const saved = (await created.json()).entity;
    const secondResponse = await fetch(`${base}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "person",
        preferredName: "Synthetic co-parent",
        visibility: "owner_only",
      }),
    });
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()).entity;
    const relationshipResponse = await fetch(`${base}/relationships`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fromEntityId: saved.entityId,
        toEntityId: second.entityId,
        type: "co_parent",
        source: "user_chat",
      }),
    });
    expect(relationshipResponse.status).toBe(200);
    const relationship = (await relationshipResponse.json()).relationship;
    expect(
      await graph
        .getRelationshipStore(runtime.agentId)
        .get(relationship.relationshipId),
    ).toMatchObject({
      fromEntityId: saved.entityId,
      toEntityId: second.entityId,
      type: "co_parent",
    });
    expect(
      await graph
        .getRelationshipStore("another-agent")
        .get(relationship.relationshipId),
    ).toBeNull();
    const options = await fetch(`${base}/family-workflows/email-options`, {
      headers,
    });
    expect(options.status).toBe(200);
    expect((await options.json()).options.recipients).toContainEqual({
      entityId: saved.entityId,
      name: payload.preferredName,
      address: "owner@example.test",
    });
    expect(
      await graph.getEntityStore(runtime.agentId).get(saved.entityId),
    ).toMatchObject({
      entityId: saved.entityId,
      preferredName: payload.preferredName,
    });
    expect(
      await graph.getEntityStore("another-agent").get(saved.entityId),
    ).toBeNull();
    await expect(
      new FamilyWorkflowRuntimeService(runtime).validateRecipientIdentity({
        recipientEntityId: saved.entityId,
        recipient: "owner@example.test",
        email: {
          senderGrantId: "unselected-test-grant",
          subject: "Synthetic identity validation only",
        },
      }),
    ).resolves.toBeUndefined();
    expect(await legacyStore.get(legacy.entityId)).toEqual(legacy);
    expect(
      await graph.getEntityStore(runtime.agentId).get(legacy.entityId),
    ).toBeNull();
    const legacyRead = await fetch(`${base}/entities/${legacy.entityId}`, {
      headers,
    });
    expect(legacyRead.status).toBe(404);
    const readDenied = await fetch(`${base}/entities/${saved.entityId}`);
    expect(readDenied.status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
