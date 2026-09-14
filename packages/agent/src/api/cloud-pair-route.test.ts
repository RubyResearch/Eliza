/** Exercises the standalone Cloud-pair relay and its executable browser handoff. */

import http from "node:http";
import { Socket } from "node:net";
import { runInNewContext } from "node:vm";
import { logger } from "@elizaos/core";
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import {
  CLOUD_PAIR_LEGACY_STORAGE_KEY,
  CLOUD_PAIR_LOCAL_OWNER_HINT_KEY,
  cloudPairTokenKeyForAgent,
} from "@elizaos/shared/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __cloudPairRateLimitBucketCountForTests,
  __resetCloudPairRateLimitForTests,
  handleStandaloneCloudPairRoute,
} from "./cloud-pair-route.ts";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

interface FakeRes {
  res: http.ServerResponse;
  body(): string;
  status(): number;
  headers(): Record<string, string>;
}

const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const HOSTILE_AGENT_ID = "99999999-9999-4999-8999-999999999999";
const MANAGED_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
  "ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS",
  "ELIZA_CLOUD_AGENT_ID",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;
const originalManagedEnv = Object.fromEntries(
  MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function clearManagedEnv(): void {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
}

function restoreManagedEnv(): void {
  for (const key of MANAGED_ENV_KEYS) {
    const value = originalManagedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function executeHandoffHtml(html: string) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Cloud-pair handoff script was not rendered.");

  const sessionValues = new Map<string, string>();
  const localValues = new Map<string, string>();
  const storage = (values: Map<string, string>) => ({
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  });
  const replace = vi.fn();
  const windowObject: Record<PropertyKey, unknown> = {
    sessionStorage: storage(sessionValues),
    localStorage: storage(localValues),
    location: { hostname: "127.0.0.1", protocol: "http:", replace },
  };
  runInNewContext(script, {
    window: windowObject,
    document: { querySelector: () => ({ textContent: "" }) },
    console: { error: vi.fn() },
  });

  return { localValues, replace, sessionValues, windowObject };
}

function fakeRes(): FakeRes {
  let bodyText = "";
  let writtenStatus = 200;
  const writtenHeaders: Record<string, string> = {};
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.writeHead = ((
    status: number,
    headers?: Record<string, string>,
  ): http.ServerResponse => {
    writtenStatus = status;
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        writtenHeaders[key.toLowerCase()] = String(value);
      }
    }
    return res;
  }) as typeof res.writeHead;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body: () => bodyText,
    status: () => writtenStatus,
    headers: () => writtenHeaders,
  };
}

