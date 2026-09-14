/**
 * Pins the remote managed-container pairing mode at the pure env helper and
 * the Docker provider boundary without reaching SSH or a live node.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";

afterEach(() => {
  mock.restore();
});

describe("applyRemoteDockerRuntimeMode", () => {
  test("preserves unrelated values while overriding a historical direct-relay opt-in", () => {
    const stored = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "0.0.0.0/0",
      ELIZA_API_TOKEN: "agent-token",
    };

    expect(applyRemoteDockerRuntimeMode(stored)).toEqual({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      ELIZA_API_TOKEN: "agent-token",
    });
    expect(stored.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
    expect(stored.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS).toBe("0.0.0.0/0");
  });

  test("drops the terminal-run token under its eliza name and its brand partner", () => {
    // The platform never sets this key; its absence is what keeps command
    // execution off. `readAliasedEnv` resolves both spellings to one value, so
    // stripping only the ELIZA_ one would leave the switch reachable.
    const applied = applyRemoteDockerRuntimeMode({
      ELIZA_TERMINAL_RUN_TOKEN: "caller-set",
      ACME_TERMINAL_RUN_TOKEN: "caller-set-via-brand-prefix",
      VITE_ACME_TERMINAL_RUN_TOKEN: "caller-set-via-vite-partner",
      CUSTOM_SETTING: "preserved",
    });

    expect(applied).not.toHaveProperty("ELIZA_TERMINAL_RUN_TOKEN");
    expect(applied).not.toHaveProperty("ACME_TERMINAL_RUN_TOKEN");
    expect(applied).not.toHaveProperty("VITE_ACME_TERMINAL_RUN_TOKEN");
    expect(applied.CUSTOM_SETTING).toBe("preserved");
  });

  test("drops the skill download origins and unscanned skill directories", () => {
    // Repointing any of these makes "install a skill" fetch caller-hosted code,
    // which the installer only content-scans for JS/TS.
    const applied = applyRemoteDockerRuntimeMode({
      SKILLS_REGISTRY: "https://attacker.example",
      CLAWHUB_REGISTRY: "https://attacker.example",
      SKILLS_MARKETPLACE_URL: "https://attacker.example",
      WORKSPACE_SKILLS_DIR: "/tmp/caller",
      EXTRA_SKILLS_DIRS: "/tmp/caller",
      OPENAI_API_KEY: "kept",
    });

    expect(Object.keys(applied).sort()).toEqual([
      "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
      "OPENAI_API_KEY",
    ]);
  });

  test("drops the auth bypasses and self-modification switches", () => {
    // Each is permissive when set and absent by default, so a caller who can
    // set one turns it on. DEV_MODE and NODE_ENV are the pair self-edit needs;
    // the caller supplies both.
    const applied = applyRemoteDockerRuntimeMode({
      ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: "1",
      ELIZA_DEV_AUTH_BYPASS: "1",
      ELIZA_ALLOW_NULL_ORIGIN: "1",
      ELIZA_ENABLE_SELF_EDIT: "1",
      ELIZA_DEV_MODE: "1",
      ELIZA_CAPABILITY_ROUTER_URLS: '["https://attacker.example"]',
      ELIZA_CAPABILITY_ROUTER_TOKEN: "caller-set",
      AGENT_NAME: "kept",
    });

    expect(Object.keys(applied).sort()).toEqual(["AGENT_NAME", "ELIZA_CLOUD_PAIR_DIRECT_RELAY"]);
  });
});

describe("DockerSandboxProvider remote runtime mode", () => {
  test("forces the flag before every remote create attempt", async () => {
    const provider = new DockerSandboxProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: { environmentVars: Record<string, string> }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("captured remote create config"));
    const callerEnvironment = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "0.0.0.0/0",
      CUSTOM_SETTING: "preserved",
    };

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Remote pairing guard",
        startFundedContainer: async () => {
          throw new Error("Configuration capture cannot start a container");
        },
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: callerEnvironment,
      }),
    ).rejects.toThrow("captured remote create config");

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(createOnce.mock.calls[0]?.[0].environmentVars).toMatchObject({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      CUSTOM_SETTING: "preserved",
    });
    expect(createOnce.mock.calls[0]?.[0].environmentVars).not.toHaveProperty(
      "ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS",
    );
    expect(callerEnvironment.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
  });

  test("strips caller-set execution keys before the remote create attempt", async () => {
    // The pure-helper cases above only prove the function is correct. This one
    // proves the create path actually runs it on a stored row, which is what
    // covers the surfaces that accept environmentVars with no denylist and the
    // rows already carrying these keys.
    const provider = new DockerSandboxProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: { environmentVars: Record<string, string> }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("captured remote create config"));

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Execution key guard",
        startFundedContainer: async () => {
          throw new Error("Configuration capture cannot start a container");
        },
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {
          ELIZA_TERMINAL_RUN_TOKEN: "caller-set",
          SKILLS_REGISTRY: "https://attacker.example",
          CUSTOM_SETTING: "preserved",
        },
      }),
    ).rejects.toThrow("captured remote create config");

    const forwarded = createOnce.mock.calls[0]?.[0].environmentVars;
    expect(forwarded).not.toHaveProperty("ELIZA_TERMINAL_RUN_TOKEN");
    expect(forwarded).not.toHaveProperty("SKILLS_REGISTRY");
    expect(forwarded).toMatchObject({ CUSTOM_SETTING: "preserved" });
  });
});
