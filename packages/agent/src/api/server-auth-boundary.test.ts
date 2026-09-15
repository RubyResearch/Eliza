/**
 * Real-server contract for three agent API auth-boundary fixes:
 *  - W1-010: GET /api/cloud/status and /api/cloud/credits no longer bypass the
 *    token gate — an unauthenticated caller who merely reaches the port gets
 *    401 instead of the owner's cloud userId/organizationId/credit balance.
 *  - W1-039: GET /api/health keeps its unauthenticated liveness bit but trims
 *    the topology detail (connectors, plugin/service counts, DB internals,
 *    boot phase) for callers that fail the trusted-local check.
 *  - W1-011: the device-bridge WS path fails closed (HTTP 404) when the
 *    bridge cannot be attached, instead of skipping WS auth unconditionally.
 *  - W9-AGENT-01: the device-bridge WS path ALSO fails closed (HTTP 404) when
 *    delegation is expected (bridge enabled + pairing token configured) but
 *    the deferred bridge attach never landed a listener — an unconditional
 *    early return would otherwise leave the raw pre-auth socket dangling
 *    outside the W5-015 bounds.
 *  - W5-015: unauthenticated /ws sockets are bounded — a per-peer cap on
 *    concurrent pre-auth upgrades and a post-open auth grace period that
 *    closes sockets which never authenticate — while the post-open token
 *    flow keeps working.
 * Boots the real `startApiServer` on an ephemeral loopback port with an
 * explicit API token; a remote caller is simulated with a non-loopback
 * X-Forwarded-For, which the trusted-local classifier treats as untrusted.
 */

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
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
  WS_AUTH_GRACE_TIMEOUT_MS,
} from "./server-helpers-auth.ts";

type WsClient = InstanceType<typeof WebSocket>;

// The gate contract under test lives in server.ts. The cloud plugin's own
// handler is NOT exercised here: under the source-alias test environment the
// real `@elizaos/plugin-elizacloud` module graph fails to evaluate (ENOTDIR
// on its internal route scan) and the request 500s after passing the gate —
// pre-existing behavior unrelated to the auth boundary. The authorized-caller
// cases therefore assert the gate decision (no 401), while the 401 case
// proves the unauthorized response.

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const API_TOKEN = "auth-boundary-test-api-token";

const touchedEnv = [
  "ELIZA_API_AUTH_TOKEN",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DEVICE_BRIDGE_ENABLED",
  "ELIZA_DEVICE_BRIDGE_TOKEN",
  "ELIZA_DEVICE_LOAD_TIMEOUT_MS",
  "ELIZA_DEVICE_PAIRING_TOKEN",
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

beforeEach(async () => {
  snapshotEnvironment();
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-auth-boundary-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_API_TOKEN = API_TOKEN;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_DEVICE_BRIDGE_ENABLED;
  delete process.env.ELIZA_DEVICE_PAIRING_TOKEN;
  delete process.env.ELIZA_DEVICE_BRIDGE_TOKEN;
  delete process.env.ELIZA_DEVICE_LOAD_TIMEOUT_MS;
});

afterEach(async () => {
  _resetAgentHostBridge();
  if (api) {
    await api.close();
    api = null;
  }
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
    stateDir = null;
  }
  restoreEnvironment();
});

async function bootServer(
  configureServer?: NonNullable<
    Parameters<typeof startApiServer>[0]
  >["configureServer"],
  authorizeWebSocket?: NonNullable<
    Parameters<typeof startApiServer>[0]
  >["authorizeWebSocket"],
): Promise<string> {
  api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
    configureServer,
    authorizeWebSocket,
  });
  process.env.ELIZA_PORT = String(api.port);
  process.env.ELIZA_API_PORT = String(api.port);
  return `http://127.0.0.1:${api.port}`;
}

describe("packaged desktop bootstrap host boundary", () => {
  it("dispatches the host-owned bootstrap before generic API auth", async () => {
    let calls = 0;
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      handleDesktopAuthBootstrapRoute: async (req, res) => {
        if (req.url !== "/api/auth/desktop-bootstrap") return false;
        calls += 1;
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ desktopBootstrap: true }));
        return true;
      },
    });
    const baseUrl = await bootServer();

    const response = await fetch(`${baseUrl}/api/auth/desktop-bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ socketPath: "/unused-by-host-test" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ desktopBootstrap: true });
    expect(calls).toBe(1);
  }, 120_000);
});

/** Headers that make a loopback test client look like a proxied remote peer. */
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.10" } as const;

function wsUpgradeResponse(port: number, pathname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let raw = "";
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("timed out waiting for the upgrade rejection"));
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.write(
        `GET ${pathname} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "\r\n",
      );
    });
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
      if (raw.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(raw);
      }
    });
  });
}

