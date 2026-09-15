/**
 * Deterministic integration coverage for cross-world recent-conversation
 * authorization. The production provider, access-context helper, AgentRuntime,
 * and in-memory adapter execute together; only live membership changes between
 * reads, proving a revoked room is removed before storage disclosure.
 */
import {
  AgentRuntime,
  attestDeliveryAudienceFromCanonicalRoom,
  buildCrossWorldConversationAccessContext,
  ChannelType,
  createCharacter,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  type Memory,
  revalidateOwnerExclusiveDisclosure,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAction } from "../actions/memories.ts";
import { recentConversationsProvider } from "./recent-conversations.ts";

const OWNER = stringToUuid("recent-conversations-access-owner");
const CURRENT_ROOM = stringToUuid("recent-conversations-access-current-room");
const RETAINED_ROOM = stringToUuid("recent-conversations-access-retained-room");
const REVOKED_ROOM = stringToUuid("recent-conversations-access-revoked-room");
const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const activeRuntimes: AgentRuntime[] = [];

afterEach(async () => {
  await Promise.all(
    activeRuntimes.splice(0).map(async (runtime) => {
      await runtime.stop();
      await runtime.close();
    }),
  );
});

async function createRuntime(): Promise<{
  runtime: AgentRuntime;
  adapter: InMemoryDatabaseAdapter;
}> {
  const character = createCharacter({ name: "RecentConversationAccessAgent" });
  const agentId = stringToUuid("recent-conversations-access-agent");
  const adapter = new InMemoryDatabaseAdapter(agentId);
  const runtime = new AgentRuntime({
    character,
    agentId,
    adapter,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  activeRuntimes.push(runtime);
  await runtime.initialize();
  runtime.registerAction(memoryAction);
  runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", OWNER);
  return { runtime, adapter };
}

async function ensureOwnerDm(
  runtime: AgentRuntime,
  roomId: UUID,
  source: string,
): Promise<void> {
  const worldId = stringToUuid(`recent-conversations-world:${source}`);
  await runtime.ensureConnection({
    entityId: OWNER,
    roomId,
    worldId,
    worldName: `${source} world`,
    userName: "owner",
    source,
    channelId: `${source}:${roomId}`,
    type: ChannelType.DM,
  });
  const world = await runtime.getWorld(worldId);
  if (!world) throw new Error(`missing ${source} test world`);
  world.metadata = {
    ...world.metadata,
    ownership: { ownerId: OWNER },
    roles: { ...world.metadata?.roles, [OWNER]: "OWNER" },
    roleSources: { [OWNER]: "manual" },
  };
  await runtime.updateWorld(world);
}

function storedMessage(
  runtime: AgentRuntime,
  roomId: UUID,
  source: string,
  text: string,
  createdAt: number,
): Memory {
  const memory = createMessageMemory({
    id: stringToUuid(`recent-conversations-message:${roomId}`),
    agentId: runtime.agentId,
    entityId: OWNER,
    roomId,
    content: { text, source, channelType: ChannelType.DM },
  });
  memory.createdAt = createdAt;
  memory.metadata = { type: "message", scope: "global" };
  return memory;
}

async function ownerTurn(
  runtime: AgentRuntime,
  sequence: number,
): Promise<Memory> {
  const turn = createMessageMemory({
    id: stringToUuid(`recent-conversations-turn:${sequence}`),
    agentId: runtime.agentId,
    entityId: OWNER,
    roomId: CURRENT_ROOM,
    content: {
      text: "What did I say elsewhere?",
      source: "discord",
      channelType: ChannelType.DM,
    },
  });
  await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);
  return turn;
}

describe("recentConversationsProvider access-context integration", () => {
  it("removes a cross-world room from recall immediately after membership is revoked", async () => {
    const { runtime, adapter } = await createRuntime();
    await ensureOwnerDm(runtime, CURRENT_ROOM, "discord");
    await ensureOwnerDm(runtime, RETAINED_ROOM, "telegram");
    await ensureOwnerDm(runtime, REVOKED_ROOM, "x");

    await runtime.createMemory(
      storedMessage(
        runtime,
        RETAINED_ROOM,
        "telegram",
        "retained cross-world message",
        100,
      ),
      "messages",
    );
    await runtime.createMemory(
      storedMessage(
        runtime,
        REVOKED_ROOM,
        "x",
        "revoked cross-world message",
        200,
      ),
      "messages",
    );

    const storageRead = vi.spyOn(adapter, "getMemoriesByRoomIds");
    const firstTurn = await ownerTurn(runtime, 1);
    expect(
      await revalidateOwnerExclusiveDisclosure(runtime, firstTurn),
    ).toMatchObject({ allowed: true, basis: "owner_private_destination" });
    const firstAccessContext = await buildCrossWorldConversationAccessContext(
      runtime,
      firstTurn,
    );
    expect(firstAccessContext).toMatchObject({
      role: "OWNER",
      isOwner: true,
      authorizedRoomIds: expect.arrayContaining([RETAINED_ROOM, REVOKED_ROOM]),
    });
    storageRead.mockClear();
    const beforeRevocation = await recentConversationsProvider.get(
      runtime,
      firstTurn,
      EMPTY_STATE,
    );

    expect(beforeRevocation.overflowText).toContain(`roomId=${RETAINED_ROOM}`);
    expect(beforeRevocation.overflowText).toContain(`roomId=${REVOKED_ROOM}`);
    expect(beforeRevocation.text).not.toContain("cross-world message");
    expect(beforeRevocation.values?.recentConversationCount).toBe(2);
    expect(storageRead).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roomIds: expect.arrayContaining([RETAINED_ROOM, REVOKED_ROOM]),
        tableName: "messages",
      }),
    );

    await runtime.removeParticipant(OWNER, REVOKED_ROOM);
    const afterRevocation = await recentConversationsProvider.get(
      runtime,
      await ownerTurn(runtime, 2),
      EMPTY_STATE,
    );

    expect(afterRevocation.overflowText).toContain(`roomId=${RETAINED_ROOM}`);
    expect(afterRevocation.overflowText).not.toContain(
      `roomId=${REVOKED_ROOM}`,
    );
    expect(afterRevocation.values?.recentConversationCount).toBe(1);
    expect(storageRead).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roomIds: [RETAINED_ROOM],
        tableName: "messages",
      }),
    );
  });

  it("retrieves every complete stored body and attachment through the manifest's lossless read contract", async () => {
    const { runtime } = await createRuntime();
    await ensureOwnerDm(runtime, CURRENT_ROOM, "discord");
    await ensureOwnerDm(runtime, RETAINED_ROOM, "telegram");
    const first = storedMessage(
      runtime,
      RETAINED_ROOM,
      "telegram",
      "The decision was to bring a violet folder. ".repeat(700),
      100,
    );
    const second = storedMessage(
      runtime,
      RETAINED_ROOM,
      "telegram",
      "The meeting starts at 6:30 PM.",
      200,
    );
    second.id = stringToUuid("recent-conversations-second-record");
    second.content.attachments = [
      {
        id: "receipt",
        filename: "reservation.png",
        mimeType: "image/png",
        description: "Dinner reservation is under Morgan.",
        url: "https://private.example/secret-capability",
      },
    ];
    await runtime.createMemory(first, "messages");
    await runtime.createMemory(second, "messages");
    const turn = await ownerTurn(runtime, 3);
    const manifest = await recentConversationsProvider.get(
      runtime,
      turn,
      EMPTY_STATE,
    );
    expect(manifest.text).toContain(`roomId=${RETAINED_ROOM}`);
    expect(manifest.text).not.toContain("violet folder");
    expect(manifest.text).not.toContain("reservation.png");

    const firstPage = await memoryAction.handler(runtime, turn, EMPTY_STATE, {
      parameters: {
        action: "search",
        type: "messages",
        roomId: RETAINED_ROOM,
        limit: 1,
      },
    });
    if (!firstPage) throw new Error("memory read returned no result");
    expect(firstPage.success).toBe(true);
    expect(firstPage.text).toContain(second.content.text);
    expect(firstPage.text).toContain("Dinner reservation is under Morgan.");
    expect(firstPage.text).not.toContain("secret-capability");
    expect(firstPage.values?.nextOffset).toBe(1);
    const offset = firstPage.values?.nextOffset;
    const snapshot = firstPage.values?.snapshot;
    if (typeof offset !== "number" || typeof snapshot !== "string") {
      throw new Error("memory read must return its continuation contract");
    }
    const finalPage = await memoryAction.handler(runtime, turn, EMPTY_STATE, {
      parameters: {
        action: "search",
        type: "messages",
        roomId: RETAINED_ROOM,
        limit: 1,
        offset,
        snapshot,
      },
    });
    if (!finalPage) throw new Error("memory continuation returned no result");
    expect(finalPage.success).toBe(true);
    expect(finalPage.text).toContain(first.content.text);
    expect(finalPage.values?.nextOffset).toBeNull();
    if (!first.id) throw new Error("stored fixture must have an id");
    expect(await runtime.getMemoryById(first.id)).toMatchObject({
      content: { text: first.content.text },
    });
  });
});
