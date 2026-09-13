// Exercises cloud API v1 eliza agents agentid pairing token route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
const findByIdAndOrg = mock();
const wasStoppedByUser = mock(async () => false);
const generateToken = mock(async () => "pair-token");
const warmInferenceRateLimitGate = mock(async (_organizationId: string) => {});
const warn = mock(() => undefined);
const enqueueAgentProvisionOnce = mock();
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
let canonicalAgentBaseDomain: string | undefined = "elizacloud.ai";

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg,
    wasStoppedByUser,
  },
}));

mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentDirectWebUiUrl: (sandbox: {
    headscale_ip?: string | null;
    web_ui_port?: number | null;
    bridge_port?: number | null;
  }) => {
    const port = sandbox.web_ui_port ?? sandbox.bridge_port;
    return sandbox.headscale_ip && port
      ? `http://${sandbox.headscale_ip}:${port}`
      : null;
  },
  getConfiguredElizaAgentPublicWebUiUrl: (
    sandbox: { id: string },
    baseDomain?: string | null,
  ) => {
    if (!baseDomain || /^(?:\d|localhost)/.test(baseDomain)) return null;
    return `https://${sandbox.id}.${baseDomain}`;
  },
}));

mock.module("@/lib/services/pairing-token", () => ({
  getPairingTokenService: () => ({
    generateToken,
  }),
}));

mock.module("@/lib/services/inference-admission-gate", () => ({
  warmInferenceRateLimitGate,
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "worker unavailable",
  }),
}));

const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 10,
  error: undefined as string | undefined,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    warn,
  },
}));

const { default: pairingRoute } = await import("./route");

const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/agents/:agentId/pairing-token", pairingRoute);

function runningSandbox(executionTier: "custom" | "dedicated-lazy" | "shared") {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: "bnancy",
    status: "running",
    execution_tier: executionTier,
    bridge_url: "http://168.119.244.189:19027",
    web_ui_port: 19028,
    bridge_port: 19027,
    headscale_ip: null,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    updated_at: new Date("2026-06-04T12:00:00.000Z"),
  };
}

async function postPairingToken(
  executionCtx?: Parameters<typeof app.fetch>[2],
) {
  return app.fetch(
    new Request(
      "https://api.example.test/api/v1/eliza/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8/pairing-token",
      { method: "POST" },
    ),
    {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: canonicalAgentBaseDomain,
    } as AppEnv["Bindings"],
    executionCtx,
  );
}

