/** Exercises WhatsApp authentication-scope validation and config-persistence failure handling through the route harness. */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  handleWhatsAppRoute,
  type WhatsAppPairingEventLike,
  type WhatsAppRouteDeps,
  type WhatsAppRouteState,
} from "./whatsapp-routes.js";

function createHarness(path: string) {
  const chunks: string[] = [];
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    end: (body?: string) => {
      if (body) chunks.push(body);
    },
  } as unknown as ServerResponse;
  const req = {
    url: path,
    headers: { host: "localhost" },
  } as IncomingMessage;
  const whatsappAuthExists = vi.fn(() => false);
  const state: WhatsAppRouteState = {
    whatsappPairingSessions: new Map(),
    config: {},
    saveConfig: vi.fn(),
    workspaceDir: "/tmp/whatsapp-auth-scope-test",
  };
  const deps: WhatsAppRouteDeps = {
    sanitizeAccountId: (accountId) => accountId,
    whatsappAuthExists,
    whatsappLogout: vi.fn(async () => undefined),
    createWhatsAppPairingSession: vi.fn(),
  };
  return { req, res, state, deps, chunks, whatsappAuthExists };
}

function createPostHarness(path: string, body: object) {
  const harness = createHarness(path);
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.url = path;
  req.headers = { host: "localhost" };
  return { ...harness, req };
}

function parsed(chunks: string[]): { error?: string; authScope?: string } {
  return JSON.parse(chunks.join("") || "{}") as {
    error?: string;
    authScope?: string;
  };
}

describe("GET /api/whatsapp/status authScope identity", () => {
  it.each(["/api/whatsapp/status", "/api/whatsapp/status?authScope="])(
    "accepts omitted/empty authScope as the platform auth dir",
    async (path) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } = createHarness(path);
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps)
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(parsed(chunks).authScope).toBe("platform");
      expect(whatsappAuthExists).toHaveBeenCalledWith("default");
    }
  );

  it.each(["platform", "lifeops"] as const)(
    "accepts authScope=%s as that auth dir",
    async (token) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } = createHarness(
        `/api/whatsapp/status?authScope=${token}`
      );
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps)
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(200);
      expect(parsed(chunks).authScope).toBe(token);
      expect(whatsappAuthExists).toHaveBeenCalled();
    }
  );

  it.each(["LIFEOPS", "PLATFORM", "1", "0", "true", "TRUE", "foo", "1e2"])(
    "rejects authScope=%s before auth-dir lookup",
    async (token) => {
      const { req, res, state, deps, chunks, whatsappAuthExists } = createHarness(
        `/api/whatsapp/status?authScope=${encodeURIComponent(token)}`
      );
      await expect(
        handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps)
      ).resolves.toBe(true);
      expect(res.statusCode).toBe(400);
      expect(parsed(chunks)).toEqual({ error: "Invalid authScope" });
      expect(whatsappAuthExists).not.toHaveBeenCalled();
    }
  );

  it.each([
    "/api/whatsapp/status?authScope=lifeops&authScope=lifeops",
    "/api/whatsapp/status?authScope=lifeops&authScope=platform",
    "/api/whatsapp/status?authScope=&authScope=lifeops",
    "/api/whatsapp/status?authScope=foo&authScope=lifeops",
  ])("rejects duplicate authScope values in %s", async (path) => {
    const { req, res, state, deps, chunks, whatsappAuthExists } = createHarness(path);
    await expect(
      handleWhatsAppRoute(req, res, "/api/whatsapp/status", "GET", state, deps)
    ).resolves.toBe(true);
    expect(res.statusCode).toBe(400);
    expect(parsed(chunks)).toEqual({ error: "Invalid authScope" });
    expect(whatsappAuthExists).not.toHaveBeenCalled();
  });
});

describe("WhatsApp pairing route teardown ordering", () => {
  it("awaits the replaced session before creating another session for the auth directory", async () => {
    const { req, res, state, deps } = createPostHarness("/api/whatsapp/pair", {
      accountId: "default",
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const oldSession = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => stopGate),
      getStatus: vi.fn(() => "waiting_for_qr"),
    };
    const newSession = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => "initializing"),
    };
    state.whatsappPairingSessions.set("platform:default", oldSession);
    vi.mocked(deps.createWhatsAppPairingSession).mockReturnValue(newSession);

    const handling = handleWhatsAppRoute(req, res, "/api/whatsapp/pair", "POST", state, deps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(oldSession.stop).toHaveBeenCalledTimes(1);
    expect(deps.createWhatsAppPairingSession).not.toHaveBeenCalled();

    releaseStop?.();
    await expect(handling).resolves.toBe(true);
    expect(deps.createWhatsAppPairingSession).toHaveBeenCalledTimes(1);
    expect(newSession.start).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent pair requests that begin without an existing session", async () => {
    const first = createPostHarness("/api/whatsapp/pair", { accountId: "default" });
    const second = createPostHarness("/api/whatsapp/pair", { accountId: "default" });
    let releaseFirstStart: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      releaseFirstStart = resolve;
    });
    const firstSession = {
      start: vi.fn(async () => firstStartGate),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => "initializing"),
    };
    const secondSession = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      getStatus: vi.fn(() => "initializing"),
    };
    vi.mocked(first.deps.createWhatsAppPairingSession)
      .mockReturnValueOnce(firstSession)
      .mockReturnValueOnce(secondSession);

    const firstHandling = handleWhatsAppRoute(
      first.req,
      first.res,
      "/api/whatsapp/pair",
      "POST",
      first.state,
      first.deps
    );
    await vi.waitFor(() => expect(firstSession.start).toHaveBeenCalledTimes(1));
    const secondHandling = handleWhatsAppRoute(
      second.req,
      second.res,
      "/api/whatsapp/pair",
      "POST",
      first.state,
      first.deps
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(first.deps.createWhatsAppPairingSession).toHaveBeenCalledTimes(1);

    releaseFirstStart?.();
    await firstHandling;
    await secondHandling;
    expect(firstSession.stop).toHaveBeenCalledTimes(1);
    expect(first.deps.createWhatsAppPairingSession).toHaveBeenCalledTimes(2);
    expect(secondSession.start).toHaveBeenCalledTimes(1);
  });

  it("awaits pairing teardown before deleting or logging out shared auth state", async () => {
    const { req, res, state, deps } = createPostHarness("/api/whatsapp/disconnect", {
      accountId: "default",
    });
    let releaseStop: (() => void) | undefined;
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const session = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => stopGate),
      getStatus: vi.fn(() => "waiting_for_qr"),
    };
    state.whatsappPairingSessions.set("platform:default", session);

    const handling = handleWhatsAppRoute(req, res, "/api/whatsapp/disconnect", "POST", state, deps);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(deps.whatsappLogout).not.toHaveBeenCalled();

    releaseStop?.();
    await expect(handling).resolves.toBe(true);
    expect(deps.whatsappLogout).toHaveBeenCalledWith("default");
  });
});

