/** Exercises Docker sandbox Headscale routing with deterministic cloud-shared fixtures. */
import { afterEach, describe, expect, test } from "bun:test";
import { resolveElizaCloudTopology } from "@elizaos/shared";
import {
  buildManagedElizaRuntimeConfig,
  DockerSandboxProvider,
  headscaleVpnEnabled,
  requiresHeadscaleRoute,
  resolveContainerPort,
  resolveDockerSandboxImage,
  resolveSandboxRegistryEnv,
  shouldCleanupHeadscaleVpn,
} from "../docker-sandbox-provider";

const savedEnv = { ...process.env };

afterEach(() => {
  // Restore env by mutation, never by reassigning `process.env`. Replacing the
  // global env object swaps out Bun's special process.env, which breaks env
  // reads (and the DNS resolver config) for every later test in the same
  // process — surfacing as unrelated env/DNS failures elsewhere in the run.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("requiresHeadscaleRoute", () => {
  test("does not require Headscale routing when Headscale is not configured", () => {
    expect(requiresHeadscaleRoute({})).toBe(false);
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "" })).toBe(false);
  });

  test("requires a persisted headscale route when Headscale is configured", () => {
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "secret" })).toBe(true);
  });

  test("requires Headscale routing for public cloud agent ingress", () => {
    expect(
      requiresHeadscaleRoute({
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "waifu.fun",
      }),
    ).toBe(true);
    expect(
      requiresHeadscaleRoute({
        CONTAINERS_PUBLIC_BASE_DOMAIN: "containers.elizacloud.ai",
      }),
    ).toBe(true);
  });

  test("requires Headscale routing for deployed cloud environments", () => {
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "production" })).toBe(true);
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "staging" })).toBe(true);
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "development" })).toBe(false);
  });

  test("requires Headscale routing when Headscale URL config is present", () => {
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_URL: "https://headscale.elizacloud.ai",
      }),
    ).toBe(true);
  });

  test("allows explicit legacy bridge-host fallback", () => {
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      }),
    ).toBe(false);
    expect(
      requiresHeadscaleRoute({
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "waifu.fun",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
  });
});

