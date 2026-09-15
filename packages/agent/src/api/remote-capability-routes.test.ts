/**
 * Exercises handleRemoteCapabilityRoutes — the POST
 * /api/capability-router/connect surface (direct / url-provider / cloud endpoint
 * connect, config persistence, token redaction, and SSRF / traversal /
 * embedded-credential validation) plus the GET/HEAD remote-asset proxy. Mixes
 * injected provider/cloud spies with real end-to-end connects driven against a
 * stubbed globalThis.fetch and an in-memory plugin runtime.
 */
import type http from "node:http";
import {
  CAPABILITY_ROUTER_SERVICE_TYPE,
  type ElizaCapabilityRouter,
  type IAgentRuntime,
  type Plugin,
  type RouteHelpers,
  type RouteRequestMeta,
  type UUID,
} from "@elizaos/core";
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemotePluginSyncResult } from "../services/remote-plugin-adapter";
import { handleRemoteCapabilityRoutes } from "./remote-capability-routes";

const originalFetch = globalThis.fetch;

/**
 * The cloud sandbox canonicalizes a recognized legacy elizacloud.ai host onto
 * the current cloud API origin before it calls out, so the fetch stub below is
 * keyed on the contract rather than the pre-consolidation literal. Keying it on
 * the old host made the stub silently miss and fall through to its 404 branch,
 * which surfaced as the cloud plugin never registering.
 */
const CLOUD_API_ORIGIN = ELIZA_DOMAIN_CONTRACTS.production.cloudApiOrigin;
const originalEnabled = process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
const originalUrls = process.env.ELIZA_CAPABILITY_ROUTER_URLS;
const originalAllowedModules =
  process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
const originalTrustPolicy = process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY;
const originalTrustAudit = process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;
const MALFORMED_COMPONENTS = [
  "%",
  "%2",
  "%ZZ",
  "%E0%A4",
  "%ED%A0%80",
  "%C0%80",
] as const;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalEnabled === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_ENABLED;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_ENABLED = originalEnabled;
  }
  if (originalUrls === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_URLS;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_URLS = originalUrls;
  }
  if (originalAllowedModules === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES =
      originalAllowedModules;
  }
  if (originalTrustPolicy === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY = originalTrustPolicy;
  }
  if (originalTrustAudit === undefined) {
    delete process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT;
  } else {
    process.env.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT = originalTrustAudit;
  }
});

function makeRuntime(): IAgentRuntime {
  return {
    services: new Map(),
  } as unknown as IAgentRuntime;
}

function makePluginRuntime(): IAgentRuntime {
  const runtime = {
    agentId: "44444444-4444-4444-4444-444444444444" as UUID,
    character: { name: "Remote Capability Route Test" },
    plugins: [] as Plugin[],
    actions: [] as NonNullable<Plugin["actions"]>,
    providers: [] as NonNullable<Plugin["providers"]>,
    evaluators: [] as NonNullable<Plugin["evaluators"]>,
    routes: [] as NonNullable<Plugin["routes"]>,
    services: new Map() as IAgentRuntime["services"],
    getService: (serviceType: string) =>
      runtime.services.get(serviceType as never)?.[0] ?? null,
    getServicesByType: (serviceType: string) =>
      runtime.services.get(serviceType as never) ?? [],
    hasService: (serviceType: string) =>
      runtime.services.has(serviceType as never) ||
      serviceType === CAPABILITY_ROUTER_SERVICE_TYPE,
    registerPlugin: async (plugin: Plugin) => {
      runtime.plugins.push(plugin);
      runtime.actions.push(...(plugin.actions ?? []));
      runtime.providers.push(...(plugin.providers ?? []));
      runtime.evaluators.push(...(plugin.evaluators ?? []));
      runtime.routes.push(...(plugin.routes ?? []));
    },
    reloadPlugin: async (plugin: Plugin) => {
      await runtime.registerPlugin(plugin);
    },
    unloadPlugin: async () => null,
    getAllPluginOwnership: () =>
      runtime.plugins.map((plugin) => ({
        pluginName: plugin.name,
        plugin,
        actions: plugin.actions ?? [],
        providers: plugin.providers ?? [],
        evaluators: plugin.evaluators ?? [],
        services: [],
        routes: plugin.routes ?? [],
      })),
  } as unknown as IAgentRuntime & {
    actions: NonNullable<Plugin["actions"]>;
    providers: NonNullable<Plugin["providers"]>;
    evaluators: NonNullable<Plugin["evaluators"]>;
    routes: NonNullable<Plugin["routes"]>;
  };
  return runtime;
}

