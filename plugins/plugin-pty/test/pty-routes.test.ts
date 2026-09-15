/**
 * Route-handler coverage for the PTY spawn/list/buffered-output/stop endpoints,
 * driven against a real `PtyService` backed by an injected fake spawn
 * (`makeFakeSpawn`) — no OS PTY. Exercises the terminal-token gate, the
 * interactive/vendor enable flags, session-kind validation, and error responses.
 */
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ELIZA_CLOUD_FAST_MODEL,
  ELIZA_CLOUD_SMART_MODEL,
} from "../lib/eliza-code-spec";
import { ptyRoutes } from "../routes/pty-routes";
import { PtyService } from "../services/pty-service";
import { makeFakeSpawn, type SpawnCall } from "./fake-pty";

// A real file that always exists, so resolveElizaCodeBin() succeeds in tests.
const EXISTING_FILE = fileURLToPath(import.meta.url);

const routeByName = (name: string) => {
  const r = ptyRoutes.find((x) => x.name === name);
  if (!r?.routeHandler) throw new Error(`route ${name} missing`);
  return r.routeHandler;
};

interface Harness {
  runtime: IAgentRuntime;
  svc: PtyService | null;
  calls: SpawnCall[];
  fake: ReturnType<typeof makeFakeSpawn>;
}

function makeHarness(opts?: {
  settings?: Record<string, string>;
  noService?: boolean;
}): Harness {
  const fake = makeFakeSpawn();
  const svc = opts?.noService
    ? null
    : new PtyService(undefined, fake.resolver, { allowedRoot: process.cwd() });
  const settings = opts?.settings ?? {};
  const runtime = {
    getSetting: (k: string) => settings[k],
    getService: (t: string) => (t === "PTY_SERVICE" ? svc : null),
  } as unknown as IAgentRuntime;
  return { runtime, svc, calls: fake.calls, fake };
}

function ctx(
  runtime: IAgentRuntime,
  body?: unknown,
  params?: Record<string, string>,
  opts?: {
    headers?: Record<string, string>;
    query?: Record<string, string>;
    inProcess?: boolean;
    isTrustedLocal?: boolean;
  },
) {
  return {
    body,
    params: params ?? {},
    query: opts?.query ?? {},
    headers: opts?.headers ?? {},
    method: "POST",
    path: "/api/pty/sessions",
    runtime,
    inProcess: opts?.inProcess ?? true,
    isTrustedLocal: opts?.isTrustedLocal ?? false,
  };
}

