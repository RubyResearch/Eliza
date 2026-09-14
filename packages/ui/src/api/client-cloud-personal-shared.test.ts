/**
 * Verifies that account-native Shared identity resolution uses the read-only
 * personal endpoint and returns the standard per-agent chat base.
 */
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { capacitorHttpRequestMock, capacitorState } = vi.hoisted(() => ({
  capacitorHttpRequestMock: vi.fn(),
  capacitorState: { isNative: false },
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => capacitorState.isNative,
    registerPlugin: vi.fn(() => ({})),
  },
  CapacitorHttp: {
    get: vi.fn(),
    post: vi.fn(),
    request: capacitorHttpRequestMock,
  },
}));

import {
  loadAgentProfileRegistry,
  upsertAndActivateAgentProfile,
} from "../state/agent-profiles";
import {
  createPersistedActiveServer,
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import { ElizaClient } from "./client-base";
import { verifyDirectCloudStewardSession } from "./client-cloud";
import type { DedicatedActivationConfirmationRequester } from "./dedicated-activation-confirmation";

const ACTIVATION_TERMS = {
  sourceAgentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
  hourlyRateUsd: 0.01,
  dailyRateUsd: 0.24,
  minimumActivationChargeUsd: 0.3,
  minimumBalanceUsd: 0.72,
  minimumRunwayDays: 3,
  balanceUsd: 10,
  deficitUsd: 0,
  requiresConfirmation: true,
  action: "activate_dedicated",
};
const confirmActivation: DedicatedActivationConfirmationRequester = async (
  quote,
) => ({
  action: "activate_dedicated",
  quoteId: quote.quoteId,
});

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

afterEach(() => {
  capacitorState.isNative = false;
  capacitorHttpRequestMock.mockReset();
});

describe("getPersonalSharedEliza", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("resolves the rowless identity without creating an agent", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const result = await new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      signal: controller.signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eliza.app/api/v1/eliza/personal",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: "Bearer steward-token",
      },
      signal: controller.signal,
    });
    expect(result).toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentName: "Eliza",
      apiBase:
        "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      runtime: "shared",
    });
  });

  it("reconnects a returning account to its activated Dedicated target", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "dedicated",
              activeAgentId: "00000000-0000-4000-8000-000000000020",
              apiBase:
                "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).resolves.toEqual({
      personalElizaId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      agentId: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
      activeAgentId: "00000000-0000-4000-8000-000000000020",
      agentName: "Eliza",
      apiBase: "https://00000000-0000-4000-8000-000000000020.cloud.eliza.app",
      runtime: "dedicated",
    });
  });

  it("rejects a response that does not identify the personal Shared runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "sandbox-row-id",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Eliza identity");
  });

  it("keeps the browser deadline active through a stalled Personal response body", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const response = jsonResponse(200, {});
    vi.spyOn(response, "text").mockImplementation(
      async () => await new Promise<string>(() => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return response;
      }),
    );

    const request = new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
    });
    const rejection = expect(request).rejects.toThrow(
      "Eliza Cloud request timed out after 30s",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it.each([409, 423, 503])(
    "preserves HTTP %s metadata when the Personal response body rejects",
    async (status) => {
      const response = jsonResponse(
        status,
        { error: "still starting" },
        { "Retry-After": "7" },
      );
      vi.spyOn(response, "text").mockRejectedValue(
        new Error("response body unavailable"),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );

      const error = await new ElizaClient()
        .getPersonalSharedEliza({
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
        })
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        status,
        url: "https://api.eliza.app/api/v1/eliza/personal",
        retryAfter: 7,
      });
      expect((error as { headers: Headers }).headers.get("Retry-After")).toBe(
        "7",
      );
    },
  );

  it.each([409, 423, 503])(
    "preserves HTTP %s metadata when the Personal response body stalls until timeout",
    async (status) => {
      vi.useFakeTimers();
      const response = jsonResponse(
        status,
        { error: "still starting" },
        { "Retry-After": "7" },
      );
      vi.spyOn(response, "text").mockImplementation(
        async () => await new Promise<string>(() => undefined),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );

      const outcome = new ElizaClient()
        .getPersonalSharedEliza({
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
        })
        .catch((cause: unknown) => cause);
      await vi.advanceTimersByTimeAsync(30_000);
      const error = await outcome;

      expect(error).toMatchObject({
        status,
        url: "https://api.eliza.app/api/v1/eliza/personal",
        retryAfter: 7,
      });
      expect((error as { headers: Headers }).headers.get("Retry-After")).toBe(
        "7",
      );
    },
  );

  it("propagates caller abort while the Personal response body is pending", async () => {
    const response = jsonResponse(200, {});
    vi.spyOn(response, "text").mockImplementation(
      async () => await new Promise<string>(() => undefined),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    const controller = new AbortController();
    const abortReason = new Error("owner cancelled Personal resolution");

    const request = new ElizaClient().getPersonalSharedEliza({
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      signal: controller.signal,
    });
    controller.abort(abortReason);

    await expect(request).rejects.toBe(abortReason);
  });

  it("preserves a caller abort reason before the Personal request is dispatched", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const abortReason = new Error("owner cancelled before dispatch");
    controller.abort(abortReason);

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not dispatch an already-aborted Personal request through native HTTP", async () => {
    capacitorState.isNative = true;
    const controller = new AbortController();
    const abortReason = new Error("owner cancelled native Personal resolution");
    controller.abort(abortReason);

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(capacitorHttpRequestMock).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Personal JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      new ElizaClient().getPersonalSharedEliza({
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toThrow("invalid personal Eliza identity");
  });
});

