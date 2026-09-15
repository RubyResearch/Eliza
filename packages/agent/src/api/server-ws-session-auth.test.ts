/**
 * Real-server contract for WebSocket session-bearer authentication (#13985).
 *
 * Device pairing mints a revocable machine-session id as the client's bearer —
 * never the static connection key — so both WebSocket auth paths must accept a
 * live session id through the same host-bridge seam REST uses
 * (`resolveSessionTokenAuthorization` → app-core `resolveSessionTokenRole` →
 * `findActiveSession`), while staying fail-closed for everything else:
 *
 *  - in-band `{type:"auth", token:<session-id>}` → `auth-ok`;
 *  - handshake `Authorization: Bearer <session-id>` → socket opens authenticated;
 *  - the static API token keeps working on both paths;
 *  - unknown/expired/revoked sessions, non-auth pre-auth frames, and a host
 *    without the bridge method all still reject (1008 in-band, 401 handshake).
 *
 * Harness: real HTTP server + real `ws` clients over loopback with an API
 * token configured and strict local auth enabled, so loopback exercises the
 * credential boundary instead of trusted same-machine access. The host
 * bridge is substituted at its documented injection seam
 * (`setAgentHostBridge`) with a session resolver that recognizes one active
 * session id — the session-store internals themselves are app-core's contract
 * and are covered by app-core's auth tests.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { startApiServer } from "./server.ts";
import {
  __resetPendingWebSocketsForTests,
  MAX_PENDING_WEBSOCKETS_PER_PEER,
  pendingWebSocketCount,
} from "./server-helpers-auth.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "ws-session-auth-test-api-token";
const ACTIVE_SESSION_ID = "11111111-2222-4333-8444-555555555555";
const REVOKED_SESSION_ID = "99999999-8888-4777-8666-555555555555";

const touchedEnv = [
  "ELIZA_ALLOW_WS_QUERY_TOKEN",
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
] as const;

const originalEnv = new Map<string, string | undefined>();

function snapshotEnvironment(): void {
  originalEnv.clear();
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
}

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

let stateDir: string | null = null;
let api: ApiServer | null = null;

/** Host bridge whose session resolver models the real fail-closed contract. */
function installSessionBridge(): void {
  setAgentHostBridge({
    ...defaultAgentHostBridge,
    resolveSessionTokenAuthorization: async (token) =>
      token === ACTIVE_SESSION_ID
        ? { ok: true, role: "USER", identityId: "identity-paired-device" }
        : { ok: false, role: "NONE" },
  });
}

beforeEach(async () => {
  snapshotEnvironment();
  __resetPendingWebSocketsForTests();
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-ws-session-auth-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_ALLOW_WS_QUERY_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
});

