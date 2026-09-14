/** Proves missing eliza-app credentials fail locally before shared rate-limit infrastructure. */

import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const limiterCalls = mock(() => undefined);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { STANDARD: {} },
  rateLimit:
    () => async (c: { json: (body: unknown, status: number) => Response }) => {
      limiterCalls();
      return c.json({ code: "RATE_LIMIT_UNAVAILABLE" }, 503);
    },
}));

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppSessionService: {
    validateAuthHeader: mock(async () => null),
  },
  elizaAppUserService: {
    getById: mock(async () => null),
    update: mock(async () => null),
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), warn: mock(), info: mock() },
}));

const { default: route } = await import("./route");
const app = new Hono().route("/api/eliza-app/user/phone", route);

test("missing Authorization returns 401 without consulting the distributed limiter", async () => {
  limiterCalls.mockClear();

  const response = await app.request("/api/eliza-app/user/phone", {
    method: "POST",
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({
    success: false,
    error: "Authorization header required",
    code: "UNAUTHORIZED",
  });
  expect(limiterCalls).not.toHaveBeenCalled();
});

test("an authenticated-shaped request still traverses the standard limiter", async () => {
  limiterCalls.mockClear();

  const response = await app.request("/api/eliza-app/user/phone", {
    method: "POST",
    headers: { Authorization: "Bearer test" },
  });

  expect(response.status).toBe(503);
  expect(limiterCalls).toHaveBeenCalledTimes(1);
});