function fakeReq(opts: {
  pathname: string;
  search?: string;
  host?: string;
  proto?: string;
  ip?: string;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = `${opts.pathname}${opts.search ?? ""}`;
  req.headers = {
    host: opts.host ?? "127.0.0.1:43123",
    ...(opts.proto ? { "x-forwarded-proto": opts.proto } : {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  __resetCloudPairRateLimitForTests();
  clearManagedEnv();
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "1";
  process.env.ELIZA_CLOUD_AGENT_ID = AGENT_ID;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  restoreManagedEnv();
  resetDevCloudEnvAuthorityForTests();
});

describe("handleStandaloneCloudPairRoute", () => {
  it.each(["staging-default", "offline"] as const)(
    "keeps the relay disabled under frozen %s authority despite late env pollution",
    async (authority) => {
      delete process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY;
      delete process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS;
      delete process.env.ELIZA_CLOUD_AGENT_ID;
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api-staging.eliza.app/api/v1";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "1";
      process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS = "203.0.113.0/24";
      process.env.ELIZA_CLOUD_AGENT_ID = HOSTILE_AGENT_ID;
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=late-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(421);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      authority: "staging-explicit" as const,
      launchBase: "https://api-staging.eliza.app/api/v1",
      exchangeUrl: "https://api-staging.eliza.app/api/auth/pair",
    },
    {
      authority: "self-hosted" as const,
      launchBase: "https://private.example:8787/api/v1",
      exchangeUrl: "https://private.example:8787/api/auth/pair",
    },
  ])(
    "uses only the frozen $authority relay identity, base, and CIDRs",
    async ({ authority, launchBase, exchangeUrl }) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL = launchBase;
      process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "1";
      process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS = "172.17.0.0/16";
      process.env.ELIZA_CLOUD_AGENT_ID = AGENT_ID;
      expect(resolveDevCloudEnvAuthority()).toBe(authority);

      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      process.env.ELIZA_CLOUD_PAIR_DIRECT_RELAY = "0";
      process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS = "192.168.0.0/16";
      process.env.ELIZA_CLOUD_AGENT_ID = HOSTILE_AGENT_ID;
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            apiKey: "agent_secret_value",
            agentId: AGENT_ID,
            agentName: "Frozen",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const admitted = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=frozen-token",
          ip: "172.17.0.2",
        }),
        admitted.res,
      );
      expect(admitted.status()).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        exchangeUrl,
        expect.objectContaining({
          body: JSON.stringify({
            token: "frozen-token",
            agentId: AGENT_ID,
          }),
        }),
      );

      fetchMock.mockClear();
      const lateOnlyPeer = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=late-token",
          ip: "192.168.1.2",
        }),
        lateOnlyPeer.res,
      );
      expect(lateOnlyPeer.status()).toBe(421);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("falls through for non-pair paths", async () => {
    const harness = fakeRes();
    await expect(
      handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/api/status" }),
        harness.res,
      ),
    ).resolves.toBe(false);
  });

  it("exchanges a one-time token and serves the session handoff HTML", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          apiKey: "agent_secret_value",
          agentId: AGENT_ID,
          agentName: "Nova",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const harness = fakeRes();
    const handled = await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      harness.res,
    );

    expect(handled).toBe(true);
    expect(harness.status()).toBe(200);
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.headers()["x-frame-options"]).toBe("DENY");
    expect(harness.headers()["content-security-policy"]).toContain(
      "default-src 'none'",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/pair",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          origin: "http://127.0.0.1:43123",
        }),
        body: JSON.stringify({ token: "pair-token", agentId: AGENT_ID }),
      }),
    );
    const handoff = executeHandoffHtml(harness.body());
    const scopedKey = cloudPairTokenKeyForAgent(AGENT_ID);
    expect(handoff.sessionValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.localValues.get(scopedKey)).toBe("agent_secret_value");
    expect(handoff.sessionValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(
      false,
    );
    expect(handoff.localValues.has(CLOUD_PAIR_LEGACY_STORAGE_KEY)).toBe(false);
    expect(handoff.sessionValues.get(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)).toBe(
      AGENT_ID,
    );
    expect(handoff.localValues.get(CLOUD_PAIR_LOCAL_OWNER_HINT_KEY)).toBe(
      AGENT_ID,
    );
    expect(handoff.windowObject.__ELIZAOS_APP_BOOT_CONFIG__).toEqual({
      apiToken: "agent_secret_value",
    });
    expect(handoff.windowObject.__ELIZA_APP_BOOT_CONFIG__).toEqual({
      apiToken: "agent_secret_value",
    });
    const bootSlot = Object.getOwnPropertySymbols(handoff.windowObject).find(
      (symbol) => symbol.description === "elizaos.app.boot-config",
    );
    expect(bootSlot).toBeDefined();
    expect(bootSlot ? handoff.windowObject[bootSlot] : undefined).toEqual({
      current: { apiToken: "agent_secret_value" },
    });
    expect(handoff.replace).toHaveBeenCalledWith("/");
  });

  it("never exchanges managed requests that reach the container directly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const req = fakeReq({
      pathname: "/pair",
      search: "?token=pair-token",
      host: "eliza-staging-1.elizacloud.ai",
      proto: "https",
      ip: "203.0.113.10",
    });
    req.headers["x-forwarded-host"] = "attacker.example";
    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(421);
    expect(harness.body()).toContain("Open this agent from Eliza Cloud");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never exchanges for a remote peer spoofing a loopback forwarded host (W1-037)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    // Before the fix, X-Forwarded-Host/Host were trusted for the loopback
    // gate, so this exact request passed it: a remote peer presenting a
    // loopback-looking origin could redeem a held pairing token through the
    // relay and receive the minted agent apiKey in the handoff HTML.
    const req = fakeReq({
      pathname: "/pair",
      search: "?token=pair-token",
      host: "localhost:43123",
      ip: "203.0.113.10",
    });
    req.headers["x-forwarded-host"] = "localhost";
    req.headers["x-forwarded-proto"] = "http";
    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(req, harness.res);

    expect(harness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the explicit local-provider relay for loopback and allowlisted Docker-gateway peers", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            apiKey: "agent_secret_value",
            agentId: AGENT_ID,
            agentName: "Local",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const loopbackHarness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      loopbackHarness.res,
    );
    expect(loopbackHarness.status()).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/pair",
      expect.objectContaining({
        headers: expect.objectContaining({ origin: "http://127.0.0.1:43123" }),
        body: JSON.stringify({ token: "pair-token", agentId: AGENT_ID }),
      }),
    );

    // The exchange origin is reconstructed from direct request metadata only:
    // forwarded headers must not rewrite it (W1-037).
    fetchMock.mockClear();
    const forwardedHarness = fakeRes();
    const forwardedReq = fakeReq({
      pathname: "/pair",
      search: "?token=pair-token",
      host: "127.0.0.1:43123",
      proto: "http",
    });
    forwardedReq.headers["x-forwarded-host"] = "attacker.example";
    await handleStandaloneCloudPairRoute(forwardedReq, forwardedHarness.res);
    expect(forwardedHarness.status()).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.eliza.app/api/auth/pair",
      expect.objectContaining({
        headers: expect.objectContaining({ origin: "http://127.0.0.1:43123" }),
      }),
    );

    // W5-016: private-range peers are NO LONGER admitted by default. The
    // local-Docker flow (port published on the host loopback, so the in-container
    // peer is the bridge gateway) requires the explicit CIDR allowlist.
    fetchMock.mockClear();
    const dockerDefaultHarness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
        ip: "172.17.0.1",
      }),
      dockerDefaultHarness.res,
    );
    expect(dockerDefaultHarness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS = "172.17.0.0/16";
    try {
      fetchMock.mockClear();
      const dockerHarness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          host: "127.0.0.1:43123",
          proto: "http",
          ip: "172.17.0.1",
        }),
        dockerHarness.res,
      );
      expect(dockerHarness.status()).toBe(200);
      expect(fetchMock).toHaveBeenCalled();

      // Dual-stack sockets report IPv4 peers in IPv4-mapped spelling.
      fetchMock.mockClear();
      const mappedHarness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          host: "127.0.0.1:43123",
          proto: "http",
          ip: "::ffff:172.17.0.1",
        }),
        mappedHarness.res,
      );
      expect(mappedHarness.status()).toBe(200);
      expect(fetchMock).toHaveBeenCalled();

      // The allowlist admits ONLY its ranges — other LAN/VPC peers stay out.
      fetchMock.mockClear();
      const lanHarness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          host: "127.0.0.1:43123",
          proto: "http",
          ip: "192.168.1.10",
        }),
        lanHarness.res,
      );
      expect(lanHarness.status()).toBe(421);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS;
    }

    fetchMock.mockClear();
    const publicHarness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "agent.example",
        proto: "https",
        ip: "203.0.113.10",
      }),
      publicHarness.res,
    );
    expect(publicHarness.status()).toBe(421);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before exchange when the local platform identity is missing", async () => {
    delete process.env.ELIZA_CLOUD_AGENT_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.status()).toBe(503);
    expect(harness.body()).toContain("Agent identity unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails visibly when the Cloud response omits or corrupts agent ownership", async () => {
    for (const body of [
      { apiKey: "agent_secret_value", agentName: "Nova" },
      {
        apiKey: "agent_secret_value",
        agentId: "not-an-agent",
        agentName: "Nova",
      },
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(502);
      expect(harness.body()).toContain("Sign-in failed");
      // Cloud really did return 2xx here, so "accepted the link" is honest,
      // but recovery must point at a fresh link (the token is spent), and the
      // response is not retryable at this URL — no Retry-After.
      expect(harness.body()).toContain("accepted the link");
      expect(harness.body()).toContain("fresh link");
      expect(harness.headers()["retry-after"]).toBeUndefined();
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("reports upstream 5xx without asserting whether Cloud consumed the link", async () => {
    for (const upstreamStatus of [500, 502, 503]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response("<html>upstream degraded</html>", {
            status: upstreamStatus,
          }),
        ),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(502);
      expect(harness.headers()["retry-after"]).toBe("60");
      expect(harness.body()).not.toContain("accepted the link");
      expect(harness.body()).not.toContain("was not accepted");
      expect(harness.body()).toContain(
        "could not confirm whether sign-in completed",
      );
      expect(harness.body()).toContain("fresh link");
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("aborts at the relay deadline without guessing whether Cloud consumed the link", async () => {
    vi.useFakeTimers();
    try {
      let upstreamCompletedAfterAbort = false;
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected the relay abort signal.");
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                // A caller-side abort does not roll back work already running
                // upstream; model the Cloud claim committing afterward.
                setTimeout(() => {
                  upstreamCompletedAfterAbort = true;
                }, 1_000);
                reject(
                  Object.assign(new Error("This operation was aborted"), {
                    name: "AbortError",
                  }),
                );
              },
              { once: true },
            );
          });
        }),
      );

      const harness = fakeRes();
      let settled = false;
      const handled = handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      ).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      expect(harness.body()).toBe("");

      await vi.advanceTimersByTimeAsync(1);
      await expect(handled).resolves.toBe(true);
      expect(harness.status()).toBe(503);
      expect(harness.headers()["retry-after"]).toBe("60");
      expect(harness.body()).toContain("did not respond in time");
      expect(harness.body()).not.toContain("accepted the link");
      expect(harness.body()).not.toContain("was not accepted");
      expect(harness.body()).toContain(
        "could not confirm whether sign-in completed",
      );
      expect(harness.body()).toContain("fresh link");
      expect(upstreamCompletedAfterAbort).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(upstreamCompletedAfterAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a stalled successful response body on the timeout path", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_input: string | URL | Request, init?: RequestInit) => {
          const signal = init?.signal;
          if (!signal) throw new Error("Expected the relay abort signal.");
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      Object.assign(new Error("This operation was aborted"), {
                        name: "AbortError",
                      }),
                    ),
                  { once: true },
                );
              }),
          } as unknown as Response);
        }),
      );

      const harness = fakeRes();
      const handled = handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      await vi.advanceTimersByTimeAsync(14_999);
      expect(harness.body()).toBe("");
      await vi.advanceTimersByTimeAsync(1);
      await expect(handled).resolves.toBe(true);
      expect(harness.status()).toBe(503);
      expect(harness.headers()["retry-after"]).toBe("60");
      expect(harness.body()).toContain(
        "could not confirm whether sign-in completed",
      );
      expect(harness.body()).not.toContain("accepted the link");
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits Retry-After and honest copy on transport failure", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(503);
      expect(harness.headers()["retry-after"]).toBe("60");
      expect(harness.body()).toContain("could not reach Eliza Cloud");
      expect(harness.body()).not.toContain("accepted the link");
      expect(harness.body()).not.toContain("was not accepted");
      expect(harness.body()).toContain(
        "could not reach Eliza Cloud or confirm whether sign-in completed",
      );
      expect(harness.body()).toContain("fresh link");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unexpected non-2xx statuses without claiming acceptance", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not found", { status: 404 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.status()).toBe(502);
    expect(harness.body()).not.toContain("accepted the link");
    expect(harness.body()).toContain("unexpected response (status 404)");
    expect(harness.body()).toContain("fresh link");
    expect(harness.headers()["retry-after"]).toBeUndefined();
  });

  it("escapes script-closing content while preserving the exact bearer", async () => {
    const apiKey = `agent_a"</script><script>alert(1)</script>`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ apiKey, agentId: AGENT_ID, agentName: "Nova" }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.status()).toBe(200);
    expect(harness.body().match(/<\/script>/g)).toHaveLength(1);
    const handoff = executeHandoffHtml(harness.body());
    expect(handoff.localValues.get(cloudPairTokenKeyForAgent(AGENT_ID))).toBe(
      apiKey,
    );
  });

  it("shows a no-store error page when the token is missing", async () => {
    const harness = fakeRes();
    const handled = await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair" }),
      harness.res,
    );

    expect(handled).toBe(true);
    expect(harness.status()).toBe(400);
    expect(harness.headers()["cache-control"]).toContain("no-store");
    expect(harness.body()).toContain("Missing pairing token");
  });

  it("does not redirect on rejected pairing links and renders honest copy", async () => {
    for (const rejectStatus of [401, 403, 410]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({}), { status: rejectStatus }),
          ),
      );

      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
        harness.res,
      );

      expect(harness.status()).toBe(403);
      expect(harness.body()).toContain("Sign-in link could not be verified");
      // The word "expired" must not appear anywhere — the relay cannot know
      // the cause, so it must not assert it. See issue #18184.
      expect(harness.body().toLowerCase()).not.toContain("expired");
      expect(harness.body()).not.toContain('window.location.replace("/")');
    }
  });

  it("never logs or renders the pairing token on rejection", async () => {
    const secretToken = "super-secret-pair-token-abc123";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: `?token=${secretToken}` }),
      harness.res,
    );

    // Token must not appear in the rendered HTML.
    expect(harness.body()).not.toContain(secretToken);
    // Token must not appear in any logger call.
    for (const call of vi.mocked(logger.warn).mock.calls) {
      expect(call.join(" ")).not.toContain(secretToken);
    }
    for (const call of vi.mocked(logger.error).mock.calls) {
      expect(call.join(" ")).not.toContain(secretToken);
    }
  });

  it("emits exactly one structured warning with status, exchangeUrl, and requestOrigin on rejection", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    vi.mocked(logger.warn).mockClear();

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        host: "127.0.0.1:43123",
        proto: "http",
      }),
      harness.res,
    );

    // Exactly one warning — not two (no generic non-2xx log for 401/403/410).
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const logLine = String(vi.mocked(logger.warn).mock.calls[0][0]);
    expect(logLine).toContain("pairing link rejected");
    expect(logLine).toContain("status=410");
    expect(logLine).toContain("exchangeUrl=");
    expect(logLine).toContain("requestOrigin=http://127.0.0.1:43123");
  });

  it("resolves the recovery link to the production console by default", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain("https://cloud.eliza.app/cloud/agents");
    expect(harness.body()).not.toContain("staging.elizacloud.ai");
  });

  it("resolves the recovery link to the staging console for a staging-provisioned agent", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://api-staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://cloud-staging.eliza.app/cloud/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });

  it("resolves the recovery link to staging for wildcard staging hostnames", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://us-east.staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://cloud-staging.eliza.app/cloud/agents",
    );
  });

  it("resolves the recovery link to staging for the bare staging apex", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://cloud-staging.eliza.app/cloud/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });

  it("resolves the recovery link to staging for the app-staging host", async () => {
    process.env.ELIZAOS_CLOUD_BASE_URL =
      "https://app-staging.elizacloud.ai/api/v1";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );

    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({ pathname: "/pair", search: "?token=pair-token" }),
      harness.res,
    );

    expect(harness.body()).toContain(
      "https://cloud-staging.eliza.app/cloud/agents",
    );
    expect(harness.body()).not.toContain("www.elizacloud.ai");
  });
});

