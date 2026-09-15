/** Structural retry timing and permanent-quota boundaries; no network or model. */
import { describe, expect, it, vi } from "vitest";
import { providerRateLimitRetryAt, providerRetryAfterMs } from "./model-retry";

const now = 1789276000000;
describe("provider retry deadlines", () => {
	it.each([
		[{ "retry-after": "60" }, 60000],
		[{ "ReTrY-AfTeR": ["0.8"] }, 800],
		[{ "retry-after-ms": "125.5", "retry-after": "60" }, 125.5],
		[{ "retry-after-ms": "bad", "retry-after": "60" }, 60000],
		[{ "retry-after": "" }, undefined],
		[{ "retry-after": "-3" }, undefined],
		[{ "retry-after": "nonsense" }, undefined],
	] as const)("reads protocol headers %j", (responseHeaders, expected) => {
		expect(providerRetryAfterMs({ responseHeaders })).toBe(expected);
		expect(
			providerRateLimitRetryAt({ statusCode: 429, responseHeaders }, now),
		).toBe(expected === undefined ? undefined : now + expected);
	});
	it("reads a date deadline and the provider's remaining cooldown", () => {
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			expect(
				providerRateLimitRetryAt({
					statusCode: 429,
					responseHeaders: {
						"retry-after": new Date(now + 60000).toUTCString(),
					},
				}),
			).toBe(now + 60000);
			expect(
				providerRateLimitRetryAt({ statusCode: 429, retryAfterMs: 17000 }),
			).toBe(now + 17000);
		} finally {
			clock.mockRestore();
		}
	});
	it("uses the same clock instant for an HTTP-date conversion", () => {
		expect(
			providerRateLimitRetryAt(
				{
					statusCode: 429,
					responseHeaders: {
						"retry-after": new Date(now + 60000).toUTCString(),
					},
				},
				now,
			),
		).toBe(now + 60000);
	});

	it.each([
		{ statusCode: 401, retryAfterMs: 60000 },
		{ statusCode: 503, retryAfterMs: 60000 },
		{ message: "Too Many Requests; retry after 60 seconds" },
		{ statusCode: 429, retryAfterMs: 0 },
		{ statusCode: 429, retryAfterMs: NaN },
		{ statusCode: 429, retryAfterMs: Infinity },
		{ statusCode: 429, retryAfterMs: -1 },
		{ statusCode: 429, retryAfterMs: 60000, code: "insufficient_quota" },
		{
			statusCode: 429,
			retryAfterMs: 60000,
			data: { error: { type: "credit_balance_exhausted" } },
		},
		{
			statusCode: 429,
			retryAfterMs: 60000,
			responseBody: '{"error":{"code":"insufficient_quota"}}',
		},
	])("does not turn other failures into cooldown waits: %j", (error) => {
		expect(providerRateLimitRetryAt(error, now)).toBeUndefined();
	});
});