function makeCtx(
  body: Record<string, unknown>,
  overrides: Partial<Parameters<typeof handleRemoteCapabilityRoutes>[0]> = {},
): {
  ctx: Parameters<typeof handleRemoteCapabilityRoutes>[0];
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const json = vi.fn();
  const error = vi.fn();
  const ctx = {
    req: { headers: {} } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/capability-router/connect",
    runtime: makeRuntime(),
    config: {},
    saveConfig: vi.fn(),
    persistConfigEnv: vi.fn(async (key: string, value: string) => {
      process.env[key] = value;
    }),
    readJsonBody: vi.fn().mockResolvedValue(body),
    json,
    error,
    ...overrides,
  } satisfies RouteRequestMeta &
    Pick<RouteHelpers, "json" | "error"> &
    Parameters<typeof handleRemoteCapabilityRoutes>[0];
  return { ctx, json, error };
}

const syncResult: RemotePluginSyncResult = {
  registered: [{ name: "remote-plugin" } as Plugin],
  unloaded: ["old-remote-plugin"],
  skipped: ["local-plugin"],
  trustDecisions: [
    {
      moduleId: "remote-plugin",
      pluginName: "remote-plugin",
      endpointId: "tools",
      trusted: true,
      reason: "allowed",
    },
  ],
};