// Keep the eliza-code bin resolution deterministic and isolate every Cloud
// authority/key/base input the route or child-spec policy can consult.
const CLOUD_ENV_KEYS = [
  "ELIZA_CODE_BIN",
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "PTY_ELIZA_CLOUD_API_KEY",
  "PTY_ALLOWED_BASE_URLS",
  "PTY_ELIZA_CLOUD_BASE_URL_ALLOWLIST",
] as const;
const savedCloudEnv = Object.fromEntries(
  CLOUD_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof CLOUD_ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of CLOUD_ENV_KEYS) delete process.env[key];
  process.env.ELIZA_CODE_BIN = EXISTING_FILE;
});
afterEach(() => {
  for (const key of CLOUD_ENV_KEYS) {
    const value = savedCloudEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("POST /api/pty/sessions", () => {
  it("403s HTTP callers when no terminal token is configured", async () => {
    const h = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk-cloud" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        inProcess: false,
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/terminal token/i);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts trusted local HTTP cockpit callers without exposing a terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-elizaos-client-id": "client-1" },
        inProcess: false,
        isTrustedLocal: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    const session = (res.body as { session: { ownerClientId?: string } })
      .session;
    expect(session.ownerClientId).toBe("client-1");
  });

  it("401s HTTP callers that omit a configured terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        inProcess: false,
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/missing/i);
    expect(h.calls).toHaveLength(0);
  });

  it("401s HTTP callers with an invalid terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "wrong" },
        inProcess: false,
      }),
    );
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/invalid/i);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts HTTP callers with the configured terminal token", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk-cloud",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "pty-secret" },
        inProcess: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it("spawns an interactive eliza-code session and returns its id", async () => {
    const h = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk-cloud" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "eliza-code", cwd: process.cwd(), tier: "smart" }),
    );
    expect(res.status).toBe(200);
    const session = (res.body as { session: { sessionId: string } }).session;
    expect(session.sessionId).toMatch(/[0-9a-f-]{36}/);
    // Real spawn wiring: bun runs the interactive bin with cerebras env.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].file).toBe("bun");
    expect(h.calls[0].args).toEqual([
      EXISTING_FILE,
      "--interactive",
      "--coding-only",
    ]);
    expect(h.calls[0].opts.env?.ELIZA_CODE_CODING_ONLY).toBe("1");
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-cloud");
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe(
      ELIZA_CLOUD_FAST_MODEL,
    );
  });

  it("403 when interactive spawning is disabled", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_INTERACTIVE_ENABLED: "false",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("403s for explicit non-truthy interactive settings", async () => {
    for (const value of [" FALSE ", "off", "no", "disable-please"]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(403);
      expect(h.calls, value).toHaveLength(0);
    }
  });

  it("accepts explicit truthy interactive settings", async () => {
    for (const value of ["true", "1", "on", "YES"]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(200);
      expect(h.calls, value).toHaveLength(1);
    }
  });

  it("403 on store builds", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        ELIZA_BUILD_VARIANT: "store",
      },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(403);
  });

  it("503 when PTY_SERVICE is not registered", async () => {
    const h = makeHarness({
      noService: true,
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" },
    });
    const res = await routeByName("pty-spawn-session")(ctx(h.runtime, {}));
    expect(res.status).toBe(503);
  });

  it("400 on an unsupported session kind", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "bash" }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/unsupported/i);
  });

  it("400 when no Eliza Cloud API key is available", async () => {
    const h = makeHarness({ settings: {} }); // no key anywhere
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/api key/i);
  });

  it("does not fall back to the agent primary OPENAI_API_KEY", async () => {
    const h = makeHarness({ settings: { OPENAI_API_KEY: "sk-primary" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("accepts an apiKey supplied in the body", async () => {
    const h = makeHarness({ settings: {} });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { apiKey: "sk-body", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("sk-body");
  });

  it.each(["staging-default", "offline"] as const)(
    "403s the Eliza Cloud lane under %s authority despite body/runtime/process overrides",
    async (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "inherited-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      process.env.PTY_ELIZA_CLOUD_API_KEY = "process-pty-key";
      const h = makeHarness({
        settings: {
          ELIZAOS_CLOUD_API_KEY: "runtime-canonical-key",
          ELIZAOS_CLOUD_BASE_URL: "https://runtime.example/api/v1",
          PTY_ELIZA_CLOUD_API_KEY: "runtime-pty-key",
          PTY_ALLOWED_BASE_URLS: "https://attacker.example/v1",
        },
      });

      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, {
          kind: "eliza-code",
          cwd: process.cwd(),
          apiKey: "body-key",
          baseUrl: "https://attacker.example/v1",
        }),
      );

      expect(res.status).toBe(403);
      expect((res.body as { error: string }).error).toMatch(/disabled/i);
      expect(h.calls).toHaveLength(0);
    },
  );

  it("uses only the frozen explicit staging tuple across body/runtime/process overrides", async () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-launch-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    process.env.PTY_ELIZA_CLOUD_API_KEY = "process-pty-key";
    const h = makeHarness({
      settings: {
        ELIZAOS_CLOUD_API_KEY: "runtime-canonical-key",
        ELIZAOS_CLOUD_BASE_URL: "https://runtime.example/api/v1",
        PTY_ELIZA_CLOUD_API_KEY: "runtime-pty-key",
        PTY_ALLOWED_BASE_URLS: "https://attacker.example/v1",
      },
    });

    const first = await routeByName("pty-spawn-session")(
      ctx(h.runtime, {
        kind: "eliza-code",
        cwd: process.cwd(),
        apiKey: "body-key",
        // Deliberately not allowlisted by the route. Authority must ignore it
        // before parsing rather than reject or adopt it.
        baseUrl: "https://untrusted.example/v1",
      }),
    );
    expect(first.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBe("staging-launch-key");
    expect(h.calls[0].opts.env?.OPENAI_BASE_URL).toBe(
      "https://api-staging.eliza.app/v1",
    );

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    const second = await routeByName("pty-spawn-session")(
      ctx(h.runtime, {
        kind: "eliza-code",
        cwd: process.cwd(),
        apiKey: "second-body-key",
        baseUrl: "not a URL",
      }),
    );
    expect(second.status).toBe(200);
    expect(h.calls[1].opts.env?.OPENAI_API_KEY).toBe("staging-launch-key");
    expect(h.calls[1].opts.env?.OPENAI_BASE_URL).toBe(
      "https://api-staging.eliza.app/v1",
    );
  });

  it("uses operator-pinned tier model fallbacks", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_FAST_MODEL: "fast-pin",
        PTY_ELIZA_CLOUD_SMART_MODEL: "smart-pin",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("fast-pin");
    expect(h.calls[0].opts.env?.OPENAI_MEDIUM_MODEL).toBe("fast-pin");
    expect(h.calls[0].opts.env?.OPENAI_LARGE_MODEL).toBe("smart-pin");
  });

  it("lets request body tier models override operator fallbacks", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_FAST_MODEL: "fast-pin",
        PTY_ELIZA_CLOUD_SMART_MODEL: "smart-pin",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, {
        cwd: process.cwd(),
        fastModel: "fast-body",
        smartModel: "smart-body",
      }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_SMALL_MODEL).toBe("fast-body");
    expect(h.calls[0].opts.env?.OPENAI_MEDIUM_MODEL).toBe("fast-body");
    expect(h.calls[0].opts.env?.OPENAI_LARGE_MODEL).toBe("smart-body");
  });

  it("rejects unallowlisted base URLs and accepts explicit operator allowlist", async () => {
    const rejected = makeHarness({
      settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" },
    });
    const blocked = await routeByName("pty-spawn-session")(
      ctx(rejected.runtime, {
        cwd: process.cwd(),
        baseUrl: "https://attacker.example/v1",
      }),
    );
    expect(blocked.status).toBe(400);
    expect((blocked.body as { error: string }).error).toMatch(/baseUrl/i);
    expect(rejected.calls).toHaveLength(0);

    const allowed = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ALLOWED_BASE_URLS: "https://staging.example/v1",
      },
    });
    const ok = await routeByName("pty-spawn-session")(
      ctx(allowed.runtime, {
        cwd: process.cwd(),
        baseUrl: "https://staging.example/v1/",
      }),
    );
    expect(ok.status).toBe(200);
    expect(allowed.calls[0].opts.env?.OPENAI_BASE_URL).toBe(
      "https://staging.example/v1",
    );
  });
});

