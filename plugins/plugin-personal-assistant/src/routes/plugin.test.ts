/**
 * Tests the personal-assistant route plugin's auth/authorization gate: token
 * enforcement, session resolution, and OWNER/ADMIN role gating on the raw
 * `/api/lifeops/*` surface. Downstream route handlers are stubbed (deterministic
 * vi.mock), so the assertions isolate the access-control boundary in plugin.ts.
 */

import type http from "node:http";
import { _resetAuthRateLimiter } from "@elizaos/app-core/api/auth";
import type { AgentRuntime, Route } from "@elizaos/core";
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloudRouteMocks = vi.hoisted(() => ({
  handleCloudFeaturesRoute: vi.fn(async () => true),
}));

vi.mock("../lifeops/scheduled-task/service.js", () => ({
  getScheduledTaskRunner: () => null,
}));

vi.mock("./entities.js", () => ({
  handleEntityRoutes: async () => false,
}));

vi.mock("./lifeops-routes.js", () => ({
  handleLifeOpsRoutes: async () => undefined,
}));

vi.mock("./relationships.js", () => ({
  handleRelationshipRoutes: async () => false,
}));

vi.mock("./scheduled-tasks.js", () => ({
  DEV_REGISTRIES_ROUTE_PATHS: [],
  makeScheduledTasksRouteHandler: () => async () => false,
}));

vi.mock("./sleep-routes.js", () => ({
  handleSleepRoutes: async () => undefined,
}));

vi.mock("./website-blocker-routes.js", () => ({
  handleWebsiteBlockerRoutes: async () => undefined,
}));

vi.mock("./cloud-features-routes.js", () => ({
  handleCloudFeaturesRoute: cloudRouteMocks.handleCloudFeaturesRoute,
}));

import {
  AGREEMENT_UPLOAD_CHUNK_BYTES,
  AGREEMENT_UPLOAD_METADATA_BYTES,
} from "../lifeops/household/agreement-upload-limits.js";
import {
  personalAssistantRoutesPlugin,
  requireLifeOpsRouteOwnerAdminAccess,
} from "./plugin.js";

type CapturedResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | number | string[]>;
  writableEnded: boolean;
};

function createRequest(
  url: string,
  headers: http.IncomingHttpHeaders = {},
  options: { method?: string; remoteAddress?: string; host?: string } = {},
): http.IncomingMessage {
  return {
    method: options.method ?? "GET",
    url,
    headers: {
      host: options.host ?? "example.test",
      ...headers,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "203.0.113.10",
    },
  } as http.IncomingMessage;
}

function createResponse(): CapturedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    writableEnded: false,
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers[name.toLowerCase()] = Array.isArray(value)
        ? [...value]
        : value;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk != null) {
        this.body += Buffer.isBuffer(chunk)
          ? chunk.toString("utf8")
          : String(chunk);
      }
      this.writableEnded = true;
      return this;
    },
  } as CapturedResponse;
}

function createRuntime(options?: {
  ownerId?: string | null;
  roles?: Record<string, "OWNER" | "ADMIN" | "USER" | "GUEST">;
}): AgentRuntime {
  const ownerId = options?.ownerId === undefined ? "owner-1" : options.ownerId;
  return {
    agentId: "agent-1",
    getSetting: vi.fn((key: string) =>
      key === "ELIZA_ADMIN_ENTITY_ID" ? (ownerId ?? undefined) : undefined,
    ),
    getAllWorlds: vi.fn(async () => [
      {
        id: "world-1",
        metadata: {
          roles: options?.roles ?? {},
        },
      },
    ]),
    getEntityById: vi.fn(async () => null),
    getRelationships: vi.fn(async () => []),
    getService: vi.fn(() => null),
  } as AgentRuntime;
}

function findRoute(
  type: Route["type"],
  path: string,
): Route & { handler: NonNullable<Route["handler"]> } {
  const route = personalAssistantRoutesPlugin.routes?.find(
    (candidate) => candidate.type === type && candidate.path === path,
  );
  expect(route?.handler).toBeTypeOf("function");
  return route as Route & { handler: NonNullable<Route["handler"]> };
}

