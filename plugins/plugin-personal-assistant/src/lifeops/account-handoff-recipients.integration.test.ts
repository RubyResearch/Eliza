/** Real PGlite identity graph and handoff receipts; no connector account is contacted or messaged. */
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { AccountHandoffRecipients } from "./account-handoff-recipients.js";
import { AccountHandoffStore } from "./account-handoff-store.js";

let host: RealTestRuntimeResult;
beforeAll(async () => {
  host = await createLifeOpsTestRuntime();
}, 60_000);
afterAll(async () => {
  await host.cleanup();
});
function graph() {
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture identity service missing");
  return graph.getEntityStore(host.runtime.agentId);
}
async function put(
  entityId: string,
  platform: string,
  handle: string,
  connectorAccountId: string,
  verified = true,
) {
  return graph().upsert({
    entityId,
    type: "person",
    preferredName: entityId,
    identities: [
      {
        platform,
        handle,
        connectorAccountId,
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
  channel: "email" | "imessage" | "telegram" | "discord",
  account: string,
  recipientId: string,
) {
  const f = googleHandoffFixture();
  f.review.messageDestinations = [
    { channel, connectorAccountId: account, recipientId },
  ];
  const store = new AccountHandoffStore(host.runtime, owner);
  const state = await store.review(owner, f.review);
  const service = () => new AccountHandoffRecipients(host.runtime, owner);
  return { state, store, service };
}

describe("reviewed recipient identity binding", () => {
  it("persists the selected entity and refuses a different entity with the same verified address on retry", async () => {
    await put("original-contact", "email", "recipient@example.test", "default");
    const p = await prepared(
      "recipient-owner",
      "email",
      "replacement",
      "RECIPIENT@example.test",
    );
    const captured = await p
      .service()
      .capture(p.state.operationId, p.state.revision, ["original-contact"]);
    await expect(
      p.service().verify(captured.operationId, captured.revision),
    ).resolves.toBeUndefined();
    await put(
      "replacement-contact",
      "email",
      "recipient@example.test",
      "default",
    );
    await expect(
      p
        .service()
        .capture(captured.operationId, captured.revision, [
          "replacement-contact",
        ]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    await put(
      "original-contact",
      "email",
      "recipient@example.test",
      "default",
      false,
    );
    await expect(
      p.service().verify(captured.operationId, captured.revision),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    expect(await p.store.read(captured.operationId)).toEqual(captured);
  });

  it("rejects a Telegram identity established through a different bot account", async () => {
    await put("telegram-contact", "telegram", "12345", "bot-a");
    const p = await prepared("telegram-owner", "telegram", "bot-b", "12345");
    await expect(
      p
        .service()
        .capture(p.state.operationId, p.state.revision, ["telegram-contact"]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    expect(await p.store.read(p.state.operationId)).toEqual(p.state);
    await put("telegram-contact", "telegram", "12345", "bot-b");
    const captured = await p
      .service()
      .capture(p.state.operationId, p.state.revision, ["telegram-contact"]);
    await expect(
      p.service().verify(captured.operationId, captured.revision),
    ).resolves.toBeUndefined();
  });

  it("rejects cross-channel matches and an unverified identity", async () => {
    await put("discord-contact", "telegram", "67890", "default");
    const p = await prepared("discord-owner", "discord", "default", "67890");
    await expect(
      p
        .service()
        .capture(p.state.operationId, p.state.revision, ["discord-contact"]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    await put("discord-contact", "discord", "67890", "default", false);
    await expect(
      p
        .service()
        .capture(p.state.operationId, p.state.revision, ["discord-contact"]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    await put("discord-contact", "discord", "67890", "default");
    const captured = await p
      .service()
      .capture(p.state.operationId, p.state.revision, ["discord-contact"]);
    await expect(
      p.service().verify(captured.operationId, captured.revision),
    ).resolves.toBeUndefined();
  });

  it("preserves owner scope and rejects a stale capture revision", async () => {
    await put("phone-contact", "imessage", "+15555550123", "default");
    const p = await prepared(
      "phone-owner",
      "imessage",
      "default",
      "+15555550123",
    );
    const other = new AccountHandoffRecipients(host.runtime, "another-owner");
    await expect(
      other.capture(p.state.operationId, p.state.revision, ["phone-contact"]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    const captured = await p
      .service()
      .capture(p.state.operationId, p.state.revision, ["phone-contact"]);
    await expect(
      p
        .service()
        .capture(p.state.operationId, p.state.revision, ["phone-contact"]),
    ).rejects.toMatchObject({ code: "ACCOUNT_HANDOFF_RECIPIENT_CHANGED" });
    expect(
      await p
        .service()
        .capture(captured.operationId, captured.revision, ["phone-contact"]),
    ).toEqual(captured);
  });
});