describe("ensurePersonalDedicatedEliza", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates one fresh Dedicated target without entering adoption and completes cutover", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const jobId = "10000000-0000-4000-8000-000000000020";
    const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
    let cutoverAttempts = 0;
    const events: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.eliza.app/api/v1/eliza/personal") {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          events.push("activation");
          expect(JSON.parse(String(init.body))).toEqual({
            minimumActivationChargeUsd: 0.3,
            action: "activate_dedicated",
            quoteId: "a".repeat(64),
          });
          return jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId, jobId },
          });
        }
        if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
          events.push("job");
          return jsonResponse(200, {
            success: true,
            data: { id: jobId, status: "completed" },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          events.push("cutover");
          cutoverAttempts += 1;
          if (cutoverAttempts <= 3) {
            return jsonResponse([409, 423, 503][cutoverAttempts - 1] ?? 409, {
              success: false,
              code: [
                "dedicated_not_healthy",
                "personal_reminder_cutover_in_progress",
                "dedicated_history_import_failed",
              ][cutoverAttempts - 1],
              error: "Dedicated is still provisioning",
            });
          }
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: dedicatedBase,
              importedMessages: 7,
            },
          });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const onProgress = vi.fn();

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        onProgress,
      }),
    ).resolves.toEqual({
      personalElizaId,
      agentId: personalElizaId,
      activeAgentId: dedicatedAgentId,
      agentName: "Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated",
    });
    expect(cutoverAttempts).toBe(4);
    expect(events.slice(0, 3)).toEqual(["activation", "job", "cutover"]);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/upgrade-tier/adopt-existing"),
      ),
    ).toHaveLength(0);
    expect(onProgress).toHaveBeenCalledWith(
      "provisioning",
      "Starting your Dedicated agent…",
    );
    expect(onProgress).toHaveBeenLastCalledWith(
      "ready",
      "Connected to your Dedicated agent",
    );
  });

  it.each([undefined, "", { invalid: true }])(
    "rejects an accepted activation with invalid job identity %j before cutover",
    async (jobId) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const unexpectedRequests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "a".repeat(64),
                canActivate: true,
                activation: { state: "available" },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            return jsonResponse(202, {
              success: true,
              data: { dedicatedAgentId, jobId },
            });
          }
          unexpectedRequests.push(url);
          return jsonResponse(500, {
            error: "unexpected request after invalid activation",
          });
        }),
      );
      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          timeoutMs: 1_000,
        }),
      ).rejects.toMatchObject({
        code: "CLOUD_DEDICATED_PROVISION_JOB_INVALID",
        context: { phase: "activation", field: "jobId" },
      });
      expect(unexpectedRequests).toEqual([]);
    },
  );

  it("does not retry cutover from HTTP status alone without a retryable response code", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const jobId = "10000000-0000-4000-8000-000000000020";
    let cutoverAttempts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId, jobId },
          });
        }
        if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
          return jsonResponse(200, {
            success: true,
            data: { id: jobId, status: "completed" },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverAttempts += 1;
          return jsonResponse(409, {
            success: false,
            code: "dedicated_history_receipt_invalid",
            error: "Dedicated history receipt is invalid.",
          });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      status: 409,
      data: { code: "dedicated_history_receipt_invalid" },
    });
    expect(cutoverAttempts).toBe(1);
  });

  it("adopts the selected existing Dedicated row after the create contract redirects it", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
    const activationQuoteId = "a".repeat(64);
    const adoptionQuoteId = "b".repeat(64);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: adoptionQuoteId,
              dedicatedAgentId,
              adoptionState: "available",
              status: "running",
              startsCompute: false,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "POST"
        ) {
          expect(JSON.parse(String(init.body))).toEqual({
            minimumActivationChargeUsd: 0.3,
            action: "adopt_existing_dedicated",
            quoteId: adoptionQuoteId,
          });
          return jsonResponse(200, {
            success: true,
            created: false,
            data: {
              dedicatedAgentId,
              runtime: "dedicated_pending_cutover",
              status: "running",
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: activationQuoteId,
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            minimumActivationChargeUsd: 0.3,
            action: "activate_dedicated",
            quoteId: activationQuoteId,
          });
          return jsonResponse(409, {
            success: false,
            code: "dedicated_adoption_selection_required",
            error:
              "An existing Dedicated agent is selected for this account. Continue with same-row adoption instead of creating another agent.",
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          expect(JSON.parse(String(init?.body))).toEqual({ dedicatedAgentId });
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: dedicatedBase,
              importedMessages: 0,
            },
          });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        requestDedicatedAdoptionConfirmation: async (quote) => ({
          action: "adopt_existing_dedicated",
          quoteId: quote.quoteId,
        }),
      }),
    ).resolves.toEqual({
      personalElizaId,
      agentId: personalElizaId,
      activeAgentId: dedicatedAgentId,
      agentName: "Eliza",
      apiBase: dedicatedBase,
      runtime: "dedicated",
    });
    expect(
      fetchMock.mock.calls.map(([url, init]) => ({
        url: String(url).replace(
          `https://api.eliza.app/api/v1/eliza/agents/${encodeURIComponent(personalElizaId)}`,
          "<personal>",
        ),
        method: init?.method ?? "GET",
      })),
    ).toEqual([
      {
        url: "https://api.eliza.app/api/v1/eliza/personal",
        method: "GET",
      },
      { url: "<personal>/upgrade-tier", method: "GET" },
      { url: "<personal>/upgrade-tier", method: "POST" },
      { url: "<personal>/upgrade-tier/adopt-existing", method: "GET" },
      { url: "<personal>/upgrade-tier/adopt-existing", method: "POST" },
      { url: "<personal>/upgrade-tier/cutover", method: "POST" },
    ]);
  });

  it("polls an adopted target's provisioning job to completion before cutover", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const jobId = "10000000-0000-4000-8000-000000000020";
    const events: string[] = [];
    let jobReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(409, {
            success: false,
            code: "dedicated_adoption_selection_required",
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "b".repeat(64),
              dedicatedAgentId,
              adoptionState: "available",
              status: "error",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "POST"
        ) {
          events.push("adoption");
          return jsonResponse(202, {
            success: true,
            data: {
              dedicatedAgentId,
              jobId,
              status: "pending",
              runtime: "dedicated_pending_cutover",
            },
          });
        }
        if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
          jobReads += 1;
          events.push(`job:${jobReads}`);
          return jsonResponse(200, {
            success: true,
            data: {
              id: jobId,
              status: jobReads === 1 ? "pending" : "completed",
            },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          events.push("cutover");
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: `https://${dedicatedAgentId}.cloud.eliza.app`,
              importedMessages: 0,
            },
          });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        requestDedicatedAdoptionConfirmation: async (quote) => ({
          action: "adopt_existing_dedicated",
          quoteId: quote.quoteId,
        }),
      }),
    ).resolves.toMatchObject({ activeAgentId: dedicatedAgentId });
    expect(events).toEqual(["adoption", "job:1", "job:2", "cutover"]);
  });

  it("surfaces an adopted target's terminal provisioning error without cutover", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const jobId = "10000000-0000-4000-8000-000000000020";
    let cutoverPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(409, {
            success: false,
            code: "dedicated_adoption_selection_required",
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "b".repeat(64),
              dedicatedAgentId,
              adoptionState: "available",
              status: "error",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "POST"
        ) {
          return jsonResponse(202, {
            success: true,
            data: {
              dedicatedAgentId,
              jobId,
              status: "pending",
              runtime: "dedicated_pending_cutover",
            },
          });
        }
        if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
          return jsonResponse(200, {
            success: true,
            data: {
              id: jobId,
              status: "failed",
              error: "No healthy capacity is available.",
            },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) cutoverPosts += 1;
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
        requestDedicatedAdoptionConfirmation: async (quote) => ({
          action: "adopt_existing_dedicated",
          quoteId: quote.quoteId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_PROVISION_JOB_FAILED",
      message:
        "Your Dedicated agent failed to start: No healthy capacity is available.",
    });
    expect(cutoverPosts).toBe(0);
  });

  it("returns the current adoption quote without POSTing when visible confirmation is unavailable", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let adoptionPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(409, {
            success: false,
            code: "dedicated_adoption_selection_required",
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "b".repeat(64),
              dedicatedAgentId,
              adoptionState: "available",
              status: "error",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "POST"
        ) {
          adoptionPosts += 1;
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ADOPTION_CONFIRMATION_REQUIRED",
      status: 409,
      name: "ElizaError",
    });
    expect(adoptionPosts).toBe(0);
  });

  it.each([
    {
      requiresCatalogRestore: false,
      expectedCode: "CLOUD_DEDICATED_ADOPTION_UNAVAILABLE",
    },
    {
      requiresCatalogRestore: true,
      expectedCode: "CLOUD_DEDICATED_ADOPTION_CATALOG_RESTORE_REQUIRED",
    },
  ])(
    "fails closed without fabricating an HTTP status when adoption is unavailable ($expectedCode)",
    async ({ requiresCatalogRestore, expectedCode }) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      let adoptionPosts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "a".repeat(64),
                canActivate: true,
                activation: { state: "available" },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            return jsonResponse(409, {
              success: false,
              code: "dedicated_adoption_selection_required",
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "GET"
          ) {
            return jsonResponse(200, {
              success: true,
              data: {
                quoteId: "b".repeat(64),
                dedicatedAgentId,
                adoptionState: "available",
                status: "error",
                startsCompute: true,
                hourlyRateUsd: 0.01,
                dailyRateUsd: 0.24,
                minimumActivationChargeUsd: 0.3,
                minimumBalanceUsd: 0.72,
                minimumRunwayDays: 3,
                balanceUsd: 0,
                deficitUsd: 0.72,
                stateDisposition: "fresh_boot_no_verified_backup",
                canAdopt: false,
                requiresCatalogRestore,
                requiresConfirmation: true,
                action: "adopt_existing_dedicated",
                unavailableReason: "The selected target is unavailable.",
              },
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "POST"
          ) {
            adoptionPosts += 1;
          }
          return jsonResponse(500, { error: `Unexpected URL ${url}` });
        }),
      );

      const rejection = await new ElizaClient()
        .ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          requestDedicatedAdoptionConfirmation: async (quote) => ({
            action: "adopt_existing_dedicated",
            quoteId: quote.quoteId,
          }),
        })
        .catch((error: unknown) => error);

      expect(rejection).toMatchObject({
        code: expectedCode,
        message: "The selected target is unavailable.",
        name: "ElizaError",
      });
      expect(rejection).not.toHaveProperty("status");
      expect(adoptionPosts).toBe(0);
    },
  );

  it.each(["error", "stopped", "sleeping"])(
    "retries an adopted %s target through the authority-preserving adoption route",
    async (status) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
      let genericActivationPosts = 0;
      let adoptionPosts = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "a".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status,
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            genericActivationPosts += 1;
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "GET"
          ) {
            return jsonResponse(200, {
              success: true,
              data: {
                quoteId: "b".repeat(64),
                dedicatedAgentId,
                adoptionState: "adopted",
                status,
                startsCompute: true,
                hourlyRateUsd: 0.01,
                dailyRateUsd: 0.24,
                minimumActivationChargeUsd: 0.3,
                minimumBalanceUsd: 0.72,
                minimumRunwayDays: 3,
                balanceUsd: 115.54,
                deficitUsd: 0,
                stateDisposition: "verified_backup_present",
                canAdopt: true,
                requiresCatalogRestore: false,
                requiresConfirmation: true,
                action: "adopt_existing_dedicated",
              },
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "POST"
          ) {
            adoptionPosts += 1;
            expect(JSON.parse(String(init.body))).toEqual({
              minimumActivationChargeUsd: 0.3,
              action: "adopt_existing_dedicated",
              quoteId: "b".repeat(64),
            });
            return jsonResponse(202, {
              success: true,
              created: false,
              data: {
                dedicatedAgentId,
                jobId: "10000000-0000-4000-8000-000000000020",
                runtime: "dedicated_pending_cutover",
                status: "queued",
              },
            });
          }
          if (
            url.endsWith("/api/v1/jobs/10000000-0000-4000-8000-000000000020")
          ) {
            return jsonResponse(200, {
              success: true,
              data: {
                id: "10000000-0000-4000-8000-000000000020",
                status: "completed",
              },
            });
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: dedicatedBase,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: `Unexpected URL ${url}` });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          requestDedicatedAdoptionConfirmation: async (quote) => ({
            action: "adopt_existing_dedicated",
            quoteId: quote.quoteId,
          }),
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(genericActivationPosts).toBe(0);
      expect(adoptionPosts).toBe(1);
    },
  );

  it.each([
    { responseShape: "embedded replacement quote", embedsQuote: true },
    { responseShape: "code-only response", embedsQuote: false },
  ])(
    "requires renewed visible confirmation after a $responseShape within the same attempt",
    async ({ embedsQuote }) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
      const initialQuoteId = "b".repeat(64);
      const changedQuoteId = "c".repeat(64);
      let adoptionGets = 0;
      let adoptionPosts = 0;
      const confirmationReasons: string[] = [];
      const quoteData = (quoteId: string, balanceUsd: number) => ({
        quoteId,
        dedicatedAgentId,
        adoptionState: "available",
        status: "error",
        startsCompute: true,
        hourlyRateUsd: 0.01,
        dailyRateUsd: 0.24,
        minimumActivationChargeUsd: 0.3,
        minimumBalanceUsd: 0.72,
        minimumRunwayDays: 3,
        balanceUsd,
        deficitUsd: 0,
        stateDisposition: "verified_backup_present",
        canAdopt: true,
        requiresCatalogRestore: false,
        requiresConfirmation: true,
        action: "adopt_existing_dedicated",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "a".repeat(64),
                canActivate: true,
                activation: { state: "available" },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            return jsonResponse(409, {
              success: false,
              code: "dedicated_adoption_selection_required",
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "GET"
          ) {
            adoptionGets += 1;
            return jsonResponse(200, {
              success: true,
              data:
                adoptionGets === 1
                  ? quoteData(initialQuoteId, 115.54)
                  : quoteData(changedQuoteId, 115.53),
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "POST"
          ) {
            adoptionPosts += 1;
            const body = JSON.parse(String(init.body));
            if (adoptionPosts === 1) {
              expect(body.quoteId).toBe(initialQuoteId);
              return jsonResponse(409, {
                success: false,
                code: "dedicated_adoption_quote_changed",
                ...(embedsQuote
                  ? { data: quoteData(changedQuoteId, 115.53) }
                  : {}),
              });
            }
            expect(body.quoteId).toBe(changedQuoteId);
            return jsonResponse(202, {
              success: true,
              created: false,
              data: {
                dedicatedAgentId,
                jobId: "10000000-0000-4000-8000-000000000020",
                runtime: "dedicated_pending_cutover",
                status: "queued",
              },
            });
          }
          if (
            url.endsWith("/api/v1/jobs/10000000-0000-4000-8000-000000000020")
          ) {
            return jsonResponse(200, {
              success: true,
              data: {
                id: "10000000-0000-4000-8000-000000000020",
                status: "completed",
              },
            });
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: dedicatedBase,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: `Unexpected URL ${url}` });
        }),
      );

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          timeoutMs: 1_000,
          requestDedicatedAdoptionConfirmation: async (quote, context) => {
            expect(adoptionPosts).toBe(context.reason === "initial" ? 0 : 1);
            expect(quote.quoteId).toBe(
              context.reason === "initial" ? initialQuoteId : changedQuoteId,
            );
            confirmationReasons.push(context.reason);
            return {
              action: "adopt_existing_dedicated",
              quoteId: quote.quoteId,
            };
          },
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(adoptionPosts).toBe(2);
      expect(adoptionGets).toBe(embedsQuote ? 1 : 2);
      expect(confirmationReasons).toEqual(["initial", "quote_changed"]);
    },
  );

  it("fails closed when adoption returns a row other than the selected quote target", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const selectedAgentId = "00000000-0000-4000-8000-000000000020";
    const otherAgentId = "00000000-0000-4000-8000-000000000021";
    let cutoverPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              quoteId: "b".repeat(64),
              dedicatedAgentId: selectedAgentId,
              adoptionState: "available",
              status: "running",
              startsCompute: false,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumActivationChargeUsd: 0.3,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "POST"
        ) {
          return jsonResponse(200, {
            success: true,
            data: {
              dedicatedAgentId: otherAgentId,
              runtime: "dedicated_pending_cutover",
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: { state: "available" },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(409, {
            success: false,
            code: "dedicated_adoption_selection_required",
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) cutoverPosts += 1;
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        requestDedicatedAdoptionConfirmation: async (quote) => ({
          action: "adopt_existing_dedicated",
          quoteId: quote.quoteId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_ADOPTION_TARGET_MISMATCH",
      context: { phase: "adoption", field: "dedicatedAgentId" },
      name: "ElizaError",
    });
    expect(cutoverPosts).toBe(0);
  });

  it.each(["pending", "provisioning", "running"])(
    "reattaches to an in-progress %s target without replaying activation",
    async (targetStatus) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;
      let cutoverAttempts = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "d".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: targetStatus,
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            throw new Error("activation POST must not replay");
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            cutoverAttempts += 1;
            if (cutoverAttempts <= 3) {
              const response = jsonResponse(
                [409, 423, 503][cutoverAttempts - 1] ?? 409,
                {
                  success: false,
                  code: [
                    "dedicated_not_healthy",
                    "personal_reminder_cutover_in_progress",
                    "dedicated_history_import_failed",
                  ][cutoverAttempts - 1],
                  error: "Dedicated is still provisioning",
                },
              );
              return response;
            }
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: dedicatedBase,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: "unexpected route" });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          pollIntervalMs: 0,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(
        fetchMock.mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/upgrade-tier") && init?.method === "POST",
        ),
      ).toHaveLength(0);
      expect(cutoverAttempts).toBe(4);
    },
  );

  it.each(["error", "stopped", "sleeping"])(
    "uses generic confirmed resume for an unselected in-progress %s target",
    async (targetStatus) => {
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const jobId = "10000000-0000-4000-8000-000000000020";
      let activationPosts = 0;
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "e".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: targetStatus,
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            activationPosts += 1;
            return jsonResponse(202, {
              success: true,
              data: { dedicatedAgentId, jobId },
            });
          }
          if (
            url.endsWith("/upgrade-tier/adopt-existing") &&
            init?.method === "GET"
          ) {
            return jsonResponse(404, {
              success: false,
              code: "dedicated_adoption_unavailable",
              error: "Agent not found",
            });
          }
          if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
            return jsonResponse(200, {
              success: true,
              data: { id: jobId, status: "completed" },
            });
          }
          if (url.endsWith("/upgrade-tier/cutover")) {
            return jsonResponse(200, {
              success: true,
              data: {
                personalElizaId,
                activeAgentId: dedicatedAgentId,
                runtime: "dedicated",
                apiBase: `https://${dedicatedAgentId}.cloud.eliza.app`,
                importedMessages: 0,
              },
            });
          }
          return jsonResponse(500, { error: "unexpected route" });
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        new ElizaClient().ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          pollIntervalMs: 0,
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        activeAgentId: dedicatedAgentId,
        runtime: "dedicated",
      });
      expect(activationPosts).toBe(1);
    },
  );

  it("reconciles a stalled first activation body without replaying its POST", async () => {
    vi.useFakeTimers();
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let activationPosts = 0;
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "f".repeat(64),
              canActivate: true,
              activation:
                activationPosts === 0
                  ? { state: "available" }
                  : {
                      state: "in_progress",
                      dedicatedAgentId,
                      status: "provisioning",
                    },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({
            minimumActivationChargeUsd: 0.3,
            action: "activate_dedicated",
            quoteId: "f".repeat(64),
          });
          activationPosts += 1;
          const committed = jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId },
          });
          vi.spyOn(committed, "text").mockImplementation(
            async () => await new Promise<string>(() => undefined),
          );
          return committed;
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          return jsonResponse(200, {
            success: true,
            data: {
              personalElizaId,
              activeAgentId: dedicatedAgentId,
              runtime: "dedicated",
              apiBase: `https://${dedicatedAgentId}.cloud.eliza.app`,
              importedMessages: 0,
            },
          });
        }
        return jsonResponse(500, { error: "unexpected route" });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient();

    const ambiguous = client.ensurePersonalDedicatedEliza({
      requestDedicatedActivationConfirmation: confirmActivation,
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
      timeoutMs: 60_000,
    });
    const rejection = expect(ambiguous).rejects.toThrow(
      "Eliza Cloud request timed out after 30s",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    expect(activationPosts).toBe(1);

    await expect(
      client.ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        pollIntervalMs: 0,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      activeAgentId: dedicatedAgentId,
      runtime: "dedicated",
    });
    expect(activationPosts).toBe(1);
    expect(
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/upgrade-tier"))
        .map(([, init]) => init?.method),
    ).toEqual(["GET", "POST", "GET"]);
  });

  it("preserves the caller abort reason through a pending cutover body", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const controller = new AbortController();
    const abortReason = new Error("owner cancelled Dedicated cutover");
    let cutoverPosts = 0;
    let releaseLateBody: ((body: string) => void) | undefined;
    let signalCutoverStarted: (() => void) | undefined;
    const cutoverStarted = new Promise<void>((resolve) => {
      signalCutoverStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "4".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId,
                status: "provisioning",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          throw new Error("activation POST must not replay");
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverPosts += 1;
          const headersOnly = jsonResponse(409, {
            success: false,
            code: "dedicated_not_healthy",
            error: "Dedicated is still provisioning",
          });
          vi.spyOn(headersOnly, "text").mockImplementation(
            async () =>
              await new Promise<string>((resolve) => {
                releaseLateBody = resolve;
                signalCutoverStarted?.();
              }),
          );
          return headersOnly;
        }
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    const attempt = new ElizaClient().ensurePersonalDedicatedEliza({
      requestDedicatedActivationConfirmation: confirmActivation,
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
      signal: controller.signal,
    });
    await cutoverStarted;
    controller.abort(abortReason);

    await expect(attempt).rejects.toBe(abortReason);
    expect(cutoverPosts).toBe(1);

    releaseLateBody?.(
      JSON.stringify({
        success: false,
        error: "late Dedicated response",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(cutoverPosts).toBe(1);
  });

  it.each([
    ["cutover", "request"],
    ["cutover", "body"],
    ["job", "request"],
    ["job", "body"],
  ] as const)(
    "aborts a hung boundary %s %s at exactly 720000ms without late work",
    async (stalledBoundary, stalledPhase) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
      const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
      const jobId = "10000000-0000-4000-8000-000000000020";
      let cutoverPosts = 0;
      let boundaryRequests = 0;
      let releaseLateRequest: ((response: Response) => void) | undefined;
      let releaseLateBody: ((body: string) => void) | undefined;
      const onProgress = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/api/v1/eliza/personal")) {
            return jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
            return jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "3".repeat(64),
                canActivate: true,
                activation:
                  stalledBoundary === "job"
                    ? { state: "available" }
                    : {
                        state: "in_progress",
                        dedicatedAgentId,
                        status: "provisioning",
                      },
              },
            });
          }
          if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
            if (stalledBoundary === "job") {
              return jsonResponse(202, {
                success: true,
                data: { dedicatedAgentId, jobId },
              });
            }
            throw new Error("activation POST must not replay");
          }
          if (url.endsWith("/upgrade-tier/cutover")) cutoverPosts += 1;
          if (
            url.endsWith("/upgrade-tier/cutover") ||
            url.endsWith(`/api/v1/jobs/${jobId}`)
          ) {
            boundaryRequests += 1;
            if (boundaryRequests === 2) {
              if (stalledPhase === "request") {
                return await new Promise<Response>((resolve) => {
                  releaseLateRequest = resolve;
                });
              }
              const headersOnly =
                stalledBoundary === "job"
                  ? jsonResponse(200, {
                      success: true,
                      data: { id: jobId, status: "in_progress" },
                    })
                  : jsonResponse(409, {
                      success: false,
                      code: "dedicated_not_healthy",
                      error: "Dedicated is still provisioning",
                    });
              vi.spyOn(headersOnly, "text").mockImplementation(
                async () =>
                  await new Promise<string>((resolve) => {
                    releaseLateBody = resolve;
                  }),
              );
              return headersOnly;
            }
            return stalledBoundary === "job"
              ? jsonResponse(200, {
                  success: true,
                  data: { id: jobId, status: "in_progress" },
                })
              : jsonResponse(409, {
                  success: false,
                  code: "dedicated_not_healthy",
                  error: "Dedicated is still provisioning",
                });
          }
          return jsonResponse(500, { error: "unexpected route" });
        }),
      );

      let outcome: Error | "resolved" | undefined;
      const attempt = new ElizaClient()
        .ensurePersonalDedicatedEliza({
          requestDedicatedActivationConfirmation: confirmActivation,
          cloudApiBase: "https://api.eliza.app",
          authToken: "steward-token",
          onProgress,
          pollIntervalMs: 719_999,
        })
        .then(() => {
          outcome = "resolved";
        })
        .catch((error: unknown) => {
          outcome = error instanceof Error ? error : new Error(String(error));
        });

      await vi.advanceTimersByTimeAsync(719_999);
      expect(outcome).toBeUndefined();
      expect(boundaryRequests).toBe(2);
      expect(cutoverPosts).toBe(stalledBoundary === "cutover" ? 2 : 0);
      const progressCountAtBoundaryRequest = onProgress.mock.calls.length;

      await vi.advanceTimersByTimeAsync(1);
      await attempt;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain(
        "did not become ready before the signed-in startup deadline",
      );
      expect((outcome as Error).cause).toMatchObject({
        message: "The startup deadline elapsed",
        name: "TimeoutError",
      });
      expect(Date.now()).toBe(720_000);
      expect(boundaryRequests).toBe(2);
      expect(onProgress).toHaveBeenCalledTimes(progressCountAtBoundaryRequest);

      const lateResponse =
        stalledBoundary === "job"
          ? jsonResponse(200, {
              success: true,
              data: { id: jobId, status: "completed" },
            })
          : jsonResponse(409, {
              success: false,
              error: "late Dedicated response",
            });
      releaseLateRequest?.(lateResponse);
      releaseLateBody?.(await lateResponse.text());
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(boundaryRequests).toBe(2);
      expect(cutoverPosts).toBe(stalledBoundary === "cutover" ? 2 : 0);
      expect(onProgress).toHaveBeenCalledTimes(progressCountAtBoundaryRequest);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not dispatch cutover after the absolute startup deadline elapses", async () => {
    vi.useFakeTimers();
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let cutoverPosts = 0;
    let nowReadCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowReadCount += 1;
      if (nowReadCount === 1) return 0;
      if (nowReadCount <= 11) return 719_999;
      return 720_000;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "9".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId,
                status: "provisioning",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          throw new Error("activation POST must not replay");
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverPosts += 1;
          return jsonResponse(409, {
            success: false,
            code: "dedicated_not_healthy",
            error: "Dedicated is still provisioning",
          });
        }
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    const rejection = new ElizaClient().ensurePersonalDedicatedEliza({
      requestDedicatedActivationConfirmation: confirmActivation,
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
    });

    await expect(rejection).rejects.toMatchObject({
      cause: {
        message: "The startup deadline elapsed",
        name: "TimeoutError",
      },
    });
    expect(nowReadCount).toBeGreaterThanOrEqual(4);
    expect(cutoverPosts).toBe(0);
  });

  it("bounds personal, quote, retained activation, and cutover to one overall deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const jobId = "10000000-0000-4000-8000-000000000020";
    const onProgress = vi.fn();
    let activationPosts = 0;
    let cutoverPosts = 0;
    const delayResponse = async <T>(delayMs: number, value: T): Promise<T> =>
      await new Promise<T>((resolve) =>
        setTimeout(() => resolve(value), delayMs),
      );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return await delayResponse(
            1_000,
            jsonResponse(200, {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            }),
          );
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return await delayResponse(
            1_000,
            jsonResponse(200, {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "7".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: "stopped",
                },
              },
            }),
          );
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          activationPosts += 1;
          return await delayResponse(
            1_000,
            jsonResponse(202, {
              success: true,
              data: { dedicatedAgentId, jobId },
            }),
          );
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(404, {
            success: false,
            code: "dedicated_adoption_unavailable",
          });
        }
        if (url.endsWith(`/api/v1/jobs/${jobId}`)) {
          return await delayResponse(
            1_000,
            jsonResponse(200, {
              success: true,
              data: { id: jobId, status: "completed" },
            }),
          );
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverPosts += 1;
          return jsonResponse(409, {
            success: false,
            code: "dedicated_not_healthy",
            error: "Dedicated is still provisioning",
          });
        }
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    let outcome: Error | "resolved" | undefined;
    const attempt = new ElizaClient()
      .ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
        onProgress,
        pollIntervalMs: 30_000,
      })
      .then(() => {
        outcome = "resolved";
      })
      .catch((error: unknown) => {
        outcome = error instanceof Error ? error : new Error(String(error));
      });

    await vi.advanceTimersByTimeAsync(719_999);
    expect(outcome).toBeUndefined();
    expect(activationPosts).toBe(1);
    expect(cutoverPosts).toBeGreaterThan(0);
    const cutoverPostsAtBoundary = cutoverPosts;
    const progressAtBoundary = onProgress.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1);
    await attempt;
    expect(Date.now()).toBe(720_000);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain(
      "did not become ready before the signed-in startup deadline",
    );
    expect(activationPosts).toBe(1);
    expect(cutoverPosts).toBe(cutoverPostsAtBoundary);
    expect(onProgress).toHaveBeenCalledTimes(progressAtBoundary);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(cutoverPosts).toBe(cutoverPostsAtBoundary);
    expect(onProgress).toHaveBeenCalledTimes(progressAtBoundary);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not dispatch native cutover when the deadline crosses at transport", async () => {
    vi.useFakeTimers();
    capacitorState.isNative = true;
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    let cutoverPosts = 0;
    let nowReadCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowReadCount += 1;
      if (nowReadCount === 1) return 0;
      if (nowReadCount <= 11) return 719_999;
      return 720_000;
    });
    capacitorHttpRequestMock.mockImplementation(
      async ({ method, url }: { method: string; url: string }) => {
        if (url.endsWith("/api/v1/eliza/personal")) {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                identity: {
                  id: personalElizaId,
                  displayName: "Eliza",
                  runtime: "shared",
                },
              },
            },
          };
        }
        if (url.endsWith("/upgrade-tier") && method === "GET") {
          return {
            status: 200,
            data: {
              success: true,
              data: {
                ...ACTIVATION_TERMS,
                quoteId: "9".repeat(64),
                canActivate: true,
                activation: {
                  state: "in_progress",
                  dedicatedAgentId,
                  status: "provisioning",
                },
              },
            },
          };
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          cutoverPosts += 1;
        }
        return { status: 500, data: { error: "unexpected route" } };
      },
    );

    const rejection = new ElizaClient().ensurePersonalDedicatedEliza({
      requestDedicatedActivationConfirmation: confirmActivation,
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
    });

    await expect(rejection).rejects.toMatchObject({
      cause: {
        message: "The startup deadline elapsed",
        name: "TimeoutError",
      },
    });
    expect(nowReadCount).toBeGreaterThanOrEqual(4);
    expect(cutoverPosts).toBe(0);
  });

  it("preserves caller cancellation when it wins the absolute deadline race", async () => {
    const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
    const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
    const controller = new AbortController();
    const abortReason = new Error("owner cancelled at the startup boundary");
    let nowReadCount = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      nowReadCount += 1;
      if (nowReadCount === 1) return 0;
      if (nowReadCount === 2) {
        controller.abort(abortReason);
        return 719_999;
      }
      return 720_000;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "8".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId,
                status: "provisioning",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) {
          throw new Error(
            "cutover must not dispatch after caller cancellation",
          );
        }
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    const rejection = new ElizaClient().ensurePersonalDedicatedEliza({
      requestDedicatedActivationConfirmation: confirmActivation,
      cloudApiBase: "https://api.eliza.app",
      authToken: "steward-token",
      pollIntervalMs: 0,
      signal: controller.signal,
    });

    await expect(rejection).rejects.toBe(abortReason);
    expect(nowReadCount).toBeGreaterThanOrEqual(2);
  });

  it("fails closed on an unknown retained-target status", async () => {
    let activationPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "1".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId: "00000000-0000-4000-8000-000000000020",
                status: "unknown-future-state",
              },
            },
          });
        }
        if (init?.method === "POST") activationPosts += 1;
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_STATUS_UNKNOWN",
      context: { phase: "quote", field: "activation.status" },
      message: expect.stringContaining("invalid in-progress Dedicated status"),
      name: "ElizaError",
    });
    expect(activationPosts).toBe(0);
  });

  it("fails with a coded sanitized error on an unknown quote state", async () => {
    let activationPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "4".repeat(64),
              canActivate: true,
              activation: { state: "unknown-future-state" },
            },
          });
        }
        if (init?.method === "POST") activationPosts += 1;
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_QUOTE_STATE_UNKNOWN",
      context: { phase: "quote", field: "activation.state" },
      message: expect.stringContaining("invalid Dedicated quote state"),
      name: "ElizaError",
    });
    expect(activationPosts).toBe(0);
  });

  it("rejects a resume receipt for a target other than the quoted row", async () => {
    const quotedTargetId = "00000000-0000-4000-8000-000000000020";
    const otherTargetId = "00000000-0000-4000-8000-000000000021";
    let cutoverPosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/eliza/personal")) {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
                displayName: "Eliza",
                runtime: "shared",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "GET") {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "2".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId: quotedTargetId,
                status: "stopped",
              },
            },
          });
        }
        if (url.endsWith("/upgrade-tier") && init?.method === "POST") {
          return jsonResponse(202, {
            success: true,
            data: { dedicatedAgentId: otherTargetId },
          });
        }
        if (
          url.endsWith("/upgrade-tier/adopt-existing") &&
          init?.method === "GET"
        ) {
          return jsonResponse(404, {
            success: false,
            code: "dedicated_adoption_unavailable",
          });
        }
        if (url.endsWith("/upgrade-tier/cutover")) cutoverPosts += 1;
        return jsonResponse(500, { error: "unexpected route" });
      }),
    );

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      code: "CLOUD_DEDICATED_TARGET_MISMATCH",
      context: { phase: "activation", field: "dedicatedAgentId" },
      message: expect.stringContaining(
        "different Dedicated target than the quoted activation",
      ),
      name: "ElizaError",
    });
    expect(cutoverPosts).toBe(0);
  });

  it("fails closed instead of returning Shared when hosting credit is insufficient", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.eliza.app/api/v1/eliza/personal") {
        return jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b",
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        });
      }
      return jsonResponse(200, {
        success: true,
        data: {
          ...ACTIVATION_TERMS,
          quoteId: "b".repeat(64),
          canActivate: false,
          activation: { state: "available" },
          unavailableReason: "Add hosting credits to continue.",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ElizaClient().ensurePersonalDedicatedEliza({
        requestDedicatedActivationConfirmation: confirmActivation,
        cloudApiBase: "https://api.eliza.app",
        authToken: "steward-token",
      }),
    ).rejects.toMatchObject({
      message: "Add hosting credits to continue.",
      status: 402,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("personal Eliza runtime repoint", () => {
  const personalElizaId = "personal:3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const sharedBase =
    "https://api.eliza.app/api/v1/eliza/agents/personal%3A3b9e517b-5c33-5c5f-a6f9-f78c764dc41b";
  const dedicatedAgentId = "00000000-0000-4000-8000-000000000020";
  const dedicatedBase = `https://${dedicatedAgentId}.cloud.eliza.app`;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const server = createPersistedActiveServer({
      kind: "cloud",
      id: `cloud:${personalElizaId}`,
      label: "Eliza",
      apiBase: sharedBase,
      accessToken: "steward-token",
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
    });
    savePersistedActiveServer(server);
    upsertAndActivateAgentProfile({
      kind: "cloud",
      label: "Eliza",
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: personalElizaId,
      cloudRuntime: "shared",
      apiBase: sharedBase,
      accessToken: "steward-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("repoints an open Shared client and retries the rejected turn once", async () => {
    const requestBodies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === `${sharedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(409, {
            success: false,
            code: "personal_eliza_dedicated",
            error: "This personal Eliza is active on Dedicated.",
          });
        }
        if (url === "https://api.eliza.app/api/v1/eliza/personal") {
          return jsonResponse(200, {
            success: true,
            data: {
              identity: {
                id: personalElizaId,
                displayName: "Eliza",
                runtime: "dedicated",
                activeAgentId: dedicatedAgentId,
                apiBase: dedicatedBase,
              },
            },
          });
        }
        if (url === `${dedicatedBase}/api/chat`) {
          requestBodies.push(String(init?.body));
          return jsonResponse(200, { delivered: true });
        }
        return jsonResponse(500, { error: `Unexpected URL ${url}` });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");
    const body = JSON.stringify({
      text: "keep this exact turn",
      clientMessageId: "same-idempotency-key",
    });

    await expect(
      client.fetch<{ delivered: boolean }>("/api/chat", {
        method: "POST",
        body,
      }),
    ).resolves.toEqual({ delivered: true });

    expect(requestBodies).toEqual([body, body]);
    expect(client.getBaseUrl()).toBe(dedicatedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      apiBase: dedicatedBase,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
    });
    const registry = loadAgentProfileRegistry();
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]).toMatchObject({
      cloudAgentId: personalElizaId,
      cloudRuntimeAgentId: dedicatedAgentId,
      cloudRuntime: "dedicated",
      apiBase: dedicatedBase,
    });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method ?? "GET",
    }));
    expect(calls).toEqual([
      { url: `${sharedBase}/api/chat`, method: "POST" },
      {
        url: "https://api.eliza.app/api/v1/eliza/personal",
        method: "GET",
      },
      { url: `${dedicatedBase}/api/chat`, method: "POST" },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(
      /upgrade-tier|provision|create-agent|sandbox/i,
    );
  });

  it("fails closed when the saved logical identity does not own the rejection", async () => {
    savePersistedActiveServer(
      createPersistedActiveServer({
        kind: "cloud",
        id: "cloud:personal:00000000-0000-5000-8000-000000000099",
        label: "Other account",
        apiBase: sharedBase,
        accessToken: "steward-token",
      }),
    );
    const fetchMock = vi.fn(async () =>
      jsonResponse(409, {
        code: "personal_eliza_dedicated",
        error: "This personal Eliza is active on Dedicated.",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.getBaseUrl()).toBe(sharedBase);
  });

  it("fails closed when Shared authority cannot fund the required Dedicated target", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url === `${sharedBase}/api/chat`) {
          return jsonResponse(409, {
            code: "personal_eliza_dedicated",
            error: "This personal Eliza is active on Dedicated.",
          });
        }
        if (url.endsWith("/upgrade-tier")) {
          return jsonResponse(200, {
            success: true,
            data: {
              ...ACTIVATION_TERMS,
              quoteId: "c".repeat(64),
              canActivate: false,
              activation: { state: "available" },
              unavailableReason: "Dedicated hosting credit is required.",
            },
          });
        }
        return jsonResponse(200, {
          success: true,
          data: {
            identity: {
              id: personalElizaId,
              displayName: "Eliza",
              runtime: "shared",
            },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new ElizaClient(sharedBase, "steward-token");

    await expect(client.fetch("/api/chat")).rejects.toMatchObject({
      status: 409,
      code: "personal_eliza_dedicated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(
      fetchMock.mock.calls.some((call) => call[1]?.method === "POST"),
    ).toBe(false);
    expect(client.getBaseUrl()).toBe(sharedBase);
    expect(loadPersistedActiveServer()).toMatchObject({
      id: `cloud:${personalElizaId}`,
      cloudRuntime: "shared",
    });
  });
});

describe("verifyDirectCloudStewardSession", () => {
  const stewardToken = "pinned-steward-token";

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function preservePinnedAmbientClient(): ElizaClient {
    return new ElizaClient("https://owned-agent.example", "agent-pair-bearer");
  }

  function expectPinnedAmbientClientPreserved(client: ElizaClient): void {
    expect(client.getBaseUrl()).toBe("https://owned-agent.example");
    expect(client.getRestAuthToken()).toBe("agent-pair-bearer");
    expect(localStorage.getItem("steward_session_token")).toBe(stewardToken);
  }

  it.each(["user", "credits"] as const)(
    "keeps the pinned %s body stall transient without clearing or repointing",
    async (stalledEndpoint) => {
      vi.useFakeTimers();
      localStorage.setItem("steward_session_token", stewardToken);
      const ambientClient = preservePinnedAmbientClient();
      const requests: Array<{ init?: RequestInit; url: string }> = [];
      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          requests.push({ init, url });
          const response = jsonResponse(
            200,
            url.endsWith("/api/v1/user")
              ? {
                  data: {
                    id: "user-pinned",
                    organization_id: "org-pinned",
                  },
                }
              : { balance: 8.5 },
          );
          const shouldStall =
            (stalledEndpoint === "user" && url.endsWith("/api/v1/user")) ||
            (stalledEndpoint === "credits" &&
              url.endsWith("/api/v1/credits/balance"));
          if (shouldStall) {
            vi.spyOn(response, "text").mockImplementation(
              async () => await new Promise<string>(() => undefined),
            );
          }
          return response;
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      const verification = verifyDirectCloudStewardSession({
        cloudApiBase: "https://api-staging.eliza.app",
        stewardToken,
      });
      let rejection: unknown;
      void verification.catch((error: unknown) => {
        rejection = error;
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(verification).rejects.toThrow(
        "Eliza Cloud request timed out after 30s",
      );

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).not.toMatch(
        /auth-rejected|not-authenticated/iu,
      );
      expectPinnedAmbientClientPreserved(ambientClient);
      expect(requests.map(({ url }) => url)).toEqual(
        stalledEndpoint === "user"
          ? ["https://api-staging.eliza.app/api/v1/user"]
          : [
              "https://api-staging.eliza.app/api/v1/user",
              "https://api-staging.eliza.app/api/v1/credits/balance",
            ],
      );
      for (const request of requests) {
        expect(new Headers(request.init?.headers).get("Authorization")).toBe(
          `Bearer ${stewardToken}`,
        );
      }
    },
  );

  it.each([
    { label: "user 5xx", user: jsonResponse(503, { error: "unavailable" }) },
    {
      label: "malformed user",
      user: new Response("not-json", { status: 200 }),
    },
  ])(
    "keeps $label transient and retains the current token",
    async ({ user }) => {
      localStorage.setItem("steward_session_token", stewardToken);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => user),
      );

      await expect(
        verifyDirectCloudStewardSession({
          cloudApiBase: "https://api-staging.eliza.app",
          stewardToken,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(localStorage.getItem("steward_session_token")).toBe(stewardToken);
    },
  );

  it("keeps a malformed credits body transient and retains the current token", async () => {
    localStorage.setItem("steward_session_token", stewardToken);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { id: "user-pinned", organization_id: "org-pinned" },
        }),
      )
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      verifyDirectCloudStewardSession({
        cloudApiBase: "https://api-staging.eliza.app",
        stewardToken,
      }),
    ).rejects.toThrow("invalid credits response");
    expect(localStorage.getItem("steward_session_token")).toBe(stewardToken);
  });

  it.each([401, 403])(
    "clears only the exact current token after authoritative HTTP %s",
    async (status) => {
      localStorage.setItem("steward_session_token", stewardToken);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => jsonResponse(status, { error: "unauthorized" })),
      );

      await expect(
        verifyDirectCloudStewardSession({
          cloudApiBase: "https://api-staging.eliza.app",
          stewardToken,
        }),
      ).resolves.toMatchObject({
        status: { connected: false, reason: "auth-rejected" },
      });
      expect(localStorage.getItem("steward_session_token")).toBeNull();
    },
  );

  it.each(["rejecting", "stalled"] as const)(
    "clears an authoritative HTTP 401 without consuming its %s body",
    async (bodyMode) => {
      localStorage.setItem("steward_session_token", stewardToken);
      const response = jsonResponse(401, { error: "unauthorized" });
      const bodySpy = vi.spyOn(response, "text");
      if (bodyMode === "rejecting") {
        bodySpy.mockRejectedValue(new Error("error body unavailable"));
      } else {
        bodySpy.mockImplementation(
          async () => await new Promise<string>(() => undefined),
        );
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );

      await expect(
        verifyDirectCloudStewardSession({
          cloudApiBase: "https://api-staging.eliza.app",
          stewardToken,
        }),
      ).resolves.toMatchObject({
        status: { connected: false, reason: "auth-rejected" },
      });
      expect(bodySpy).not.toHaveBeenCalled();
      expect(localStorage.getItem("steward_session_token")).toBeNull();
    },
  );

  it("does not clear a newer token when the verified token is rejected", async () => {
    localStorage.setItem("steward_session_token", stewardToken);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        localStorage.setItem("steward_session_token", "rotated-steward-token");
        return jsonResponse(401, { error: "unauthorized" });
      }),
    );

    await expect(
      verifyDirectCloudStewardSession({
        cloudApiBase: "https://api-staging.eliza.app",
        stewardToken,
      }),
    ).resolves.toMatchObject({
      status: { connected: false, reason: "auth-rejected" },
    });
    expect(localStorage.getItem("steward_session_token")).toBe(
      "rotated-steward-token",
    );
  });
});