describe("cloud-pair rate-limit bucket sweeping", () => {
  it("evicts expired buckets once the map passes the sweep threshold (#29715)", async () => {
    vi.useFakeTimers();
    try {
      // Distinct admitted loopback peers each mint one bucket; none expire
      // during the window, so the map grows past the 100-entry threshold.
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
      );
      for (let host = 1; host <= 120; host++) {
        const harness = fakeRes();
        await handleStandaloneCloudPairRoute(
          fakeReq({
            pathname: "/pair",
            search: "?token=pair-token",
            ip: `127.0.0.${host}`,
          }),
          harness.res,
        );
      }
      expect(__cloudPairRateLimitBucketCountForTests()).toBe(120);

      // Past the 60s window every bucket is expired; the next consume
      // sweeps them and leaves only the freshly minted bucket behind.
      vi.advanceTimersByTime(61_000);
      const harness = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          ip: "127.0.0.200",
        }),
        harness.res,
      );
      expect(__cloudPairRateLimitBucketCountForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an unexpired bucket when the sweep threshold is not reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
    );
    const harness = fakeRes();
    await handleStandaloneCloudPairRoute(
      fakeReq({
        pathname: "/pair",
        search: "?token=pair-token",
        ip: "127.0.0.1",
      }),
      harness.res,
    );
    // Below the threshold nothing is evicted: small maps keep their state
    // so the per-peer limit stays enforced within the window.
    expect(__cloudPairRateLimitBucketCountForTests()).toBe(1);
  });

  it("pins the exact expiry instant: limiter resets at resetAt, sweep deletes only strictly past it", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify({}), { status: 410 })),
      );
      for (let host = 1; host <= 120; host++) {
        const harness = fakeRes();
        await handleStandaloneCloudPairRoute(
          fakeReq({
            pathname: "/pair",
            search: "?token=pair-token",
            ip: `127.0.0.${host}`,
          }),
          harness.res,
        );
      }
      expect(__cloudPairRateLimitBucketCountForTests()).toBe(120);

      // At now === resetAt the limiter already treats the peer's bucket as
      // expired (resetAt <= now mints a fresh window) while the sweep's
      // strict now > resetAt predicate declines to delete it — the documented
      // one-tick gap between the two checks.
      vi.advanceTimersByTime(60_000);
      const boundary = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          ip: "127.0.0.1",
        }),
        boundary.res,
      );
      expect(__cloudPairRateLimitBucketCountForTests()).toBe(120);

      // One tick later the sweep deletes every strictly expired bucket; only
      // the bucket 127.0.0.1 just reset survives, so the sweep does not
      // over-exclude live state.
      vi.advanceTimersByTime(1);
      const after = fakeRes();
      await handleStandaloneCloudPairRoute(
        fakeReq({
          pathname: "/pair",
          search: "?token=pair-token",
          ip: "127.0.0.1",
        }),
        after.res,
      );
      expect(__cloudPairRateLimitBucketCountForTests()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
