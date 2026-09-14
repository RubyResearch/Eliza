/**
 * Tests for the per-agent container memory ceiling knob in containers-env.ts.
 * `containersEnv` reads through `getCloudAwareEnv()`, which returns
 * `process.env` directly when no cloud ALS store is active (the case under
 * bun test), so we drive these by mutating + restoring the two
 * *_AGENT_MEMORY_LIMIT_MB keys.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { containersEnv } from "./containers-env";

const KEYS = ["CONTAINERS_AGENT_MEMORY_LIMIT_MB", "ELIZA_AGENT_MEMORY_LIMIT_MB"] as const;

const saved = new Map<string, string | undefined>();
function setEnv(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe("agentContainerMemoryLimitMb", () => {
  test("defaults to 6144 when unset", () => {
    setEnv({});
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(6144);
  });

  test("honors CONTAINERS_AGENT_MEMORY_LIMIT_MB", () => {
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "4096" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(4096);
  });

  test("falls back to the ELIZA_ alias", () => {
    setEnv({ ELIZA_AGENT_MEMORY_LIMIT_MB: "2048" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(2048);
  });

  test("CONTAINERS_ key wins over the ELIZA_ alias", () => {
    setEnv({
      CONTAINERS_AGENT_MEMORY_LIMIT_MB: "4096",
      ELIZA_AGENT_MEMORY_LIMIT_MB: "2048",
    });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(4096);
  });

  test("0 disables the ceiling (returns 0, not the default)", () => {
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "0" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(0);
  });

  test("floors fractional values", () => {
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "1536.9" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(1536);
  });

  test("clamps to 65536 MiB", () => {
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "1000000" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(65536);
  });

  test("rejects garbage and negative values back to the default", () => {
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "not-a-number" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(6144);
    setEnv({ CONTAINERS_AGENT_MEMORY_LIMIT_MB: "-512" });
    expect(containersEnv.agentContainerMemoryLimitMb()).toBe(6144);
  });
});