describe("cloud session reads require authorization (W1-010)", () => {
  it("rejects unauthenticated remote callers on /api/cloud/status and /api/cloud/credits", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        headers: REMOTE_HEADERS,
      });
      expect(res.status, pathname).toBe(401);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.userId, pathname).toBeUndefined();
      expect(body.organizationId, pathname).toBeUndefined();
      expect(body.balance, pathname).toBeUndefined();
    }
  }, 120_000);

  it("still lets a bearer-token caller through the gate", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`, {
        headers: {
          ...REMOTE_HEADERS,
          Authorization: `Bearer ${API_TOKEN}`,
        },
      });
      // Not 401: the request passes the gate and reaches dispatch (see the
      // comment above for why no stronger status is asserted here).
      expect(res.status, pathname).not.toBe(401);
    }
  }, 120_000);

  it("still lets the trusted loopback dashboard through the gate", async () => {
    const baseUrl = await bootServer();
    for (const pathname of ["/api/cloud/status", "/api/cloud/credits"]) {
      const res = await fetch(`${baseUrl}${pathname}`);
      expect(res.status, pathname).not.toBe(401);
    }
  }, 120_000);
});

describe("/api/health topology trim (W1-039)", () => {
  it("returns only the liveness bit to untrusted callers", async () => {
    const baseUrl = await bootServer();
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: REMOTE_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.ready).toBe("boolean");
    expect(body.connectors).toBeUndefined();
    expect(body.plugins).toBeUndefined();
    expect(body.services).toBeUndefined();
    expect(body.databaseLiveness).toBeUndefined();
    expect(body.agentState).toBeUndefined();
    expect(body.startup).toBeUndefined();
    expect(body.deferredBoot).toBeUndefined();
  }, 120_000);

  it("returns the full subsystem detail to trusted loopback callers", async () => {
    const baseUrl = await bootServer();
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.ready).toBe("boolean");
    expect(body.plugins).toBeDefined();
    expect(body.services).toBeDefined();
    expect(body.connectors).toBeDefined();
  }, 120_000);
});

describe("device-bridge WS upgrade gate (W1-011)", () => {
  it("rejects the device-bridge upgrade with 404 when the bridge cannot attach", async () => {
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);
    const raw = await wsUpgradeResponse(
      port,
      "/api/local-inference/device-bridge",
    );
    expect(raw.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
  }, 120_000);

  it("rejects the device-bridge upgrade with 404 when delegation is expected but the bridge never attached (W9-AGENT-01)", async () => {
    // Delegation is expected: the bridge is enabled and a pairing token is
    // configured. But the deferred attach can never land a listener here —
    // a malformed activation-time timeout makes attachMobileDeviceBridgeToServer
    // reject before it registers its upgrade handler, and on bundles without
    // the capacitor plugin the import itself rejects into the no-op fallback.
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    process.env.ELIZA_DEVICE_PAIRING_TOKEN = "auth-boundary-test-pairing-token";
    process.env.ELIZA_DEVICE_LOAD_TIMEOUT_MS = "not-a-number";
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);

    // Before the doomed attach settles the delegation has not landed yet:
    // the upgrade must be answered with a closed rejection, not left to
    // dangle outside the W5-015 pending-socket cap and auth grace period.
    const duringAttach = await wsUpgradeResponse(
      port,
      "/api/local-inference/device-bridge",
    );
    expect(duringAttach.startsWith("HTTP/1.1 404 Not Found")).toBe(true);

    // After the attach attempt has had time to fail, the path stays failed
    // closed — the delegation never activates without a real listener.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const afterFailure = await wsUpgradeResponse(
      port,
      "/api/local-inference/device-bridge",
    );
    expect(afterFailure.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
  }, 120_000);

  it("does not mistake an unrelated concurrent upgrade listener for the bridge", async () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    process.env.ELIZA_DEVICE_PAIRING_TOKEN = "auth-boundary-test-pairing-token";
    process.env.ELIZA_DEVICE_LOAD_TIMEOUT_MS = "not-a-number";
    const baseUrl = await bootServer((server) => {
      // Land a listener while the deferred plugin import/attach is in flight.
      // A process-global listener-count delta cannot prove who registered it.
      setImmediate(() => {
        setImmediate(() => server.on("upgrade", () => undefined));
      });
    });
    const port = Number(new URL(baseUrl).port);
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const raw = await wsUpgradeResponse(
      port,
      "/api/local-inference/device-bridge",
    );
    expect(raw.startsWith("HTTP/1.1 404 Not Found")).toBe(true);
  }, 120_000);

  it("delegates the device-bridge upgrade once the bridge listener has actually attached", async () => {
    // Healthy counterpart to the fail-closed cases: the deferred attach
    // succeeds here, and the upgrade handler must then keep delegating the
    // path to the bridge's own listener (pairing-token auth, 4001 close).
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    process.env.ELIZA_DEVICE_PAIRING_TOKEN = "auth-boundary-test-pairing-token";
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);

    // The attach is deferred past listen (dynamic import): poll with the
    // correct pairing token until the delegation activates. Fail-closed 404s
    // answer while the bridge listener is not yet on the server.
    await vi.waitFor(
      async () => {
        const raw = await wsUpgradeResponse(
          port,
          "/api/local-inference/device-bridge?token=auth-boundary-test-pairing-token",
        );
        expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
      },
      { timeout: 30_000, interval: 250 },
    );

    // The answering handler is the bridge's own, not the API's WS stack: a
    // wrong pairing token is upgraded and then closed with the bridge's 4001.
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/local-inference/device-bridge?token=wrong-token`,
    );
    const closeCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the bridge 4001 close")),
        10_000,
      );
      ws.once("close", (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.once("error", reject);
    });
    expect(closeCode).toBe(4001);
  }, 120_000);

  it("does not let a skip-listen API instance occupy the process-global device bridge", async () => {
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED = "1";
    process.env.ELIZA_DEVICE_PAIRING_TOKEN = "auth-boundary-test-pairing-token";
    const ipcApi = await startApiServer({
      port: 0,
      skipListen: true,
      skipDeferredStartupWork: true,
    });
    try {
      // Give the deferred optional-plugin import enough time to expose the
      // historical race before starting the real listening API instance.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const baseUrl = await bootServer();
      const port = Number(new URL(baseUrl).port);
      await vi.waitFor(
        async () => {
          const raw = await wsUpgradeResponse(
            port,
            "/api/local-inference/device-bridge?token=auth-boundary-test-pairing-token",
          );
          expect(raw.startsWith("HTTP/1.1 101")).toBe(true);
        },
        { timeout: 30_000, interval: 250 },
      );
    } finally {
      await ipcApi.close();
      const { mobileDeviceBridge } = await import(
        "@elizaos/plugin-capacitor-bridge/mobile-device-bridge-bootstrap"
      );
      await mobileDeviceBridge.close();
    }
  }, 120_000);
});