describe("headscaleVpnEnabled", () => {
  test("enabled when an API key is configured and no fallback is requested", () => {
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "secret" })).toBe(true);
  });

  test("disabled when no API key is configured", () => {
    expect(headscaleVpnEnabled({})).toBe(false);
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "" })).toBe(false);
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "   " })).toBe(false);
  });

  test("disabled when the operator opts into legacy bridge-host fallback", () => {
    // The fallback flag must also stop TS_AUTHKEY injection, not just relax the
    // route-required guard — otherwise the container entrypoint hard-`tailscale
    // up`s and dies under `set -e` on nodes that aren't on the mesh, which is
    // exactly what the flag is meant to bypass.
    expect(
      headscaleVpnEnabled({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
    expect(
      headscaleVpnEnabled({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      }),
    ).toBe(false);
  });

  test("stays consistent with requiresHeadscaleRoute under the fallback flag", () => {
    // When the fallback is on, neither the route nor the VPN enrollment is
    // required because the container boots over the bridge-host compatibility path.
    const env = {
      HEADSCALE_API_KEY: "secret",
      AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
    };
    expect(requiresHeadscaleRoute(env)).toBe(false);
    expect(headscaleVpnEnabled(env)).toBe(false);
  });
});

describe("shouldCleanupHeadscaleVpn", () => {
  test("cleans up only when VPN is enabled and a registered node name is present", () => {
    expect(shouldCleanupHeadscaleVpn({ HEADSCALE_API_KEY: "secret" }, "agent-org-example")).toBe(
      true,
    );
    expect(shouldCleanupHeadscaleVpn({ HEADSCALE_API_KEY: "secret" }, undefined)).toBe(false);
  });

  test("does not clean up fallback-mode containers even when an API key is configured", () => {
    expect(
      shouldCleanupHeadscaleVpn(
        {
          HEADSCALE_API_KEY: "secret",
          AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
        },
        "agent-org-example",
      ),
    ).toBe(false);
  });
});

describe("resolveDockerSandboxImage", () => {
  test("prefers a per-agent image over the operator default image", () => {
    expect(
      resolveDockerSandboxImage("ghcr.io/dexploarer/bnancy:latest", "ghcr.io/elizaos/eliza:stable"),
    ).toBe("ghcr.io/dexploarer/bnancy:latest");
  });

  test("uses the operator default when no per-agent image is set", () => {
    expect(resolveDockerSandboxImage(undefined, "ghcr.io/elizaos/eliza:stable")).toBe(
      "ghcr.io/elizaos/eliza:stable",
    );
  });
});

describe("buildManagedElizaRuntimeConfig", () => {
  test("writes canonical cloud runtime + inference routing for managed containers", () => {
    const config = buildManagedElizaRuntimeConfig({
      ELIZAOS_CLOUD_API_KEY: "agent-api-key",
      ELIZAOS_CLOUD_BASE_URL: "https://api.elizacloud.ai/api/v1",
      ELIZAOS_CLOUD_SMALL_MODEL: "gemma-4-31b",
      ELIZAOS_CLOUD_LARGE_MODEL: "gemma-4-31b",
      ELIZA_CLOUD_AGENT_ID: "cloud-agent-1",
    });

    const topology = resolveElizaCloudTopology(config);

    expect(config).toMatchObject({
      deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
      linkedAccounts: {
        elizacloud: { status: "linked", source: "api-key" },
      },
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
      cloud: {
        enabled: true,
        apiKey: "agent-api-key",
        baseUrl: "https://api.elizacloud.ai/api/v1",
        agentId: "cloud-agent-1",
      },
    });
    expect(topology.runtime).toBe("cloud");
    expect(topology.services.inference).toBe(true);
    expect(topology.shouldLoadPlugin).toBe(true);
  });

  test("persists configured direct embedding ownership for managed containers", () => {
    const config = buildManagedElizaRuntimeConfig({
      ELIZAOS_CLOUD_API_KEY: "agent-api-key",
      ELIZAOS_CLOUD_USE_EMBEDDINGS: "false",
      EMBEDDING_BASE_URL: "http://eliza-embedding-sidecar:80/v1",
    });

    expect(config).toMatchObject({
      serviceRouting: {
        embeddings: { backend: "embeddings", transport: "direct" },
      },
    });
  });

  test("does not invent direct embedding ownership without a configured provider", () => {
    const config = buildManagedElizaRuntimeConfig({
      ELIZAOS_CLOUD_API_KEY: "agent-api-key",
      ELIZAOS_CLOUD_USE_EMBEDDINGS: "false",
    });

    expect(config).toMatchObject({
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });
  });

  test("keeps explicit Cloud embedding opt-in on the canonical cloud-proxy route", () => {
    const config = buildManagedElizaRuntimeConfig({
      ELIZAOS_CLOUD_API_KEY: "agent-api-key",
      ELIZAOS_CLOUD_USE_EMBEDDINGS: "true",
      // A stale direct endpoint must not beat the explicit Cloud opt-in.
      EMBEDDING_BASE_URL: "http://eliza-embedding-sidecar:80/v1",
    });

    expect(config).toMatchObject({
      serviceRouting: {
        embeddings: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    });
  });
});

describe("resolveContainerPort", () => {
  const baseConfig = {
    agentId: "11111111-1111-4111-8111-111111111111",
    agentName: "BNancy",
    organizationId: "22222222-2222-4222-8222-222222222222",
    executionTier: "dedicated-always" as const,
  };

  test("uses HTTP_PORT when PORT is absent", () => {
    expect(
      resolveContainerPort({
        ...baseConfig,
        environmentVars: { HTTP_PORT: "3000" },
      }),
    ).toBe("3000");
  });

  test("prefers PORT over HTTP_PORT", () => {
    expect(
      resolveContainerPort({
        ...baseConfig,
        environmentVars: { PORT: "2138", HTTP_PORT: "3000" },
      }),
    ).toBe("2138");
  });
});

describe("DockerSandboxProvider Headscale route guard", () => {
  test("rejects public cloud provisioning before a sandbox can be marked running without Headscale config", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "waifu.fun";
    process.env.HEADSCALE_API_KEY = "";
    process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = "";

    const provider = new DockerSandboxProvider();

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Suki",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {},
        startFundedContainer: async () => {
          throw new Error("Missing route cannot start a container");
        },
      }),
    ).rejects.toThrow("HEADSCALE_API_KEY is not configured");
  });
});

