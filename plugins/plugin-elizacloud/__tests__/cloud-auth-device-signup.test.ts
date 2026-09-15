/**
 * Pins the ELIZAOS_CLOUD_ENABLED gate in front of CloudAuth device
 * auto-signup. The runtime is a real, uninitialized `AgentRuntime` so the
 * flag reaches the service through the production `getSetting` coercion
 * (the string "true" arrives as boolean `true`). `authenticateWithDevice` is
 * spied on the service so no network is touched.
 */
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAuthService } from "../src/services/cloud-auth";

const SCRUBBED_ENV = ["ELIZAOS_CLOUD_ENABLED", "ELIZAOS_CLOUD_API_KEY"] as const;

function makeRuntime(secrets: Record<string, string>): AgentRuntime {
  return new AgentRuntime({
    character: { name: "Eliza", bio: [], secrets },
    plugins: [],
  });
}

describe("CloudAuthService device auto-signup gate", () => {
  const savedEnv: Partial<Record<(typeof SCRUBBED_ENV)[number], string>> = {};
  let authenticateWithDevice: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const key of SCRUBBED_ENV) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    authenticateWithDevice = vi
      .spyOn(CloudAuthService.prototype, "authenticateWithDevice")
      .mockResolvedValue({
        apiKey: "eliza_test",
        userId: "user",
        organizationId: "org",
        authenticatedAt: Date.now(),
      });
  });

  afterEach(async () => {
    authenticateWithDevice.mockRestore();
    for (const key of SCRUBBED_ENV) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("real getSetting hands the service boolean true for ELIZAOS_CLOUD_ENABLED=true", () => {
    expect(makeRuntime({ ELIZAOS_CLOUD_ENABLED: "true" }).getSetting("ELIZAOS_CLOUD_ENABLED")).toBe(
      true
    );
  });

  it("runs device auto-signup when the runtime returns boolean true", async () => {
    const service = await CloudAuthService.start(makeRuntime({ ELIZAOS_CLOUD_ENABLED: "true" }));
    expect(authenticateWithDevice).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it("runs device auto-signup for the literal 1", async () => {
    const service = await CloudAuthService.start(makeRuntime({ ELIZAOS_CLOUD_ENABLED: "1" }));
    expect(authenticateWithDevice).toHaveBeenCalledTimes(1);
    await service.stop();
  });

  it.each([{ ELIZAOS_CLOUD_ENABLED: "false" }, { ELIZAOS_CLOUD_ENABLED: "0" }, {}])(
    "skips device auto-signup for %o",
    async (secrets) => {
      const service = await CloudAuthService.start(makeRuntime(secrets));
      expect(authenticateWithDevice).not.toHaveBeenCalled();
      await service.stop();
    }
  );
});