// The experimental vendor-CLI tier (#10832 Phase 2): interactive claude/codex
// on the user's own subscription. Gated by PTY_VENDOR_CLI_ENABLED — a SEPARATE
// gate from PTY_INTERACTIVE_ENABLED that defaults OFF.
describe("POST /api/pty/sessions — vendor CLI tier (kind claude/codex)", () => {
  // Pin the launcher overrides and clear any host credential env so results
  // don't depend on what happens to be installed/configured on this machine.
  const vendorEnvKeys = [
    "PTY_CLAUDE_BIN",
    "PTY_CODEX_BIN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CODEX_HOME",
    "PTY_VENDOR_CLI_ENABLED",
  ] as const;
  const savedVendorEnv = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of vendorEnvKeys) {
      savedVendorEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.PTY_CLAUDE_BIN = EXISTING_FILE;
    process.env.PTY_CODEX_BIN = EXISTING_FILE;
  });
  afterEach(() => {
    for (const [key, value] of savedVendorEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedVendorEnv.clear();
  });

  it("403s kind claude/codex by default (gate off) even though interactive spawning is on", async () => {
    for (const kind of ["claude", "codex"]) {
      const h = makeHarness({ settings: {} });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { kind, cwd: process.cwd() }),
      );
      expect(res.status, kind).toBe(403);
      expect((res.body as { error: string }).error, kind).toMatch(
        /PTY_VENDOR_CLI_ENABLED/,
      );
      expect(h.calls, kind).toHaveLength(0);
    }
  });

  it("fails closed on truthy-looking but unrecognized gate values", async () => {
    for (const value of ["enabled", "yep", "2", "y", "TRUE!"]) {
      const h = makeHarness({
        settings: { PTY_VENDOR_CLI_ENABLED: value },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(403);
      expect(h.calls, value).toHaveLength(0);
    }
  });

  it("spawns an interactive claude session when the gate is explicitly on", async () => {
    for (const value of ["true", "1", "on", " YES "]) {
      const h = makeHarness({
        settings: { PTY_VENDOR_CLI_ENABLED: value },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
      );
      expect(res.status, value).toBe(200);
      expect(h.calls, value).toHaveLength(1);
      // The plain interactive TUI — the resolved launcher, zero one-shot args.
      expect(h.calls[0].file, value).toBe(EXISTING_FILE);
      expect(h.calls[0].args, value).toEqual([]);
    }
  });

  it("spawns an interactive codex session when the gate is on", async () => {
    const h = makeHarness({
      settings: { PTY_VENDOR_CLI_ENABLED: "true" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "codex", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].file).toBe(EXISTING_FILE);
    expect(h.calls[0].args).toEqual([]);
    const session = (res.body as { session: { kind?: string; label?: string } })
      .session;
    expect(session.kind).toBe("codex");
    expect(session.label).toBe("codex · interactive");
  });

  it("vendor kinds do not require the Eliza Cloud API key", async () => {
    // No PTY_ELIZA_CLOUD_API_KEY configured anywhere — the vendor CLIs
    // authenticate with the user's own subscription, not Eliza Cloud.
    const h = makeHarness({
      settings: { PTY_VENDOR_CLI_ENABLED: "true" },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.OPENAI_API_KEY).toBeUndefined();
  });

  it("passes the claude OAuth token through to the child env when configured", async () => {
    const h = makeHarness({
      settings: {
        PTY_VENDOR_CLI_ENABLED: "true",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    // Proves the whole pipeline: route → spec builder → store env allowlist.
    expect(h.calls[0].opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat-test",
    );
  });

  it("omits the claude OAuth token when none is configured (CLI uses ~/.claude credentials)", async () => {
    const h = makeHarness({ settings: { PTY_VENDOR_CLI_ENABLED: "true" } });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    // HOME survives the safe inherited-env allowlist so the CLI can read its
    // own credential file.
    expect(h.calls[0].opts.env?.HOME).toBe(process.env.HOME);
  });

  it("passes CODEX_HOME through to the codex child env when configured", async () => {
    const h = makeHarness({
      settings: {
        PTY_VENDOR_CLI_ENABLED: "true",
        CODEX_HOME: "/accounts/codex-a1",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "codex", cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0].opts.env?.CODEX_HOME).toBe("/accounts/codex-a1");
  });

  it("403s vendor kinds on store builds even with the gate explicitly on", async () => {
    for (const kind of ["claude", "codex"]) {
      const h = makeHarness({
        settings: {
          PTY_VENDOR_CLI_ENABLED: "true",
          PTY_INTERACTIVE_ENABLED: "true",
          ELIZA_BUILD_VARIANT: "store",
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { kind, cwd: process.cwd() }),
      );
      expect(res.status, kind).toBe(403);
      expect(h.calls, kind).toHaveLength(0);
    }
  });

  it("403s vendor kinds when interactive spawning is disabled, regardless of the vendor gate", async () => {
    const h = makeHarness({
      settings: {
        PTY_VENDOR_CLI_ENABLED: "true",
        PTY_INTERACTIVE_ENABLED: "false",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
    );
    expect(res.status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("400s with actionable guidance when the vendor CLI is not installed", async () => {
    delete process.env.PTY_CLAUDE_BIN;
    const h = makeHarness({ settings: { PTY_VENDOR_CLI_ENABLED: "true" } });
    // Pin PATH lookup to an empty dir so a real host install can't satisfy it.
    const savedPath = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-for-pty-test";
    try {
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { kind: "claude", cwd: process.cwd() }),
      );
      expect(res.status).toBe(400);
      expect((res.body as { error: string }).error).toMatch(/PTY_CLAUDE_BIN/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe("GET + DELETE /api/pty/sessions", () => {
  it("requires terminal authorization to list or stop sessions over HTTP", async () => {
    const h = makeHarness({
      settings: {
        OPENAI_API_KEY: "sk",
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        ELIZA_TERMINAL_RUN_TOKEN: "pty-secret",
      },
    });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }, undefined, {
        headers: { "x-eliza-terminal-token": "pty-secret" },
        inProcess: false,
      }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;

    const list = await routeByName("pty-list-sessions")(
      ctx(h.runtime, undefined, undefined, { inProcess: false }),
    );
    expect(list.status).toBe(401);

    const stop = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, { id }, { inProcess: false }),
    );
    expect(stop.status).toBe(401);
    expect(h.svc?.hasSession(id)).toBe(true);
  });

  it("lists live sessions", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const res = await routeByName("pty-list-sessions")(ctx(h.runtime));
    expect(res.status).toBe(200);
    expect((res.body as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("returns buffered output for a live session", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;
    h.fake.ptys[0].emitData("ready> ");

    const res = await routeByName("pty-buffered-output")(
      ctx(h.runtime, undefined, { id }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { output: string }).output).toBe("ready> ");
  });

  it("404s buffered output for an unknown session so clients can fall back", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-buffered-output")(
      ctx(h.runtime, undefined, { id: "missing" }),
    );
    expect(res.status).toBe(404);
  });

  it("stops a session by id", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const spawn = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    const id = (spawn.body as { session: { sessionId: string } }).session
      .sessionId;
    const res = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, { id }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(h.svc?.hasSession(id)).toBe(false);
  });

  it("400 when stopping without an id", async () => {
    const h = makeHarness({ settings: { PTY_ELIZA_CLOUD_API_KEY: "sk" } });
    const res = await routeByName("pty-stop-session")(
      ctx(h.runtime, undefined, {}),
    );
    expect(res.status).toBe(400);
  });
});

// Regression edges for #11040 / #10830. The truthy-allowlist and both-tier
// model pins are covered above; these lock the remaining branches of the
// fail-closed `interactiveEnabled` gate and prove the two model env fallbacks
// (`?? PTY_ELIZA_CLOUD_FAST_MODEL` / `?? PTY_ELIZA_CLOUD_SMART_MODEL`) are
// independent — a bug that swaps or collapses them would still spawn, so only
// the resolved model env can catch it.
describe("PTY interactive gate + model fallbacks (regression edges)", () => {
  it("defaults to enabled when the flag is unset or empty", async () => {
    for (const settings of [
      { PTY_ELIZA_CLOUD_API_KEY: "sk" }, // flag absent
      { PTY_ELIZA_CLOUD_API_KEY: "sk", PTY_INTERACTIVE_ENABLED: "" },
      { PTY_ELIZA_CLOUD_API_KEY: "sk", PTY_INTERACTIVE_ENABLED: "   " },
    ]) {
      const h = makeHarness({ settings });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, JSON.stringify(settings)).toBe(200);
      expect(h.calls, JSON.stringify(settings)).toHaveLength(1);
    }
  });

  it("normalizes case + surrounding whitespace before the truthy allowlist", async () => {
    for (const value of [" TrUe ", "\tON\n", " 1 ", "  yEs  "]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, JSON.stringify(value)).toBe(200);
      expect(h.calls, JSON.stringify(value)).toHaveLength(1);
    }
  });

  it("fails closed on a truthy-looking but unrecognized flag", async () => {
    // A plausible operator typo that is NOT in the allowlist must disable
    // spawning rather than silently leave it on.
    for (const value of [" enabled ", "yep", "2", "y"]) {
      const h = makeHarness({
        settings: {
          PTY_ELIZA_CLOUD_API_KEY: "sk",
          PTY_INTERACTIVE_ENABLED: value,
        },
      });
      const res = await routeByName("pty-spawn-session")(
        ctx(h.runtime, { cwd: process.cwd() }),
      );
      expect(res.status, JSON.stringify(value)).toBe(403);
      expect(h.calls, JSON.stringify(value)).toHaveLength(0);
    }
  });

  it("applies the FAST tier env fallback without touching the SMART default", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_FAST_MODEL: "fast-only",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    const env = h.calls[0].opts.env;
    expect(env?.OPENAI_SMALL_MODEL).toBe("fast-only");
    expect(env?.OPENAI_MEDIUM_MODEL).toBe("fast-only");
    // SMART unset → the cerebras default, not the FAST pin.
    expect(env?.OPENAI_LARGE_MODEL).toBe(ELIZA_CLOUD_SMART_MODEL);
  });

  it("applies the SMART tier env fallback without touching the FAST default", async () => {
    const h = makeHarness({
      settings: {
        PTY_ELIZA_CLOUD_API_KEY: "sk",
        PTY_ELIZA_CLOUD_SMART_MODEL: "smart-only",
      },
    });
    const res = await routeByName("pty-spawn-session")(
      ctx(h.runtime, { cwd: process.cwd() }),
    );
    expect(res.status).toBe(200);
    const env = h.calls[0].opts.env;
    // FAST unset → the cerebras default, not the SMART pin.
    expect(env?.OPENAI_SMALL_MODEL).toBe(ELIZA_CLOUD_FAST_MODEL);
    expect(env?.OPENAI_MEDIUM_MODEL).toBe(ELIZA_CLOUD_FAST_MODEL);
    expect(env?.OPENAI_LARGE_MODEL).toBe("smart-only");
  });
});
