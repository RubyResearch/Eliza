/**
 * Pins the Discord gateway's `KEDA_COOLDOWN_SECONDS` boundary: the router
 * refuses an invalid value at module load with a typed error naming the
 * variable, applies the 900 s default when unset, and hands a valid value to
 * `redis.expire` unchanged. Real module evaluation against a fake Redis.
 */

import { describe, expect, test } from "bun:test";

type ServerRouterModule = typeof import("../src/server-router");

const saved = new Map<string, string | undefined>();
function stub(key: string, value: string | undefined): void {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restore(): void {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
}

function loadRouter(label: string): Promise<ServerRouterModule> {
  return import(`../src/server-router?keda=${label}-${Date.now()}`);
}

function fakeRedis(): {
  expireSeconds: number[];
  redis: Parameters<ServerRouterModule["refreshKedaActivity"]>[0];
} {
  const expireSeconds: number[] = [];
  return {
    expireSeconds,
    redis: {
      lpush: async () => 1,
      ltrim: async () => "OK",
      expire: async (_key: string, seconds: number) => {
        expireSeconds.push(seconds);
        return 1;
      },
    },
  };
}

describe("gateway-discord KEDA_COOLDOWN_SECONDS", () => {
  for (const configured of ["abc", "-5", ""]) {
    test(`refuses ${JSON.stringify(configured)} at module load`, async () => {
      stub("KEDA_COOLDOWN_SECONDS", configured);
      try {
        let thrown: unknown;
        try {
          await loadRouter(`invalid-${configured.length}`);
        } catch (error) {
          thrown = error;
        }
        // Shape, not `instanceof`: the service and its test may load
        // `@elizaos/core` through different module instances.
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown).toMatchObject({
          name: "ElizaError",
          code: "INVALID_GATEWAY_INTEGER_ENV",
          context: { envKey: "KEDA_COOLDOWN_SECONDS", configured },
          severity: "fatal",
        });
      } finally {
        restore();
      }
    }, 30_000);
  }

  test("defaults to 900 seconds when unset", async () => {
    stub("KEDA_COOLDOWN_SECONDS", undefined);
    try {
      const router = await loadRouter("unset");
      const { redis, expireSeconds } = fakeRedis();
      await router.refreshKedaActivity(redis, "srv-1");
      expect(expireSeconds).toEqual([900]);
    } finally {
      restore();
    }
  }, 30_000);

  test('passes "120" to redis.expire as 120', async () => {
    stub("KEDA_COOLDOWN_SECONDS", "120");
    try {
      const router = await loadRouter("valid");
      const { redis, expireSeconds } = fakeRedis();
      await router.refreshKedaActivity(redis, "srv-1");
      expect(expireSeconds).toEqual([120]);
    } finally {
      restore();
    }
  }, 30_000);
});