describe("handleRemoteCapabilityRoutes", () => {
  it("proxies authenticated remote assets through the agent runtime", async () => {
    const getAsset = vi.fn().mockResolvedValue({
      path: "/assets/remote-view.js",
      contentType: "text/javascript",
      bodyBase64: Buffer.from("export const marker = 'proxied';").toString(
        "base64",
      ),
      integrity: "sha256-demo",
    });
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const writeHead = vi.fn();
    const end = vi.fn();
    const { ctx, json, error } = makeCtx(
      {},
      {
        method: "GET",
        pathname:
          "/api/capability-router/assets/device/remote-demo/assets/remote-view.js",
        runtime,
        res: { writeHead, end } as unknown as http.ServerResponse,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(getAsset).toHaveBeenCalledWith({
      endpointId: "device",
      moduleId: "remote-demo",
      path: "/assets/remote-view.js",
    });
    expect(writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/javascript",
      "Content-Length": Buffer.byteLength("export const marker = 'proxied';"),
      "Cache-Control": "no-cache",
      "X-Eliza-Asset-Integrity": "sha256-demo",
    });
    expect(end).toHaveBeenCalledWith(
      Buffer.from("export const marker = 'proxied';"),
    );
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("decodes each valid remote-asset path component exactly once", async () => {
    const getAsset = vi.fn().mockResolvedValue({
      path: "/assets/remote-view.js",
      contentType: "text/javascript",
      bodyBase64: Buffer.from("export {};").toString("base64"),
    });
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const { ctx, error } = makeCtx(
      {},
      {
        method: "GET",
        pathname:
          "/api/capability-router/assets/%64evice/%72emote-demo/%61ssets/remote-view.js",
        runtime,
        res: {
          writeHead: vi.fn(),
          end: vi.fn(),
        } as unknown as http.ServerResponse,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(getAsset).toHaveBeenCalledWith({
      endpointId: "device",
      moduleId: "remote-demo",
      path: "/assets/remote-view.js",
    });
    expect(error).not.toHaveBeenCalled();
  });

  it("decodes an encoded slash only after remote-asset route matching", async () => {
    const getAsset = vi.fn().mockResolvedValue({
      path: "/assets/remote-view.js",
      contentType: "text/javascript",
      bodyBase64: Buffer.from("export {};").toString("base64"),
    });
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const { ctx, error } = makeCtx(
      {},
      {
        method: "GET",
        pathname:
          "/api/capability-router/assets/%2F/%72emote-demo/%61ssets/remote-view.js",
        runtime,
        res: {
          writeHead: vi.fn(),
          end: vi.fn(),
        } as unknown as http.ServerResponse,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(getAsset).toHaveBeenCalledWith({
      endpointId: "/",
      moduleId: "remote-demo",
      path: "/assets/remote-view.js",
    });
    expect(error).not.toHaveBeenCalled();
  });

  for (const malformed of MALFORMED_COMPONENTS) {
    for (const route of [
      {
        field: "endpoint id",
        pathname: `/api/capability-router/assets/${malformed}/module/assets/view.js`,
      },
      {
        field: "module id",
        pathname: `/api/capability-router/assets/device/${malformed}/assets/view.js`,
      },
      {
        field: "asset path",
        pathname: `/api/capability-router/assets/device/module/assets/${malformed}`,
      },
    ]) {
      it(`rejects malformed ${route.field} ${malformed} before asset lookup`, async () => {
        const getAsset = vi.fn();
        const router = {
          plugin: { getAsset },
        } as unknown as ElizaCapabilityRouter;
        const runtime = {
          getService: () => router,
        } as Partial<IAgentRuntime> as IAgentRuntime;
        const { ctx, error } = makeCtx(
          {},
          {
            method: "GET",
            pathname: route.pathname,
            runtime,
          },
        );

        await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

        expect(error).toHaveBeenCalledWith(
          ctx.res,
          `Invalid ${route.field}: malformed URL encoding`,
          400,
        );
        expect(getAsset).not.toHaveBeenCalled();
      });
    }
  }

  it("serves remote asset HEAD requests with the decoded content length", async () => {
    const getAsset = vi.fn().mockResolvedValue({
      path: "/assets/remote-view.js",
      contentType: "text/javascript",
      bodyBase64: Buffer.from("export const marker = 'head';").toString(
        "base64",
      ),
    });
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const writeHead = vi.fn();
    const end = vi.fn();
    const { ctx, json, error } = makeCtx(
      {},
      {
        method: "HEAD",
        pathname:
          "/api/capability-router/assets/device/remote-demo/assets/remote-view.js",
        runtime,
        res: { writeHead, end } as unknown as http.ServerResponse,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(writeHead).toHaveBeenCalledWith(200, {
      "Content-Type": "text/javascript",
      "Content-Length": Buffer.byteLength("export const marker = 'head';"),
      "Cache-Control": "no-cache",
    });
    expect(end).toHaveBeenCalledWith(undefined);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("blocks remote dynamic assets for restricted mobile platforms", async () => {
    const getAsset = vi.fn();
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const { ctx, json, error } = makeCtx(
      {},
      {
        method: "GET",
        pathname:
          "/api/capability-router/assets/device/remote-demo/assets/remote-view.js",
        runtime,
        req: {
          headers: { "x-eliza-platform": "ios" },
        } as unknown as http.IncomingMessage,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Dynamic capability asset loading is not permitted on this platform.",
      403,
    );
    expect(getAsset).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects remote asset proxy paths with traversal segments", async () => {
    const getAsset = vi.fn();
    const router = {
      plugin: { getAsset },
    } as unknown as ElizaCapabilityRouter;
    const runtime = {
      getService: () => router,
    } as Partial<IAgentRuntime> as IAgentRuntime;
    const { ctx, json, error } = makeCtx(
      {},
      {
        method: "GET",
        pathname:
          "/api/capability-router/assets/device/remote-demo/assets/%2E%2E/secret.js",
        runtime,
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Capability asset URL path is not valid.",
      400,
    );
    expect(getAsset).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("installs a direct endpoint, syncs plugins, and redacts tokens", async () => {
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "direct",
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test",
        token: "secret-token",
      },
      sync: syncResult,
    });
    const { ctx, json, error } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://capability.example.test/",
          token: "secret-token",
        },
        requestTimeoutMs: 15_000,
        allowedModuleIds: ["remote-plugin"],
        trustPolicy: {
          allowedProvenanceIssuers: ["eliza-cloud-build"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build":
              "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
          },
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
        },
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(connectEndpointProvider).toHaveBeenCalledWith(
      ctx.runtime,
      expect.objectContaining({
        provider: expect.objectContaining({ id: "direct" }),
        provisionOptions: {
          endpoint: {
            id: "tools",
            baseUrl: "https://capability.example.test",
            token: "secret-token",
          },
          allowedModuleIds: ["remote-plugin"],
        },
      }),
    );
    expect(connectEndpointProvider.mock.calls[0]?.[1]).toMatchObject({
      provisionOptions: {
        endpoint: {
          id: "tools",
          baseUrl: "https://capability.example.test",
          token: "secret-token",
        },
        allowedModuleIds: ["remote-plugin"],
      },
      unloadMissing: true,
      requestTimeoutMs: 15_000,
      allowedModuleIds: ["remote-plugin"],
      trustPolicy: {
        allowedProvenanceIssuers: ["eliza-cloud-build"],
        trustedProvenancePublicKeys: {
          "eliza-cloud-build":
            "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
        },
        requireSignedProvenance: true,
        requireVerifiedProvenance: true,
        requireProvenanceDigestMatch: true,
      },
    });
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      success: true,
      mode: "endpoint",
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test",
        hasToken: true,
      },
      persisted: true,
      sync: {
        registered: ["remote-plugin"],
        unloaded: ["old-remote-plugin"],
        skipped: ["local-plugin"],
        trustDecisions: [
          {
            moduleId: "remote-plugin",
            pluginName: "remote-plugin",
            endpointId: "tools",
            trusted: true,
            reason: "allowed",
          },
        ],
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1])).not.toContain(
      "secret-token",
    );
    expect(ctx.saveConfig).toHaveBeenCalledOnce();
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ENABLED).toBe("true");
    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      {
        id: "tools",
        baseUrl: "https://capability.example.test",
      },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_ENABLED",
      "true",
    );
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "tools",
          baseUrl: "https://capability.example.test",
          token: "secret-token",
        },
      ]),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS).not.toContain(
      "secret-token",
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
      JSON.stringify({ tools: ["remote-plugin"] }),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY).toBe(
      JSON.stringify({
        tools: {
          allowedProvenanceIssuers: ["eliza-cloud-build"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build":
              "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
          },
          requireSignedProvenance: true,
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
        },
      }),
    );
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
      JSON.stringify({
        tools: {
          allowedProvenanceIssuers: ["eliza-cloud-build"],
          trustedProvenancePublicKeys: {
            "eliza-cloud-build":
              "-----BEGIN PUBLIC KEY-----\nkey\n-----END PUBLIC KEY-----",
          },
          requireSignedProvenance: true,
          requireVerifiedProvenance: true,
          requireProvenanceDigestMatch: true,
        },
      }),
    );
  });

  it("keeps multiple direct endpoint connects live through the product route", async () => {
    const runtime = makePluginRuntime();
    const calls: Array<{ url: string; method?: string; moduleId?: string }> =
      [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string };
          })
        : undefined;
      calls.push({
        url: String(url),
        method: body?.method,
        moduleId: body?.params?.moduleId,
      });
      if (body?.method === "plugin.modules.list") {
        if (String(url).startsWith("https://device-a.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "device-a-plugin",
                  name: "@remote/device-a",
                  actions: [
                    {
                      name: "DEVICE_A_ACTION",
                      description: "Run on device A.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (String(url).startsWith("https://device-b.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "device-b-plugin",
                  name: "@remote/device-b",
                  actions: [
                    {
                      name: "DEVICE_B_ACTION",
                      description: "Run on device B.",
                    },
                  ],
                },
              ],
            },
          });
        }
      }
      if (body?.method === "plugin.action.invoke") {
        return jsonResponse({
          ok: true,
          result: {
            text:
              body.params?.moduleId === "device-a-plugin"
                ? "device a action"
                : "device b action",
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    const first = makeCtx(
      {
        endpoint: {
          id: "device-a",
          baseUrl: "https://device-a.example.test",
          token: "device-a-token",
        },
        persist: false,
      },
      { runtime },
    );
    const second = makeCtx(
      {
        endpoint: {
          id: "device-b",
          baseUrl: "https://device-b.example.test",
          token: "device-b-token",
        },
        persist: false,
      },
      { runtime },
    );

    await expect(handleRemoteCapabilityRoutes(first.ctx)).resolves.toBe(true);
    await expect(handleRemoteCapabilityRoutes(second.ctx)).resolves.toBe(true);

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/device-a",
      "@remote/device-b",
    ]);
    const router = runtime.getService?.(
      CAPABILITY_ROUTER_SERVICE_TYPE,
    ) as unknown as {
      getEndpointConfigs: () => Array<{ id: string; baseUrl: string }>;
    };
    expect(
      router.getEndpointConfigs().map(({ id, baseUrl }) => ({
        id,
        baseUrl,
      })),
    ).toEqual([
      { id: "device-a", baseUrl: "https://device-a.example.test" },
      { id: "device-b", baseUrl: "https://device-b.example.test" },
    ]);
    await expect(
      runtime.actions
        .find((action) => action.name === "DEVICE_A_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "device a action" });
    await expect(
      runtime.actions
        .find((action) => action.name === "DEVICE_B_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "device b action" });
    expect(
      calls
        .filter((call) => call.method === "plugin.modules.list")
        .map((call) => call.url),
    ).toEqual([
      "https://device-a.example.test/v1/capabilities/invoke",
      "https://device-b.example.test/v1/capabilities/invoke",
    ]);
    expect(first.json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      mode: "endpoint",
      endpoint: { id: "device-a", hasToken: true },
      persisted: false,
      sync: { registered: ["@remote/device-a"], unloaded: [] },
    });
    expect(second.json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      mode: "endpoint",
      endpoint: { id: "device-b", hasToken: true },
      persisted: false,
      sync: { registered: ["@remote/device-b"], unloaded: [] },
    });
  });

  it("keeps direct and cloud endpoint connects live through the product route", async () => {
    const runtime = makePluginRuntime();
    const calls: Array<{ url: string; method?: string; moduleId?: string }> =
      [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as {
            method?: string;
            params?: { moduleId?: string };
          })
        : undefined;
      calls.push({
        url: href,
        method: body?.method,
        moduleId: body?.params?.moduleId,
      });
      if (href === `${CLOUD_API_ORIGIN}/api/v1/eliza/agents`) {
        return jsonResponse({ data: { id: "cloud-agent-1" } });
      }
      if (
        href ===
        `${CLOUD_API_ORIGIN}/api/v1/eliza/agents/cloud-agent-1/provision`
      ) {
        return jsonResponse({
          data: {
            capabilityRouterUrl: "https://cloud-capability.example.test",
            capabilityRouterToken: "cloud-capability-token",
          },
        });
      }
      if (body?.method === "plugin.modules.list") {
        if (href.startsWith("https://device-local.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "local-device-plugin",
                  name: "@remote/local-device",
                  actions: [
                    {
                      name: "LOCAL_DEVICE_ACTION",
                      description: "Run on the local device.",
                    },
                  ],
                },
              ],
            },
          });
        }
        if (href.startsWith("https://cloud-capability.example.test/")) {
          return jsonResponse({
            ok: true,
            result: {
              modules: [
                {
                  id: "cloud-plugin",
                  name: "@remote/cloud-plugin",
                  actions: [
                    {
                      name: "CLOUD_ACTION",
                      description: "Run in the cloud capability sandbox.",
                    },
                  ],
                },
              ],
            },
          });
        }
      }
      if (body?.method === "plugin.action.invoke") {
        return jsonResponse({
          ok: true,
          result: {
            text:
              body.params?.moduleId === "local-device-plugin"
                ? "local device action"
                : "cloud action",
          },
        });
      }
      return jsonResponse({ ok: false, error: { message: "unexpected" } }, 404);
    }) as unknown as typeof fetch;

    const direct = makeCtx(
      {
        endpoint: {
          id: "local-device",
          baseUrl: "https://device-local.example.test",
          token: "local-device-token",
        },
        persist: false,
      },
      { runtime },
    );
    const cloud = makeCtx(
      {
        cloud: {
          cloudApiBase: "https://www.elizacloud.ai",
          authToken: "cloud-auth-token",
          name: "Cloud Dynamic Plugin",
          endpointId: "cloud-capability",
        },
        persist: false,
      },
      { runtime },
    );

    await expect(handleRemoteCapabilityRoutes(direct.ctx)).resolves.toBe(true);
    await expect(handleRemoteCapabilityRoutes(cloud.ctx)).resolves.toBe(true);

    expect(runtime.plugins.map((plugin) => plugin.name)).toEqual([
      "@remote/local-device",
      "@remote/cloud-plugin",
    ]);
    const router = runtime.getService?.(
      CAPABILITY_ROUTER_SERVICE_TYPE,
    ) as unknown as {
      getEndpointConfigs: () => Array<{ id: string; baseUrl: string }>;
    };
    expect(
      router.getEndpointConfigs().map(({ id, baseUrl }) => ({
        id,
        baseUrl,
      })),
    ).toEqual([
      {
        id: "local-device",
        baseUrl: "https://device-local.example.test",
      },
      {
        id: "cloud-capability",
        baseUrl: "https://cloud-capability.example.test",
      },
    ]);
    await expect(
      runtime.actions
        .find((action) => action.name === "LOCAL_DEVICE_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "local device action" });
    await expect(
      runtime.actions
        .find((action) => action.name === "CLOUD_ACTION")
        ?.handler(runtime, {} as never),
    ).resolves.toMatchObject({ text: "cloud action" });
    expect(cloud.json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      mode: "cloud",
      agentId: "cloud-agent-1",
      endpoint: { id: "cloud-capability", hasToken: true },
      persisted: false,
      sync: { registered: ["@remote/cloud-plugin"], unloaded: [] },
    });
    expect(JSON.stringify(cloud.json.mock.calls[0]?.[1])).not.toContain(
      "cloud-capability-token",
    );
  });

  it("provisions cloud sandbox and returns redacted endpoint metadata", async () => {
    const connectCloudSandbox = vi.fn().mockResolvedValue({
      agentId: "agent-1",
      jobId: "job-1",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        token: "cloud-secret",
      },
      sync: syncResult,
    });
    const { ctx, json, error } = makeCtx(
      {
        cloud: {
          cloudApiBase: "https://cloud.example.test/",
          authToken: "cloud-auth",
          name: "Remote Tools",
          bio: ["runs dynamic capabilities"],
          endpointId: "cloud",
          token: "endpoint-token",
          timeoutMs: 5_000,
          pollIntervalMs: 100,
          allowedModuleIds: ["remote-plugin"],
        },
        unloadMissing: false,
      },
      { connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(connectCloudSandbox).toHaveBeenCalledWith(ctx.runtime, {
      cloudApiBase: "https://cloud.example.test",
      authToken: "cloud-auth",
      name: "Remote Tools",
      bio: ["runs dynamic capabilities"],
      endpointId: "cloud",
      token: "endpoint-token",
      timeoutMs: 5_000,
      pollIntervalMs: 100,
      allowedModuleIds: ["remote-plugin"],
      unloadMissing: false,
      requestTimeoutMs: 60_000,
    });
    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(ctx.res, {
      success: true,
      mode: "cloud",
      agentId: "agent-1",
      jobId: "job-1",
      endpoint: {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
        hasToken: true,
      },
      persisted: true,
      sync: {
        registered: ["remote-plugin"],
        unloaded: ["old-remote-plugin"],
        skipped: ["local-plugin"],
        trustDecisions: [
          {
            moduleId: "remote-plugin",
            pluginName: "remote-plugin",
            endpointId: "tools",
            trusted: true,
            reason: "allowed",
          },
        ],
      },
    });
    expect(JSON.stringify(json.mock.calls[0]?.[1])).not.toContain(
      "cloud-secret",
    );
    expect(ctx.saveConfig).toHaveBeenCalledOnce();
    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      {
        id: "cloud",
        baseUrl: "https://cloud-capability.example.test",
      },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "cloud",
          baseUrl: "https://cloud-capability.example.test",
          token: "cloud-secret",
        },
      ]),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS).not.toContain(
      "cloud-secret",
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
      JSON.stringify({ cloud: ["remote-plugin"] }),
    );
  });

  it("can connect without persisting the endpoint", async () => {
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "direct",
      endpoint: {
        id: "ephemeral",
        baseUrl: "https://capability.example.test",
      },
      sync: syncResult,
    });
    const { ctx, json } = makeCtx(
      {
        endpoint: {
          id: "ephemeral",
          baseUrl: "https://capability.example.test",
        },
        persist: false,
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(ctx.saveConfig).not.toHaveBeenCalled();
    expect(ctx.persistConfigEnv).not.toHaveBeenCalled();
    expect(json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      persisted: false,
    });
  });

  it("connects URL-backed provider endpoints through the product route", async () => {
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "home-machine",
      endpoint: {
        id: "home-runner",
        baseUrl: "https://home.example.test/capability",
        token: "home-secret",
      },
      sync: syncResult,
    });
    const { ctx, json } = makeCtx(
      {
        provider: "home-machine",
        endpoint: {
          id: "home-runner",
          baseUrl: "https://home.example.test/capability/",
          token: "home-secret",
        },
        allowedModuleIds: ["remote-plugin"],
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(connectEndpointProvider).toHaveBeenCalledWith(
      ctx.runtime,
      expect.objectContaining({
        provider: expect.objectContaining({ id: "home-machine" }),
        provisionOptions: {
          baseUrl: "https://home.example.test/capability",
          endpointId: "home-runner",
          token: "home-secret",
          allowedModuleIds: ["remote-plugin"],
        },
      }),
    );
    expect(json.mock.calls[0]?.[1]).toMatchObject({
      success: true,
      mode: "home-machine",
      provider: "home-machine",
      endpoint: {
        id: "home-runner",
        baseUrl: "https://home.example.test/capability",
        hasToken: true,
      },
      persisted: true,
    });
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "home-runner",
          baseUrl: "https://home.example.test/capability",
          token: "home-secret",
        },
      ]),
    );
    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
      JSON.stringify({ "home-runner": ["remote-plugin"] }),
    );
  });

  it("merges persisted endpoints by id", async () => {
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "direct",
      endpoint: {
        id: "tools",
        baseUrl: "https://new.example.test",
        token: "new-token",
      },
      sync: syncResult,
    });
    const { ctx } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://new.example.test",
          token: "new-token",
        },
      },
      {
        connectEndpointProvider,
        config: {
          env: {
            vars: {
              ELIZA_CAPABILITY_ROUTER_URLS: JSON.stringify([
                {
                  id: "tools",
                  baseUrl: "https://old.example.test",
                  token: "old-token",
                },
                { id: "other", baseUrl: "https://other.example.test" },
              ]),
            },
          },
        },
      },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(
      JSON.parse(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS ?? "[]"),
    ).toEqual([
      { id: "tools", baseUrl: "https://new.example.test" },
      { id: "other", baseUrl: "https://other.example.test" },
    ]);
    expect(ctx.persistConfigEnv).toHaveBeenCalledWith(
      "ELIZA_CAPABILITY_ROUTER_URLS",
      JSON.stringify([
        {
          id: "tools",
          baseUrl: "https://new.example.test",
          token: "new-token",
        },
        { id: "other", baseUrl: "https://other.example.test" },
      ]),
    );
  });

  it("preserves persisted module allowlists from live config env", async () => {
    process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES = JSON.stringify({
      other: ["other-plugin"],
    });
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "direct",
      endpoint: {
        id: "tools",
        baseUrl: "https://new.example.test",
      },
      sync: syncResult,
    });
    const { ctx } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://new.example.test",
        },
        allowedModuleIds: ["remote-plugin", "remote-plugin", " "],
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
      JSON.stringify({
        other: ["other-plugin"],
        tools: ["remote-plugin"],
      }),
    );
  });

  describe("corrupted persisted settings", () => {
    const CORRUPT_URLS =
      '[{"id":"legacy","baseUrl":"https://legacy.example.test"},]';
    const CORRUPT_ALLOWLIST = '{"legacy":["legacy-plugin"],}';
    const CORRUPT_TRUST_POLICY =
      '{"legacy":{"requireVerifiedProvenance":true},}';
    const CORRUPT_AUDIT = '[{"recordedAt":"2026-09-13T00:00:00.000Z",]';

    function makeConnectCtx(
      overrides: Partial<Parameters<typeof handleRemoteCapabilityRoutes>[0]>,
      body: Record<string, unknown> = {},
    ) {
      const connectEndpointProvider = vi.fn().mockResolvedValue({
        providerId: "direct",
        endpoint: {
          id: "tools",
          baseUrl: "https://capability.example.test",
        },
        sync: syncResult,
      });
      const made = makeCtx(
        {
          endpoint: {
            id: "tools",
            baseUrl: "https://capability.example.test",
          },
          ...body,
        },
        { connectEndpointProvider, ...overrides },
      );
      return { ...made, connectEndpointProvider };
    }

    function expectRejectedWithoutPersisting(
      made: ReturnType<typeof makeConnectCtx>,
      setting: string,
    ): void {
      expect(made.error).toHaveBeenCalledTimes(1);
      const [, message, status] = made.error.mock.calls[0] ?? [];
      expect(status).toBe(500);
      expect(String(message)).toContain(setting);
      expect(made.json).not.toHaveBeenCalled();
      expect(made.ctx.persistConfigEnv).not.toHaveBeenCalled();
      expect(made.ctx.saveConfig).not.toHaveBeenCalled();
      expect(made.connectEndpointProvider).not.toHaveBeenCalled();
    }

    it("refuses to overwrite an unparseable persisted endpoint list", async () => {
      process.env.ELIZA_CAPABILITY_ROUTER_URLS = CORRUPT_URLS;
      const made = makeConnectCtx({});

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(made, "ELIZA_CAPABILITY_ROUTER_URLS");
      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toBe(CORRUPT_URLS);
    });

    it("refuses to overwrite an unparseable endpoint list stored in config env", async () => {
      const made = makeConnectCtx({
        config: {
          env: { vars: { ELIZA_CAPABILITY_ROUTER_URLS: CORRUPT_URLS } },
        },
      });

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(made, "ELIZA_CAPABILITY_ROUTER_URLS");
      expect(made.ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_URLS).toBe(
        CORRUPT_URLS,
      );
    });

    it("refuses to overwrite an unparseable module allowlist", async () => {
      process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES = CORRUPT_ALLOWLIST;
      const made = makeConnectCtx({}, { allowedModuleIds: ["remote-plugin"] });

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(
        made,
        "ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES",
      );
      expect(process.env.ELIZA_CAPABILITY_ROUTER_ALLOWED_MODULES).toBe(
        CORRUPT_ALLOWLIST,
      );
    });

    it("refuses to overwrite an unparseable trust policy map", async () => {
      const made = makeConnectCtx({
        config: {
          env: {
            vars: {
              ELIZA_CAPABILITY_ROUTER_TRUST_POLICY: CORRUPT_TRUST_POLICY,
            },
          },
        },
      });

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(
        made,
        "ELIZA_CAPABILITY_ROUTER_TRUST_POLICY",
      );
      expect(
        made.ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_TRUST_POLICY,
      ).toBe(CORRUPT_TRUST_POLICY);
    });

    it("refuses to overwrite an unparseable trust audit log", async () => {
      const made = makeConnectCtx({
        config: {
          env: { vars: { ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT: CORRUPT_AUDIT } },
        },
      });

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(
        made,
        "ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT",
      );
      expect(
        made.ctx.config?.env?.vars?.ELIZA_CAPABILITY_ROUTER_TRUST_AUDIT,
      ).toBe(CORRUPT_AUDIT);
    });

    it("treats a persisted endpoint list that is not an array as corrupt", async () => {
      process.env.ELIZA_CAPABILITY_ROUTER_URLS = '{"id":"legacy"}';
      const made = makeConnectCtx({});

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expectRejectedWithoutPersisting(made, "ELIZA_CAPABILITY_ROUTER_URLS");
      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toBe('{"id":"legacy"}');
    });

    it("still connects without persisting when the stored list is corrupt and persist is false", async () => {
      process.env.ELIZA_CAPABILITY_ROUTER_URLS = CORRUPT_URLS;
      const made = makeConnectCtx({}, { persist: false });

      await expect(handleRemoteCapabilityRoutes(made.ctx)).resolves.toBe(true);

      expect(made.error).not.toHaveBeenCalled();
      expect(made.connectEndpointProvider).toHaveBeenCalledTimes(1);
      expect(made.json.mock.calls[0]?.[1]).toMatchObject({
        success: true,
        persisted: false,
      });
      expect(process.env.ELIZA_CAPABILITY_ROUTER_URLS).toBe(CORRUPT_URLS);
    });
  });

  it("rejects requests without endpoint or cloud configuration", async () => {
    const { ctx, error, json } = makeCtx({});

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Request body must include either 'endpoint' or 'cloud'.",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects unknown endpoint provider modes", async () => {
    const connectEndpointProvider = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        provider: "unknown-provider",
        endpoint: {
          id: "unknown-provider",
          baseUrl: "https://unknown-provider.example.test",
        },
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "provider must be one of direct, home-machine, mobile-companion, or desktop-companion.",
      400,
    );
    expect(connectEndpointProvider).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects ambiguous endpoint and cloud connect requests", async () => {
    const connectEndpointProvider = vi.fn();
    const connectCloudSandbox = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        endpoint: { baseUrl: "https://capability.example.test" },
        cloud: {
          cloudApiBase: "https://api.elizacloud.ai",
          authToken: "cloud-auth",
          name: "Cloud Tools",
        },
      },
      { connectEndpointProvider, connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Request body must include only one of 'endpoint' or 'cloud'.",
      400,
    );
    expect(connectEndpointProvider).not.toHaveBeenCalled();
    expect(connectCloudSandbox).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects cloud requests with duplicate allowlist sources", async () => {
    const connectCloudSandbox = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        allowedModuleIds: ["top-level-plugin"],
        cloud: {
          cloudApiBase: "https://api.elizacloud.ai",
          authToken: "cloud-auth",
          name: "Cloud Tools",
          allowedModuleIds: ["nested-plugin"],
        },
      },
      { connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Cloud requests must set allowedModuleIds either at the top level or inside 'cloud', not both.",
      400,
    );
    expect(connectCloudSandbox).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects malformed endpoint trust policy input", async () => {
    const connectEndpointProvider = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        endpoint: { baseUrl: "https://capability.example.test" },
        trustPolicy: {
          requireVerifiedProvenance: "yes",
        },
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "trustPolicy.requireVerifiedProvenance must be a boolean.",
      400,
    );
    expect(connectEndpointProvider).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects cloud requests with duplicate trust policy sources", async () => {
    const connectCloudSandbox = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        trustPolicy: {
          allowedProvenanceIssuers: ["top-level-build"],
        },
        cloud: {
          cloudApiBase: "https://api.elizacloud.ai",
          authToken: "cloud-auth",
          name: "Cloud Tools",
          trustPolicy: {
            allowedProvenanceIssuers: ["nested-build"],
          },
        },
      },
      { connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Cloud requests must set trustPolicy either at the top level or inside 'cloud', not both.",
      400,
    );
    expect(connectCloudSandbox).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects invalid endpoint URLs", async () => {
    const { ctx, error, json } = makeCtx({
      endpoint: { baseUrl: "file:///tmp/capability" },
    });

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "endpoint.baseUrl must use http or https.",
      400,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects endpoint URLs with embedded credentials", async () => {
    const connectEndpointProvider = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        endpoint: { baseUrl: "https://user:pass@capability.example.test" },
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "endpoint.baseUrl must not include embedded credentials.",
      400,
    );
    expect(connectEndpointProvider).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    "http://169.254.169.254/latest/meta-data",
    "http://127.0.0.1:9200/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://localhost/admin",
    "http://metadata.google.internal/",
    "http://vault.internal/",
  ])(
    "rejects an endpoint baseUrl targeting an internal address (SSRF): %s",
    async (baseUrl) => {
      const connectEndpointProvider = vi.fn();
      const { ctx, error, json } = makeCtx(
        { endpoint: { baseUrl } },
        { connectEndpointProvider },
      );

      await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

      expect(error).toHaveBeenCalledWith(
        ctx.res,
        "endpoint.baseUrl must not target a private, loopback, link-local, or internal address.",
        400,
      );
      // The unguarded fetch is never reached for a blocked target.
      expect(connectEndpointProvider).not.toHaveBeenCalled();
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("normalizes endpoint URL query and fragment out of persisted identity", async () => {
    const connectEndpointProvider = vi.fn().mockResolvedValue({
      providerId: "direct",
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test/root",
        token: "explicit-token",
      },
      sync: syncResult,
    });
    const { ctx, error, json } = makeCtx(
      {
        endpoint: {
          id: "tools",
          baseUrl: "https://capability.example.test/root?token=leak#debug",
          token: "explicit-token",
        },
        persist: false,
      },
      { connectEndpointProvider },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(connectEndpointProvider).toHaveBeenCalledWith(
      ctx.runtime,
      expect.objectContaining({
        provisionOptions: {
          endpoint: {
            id: "tools",
            baseUrl: "https://capability.example.test/root",
            token: "explicit-token",
          },
        },
      }),
    );
    expect(json.mock.calls[0]?.[1]).toMatchObject({
      endpoint: {
        id: "tools",
        baseUrl: "https://capability.example.test/root",
        hasToken: true,
      },
      persisted: false,
    });
  });

  it("rejects cloud API URLs with embedded credentials", async () => {
    const connectCloudSandbox = vi.fn();
    const { ctx, error, json } = makeCtx(
      {
        cloud: {
          cloudApiBase: "https://user:pass@api.elizacloud.ai",
          authToken: "cloud-auth",
          name: "Cloud Tools",
        },
      },
      { connectCloudSandbox },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "cloud.cloudApiBase must not include embedded credentials.",
      400,
    );
    expect(connectCloudSandbox).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("returns unavailable when no runtime is active", async () => {
    const { ctx, error } = makeCtx(
      { endpoint: { baseUrl: "https://capability.example.test" } },
      { runtime: null },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Agent runtime unavailable",
      503,
    );
  });

  it("does not handle unrelated routes", async () => {
    const { ctx, json, error } = makeCtx(
      {},
      { pathname: "/api/registry/plugins" },
    );

    await expect(handleRemoteCapabilityRoutes(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