afterEach(async () => {
  _resetAgentHostBridge();
  if (api) {
    await api.close();
    api = null;
  }
  if (stateDir) {
    // The just-closed server can still be flushing state-dir writes; retry so
    // a transient ENOTEMPTY does not fail an otherwise-passed test.
    await rm(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    stateDir = null;
  }
  restoreEnvironment();
});

async function bootServer(): Promise<number> {
  api = await startApiServer({ port: 0, skipDeferredStartupWork: true });
  process.env.ELIZA_PORT = String(api.port);
  process.env.ELIZA_API_PORT = String(api.port);
  return api.port;
}

function openWs(
  port: number,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for the server close")),
      timeoutMs,
    );
    ws.once("close", (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Waits for a specific frame type, ignoring the interleaved status/replay. */
function waitForFrame(ws: WebSocket, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      5_000,
    );
    ws.on("message", (data: unknown) => {
      const msg = JSON.parse(String(data)) as { type?: string };
      if (msg.type === type) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

describe("in-band WebSocket auth accepts a machine-session bearer (#13985)", () => {
  it("authenticates {type:'auth'} with an active session id", async () => {
    installSessionBridge();
    const port = await bootServer();
    const ws = await openWs(port);
    expect(pendingWebSocketCount("127.0.0.1")).toBe(1);

    const authOk = waitForFrame(ws, "auth-ok");
    ws.send(JSON.stringify({ type: "auth", token: ACTIVE_SESSION_ID }));
    await authOk;
    expect(pendingWebSocketCount("127.0.0.1")).toBe(0);

    const pong = waitForFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;
    ws.close();
    await vi.waitFor(() => {
      expect(pendingWebSocketCount("127.0.0.1")).toBe(0);
    });
  }, 60_000);

  it("still authenticates {type:'auth'} with the static API token", async () => {
    installSessionBridge();
    const port = await bootServer();
    const ws = await openWs(port);

    const authOk = waitForFrame(ws, "auth-ok");
    ws.send(JSON.stringify({ type: "auth", token: API_TOKEN }));
    await authOk;
    ws.close();
  }, 60_000);

  it("closes 1008 on an unknown or revoked session id", async () => {
    installSessionBridge();
    const port = await bootServer();
    const ws = await openWs(port);

    ws.send(JSON.stringify({ type: "auth", token: REVOKED_SESSION_ID }));
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  }, 60_000);

  it("still closes 1008 on a non-auth message before authentication", async () => {
    installSessionBridge();
    const port = await bootServer();
    const ws = await openWs(port);

    ws.send(JSON.stringify({ type: "ping" }));
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  }, 60_000);

  it("fails closed when the host installs no session resolver", async () => {
    setAgentHostBridge({ ...defaultAgentHostBridge });
    const port = await bootServer();
    const ws = await openWs(port);

    ws.send(JSON.stringify({ type: "auth", token: ACTIVE_SESSION_ID }));
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  }, 60_000);

  it("fails closed when the session store lookup throws", async () => {
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      resolveSessionTokenAuthorization: async () => {
        throw new Error("auth db connection refused");
      },
    });
    const port = await bootServer();
    const ws = await openWs(port);

    ws.send(JSON.stringify({ type: "auth", token: ACTIVE_SESSION_ID }));
    const code = await waitForClose(ws);
    expect(code).toBe(1008);
  }, 60_000);
});

describe("handshake bearer accepts a machine-session id (#13985)", () => {
  it("opens authenticated on Authorization: Bearer <session-id>", async () => {
    installSessionBridge();
    const port = await bootServer();
    const ws = await openWs(port, {
      Authorization: `Bearer ${ACTIVE_SESSION_ID}`,
    });
    // Handshake-authenticated: no pre-auth slot is held and no in-band
    // auth frame is needed before normal traffic.
    expect(pendingWebSocketCount("127.0.0.1")).toBe(0);

    const pong = waitForFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;
    ws.close();
  }, 60_000);

  it("still rejects the upgrade 401 on a bearer that is neither the static token nor a session", async () => {
    installSessionBridge();
    const port = await bootServer();
    await expect(
      openWs(port, { Authorization: "Bearer not-a-real-credential" }),
    ).rejects.toThrow(/401/);
  }, 60_000);
});

describe("session lookups stay behind the pre-auth admission bounds", () => {
  it("runs at most one in-band session lookup per socket at a time", async () => {
    let lookups = 0;
    let releaseLookup: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      resolveSessionTokenAuthorization: async (token) => {
        lookups += 1;
        await gate;
        return token === ACTIVE_SESSION_ID
          ? { ok: true, role: "USER", identityId: "identity-paired-device" }
          : { ok: false, role: "NONE" };
      },
    });
    const port = await bootServer();
    const ws = await openWs(port);

    const authOk = waitForFrame(ws, "auth-ok");
    for (let i = 0; i < 5; i += 1) {
      ws.send(JSON.stringify({ type: "auth", token: ACTIVE_SESSION_ID }));
    }
    // Give the server time to drain all five frames while the first lookup
    // is still blocked on the gate; the other four must be dropped, not
    // fanned out as concurrent store lookups.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(lookups).toBe(1);

    releaseLookup?.();
    await authOk;
    expect(lookups).toBe(1);

    const pong = waitForFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;
    ws.close();
  }, 60_000);

  it("rejects a handshake-bearer upgrade without a store lookup once the peer's pre-auth slots are exhausted", async () => {
    let lookups = 0;
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      resolveSessionTokenAuthorization: async () => {
        lookups += 1;
        return { ok: false, role: "NONE" };
      },
    });
    const port = await bootServer();

    // Fill every pre-auth slot for this peer with bare (credential-less)
    // sockets, which the server admits pending post-open authentication.
    const preAuthSockets: WebSocket[] = [];
    while (
      pendingWebSocketCount("127.0.0.1") < MAX_PENDING_WEBSOCKETS_PER_PEER
    ) {
      preAuthSockets.push(await openWs(port));
    }

    // With the admission cap saturated, an invalid handshake bearer must be
    // rejected before any session-store work happens.
    await expect(
      openWs(port, { Authorization: "Bearer not-a-real-credential" }),
    ).rejects.toThrow(/401/);
    expect(lookups).toBe(0);

    for (const socket of preAuthSockets) socket.close();
  }, 60_000);
});
