/** Fresh sign-in cannot start billable compute before a quote-bound choice. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import "./client-cloud";
import type { DedicatedActivationConfirmationRequester } from "./dedicated-activation-confirmation";

const PERSONAL_ID = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
const QUOTE = {
  quoteId: "a".repeat(64),
  sourceAgentId: PERSONAL_ID,
  hourlyRateUsd: 0.01,
  dailyRateUsd: 0.24,
  minimumActivationChargeUsd: 0.3,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 10,
  deficitUsd: 0,
  canActivate: true,
  requiresConfirmation: true,
  action: "activate_dedicated",
  activation: { state: "available" },
};

function installQuote(quote: Record<string, unknown> = QUOTE) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          success: true,
          data: String(input).endsWith("/personal")
            ? {
                identity: {
                  id: PERSONAL_ID,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              }
            : quote,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("Dedicated activation confirmation", () => {
  it("refuses a quote without the activation minimum before asking for confirmation or posting", async () => {
    const { minimumActivationChargeUsd: _minimum, ...incomplete } = QUOTE;
    const requests = installQuote(incomplete);
    const confirmation = vi.fn<DedicatedActivationConfirmationRequester>();
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "test-token",
        requestDedicatedActivationConfirmation: confirmation,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ACTIVATION_QUOTE_INVALID",
    });
    expect(confirmation).not.toHaveBeenCalled();
    expect(requests).toHaveBeenCalledTimes(2);
    for (const [, init] of requests.mock.calls)
      expect(init?.method).toBe("GET");
  });
  it("keeps headless startup read-only", async () => {
    const requests = installQuote();
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "test-token",
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ACTIVATION_CONFIRMATION_REQUIRED",
    });
    expect(requests).toHaveBeenCalledTimes(2);
    for (const [, init] of requests.mock.calls)
      expect(init?.method).toBe("GET");
  });

  it.each([
    null,
    { action: "activate_dedicated" as const, quoteId: "stale-quote" },
  ])(
    "does not activate a cancelled or mismatched quote (%j)",
    async (decision) => {
      const requests = installQuote();
      const request = vi.fn<DedicatedActivationConfirmationRequester>(
        async () => decision,
      );
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          cloudApiBase: "https://api.eliza.app",
          authToken: "test-token",
          requestDedicatedActivationConfirmation: request,
        }),
      ).rejects.toMatchObject({
        code: "CLOUD_DEDICATED_ACTIVATION_NOT_CONFIRMED",
      });
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          quoteId: QUOTE.quoteId,
          dailyRateUsd: 0.24,
          balanceUsd: 10,
        }),
        expect.any(Object),
      );
      expect(requests).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { hourlyRateUsd: undefined },
    { dailyRateUsd: "0.24" },
    { sourceAgentId: "another-account" },
    { requiresConfirmation: false },
  ])("rejects incomplete or cross-account quote terms (%j)", async (change) => {
    const requests = installQuote({ ...QUOTE, ...change });
    const request = vi.fn<DedicatedActivationConfirmationRequester>(
      async (quote) => ({
        action: "activate_dedicated",
        quoteId: quote.quoteId,
      }),
    );
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "test-token",
        requestDedicatedActivationConfirmation: request,
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ACTIVATION_QUOTE_INVALID",
    });
    expect(request).not.toHaveBeenCalled();
    expect(requests).toHaveBeenCalledTimes(2);
  });

  it("does not POST when an abandoned attempt confirms late", async () => {
    const requests = installQuote();
    const controller = new AbortController();
    const request = vi.fn<DedicatedActivationConfirmationRequester>(
      async (quote) => {
        controller.abort();
        return { action: "activate_dedicated", quoteId: quote.quoteId };
      },
    );
    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "test-token",
        signal: controller.signal,
        requestDedicatedActivationConfirmation: request,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requests).toHaveBeenCalledTimes(2);
  });
});