describe("unauthenticated /ws bounds (W5-015)", () => {
  beforeEach(() => {
    // Exercise the unauthenticated tier explicitly. Ordinary same-machine
    // connections retain the HTTP-equivalent trusted-local owner boundary.
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    __resetPendingWebSocketsForTests();
  });

  function openUnauthenticatedWs(port: number): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });
  }

  function waitForClose(ws: WsClient, timeoutMs: number): Promise<number> {
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
  function waitForFrame(ws: WsClient, type: string): Promise<void> {
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

  it("admits a credential recognized by the host authorizer", async () => {
    const hostToken = "revocable-host-machine-session";
    const baseUrl = await bootServer(undefined, (_request, url) => {
      return url.searchParams.get("token") === hostToken;
    });
    const port = Number(new URL(baseUrl).port);
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(hostToken)}`,
    );

    await waitForFrame(ws, "status");
    const pong = waitForFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;

    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(pendingWebSocketCount("127.0.0.1")).toBe(0);
    ws.close();
  });

  it("closes a socket that never authenticates after the grace period", async () => {
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);
    const ws = await openUnauthenticatedWs(port);
    expect(pendingWebSocketCount("127.0.0.1")).toBe(1);

    const code = await waitForClose(ws, WS_AUTH_GRACE_TIMEOUT_MS + 8_000);
    expect(code).toBe(1008);
    // The pre-auth slot is released once the closed socket is reaped.
    await vi.waitFor(() => {
      expect(pendingWebSocketCount("127.0.0.1")).toBe(0);
    });
  }, 30_000);

  it("keeps the post-open token auth flow working past the grace period", async () => {
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);
    const ws = await openUnauthenticatedWs(port);

    const authOk = waitForFrame(ws, "auth-ok");
    ws.send(JSON.stringify({ type: "auth", token: API_TOKEN }));
    await authOk;
    // Authentication released the pre-auth slot.
    expect(pendingWebSocketCount("127.0.0.1")).toBe(0);

    // Wait out the grace period: an authenticated socket must survive it.
    await new Promise((resolve) =>
      setTimeout(resolve, WS_AUTH_GRACE_TIMEOUT_MS + 1_500),
    );
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const pong = waitForFrame(ws, "pong");
    ws.send(JSON.stringify({ type: "ping" }));
    await pong;
    ws.close();
    await vi.waitFor(() => {
      expect(pendingWebSocketCount("127.0.0.1")).toBe(0);
    });
  }, 30_000);

  it("caps concurrent unauthenticated upgrades per peer", async () => {
    const baseUrl = await bootServer();
    const port = Number(new URL(baseUrl).port);
    const sockets: WebSocket[] = [];
    try {
      for (let i = 0; i < MAX_PENDING_WEBSOCKETS_PER_PEER; i++) {
        sockets.push(await openUnauthenticatedWs(port));
      }
      expect(pendingWebSocketCount("127.0.0.1")).toBe(
        MAX_PENDING_WEBSOCKETS_PER_PEER,
      );

      // The next credential-less upgrade from the same peer is refused at the
      // handshake instead of pinning another file descriptor forever.
      await expect(openUnauthenticatedWs(port)).rejects.toThrow(/401/);
      expect(pendingWebSocketCount("127.0.0.1")).toBe(
        MAX_PENDING_WEBSOCKETS_PER_PEER,
      );
    } finally {
      for (const ws of sockets) ws.close();
    }
    await vi.waitFor(() => {
      expect(pendingWebSocketCount("127.0.0.1")).toBe(0);
    });
  }, 30_000);
});
