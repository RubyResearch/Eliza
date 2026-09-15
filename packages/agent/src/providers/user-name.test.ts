/**
 * Unit coverage for createUserNameProvider: registration metadata, app-chat
 * source gating (empty context for Telegram/Discord/missing source so the
 * display name never leaks into other connectors), stored-name interpolation,
 * and the admin fallback when no preferred name is configured. The provider
 * is real; only fetchConfiguredOwnerName is stubbed at its service boundary.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ownerNameMock = vi.hoisted(() => ({
  fetchConfiguredOwnerName: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../services/owner-name.ts", () => ownerNameMock);

import { createUserNameProvider } from "./user-name.ts";

const EMPTY_STATE: State = { values: {}, data: {}, text: "" };
const AGENT_ID = "00000000-0000-4000-8000-0000000000aa" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-0000000000bb" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000cc" as UUID;
const MESSAGE_ID = "00000000-0000-4000-8000-0000000000dd" as UUID;

const FALLBACK_TEXT =
  "App display name unset (fallback: admin). SETTINGS op=set_owner_name stores an explicitly requested display name.";

function makeRuntime(): IAgentRuntime {
  return { agentId: AGENT_ID } as IAgentRuntime;
}

function makeMessage(content: Record<string, unknown> | undefined): Memory {
  return {
    id: MESSAGE_ID,
    agentId: AGENT_ID,
    entityId: ENTITY_ID,
    roomId: ROOM_ID,
    content: content as Memory["content"],
  } as Memory;
}

beforeEach(() => {
  ownerNameMock.fetchConfiguredOwnerName.mockReset();
});

describe("createUserNameProvider metadata", () => {
  it("registers as a dynamic turn-scoped OWNER-gated general provider", () => {
    const provider = createUserNameProvider();
    expect(provider.name).toBe("userName");
    expect(provider.description).toBe(
      "Injects the app user's display name into context (app chat only).",
    );
    expect(provider.descriptionCompressed).toBe(
      "inject app user display name context (app chat)",
    );
    expect(provider.position).toBe(10);
    expect(provider.dynamic).toBe(true);
    expect(provider.contexts).toEqual(["general"]);
    expect(provider.contextGate).toEqual({ anyOf: ["general"] });
    expect(provider.cacheStable).toBe(false);
    expect(provider.cacheScope).toBe("turn");
    expect(provider.roleGate).toEqual({ minRole: "OWNER" });
  });
});

describe("createUserNameProvider source gating", () => {
  it("returns empty text for telegram so the name never leaks into connectors", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Alice");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({ text: "hello", source: "telegram" }),
      EMPTY_STATE,
    );
    expect(result).toEqual({ text: "" });
    expect(ownerNameMock.fetchConfiguredOwnerName).not.toHaveBeenCalled();
  });

  it("returns empty text for discord", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Alice");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({ text: "hello", source: "discord" }),
      EMPTY_STATE,
    );
    expect(result).toEqual({ text: "" });
    expect(ownerNameMock.fetchConfiguredOwnerName).not.toHaveBeenCalled();
  });

  it("returns empty text when content.source is missing", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Alice");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({ text: "hello" }),
      EMPTY_STATE,
    );
    expect(result).toEqual({ text: "" });
    expect(ownerNameMock.fetchConfiguredOwnerName).not.toHaveBeenCalled();
  });

  it("returns empty text when message.content is undefined", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Alice");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage(undefined),
      EMPTY_STATE,
    );
    expect(result).toEqual({ text: "" });
    expect(ownerNameMock.fetchConfiguredOwnerName).not.toHaveBeenCalled();
  });

  it("returns empty text for the hyphenated client-chat lookalike", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Alice");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({ text: "hello", source: "client-chat" }),
      EMPTY_STATE,
    );
    expect(MESSAGE_SOURCE_CLIENT_CHAT).toBe("client_chat");
    expect(result).toEqual({ text: "" });
    expect(ownerNameMock.fetchConfiguredOwnerName).not.toHaveBeenCalled();
  });
});

describe("createUserNameProvider app chat", () => {
  it("interpolates the stored owner name into prompt text and values", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("Ada Lovelace");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({
        text: "hello",
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      }),
      EMPTY_STATE,
    );
    expect(result).toEqual({
      text: "Configured app display name: Ada Lovelace. Entity aliases may include earlier names; follow explicit conversational corrections.",
      values: { userName: "Ada Lovelace" },
    });
    expect(result.values).not.toHaveProperty("userNameFallback");
    expect(ownerNameMock.fetchConfiguredOwnerName).toHaveBeenCalledTimes(1);
  });

  it("interpolates a name with punctuation and spaces literally", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("O'Brien, Jr.");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({
        text: "hello",
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      }),
      EMPTY_STATE,
    );
    expect(result.text).toBe(
      "Configured app display name: O'Brien, Jr.. Entity aliases may include earlier names; follow explicit conversational corrections.",
    );
    expect(result.values).toEqual({ userName: "O'Brien, Jr." });
  });

  it("falls back to admin when no preferred name is stored", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue(null);
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({
        text: "hello",
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      }),
      EMPTY_STATE,
    );
    expect(result).toEqual({
      text: FALLBACK_TEXT,
      values: { userName: "admin", userNameFallback: true },
    });
    expect(ownerNameMock.fetchConfiguredOwnerName).toHaveBeenCalledTimes(1);
  });

  it("falls back to admin when the stored name is an empty string", async () => {
    ownerNameMock.fetchConfiguredOwnerName.mockResolvedValue("");
    const result = await createUserNameProvider().get(
      makeRuntime(),
      makeMessage({
        text: "hello",
        source: MESSAGE_SOURCE_CLIENT_CHAT,
      }),
      EMPTY_STATE,
    );
    expect(result.text).toBe(FALLBACK_TEXT);
    expect(result.values).toEqual({
      userName: "admin",
      userNameFallback: true,
    });
  });
});
