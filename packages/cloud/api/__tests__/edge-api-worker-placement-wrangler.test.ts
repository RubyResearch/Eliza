/**
 * Validates the Worker deployment configuration through pinned Wrangler and
 * prohibits inferred placement for the mixed API/Durable Object workload.
 * Explicit region hints remain operator choices; this does not prove latency
 * or remote region availability.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { unstable_readConfig as readConfig } from "wrangler";

const workerConfig = fileURLToPath(
  new URL("../wrangler.toml", import.meta.url),
);

describe("edge/API Worker placement", () => {
  test("validates each deployment environment without inferred placement", () => {
    for (const env of [undefined, "staging", "production"]) {
      const config = readConfig(
        { config: workerConfig, env },
        { hideWarnings: true },
      );
      const placement = config.placement;
      if (placement === undefined) continue;
      expect(placement.mode, env ?? "top level").toBe("targeted");
      expect(
        placement.region?.trim().length,
        env ?? "top level",
      ).toBeGreaterThan(0);
    }
  });
});