describe("resolveSandboxRegistryEnv (#8756)", () => {
  const env = (overrides: Record<string, string | undefined> = {}) =>
    ({
      SANDBOX_REGISTRY_REDIS_URL: undefined,
      SANDBOX_REGISTRY_REDIS_TOKEN: undefined,
      KV_REST_API_URL: undefined,
      KV_REST_API_TOKEN: undefined,
      ...overrides,
    }) as NodeJS.ProcessEnv;

  test("no backend configured → cannot self-register, no warning", () => {
    const r = resolveSandboxRegistryEnv(env());
    expect(r.url).toBe("");
    expect(r.canSelfRegister).toBe(false);
    expect(r.schemeWarning).toBeNull();
  });

  test("a redis:// URL self-registers without a token (TCP carries auth)", () => {
    const r = resolveSandboxRegistryEnv(
      env({ SANDBOX_REGISTRY_REDIS_URL: "redis://user:pw@proxy.example:6379" }),
    );
    expect(r.url).toBe("redis://user:pw@proxy.example:6379");
    expect(r.isTcp).toBe(true);
    expect(r.canSelfRegister).toBe(true);
    expect(r.schemeWarning).toBeNull();
  });

  test("rediss:// (TLS) is also TCP", () => {
    expect(
      resolveSandboxRegistryEnv(env({ SANDBOX_REGISTRY_REDIS_URL: "rediss://h:6379" })).isTcp,
    ).toBe(true);
  });

  test("an https Upstash URL needs a token to self-register", () => {
    expect(
      resolveSandboxRegistryEnv(env({ SANDBOX_REGISTRY_REDIS_URL: "https://up.example" }))
        .canSelfRegister,
    ).toBe(false);
    const withToken = resolveSandboxRegistryEnv(
      env({
        SANDBOX_REGISTRY_REDIS_URL: "https://up.example",
        SANDBOX_REGISTRY_REDIS_TOKEN: "tok",
      }),
    );
    expect(withToken.canSelfRegister).toBe(true);
    expect(withToken.token).toBe("tok");
    expect(withToken.schemeWarning).toBeNull();
  });

  test("explicit SANDBOX_REGISTRY_* wins over legacy KV_REST_API_*, and does NOT borrow the legacy token", () => {
    const r = resolveSandboxRegistryEnv(
      env({
        SANDBOX_REGISTRY_REDIS_URL: "redis://explicit:6379",
        KV_REST_API_URL: "https://legacy.example",
        KV_REST_API_TOKEN: "legacy-tok",
      }),
    );
    expect(r.url).toBe("redis://explicit:6379");
    expect(r.token).toBe("");
  });

  test("legacy KV_REST_API_URL + token self-registers", () => {
    const r = resolveSandboxRegistryEnv(
      env({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-tok" }),
    );
    expect(r.url).toBe("https://kv.example");
    expect(r.token).toBe("kv-tok");
    expect(r.canSelfRegister).toBe(true);
  });

  test("an unexpected scheme that still self-registers surfaces a warning", () => {
    const r = resolveSandboxRegistryEnv(
      env({
        SANDBOX_REGISTRY_REDIS_URL: "ws://weird.example",
        SANDBOX_REGISTRY_REDIS_TOKEN: "t",
      }),
    );
    expect(r.canSelfRegister).toBe(true);
    expect(r.schemeWarning).toContain("unexpected scheme (ws:)");
  });

  test("trims whitespace around the URL", () => {
    expect(
      resolveSandboxRegistryEnv(env({ SANDBOX_REGISTRY_REDIS_URL: "  redis://h:6379  " })).url,
    ).toBe("redis://h:6379");
  });
});
