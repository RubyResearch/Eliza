/**
 * Real HTTP-server coverage for the cookie/CORS authority split. The host
 * session seam is deterministic, while requests traverse the production host,
 * CORS, preflight, and coarse-auth pipeline over an ephemeral TCP listener.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { registerTokenRoleResolver } from "./boundary-role-resolver.ts";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const TRUSTED_ORIGIN = "https://trusted.example";
const HOSTILE_ORIGIN = "https://hostile.example";
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const REMOTE_HEADERS = { "x-forwarded-for": "203.0.113.10" } as const;
const touchedEnv = [
  "AGENT_SERVER_SHARED_SECRET",
  "ELIZA_ALLOWED_ORIGINS",
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

let api: ApiServer | null = null;
let unregisterResolver: (() => void) | undefined;
let stateDir: string | null = null;
const originalEnv = new Map<string, string | undefined>();

function restoreEnvironment(): void {
  for (const key of touchedEnv) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  originalEnv.clear();
}

beforeEach(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-cookie-cors-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.ELIZA_ALLOWED_ORIGINS = TRUSTED_ORIGIN;
  delete process.env.AGENT_SERVER_SHARED_SECRET;
  delete process.env.ELIZA_API_AUTH_TOKEN;
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;

  setAgentHostBridge({
    ...defaultAgentHostBridge,
    resolveHttpRequestAuthorization: async (req, _runtime, options) => {
      const authorization =
        typeof req.headers.authorization === "string"
          ? req.headers.authorization
          : "";
      if (
        options.allowBearerAuth !== false &&
        authorization === "Bearer explicit-session"
      ) {
        return { ok: true, role: "OWNER", identityId: "owner" };
      }
      if (!options.allowCookieAuth) return { ok: false, role: "NONE" };
      const cookie =
        typeof req.headers.cookie === "string" ? req.headers.cookie : "";
      if (cookie.includes("eliza_session=machine-session")) {
        return { ok: true, role: "USER", identityId: "machine" };
      }
      if (!cookie.includes("eliza_session=browser-session")) {
        return { ok: false, role: "NONE" };
      }
      const method = (req.method ?? "GET").toUpperCase();
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
        req.headers["x-eliza-csrf"] !== "valid-csrf"
      ) {
        return { ok: false, role: "NONE" };
      }
      return { ok: true, role: "OWNER", identityId: "owner" };
    },
  });

  api = await startApiServer({
    port: 0,
    skipDeferredStartupWork: true,
  });
}, 30_000);

afterEach(async () => {
  await api?.close();
  api = null;
  _resetAgentHostBridge();
  unregisterResolver?.();
  unregisterResolver = undefined;
  if (stateDir) {
    await rm(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
  stateDir = null;
  restoreEnvironment();
}, 30_000);

function endpoint(): string {
  return endpointPath("/api/cors-auth-probe");
}

function endpointPath(pathname: string): string {
  if (!api) throw new Error("test server is not running");
  return `http://127.0.0.1:${api.port}${pathname}`;
}

function browserHeaders(
  origin: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...REMOTE_HEADERS, Origin: origin, ...extra };
}

describe("cookie authentication follows credentialed CORS trust", () => {
  it("accepts trusted cookie reads but ignores the same cookie from a reflected origin", async () => {
    const trusted = await fetch(endpoint(), {
      headers: browserHeaders(TRUSTED_ORIGIN, {
        Cookie: "eliza_session=browser-session",
      }),
    });
    expect(trusted.status).toBe(404);
    expect(trusted.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );

    const hostile = await fetch(endpoint(), {
      headers: browserHeaders(HOSTILE_ORIGIN, {
        Cookie: "eliza_session=browser-session",
      }),
    });
    expect(hostile.status).toBe(401);
    expect(hostile.headers.get("access-control-allow-origin")).toBe(
      HOSTILE_ORIGIN,
    );
    expect(hostile.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("requires CSRF for a trusted simple cookie mutation", async () => {
    const missingCsrf = await fetch(endpoint(), {
      method: "POST",
      headers: browserHeaders(TRUSTED_ORIGIN, {
        "Content-Type": "text/plain",
        Cookie: "eliza_session=browser-session",
      }),
      body: "mutation",
    });
    expect(missingCsrf.status).toBe(401);

    const withCsrf = await fetch(endpoint(), {
      method: "POST",
      headers: browserHeaders(TRUSTED_ORIGIN, {
        "Content-Type": "text/plain",
        Cookie: "eliza_session=browser-session",
        "X-Eliza-CSRF": "valid-csrf",
      }),
      body: "mutation",
    });
    expect(withCsrf.status).toBe(404);
  });

  it("keeps hostile reflected origins bearer-only for simple mutations", async () => {
    const cookieOnly = await fetch(endpoint(), {
      method: "POST",
      headers: browserHeaders(HOSTILE_ORIGIN, {
        "Content-Type": "text/plain",
        Cookie: "eliza_session=browser-session",
        "X-Eliza-CSRF": "valid-csrf",
      }),
      body: "mutation",
    });
    expect(cookieOnly.status).toBe(401);

    const bearer = await fetch(endpoint(), {
      method: "POST",
      headers: browserHeaders(HOSTILE_ORIGIN, {
        Authorization: "Bearer explicit-session",
        "Content-Type": "text/plain",
        Cookie: "eliza_session=browser-session",
      }),
      body: "mutation",
    });
    expect(bearer.status).toBe(404);
    expect(bearer.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("answers trusted and hostile preflights without granting hostile credentials", async () => {
    const preflight = async (origin: string) =>
      fetch(endpoint(), {
        method: "OPTIONS",
        headers: browserHeaders(origin, {
          "Access-Control-Request-Headers": "x-eliza-csrf",
          "Access-Control-Request-Method": "POST",
        }),
      });

    const trusted = await preflight(TRUSTED_ORIGIN);
    expect(trusted.status).toBe(204);
    expect(trusted.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(
      trusted.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("x-eliza-csrf");

    const hostile = await preflight(HOSTILE_ORIGIN);
    expect(hostile.status).toBe(204);
    expect(hostile.headers.get("access-control-allow-origin")).toBe(
      HOSTILE_ORIGIN,
    );
    expect(hostile.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("browser companion owner enrollment boundary", () => {
  it("does not allow trusted loopback to replace an owner session", async () => {
    const response = await fetch(
      endpointPath("/api/browser-bridge/companions/pair"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: "Owner session required",
    });
  });

  it("requires CSRF and OWNER role for pair, owner revoke, and reset", async () => {
    const paths = [
      "/api/browser-bridge/companions/pair",
      "/api/browser-bridge/companions/companion-1/revoke",
      "/api/browser-bridge/companions/companion-1/reset-revocation",
    ];
    for (const pathname of paths) {
      const missingCsrf = await fetch(endpointPath(pathname), {
        method: "POST",
        headers: { Cookie: "eliza_session=browser-session" },
      });
      expect(missingCsrf.status).toBe(403);

      const nonOwner = await fetch(endpointPath(pathname), {
        method: "POST",
        headers: {
          Cookie: "eliza_session=machine-session",
          "X-Eliza-CSRF": "valid-csrf",
        },
      });
      expect(nonOwner.status).toBe(403);

      const wrongCsrf = await fetch(endpointPath(pathname), {
        method: "POST",
        headers: {
          Cookie: "eliza_session=browser-session",
          "X-Eliza-CSRF": "wrong-csrf",
        },
      });
      expect(wrongCsrf.status).toBe(401);

      const bearerSubstitution = await fetch(endpointPath(pathname), {
        method: "POST",
        headers: {
          Authorization: "Bearer explicit-session",
          Cookie: "eliza_session=invalid-session",
          "X-Eliza-CSRF": "valid-csrf",
        },
      });
      expect(bearerSubstitution.status).toBe(401);

      const owner = await fetch(endpointPath(pathname), {
        method: "POST",
        headers: {
          Cookie: "eliza_session=browser-session",
          "X-Eliza-CSRF": "valid-csrf",
        },
      });
      expect(owner.status).not.toBe(401);
      expect(owner.status).not.toBe(403);
    }
  });

  it("grants extension CORS only to companion-authenticated capability routes", async () => {
    const preflight = async (pathname: string) =>
      fetch(endpointPath(pathname), {
        method: "OPTIONS",
        headers: {
          Origin: EXTENSION_ORIGIN,
          "Access-Control-Request-Headers": "authorization, content-type",
          "Access-Control-Request-Method": "POST",
        },
      });

    const capability = await preflight("/api/browser-bridge/companions/sync");
    expect(capability.status).toBe(204);
    expect(capability.headers.get("access-control-allow-origin")).toBe(
      EXTENSION_ORIGIN,
    );

    const ownerPairing = await preflight("/api/browser-bridge/companions/pair");
    expect(ownerPairing.status).toBe(403);
    expect(ownerPairing.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("trajectory viewer owner authority", () => {
  const readPaths = [
    "/api/trajectories",
    "/api/trajectories/stats",
    "/api/trajectories/example-run",
  ];

  it("rejects a non-owner host session on every trajectory read", async () => {
    for (const pathname of readPaths) {
      const response = await fetch(endpointPath(pathname), {
        headers: browserHeaders(TRUSTED_ORIGIN, {
          Cookie: "eliza_session=machine-session",
        }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Owner role required" });
    }
  });

  it("keeps owner sessions on the real read-service path", async () => {
    for (const pathname of readPaths) {
      const response = await fetch(endpointPath(pathname), {
        headers: browserHeaders(TRUSTED_ORIGIN, {
          Cookie: "eliza_session=browser-session",
        }),
      });
      // This host has no runtime. Reaching the core service-unavailable
      // response proves the owner was admitted without fabricating data.
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Trajectory service unavailable",
      });
    }
  });

  it("does not promote shared service credentials to viewer ownership", async () => {
    process.env.AGENT_SERVER_SHARED_SECRET = "trajectory-boundary-test-secret";
    const response = await fetch(endpointPath("/api/trajectories"), {
      headers: {
        ...REMOTE_HEADERS,
        "x-server-token": "trajectory-boundary-test-secret",
      },
    });
    expect(response.status).toBe(403);
  });

  it("keeps unauthenticated remote reads unauthorized", async () => {
    const response = await fetch(endpointPath("/api/trajectories"), {
      headers: REMOTE_HEADERS,
    });
    expect(response.status).toBe(401);
  });

  it("admits the standalone API owner credential", async () => {
    process.env.ELIZA_API_TOKEN = "trajectory-api-owner-test";
    const response = await fetch(endpointPath("/api/trajectories"), {
      headers: {
        ...REMOTE_HEADERS,
        Authorization: "Bearer trajectory-api-owner-test",
      },
    });
    expect(response.status).toBe(503);
  });

  it("preserves an explicit non-owner session even on loopback", async () => {
    const response = await fetch(endpointPath("/api/trajectories"), {
      headers: { Cookie: "eliza_session=machine-session" },
    });
    expect(response.status).toBe(403);
  });

  it.each([
    { role: "OWNER", inScope: true, isAdmin: false, status: 503 },
    { role: "OWNER", inScope: false, isAdmin: false, status: 401 },
    { role: "OWNER", inScope: false, isAdmin: true, status: 503 },
    { role: "USER", inScope: true, isAdmin: false, status: 403 },
    { role: "USER", inScope: true, isAdmin: true, status: 403 },
    { role: "GUEST", inScope: true, isAdmin: false, status: 403 },
  ] as const)(
    "honors registered $role authority with scope=$inScope admin=$isAdmin",
    async ({ role, inScope, isAdmin, status }) => {
      unregisterResolver = registerTokenRoleResolver({
        id: "trajectory-boundary-test",
        resolve: () => ({
          providerId: "trajectory-boundary-test",
          principal: "synthetic-principal",
          worldRole: role,
          isAdmin,
          isRouteInScope: () => inScope,
          claims: {},
        }),
      });
      const response = await fetch(endpointPath("/api/trajectories"), {
        headers: REMOTE_HEADERS,
      });
      expect(response.status).toBe(status);
    },
  );

  it("retains standalone trusted-local access without a host session", async () => {
    const response = await fetch(endpointPath("/api/trajectories"));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Trajectory service unavailable",
    });
  });
});