describe("eliza agent pairing token route", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    findByIdAndOrg.mockReset();
    wasStoppedByUser.mockReset();
    wasStoppedByUser.mockResolvedValue(false);
    generateToken.mockClear();
    warmInferenceRateLimitGate.mockReset();
    warmInferenceRateLimitGate.mockResolvedValue(undefined);
    warn.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 10,
      error: undefined,
    });
    canonicalAgentBaseDomain = "elizacloud.ai";
  });

  test("returns a usable pairing token while the quota-neutral gate warm is pending", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));
    const pending = Promise.withResolvers<void>();
    warmInferenceRateLimitGate.mockReturnValueOnce(pending.promise);
    const background: Promise<unknown>[] = [];
    try {
      const response = await postPairingToken({
        waitUntil(promise) {
          background.push(promise);
        },
        passThroughOnException() {},
        props: {},
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { token: "pair-token" },
      });
      expect(warmInferenceRateLimitGate).toHaveBeenCalledWith("org-1");
      expect(background).toHaveLength(1);
    } finally {
      pending.resolve();
      await Promise.all(background);
    }
  });

  test("a failed background warm preserves pairing and reports the failure", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));
    const failure = new Error("gate unavailable");
    warmInferenceRateLimitGate.mockRejectedValueOnce(failure);
    const background: Promise<unknown>[] = [];
    const response = await postPairingToken({
      waitUntil(promise) {
        background.push(promise);
      },
      passThroughOnException() {},
      props: {},
    });
    expect(response.status).toBe(200);
    await Promise.all(background);
    expect(warn).toHaveBeenCalledWith(
      "[pairing-token] Inference gate prewarm failed",
      { error: failure },
    );
  });

  test.each([
    ["unowned", null, 404],
    ["shared", runningSandbox("shared"), 503],
    [
      "starting",
      { ...runningSandbox("dedicated-lazy"), status: "provisioning" },
      202,
    ],
    ["failed", { ...runningSandbox("dedicated-lazy"), status: "error" }, 500],
  ])("does not warm a %s agent", async (_label, sandbox, status) => {
    findByIdAndOrg.mockResolvedValue(sandbox);
    const waitUntil = mock();
    const response = await postPairingToken({
      waitUntil,
      passThroughOnException() {},
      props: {},
    });
    expect(response.status).toBe(status);
    expect(warmInferenceRateLimitGate).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test("does not warm when token generation fails", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));
    generateToken.mockRejectedValueOnce(new Error("token storage unavailable"));
    const waitUntil = mock();
    const response = await postPairingToken({
      waitUntil,
      passThroughOnException() {},
      props: {},
    });
    expect(response.status).toBe(500);
    expect(warmInferenceRateLimitGate).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test("pairs without starting background work outside Workers", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));
    expect((await postPairingToken()).status).toBe(200);
    expect(warmInferenceRateLimitGate).not.toHaveBeenCalled();
  });

  test("routes production token pairing through the canonical hostname instead of its public direct IP", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("custom"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
    expect(generateToken).toHaveBeenLastCalledWith(
      "user-1",
      "org-1",
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai",
    );
  });

  test("routes staging token pairing through the staging agent hostname", async () => {
    canonicalAgentBaseDomain = "staging.elizacloud.ai";
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.staging.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("uses the Worker-bound agent domain when the broader container domain differs", async () => {
    canonicalAgentBaseDomain = "staging.elizacloud.ai";
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.staging.elizacloud.ai/pair?token=pair-token",
      },
    });
  });

  test("allows token pairing to use an explicit local-Docker loopback origin", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: "http://127.0.0.1:31000",
      web_ui_port: 31001,
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl: "http://127.0.0.1:31001/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("does not treat a public hostname beginning with 127 as loopback", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: "http://127.attacker.example:19027",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
      },
    });
  });

  test("fails closed when token pairing has only a public direct IP and no canonical hostname", async () => {
    canonicalAgentBaseDomain = undefined;
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));

    const response = await postPairingToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("skips a browser-unreachable tailnet headscale URL and falls back to the public managed hostname", async () => {
    // headscale IPs live on the 100.64/10 tailnet (CGNAT) our containers run on;
    // a browser can never reach one, so the direct-headscale rung is filtered and
    // the route must fall back to the public managed hostname (never a dead
    // http://100.64.x.x redirect).
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: null,
      headscale_ip: "100.64.0.12",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("does not expose an internal bridge when the configured gateway host is invalid", async () => {
    canonicalAgentBaseDomain = "100.64.0.99";
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: "http://10.0.0.8:19027",
      health_url: "http://192.168.1.8:19028/health",
      headscale_ip: "100.64.0.12",
    });

    const response = await postPairingToken();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(JSON.stringify(body)).not.toMatch(/100\.64|10\.0|192\.168/);
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("does not expose an internal Headscale DNS name", async () => {
    canonicalAgentBaseDomain = undefined;
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("custom"),
      bridge_url: "http://agent-12.tunnel.eliza.local:19027",
      environment_vars: {},
    });

    const response = await postPairingToken();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(JSON.stringify(body)).not.toContain("tunnel.eliza.local");
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("falls back to the managed web UI hostname when no direct UI route is stored", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: null,
      web_ui_port: null,
      bridge_port: null,
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("returns the bare Web UI origin when the agent does not support token pairing", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("custom"),
      environment_vars: {},
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai",
        expiresIn: 60,
      },
    });
  });

  test("does not issue web UI redirects for shared-runtime agents", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("shared"));

    const response = await postPairingToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("session repair does not restart an agent explicitly shut down by its user", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      status: "stopped",
    });
    wasStoppedByUser.mockResolvedValue(true);
    const response = await postPairingToken();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "agent_stopped",
      data: { status: "stopped" },
    });
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("#11224: pairing a STOPPED shared-runtime agent does not credit-gate or provision", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("shared"),
      status: "stopped",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("#11224: pairing a STOPPED dedicated agent for a suspended org is blocked 402 — no free re-provision", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      status: "stopped",
    });
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "insufficient_credits",
    });
    // The paid re-provision must NOT be enqueued for a suspended org.
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
  });

  test("#11224: pairing a STOPPED dedicated agent for a FUNDED org still re-provisions (no regression)", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      status: "stopped",
    });
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 10,
      error: undefined,
    });
    enqueueAgentProvisionOnce.mockResolvedValue({
      job: { id: "job-1" },
      created: true,
    });

    await postPairingToken();

    expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1);
  });
});