describe("WhatsApp route config persistence failures", () => {
  it("disconnect answers 500 and restores the in-memory connector when saveConfig throws", async () => {
    const { req, res, state, deps, chunks } = createPostHarness("/api/whatsapp/disconnect", {
      accountId: "default",
    });
    const connector = { enabled: true, authDir: "/tmp/wa-auth" };
    state.config.connectors = { whatsapp: connector };
    vi.mocked(state.saveConfig).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(
      handleWhatsAppRoute(req, res, "/api/whatsapp/disconnect", "POST", state, deps)
    ).resolves.toBe(true);

    expect(deps.whatsappLogout).toHaveBeenCalledWith("default");
    expect(state.saveConfig).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(500);
    expect(parsed(chunks)).toEqual({
      ok: false,
      error: "Failed to save connector config: EACCES: permission denied",
    });
    expect(state.config.connectors).toEqual({ whatsapp: connector });
  });

  it("pairing connected rolls back the connector and owner contact and broadcasts an error when saveConfig throws", async () => {
    const { req, res, state, deps, chunks } = createPostHarness("/api/whatsapp/pair", {
      accountId: "default",
    });
    const broadcasts: object[] = [];
    state.broadcastWs = (data) => {
      broadcasts.push(data);
    };
    state.config.agents = { defaults: { ownerContacts: { telegram: { channelId: "tg" } } } };
    vi.mocked(state.saveConfig).mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    let onEvent: ((event: WhatsAppPairingEventLike) => void) | undefined;
    vi.mocked(deps.createWhatsAppPairingSession).mockImplementation((options) => {
      onEvent = options.onEvent;
      return {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(() => "waiting_for_qr"),
      };
    });

    await expect(
      handleWhatsAppRoute(req, res, "/api/whatsapp/pair", "POST", state, deps)
    ).resolves.toBe(true);
    expect(res.statusCode).toBe(200);
    expect(parsed(chunks)).toMatchObject({ ok: true, accountId: "default" });

    onEvent?.({
      type: "whatsapp-status",
      accountId: "default",
      status: "connected",
      phoneNumber: "15551234567",
    });

    expect(state.saveConfig).toHaveBeenCalledTimes(1);
    expect(state.config.connectors).toBeUndefined();
    expect(state.config.agents?.defaults?.ownerContacts).toEqual({
      telegram: { channelId: "tg" },
    });
    expect(broadcasts.at(-1)).toEqual({
      type: "whatsapp-status",
      accountId: "default",
      authScope: "platform",
      status: "error",
      error: "Failed to save connector config: ENOSPC: no space left on device",
    });
  });

  it("pairing connected keeps a pre-existing connector and owner contact when saveConfig throws", async () => {
    const { req, res, state, deps } = createPostHarness("/api/whatsapp/pair", {
      accountId: "default",
    });
    const previousConnector = { enabled: false, transport: "baileys" };
    const previousContact = { channelId: "15550000000" };
    state.config.connectors = { whatsapp: previousConnector };
    state.config.agents = { defaults: { ownerContacts: { whatsapp: previousContact } } };
    vi.mocked(state.saveConfig).mockImplementation(() => {
      throw new Error("EACCES");
    });
    let onEvent: ((event: WhatsAppPairingEventLike) => void) | undefined;
    vi.mocked(deps.createWhatsAppPairingSession).mockImplementation((options) => {
      onEvent = options.onEvent;
      return {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getStatus: vi.fn(() => "waiting_for_qr"),
      };
    });

    await handleWhatsAppRoute(req, res, "/api/whatsapp/pair", "POST", state, deps);
    onEvent?.({
      type: "whatsapp-status",
      accountId: "default",
      status: "connected",
      phoneNumber: "15551234567",
    });

    expect(state.config.connectors).toEqual({ whatsapp: previousConnector });
    expect(state.config.agents?.defaults?.ownerContacts?.whatsapp).toBe(previousContact);
  });
});
