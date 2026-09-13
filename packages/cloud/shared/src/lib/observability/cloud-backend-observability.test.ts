/** Ensures Cloud request telemetry records both successful and thrown requests. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { logger } from "../utils/logger";

import {
  clearCloudTelemetry,
  getCloudTelemetrySnapshot,
  observeCloudRequest,
  observeInferenceDependency,
} from "./cloud-backend-observability";

describe("inference dependency timing", () => {
  test("a broken diagnostic sink cannot change admission results or errors", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const audit = spyOn(logger, "audit").mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    const failure = new Error("admission refused");
    const run = (fail: boolean) =>
      observeCloudRequest(
        { id: "sink", traceId: "trace-sink", method: "POST", path: "/api/v1/embeddings" },
        async () => ({
          status: 200,
          result: await observeInferenceDependency("policy_lock", "policy_admission", async () => {
            now += 300;
            if (fail) throw failure;
            return "admitted";
          }),
        }),
      );
    try {
      expect(await run(false)).toBe("admitted");
      await expect(run(true)).rejects.toBe(failure);
      expect(audit).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
      audit.mockRestore();
    }
  });

  test("correlates overlapping requests without logging their result or credentials", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const audit = spyOn(logger, "audit").mockImplementation(() => {});
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const result = { secret: "private result" };
    const run = (traceId: string, wait: Promise<void>) =>
      observeCloudRequest(
        { id: traceId, traceId, method: "POST", path: "/api/v1/embeddings" },
        async () => ({
          status: 200,
          result: await observeInferenceDependency("durable_object", "/rate-limit", async () => {
            await wait;
            return result;
          }),
        }),
      );
    try {
      const a = run("trace-a", first.promise);
      const b = run("trace-b", second.promise);
      now = 300;
      second.resolve();
      expect(await b).toBe(result);
      now = 600;
      first.resolve();
      expect(await a).toBe(result);
      expect(audit.mock.calls).toEqual([
        [
          "[InferenceAdmission] dependency timing",
          {
            traceId: "trace-b",
            dependency: "durable_object",
            operation: "/rate-limit",
            durationMs: 300,
            outcome: "returned",
          },
        ],
        [
          "[InferenceAdmission] dependency timing",
          {
            traceId: "trace-a",
            dependency: "durable_object",
            operation: "/rate-limit",
            durationMs: 600,
            outcome: "returned",
          },
        ],
      ]);
    } finally {
      clock.mockRestore();
      audit.mockRestore();
    }
  });

  test("preserves the exact policy error and omits its private message", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const audit = spyOn(logger, "audit").mockImplementation(() => {});
    const failure = new Error("private database details");
    try {
      await expect(
        observeCloudRequest(
          {
            id: "failed",
            traceId: "trace-failed",
            method: "POST",
            path: "/api/v1/chat/completions",
          },
          async () => ({
            status: 200,
            result: await observeInferenceDependency(
              "policy_lock",
              "policy_admission",
              async () => {
                now = 250;
                throw failure;
              },
            ),
          }),
        ),
      ).rejects.toBe(failure);
      expect(audit.mock.calls).toEqual([
        [
          "[InferenceAdmission] dependency timing",
          {
            traceId: "trace-failed",
            dependency: "policy_lock",
            operation: "policy_admission",
            durationMs: 250,
            outcome: "threw",
          },
        ],
      ]);
    } finally {
      clock.mockRestore();
      audit.mockRestore();
    }
  });

  test("keeps fast calls and non-inference requests quiet", async () => {
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const audit = spyOn(logger, "audit").mockImplementation(() => {});
    try {
      for (const [path, delay] of [
        ["/api/v1/embeddings", 249],
        ["/api/v1/shared-agent", 500],
      ] as const) {
        expect(
          await observeCloudRequest(
            { id: path, traceId: path, method: "POST", path },
            async () => ({
              status: 200,
              result: await observeInferenceDependency(
                "policy_read",
                "funding_policy",
                async () => {
                  now += delay;
                  return "unchanged";
                },
              ),
            }),
          ),
        ).toBe("unchanged");
      }
      expect(audit).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      audit.mockRestore();
    }
  });
});

describe("observeCloudRequest", () => {
  beforeEach(() => clearCloudTelemetry());

  test("records the application trace id on success", async () => {
    await observeCloudRequest(
      {
        id: "request-1",
        traceId: "trace-12345678",
        method: "GET",
        path: "/health",
      },
      async () => ({ result: undefined, status: 204 }),
    );

    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-1",
      traceId: "trace-12345678",
      status: 204,
    });
  });

  test("finalizes a thrown request without intercepting the error", async () => {
    const failure = new TypeError("boom");
    await expect(
      observeCloudRequest({ id: "request-2", method: "POST", path: "/explode" }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-2",
      status: 500,
    });
  });

  test("records the final Hono error response status", async () => {
    const app = new Hono();
    app.onError((_error, c) => c.json({ error: "internal" }, 500));
    app.use("*", async (c, next) =>
      observeCloudRequest(
        {
          id: "request-hono",
          traceId: "trace-hono-12345678",
          method: c.req.method,
          path: c.req.path,
        },
        async () => {
          await next();
          return { result: undefined, status: c.res.status };
        },
      ),
    );
    app.get("/explode", () => {
      throw new Error("route failure");
    });

    expect((await app.request("/explode")).status).toBe(500);
    expect(getCloudTelemetrySnapshot().requests[0]).toMatchObject({
      id: "request-hono",
      traceId: "trace-hono-12345678",
      status: 500,
    });
  });
});

describe("telemetry threshold env parsing", () => {
  const KEYS = ["CLOUD_SLOW_DB_MS", "CLOUD_SLOW_REQUEST_MS", "CLOUD_DB_BURST_COUNT"];
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      if (!saved.has(key)) saved.set(key, process.env[key]);
    }
    clearCloudTelemetry();
  });

  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  test("ignores a trailing-garbage threshold instead of publishing its prefix", () => {
    // parseInt("500junk") is 500, so the snapshot reported a slow-DB boundary
    // of 500ms — a value nobody configured — and classified against it.
    process.env.CLOUD_SLOW_DB_MS = "500junk";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(250);
  });

  test("still honours a clean threshold", () => {
    process.env.CLOUD_SLOW_DB_MS = "500";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(500);
  });

  test("still honours an explicitly signed positive threshold", () => {
    // `Number.parseInt` accepted "+500"; rejecting it would be a regression.
    process.env.CLOUD_SLOW_DB_MS = "+500";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(500);
  });

  test("falls back for an integer beyond the safe range", () => {
    // This patch tightens the predicate from finite to safe-integer, so the
    // boundary it claims is covered explicitly.
    process.env.CLOUD_SLOW_DB_MS = "9007199254740993";
    expect(getCloudTelemetrySnapshot().thresholds.slowDbMs).toBe(250);
  });
});