describe("LifeOps raw route owner/admin gate", () => {
  beforeEach(() => {
    resetDevCloudEnvAuthorityForTests();
    cloudRouteMocks.handleCloudFeaturesRoute.mockClear();
    _resetAuthRateLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetDevCloudEnvAuthorityForTests();
    _resetAuthRateLimiter();
    delete process.env.ELIZA_API_TOKEN;
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  });

  it("allows configured owner bearer tokens without trusting actor headers", async () => {
    process.env.ELIZA_API_TOKEN = "owner-token";
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state", {
        authorization: "Bearer owner-token",
        "x-eliza-entity-id": "spoofed-admin",
      }),
      res,
      runtime: createRuntime({ roles: { "spoofed-admin": "GUEST" } }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("allows trusted local UI calls without an actor header", async () => {
    const res = createResponse();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest(
        "/api/lifeops/app-state",
        {},
        { remoteAddress: "127.0.0.1", host: "localhost:3000" },
      ),
      res,
      runtime: createRuntime({ ownerId: null }),
    });

    expect(allowed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("denies remote headerless raw routes instead of defaulting to owner", async () => {
    const res = createResponse();
    const runtime = createRuntime({ ownerId: null });
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state"),
      res,
      runtime,
    });

    expect(allowed).toBe(false);
    expect(runtime.getAllWorlds).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });

  it("denies spoofed actor headers even when they name the canonical owner", async () => {
    const res = createResponse();
    const runtime = createRuntime();
    const allowed = await requireLifeOpsRouteOwnerAdminAccess({
      req: createRequest("/api/lifeops/app-state", {
        "x-eliza-entity-id": "owner-1",
        "x-eliza-actor-entity-id": "owner-1",
      }),
      res,
      runtime,
    });

    expect(allowed).toBe(false);
    expect(runtime.getAllWorlds).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
  });

  it("denies private raw routes for explicit non-admin actors before the route handler runs", async () => {
    const route = findRoute("GET", "/api/lifeops/app-state");
    const res = createResponse();

    await route.handler(
      createRequest("/api/lifeops/app-state", {
        "x-eliza-entity-id": "user-1",
      }) as never,
      res as never,
      createRuntime({ roles: { "user-1": "USER" } }) as never,
    );

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: "Unauthorized",
    });
  });

  it("mounts every owner calendar surface behind the same private gate", () => {
    const calendarRoutes = [
      ["GET", "/api/lifeops/calendar/feed"],
      ["GET", "/api/lifeops/calendar/sources"],
      ["POST", "/api/lifeops/calendar/sources"],
      ["PATCH", "/api/lifeops/calendar/sources/:sourceId"],
      ["DELETE", "/api/lifeops/calendar/sources/:sourceId"],
      ["POST", "/api/lifeops/calendar/sources/:sourceId/sync"],
      ["GET", "/api/lifeops/calendar/meeting-auto-join"],
      ["PUT", "/api/lifeops/calendar/meeting-auto-join"],
      ["GET", "/api/lifeops/calendar/calendars"],
      ["PUT", "/api/lifeops/calendar/calendars/:id/include"],
      ["GET", "/api/lifeops/calendar/next-context"],
      ["POST", "/api/lifeops/calendar/events"],
      ["PATCH", "/api/lifeops/calendar/events/:eventId"],
      ["DELETE", "/api/lifeops/calendar/events/:eventId"],
      ["GET", "/api/lifeops/calendar/links"],
      ["POST", "/api/lifeops/calendar/links"],
      ["GET", "/api/lifeops/calendar/links/:id"],
      ["POST", "/api/lifeops/calendar/links/:id/reconcile"],
      ["POST", "/api/lifeops/calendar/links/:id/resolve"],
      ["POST", "/api/lifeops/calendar/links/:id/disconnect"],
      ["POST", "/api/lifeops/calendar/cards"],
      ["GET", "/api/lifeops/calendar/cards/:cardId"],
      ["DELETE", "/api/lifeops/calendar/cards/:cardId"],
    ] as const;

    for (const [type, path] of calendarRoutes) {
      expect(findRoute(type, path).public).not.toBe(true);
    }
  });

  it("mounts every agreement mutation and preview behind the owner gate", () => {
    const agreementRoutes = [
      ["GET", "/api/lifeops/agreements"],
      ["GET", "/api/lifeops/agreements/:id"],
      ["GET", "/api/lifeops/agreements/:id/guest-projection"],
      ["GET", "/api/lifeops/agreements/:id/guest-options"],
      ["GET", "/api/lifeops/agreements/:id/review"],
      ["POST", "/api/lifeops/agreements/:id/review"],
      ["GET", "/api/lifeops/agreements/:id/download"],
      ["POST", "/api/lifeops/agreements/:id/obligations"],
      ["GET", "/api/lifeops/agreements/:id/pins"],
      ["POST", "/api/lifeops/agreements/:id/pins"],
      ["DELETE", "/api/lifeops/agreements/pins/:id"],
      ["POST", "/api/lifeops/agreements/grants/preview"],
      ["POST", "/api/lifeops/agreements/grants"],
      ["POST", "/api/lifeops/agreements/grants/:id/revoke"],
      ["POST", "/api/lifeops/agreements/obligations/:id/decision"],
      ["POST", "/api/lifeops/agreement-uploads"],
      ["GET", "/api/lifeops/agreement-uploads/:id"],
      ["PUT", "/api/lifeops/agreement-uploads/:id/chunks/:index"],
      ["POST", "/api/lifeops/agreement-uploads/:id/commit"],
    ] as const;

    for (const [type, path] of agreementRoutes) {
      expect(findRoute(type, path).public).not.toBe(true);
    }
    expect(
      findRoute("POST", "/api/lifeops/agreement-uploads").maxBodyBytes,
    ).toBe(AGREEMENT_UPLOAD_METADATA_BYTES);
    expect(
      findRoute("PUT", "/api/lifeops/agreement-uploads/:id/chunks/:index")
        .maxBodyBytes,
    ).toBe(AGREEMENT_UPLOAD_CHUNK_BYTES);
    expect(
      findRoute("POST", "/api/lifeops/agreements/grants").maxBodyBytes,
    ).toBeUndefined();
  });

  it("mounts every family workflow surface behind the owner gate", () => {
    const workflowRoutes = [
      ["PUT", "/api/lifeops/family-workflows/school/source"],
      ["GET", "/api/lifeops/family-workflows/school/status"],
      ["POST", "/api/lifeops/family-workflows/school/run"],
      ["GET", "/api/lifeops/family-workflows/school/runs/:runId"],
      ["POST", "/api/lifeops/family-workflows/school/apply"],
      ["POST", "/api/lifeops/family-workflows/run-now"],
      ["GET", "/api/lifeops/family-workflows/packets"],
      ["POST", "/api/lifeops/family-workflows/packets"],
      ["GET", "/api/lifeops/family-workflows/packets/:packetId"],
      ["POST", "/api/lifeops/family-workflows/packets/:packetId/drafts"],
      [
        "POST",
        "/api/lifeops/family-workflows/packets/:packetId/drafts/:draftVersion/approval",
      ],
    ] as const;

    for (const [type, path] of workflowRoutes) {
      expect(findRoute(type, path).public).not.toBe(true);
    }
  });

  it.each([
    ["POST", "/api/lifeops/account-handoffs"],
    ["GET", "/api/lifeops/account-handoffs/active"],
    ["GET", "/api/lifeops/account-handoffs/:operationId"],
    ["POST", "/api/lifeops/account-handoffs/:operationId/cancel"],
    ["POST", "/api/lifeops/agreements/:id/export"],
    ["GET", "/api/lifeops/agreements/pin-targets"],
    ["GET", "/api/lifeops/family-workflows/email-options"],
    [
      "POST",
      "/api/lifeops/family-workflows/packets/:packetId/drafts/:draftVersion/revision",
    ],
    ["GET", "/api/lifeops/agreements/:id/review"],
    ["POST", "/api/lifeops/agreements/:id/review"],
  ] as const)(
    "denies unauthenticated %s %s before accessing family data",
    async (method, path) => {
      const route = findRoute(method, path);
      const res = createResponse();
      await route.handler(
        createRequest(
          path.replace(":packetId", "packet-1").replace(":draftVersion", "1"),
          {
            "x-eliza-entity-id": "owner-1",
          },
          { method },
        ) as never,
        res as never,
        createRuntime() as never,
      );
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: "Unauthorized" });
    },
  );

  it("does not wrap public OAuth callback routes with the owner/admin gate", async () => {
    const route = findRoute("GET", "/api/connectors/google/oauth/callback");
    const res = createResponse();

    await route.handler(
      createRequest("/api/connectors/google/oauth/callback", {
        "x-eliza-entity-id": "user-1",
      }) as never,
      res as never,
      createRuntime({ roles: { "user-1": "USER" } }) as never,
    );

    expect(route.public).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      error: "Missing OAuth state",
    });
  });

  it("passes the frozen staging Cloud tuple after late env and runtime pollution", async () => {
    vi.stubEnv("ELIZA_DEV_SOURCE", "1");
    vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "staging-explicit");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "launch-staging-key");
    vi.stubEnv(
      "ELIZAOS_CLOUD_BASE_URL",
      "https://api-staging.eliza.app/api/v1",
    );
    vi.stubEnv("ELIZAOS_CLOUD_SERVICE_KEY", "launch-staging-service-key");
    resetDevCloudEnvAuthorityForTests();
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    process.env.ELIZAOS_CLOUD_SERVICE_KEY = "late-production-service-key";
    const runtime = createRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) => {
      if (key === "ELIZA_ADMIN_ENTITY_ID") return "owner-1";
      if (key.includes("API_KEY")) return "runtime-production-key";
      if (key.includes("BASE_URL")) return "https://api.eliza.app/api/v1";
      if (key.includes("SERVICE_KEY")) return "runtime-production-service-key";
      return undefined;
    });

    const route = findRoute("GET", "/api/cloud/features");
    await route.handler(
      createRequest(
        "/api/cloud/features",
        {},
        { remoteAddress: "127.0.0.1", host: "localhost:3000" },
      ) as never,
      createResponse() as never,
      runtime as never,
    );

    const state = cloudRouteMocks.handleCloudFeaturesRoute.mock.calls[0]?.[4] as
      | {
          config?: {
            cloud?: {
              apiKey?: string;
              baseUrl?: string;
              serviceKey?: string;
            };
          };
        }
      | undefined;
    expect(state?.config).toEqual({
      cloud: {
        apiKey: "launch-staging-key",
        baseUrl: "https://api-staging.eliza.app/api/v1",
        serviceKey: "launch-staging-service-key",
      },
    });
  });

  it("retains runtime-first Cloud proxy resolution without dev authority", async () => {
    vi.stubEnv("ELIZA_DEV_SOURCE", "");
    vi.stubEnv("ELIZA_DEV_CLOUD_ENV_AUTHORITY", "");
    vi.stubEnv("ELIZAOS_CLOUD_API_KEY", "process-key");
    vi.stubEnv("ELIZAOS_CLOUD_BASE_URL", "https://process.example/api/v1");
    vi.stubEnv("ELIZAOS_CLOUD_SERVICE_KEY", "process-service-key");
    resetDevCloudEnvAuthorityForTests();
    const runtime = createRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) => {
      if (key === "ELIZA_ADMIN_ENTITY_ID") return "owner-1";
      if (key === "ELIZAOS_CLOUD_API_KEY") return "runtime-key";
      if (key === "ELIZAOS_CLOUD_BASE_URL") {
        return "https://runtime.example/api/v1";
      }
      if (key === "ELIZAOS_CLOUD_SERVICE_KEY") return "runtime-service-key";
      return undefined;
    });

    const route = findRoute("GET", "/api/cloud/features");
    await route.handler(
      createRequest(
        "/api/cloud/features",
        {},
        { remoteAddress: "127.0.0.1", host: "localhost:3000" },
      ) as never,
      createResponse() as never,
      runtime as never,
    );

    const state = cloudRouteMocks.handleCloudFeaturesRoute.mock.calls[0]?.[4] as
      | {
          config?: {
            cloud?: {
              apiKey?: string;
              baseUrl?: string;
              serviceKey?: string;
            };
          };
        }
      | undefined;
    expect(state?.config).toEqual({
      cloud: {
        apiKey: "runtime-key",
        baseUrl: "https://runtime.example/api/v1",
        serviceKey: "runtime-service-key",
      },
    });
  });
});
