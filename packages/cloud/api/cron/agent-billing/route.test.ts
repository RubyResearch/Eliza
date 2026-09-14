/**
 * Verifies billing route outcomes, durable receipts, exact totals, and replay behavior.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";

const runningSandbox = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  agent_name: "Waifu Agent",
  organization_id: "agent-org",
  user_id: "agent-user",
  agent_config: {
    waifuAgentId: "waifu-agent-1",
    tokenContractAddress: "0x0000000000000000000000000000000000000009",
    chain: "bsc",
    chainId: 56,
    account: {
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
    },
    waifuWebhook: {
      url: "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
      secret: "test-webhook-secret",
    },
  },
  status: "running",
  billing_status: "active",
  last_billed_at: null,
  total_billed: "0",
  shutdown_warning_sent_at: null as Date | null,
  scheduled_shutdown_at: null as Date | null,
};

const listBillableSandboxes = mock(async () => ({
  runningSandboxes: [runningSandbox],
  stoppedWithBackups: [],
}));
const suspendFailedSandboxBilling = mock(async () => 0);
const listBillingOrganizations = mock(async () => [
  {
    id: "agent-org",
    name: "Agent Org",
    credit_balance: "0",
    billing_email: "billing@example.test",
  },
]);
const recordHourlyBilling = mock(async () => ({
  status: "insufficient_credits",
}));
const getOrganizationCreditBalance = mock(async () => 0);
const scheduleShutdownWarning = mock(async () => undefined);
const suspendSandboxForInsufficientCredits = mock(async () => undefined);
const shutdownSandbox = mock(async () => ({ success: true }));
const enqueueAgentSuspendOnce = mock(
  async (_input?: {
    agentId: string;
    organizationId: string;
    userId: string;
    authorization: "billing_request";
  }) => ({
    job: { id: "stop-job" },
    created: true,
  }),
);
const listRecoverableAgentComputeStopIntents = mock(async () => []);
const rearmRecoverableAgentComputeStopIntentOnce = mock(async () => ({
  id: "recovered-stop-job",
  rearmed: true,
}));
const triggerImmediate = mock(async () => undefined);
const sendContainerShutdownWarningEmail = mock(async () => true);
const webhookFetch = mock(
  async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ ok: true }),
);
const loggerInfo = mock(() => undefined);
const loggerWarn = mock(() => undefined);
const loggerError = mock(() => undefined);
const startedRuns = new Map<string, Record<string, unknown>>();
const durableRunItems = new Map<string, Map<string, Record<string, unknown>>>();
const startOrLoadBillingRun = mock(
  async (input: {
    invocationKey: string;
    triggerKind: "scheduled" | "manual";
    schedule: string | null;
    scheduledAt: Date | null;
    leaseDurationMs: number;
  }) => {
    const leaseToken = crypto.randomUUID();
    const databaseNow = new Date();
    const run = {
      id: crypto.randomUUID(),
      invocation_key: input.invocationKey,
      trigger_kind: input.triggerKind,
      schedule: input.schedule,
      scheduled_at: input.scheduledAt,
      status: "started",
      started_at: databaseNow,
      billing_cutoff_at: databaseNow,
      attempt_count: 1,
      lease_token: leaseToken,
      lease_expires_at: new Date(databaseNow.getTime() + input.leaseDurationMs),
      completed_at: null,
      sandboxes_processed: 0,
      sandboxes_billed: 0,
      warnings_sent: 0,
      sandboxes_shutdown: 0,
      errors: 0,
      total_revenue: "0.000000",
      duration_ms: null,
      error_samples: [],
      created_at: databaseNow,
      updated_at: databaseNow,
    };
    startedRuns.set(run.id, run);
    return { run, claimed: true, recovered: false, leaseToken };
  },
);
const listBillingRunItems = mock(async (runId: string) => [
  ...(durableRunItems.get(runId)?.values() ?? []),
]);
const recordBillingRunItem = mock(
  async (
    authority: { runId: string; leaseToken: string },
    input: {
      sandboxId: string;
      organizationId: string;
      agentName: string;
      action: string;
      amountDecimal?: string;
      newBalanceDecimal?: string;
      transactionId?: string;
      detailCode?: string;
      detailMessage?: string;
      completedAt: Date;
    },
  ) => {
    let items = durableRunItems.get(authority.runId);
    if (!items) {
      items = new Map();
      durableRunItems.set(authority.runId, items);
    }
    const existing = items.get(input.sandboxId);
    if (existing) return { item: existing, created: false };
    const item = {
      id: crypto.randomUUID(),
      run_id: authority.runId,
      sandbox_id: input.sandboxId,
      organization_id: input.organizationId,
      agent_name: input.agentName,
      action: input.action,
      amount: input.amountDecimal ?? "0.000000",
      new_balance: input.newBalanceDecimal ?? null,
      transaction_id: input.transactionId ?? null,
      detail_code: input.detailCode ?? null,
      detail_message: input.detailMessage ?? null,
      completed_at: input.completedAt,
      created_at: input.completedAt,
    };
    items.set(input.sandboxId, item);
    return { item, created: true };
  },
);
const enqueueAgentUnfundedStopForRun = mock(
  async (input: {
    runId: string;
    leaseToken: string;
    sandboxId: string;
    organizationId: string;
    agentName: string;
    now: Date;
  }) => {
    await enqueueAgentSuspendOnce({
      agentId: input.sandboxId,
      organizationId: input.organizationId,
      userId: runningSandbox.user_id,
      authorization: "billing_request",
    });
    return (
      await recordBillingRunItem(input, {
        sandboxId: input.sandboxId,
        organizationId: input.organizationId,
        agentName: input.agentName,
        action: "shutdown",
        completedAt: input.now,
      })
    ).item;
  },
);
const renewBillingRunLease = mock(
  async (runId: string, leaseToken: string, leaseDurationMs: number) => {
    const started = startedRuns.get(runId);
    if (!started) throw new Error("missing mocked run");
    const databaseNow = new Date();
    const renewed = {
      ...started,
      lease_token: leaseToken,
      lease_expires_at: new Date(databaseNow.getTime() + leaseDurationMs),
      updated_at: databaseNow,
    };
    startedRuns.set(runId, renewed);
    return renewed;
  },
);
const completeBillingRun = mock(
  async (
    runId: string,
    _leaseToken: string,
    input: {
      status: string;
      sandboxesProcessed: number;
      sandboxesBilled: number;
      warningsSent: number;
      sandboxesShutdown: number;
      errors: number;
      totalRevenue: string;
      errorSamples: unknown[];
    },
  ) => {
    const started = startedRuns.get(runId);
    if (!started) throw new Error("missing mocked run");
    const completedAt = new Date();
    const completed = {
      ...started,
      status: input.status,
      completed_at: completedAt,
      sandboxes_processed: input.sandboxesProcessed,
      sandboxes_billed: input.sandboxesBilled,
      warnings_sent: input.warningsSent,
      sandboxes_shutdown: input.sandboxesShutdown,
      errors: input.errors,
      total_revenue: input.totalRevenue,
      duration_ms:
        completedAt.getTime() - (started.started_at as Date).getTime(),
      error_samples: input.errorSamples,
      lease_expires_at: null,
      updated_at: completedAt,
    };
    startedRuns.set(runId, completed);
    return {
      run: completed,
      completedByCaller: true,
      terminalReplay: false,
    };
  },
);

mock.module("@/db/repositories/agent-billing", () => ({
  agentBillingRepository: {
    suspendFailedSandboxBilling,
    listBillableSandboxes,
    listBillingOrganizations,
    recordHourlyBilling,
    getOrganizationCreditBalance,
    scheduleShutdownWarning,
    suspendSandboxForInsufficientCredits,
  },
}));

mock.module("@/db/repositories/agent-billing-runs", () => ({
  agentBillingRunRepository: {
    startOrLoad: startOrLoadBillingRun,
    listItems: listBillingRunItems,
    recordItem: recordBillingRunItem,
    renewLease: renewBillingRunLease,
    complete: completeBillingRun,
  },
}));

mock.module("@/db/repositories/users", () => ({
  providerForPlatform: (platform: string | undefined) =>
    platform === "telegram" || platform === "discord" || platform === "whatsapp"
      ? platform
      : platform === "twilio" || platform === "blooio"
        ? "phone"
        : undefined,
  usersRepository: {
    listByOrganization: mock(async () => []),
  },
}));

mock.module("@/lib/services/agent-unfunded-stop", () => ({
  enqueueAgentUnfundedStopForRun,
}));

mock.module("@/lib/services/email", () => ({
  emailService: {
    sendContainerShutdownWarningEmail,
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    shutdown: shutdownSandbox,
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  listRecoverableAgentComputeStopIntents,
  rearmRecoverableAgentComputeStopIntentOnce,
  provisioningJobService: { enqueueAgentSuspendOnce, triggerImmediate },
}));

mock.module("@/lib/security/safe-fetch", () => ({
  safeFetch: webhookFetch,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
  },
}));

const { default: app } = await import("./route");

describe("agent billing cron waifu lifecycle callbacks", () => {
  beforeEach(() => {
    suspendFailedSandboxBilling.mockClear();
    listBillableSandboxes.mockClear();
    listBillingOrganizations.mockClear();
    recordHourlyBilling.mockClear();
    getOrganizationCreditBalance.mockClear();
    scheduleShutdownWarning.mockClear();
    enqueueAgentUnfundedStopForRun.mockClear();
    suspendSandboxForInsufficientCredits.mockClear();
    shutdownSandbox.mockClear();
    enqueueAgentSuspendOnce.mockClear();
    listRecoverableAgentComputeStopIntents.mockReset();
    listRecoverableAgentComputeStopIntents.mockImplementation(async () => []);
    rearmRecoverableAgentComputeStopIntentOnce.mockReset();
    rearmRecoverableAgentComputeStopIntentOnce.mockImplementation(async () => ({
      id: "recovered-stop-job",
      rearmed: true,
    }));
    triggerImmediate.mockReset();
    triggerImmediate.mockImplementation(async () => undefined);
    sendContainerShutdownWarningEmail.mockClear();
    sendContainerShutdownWarningEmail.mockImplementation(async () => true);
    webhookFetch.mockClear();
    loggerInfo.mockClear();
    loggerWarn.mockClear();
    loggerError.mockClear();
    startOrLoadBillingRun.mockClear();
    renewBillingRunLease.mockClear();
    completeBillingRun.mockClear();
    startedRuns.clear();
    durableRunItems.clear();
    listBillingRunItems.mockClear();
    recordBillingRunItem.mockClear();
    suspendFailedSandboxBilling.mockImplementation(async () => 0);
    listBillableSandboxes.mockImplementation(async () => {
      expect(suspendFailedSandboxBilling).toHaveBeenCalledTimes(1);
      return {
        runningSandboxes: [runningSandbox],
        stoppedWithBackups: [],
      };
    });
    listBillingOrganizations.mockImplementation(async () => [
      {
        id: "agent-org",
        name: "Agent Org",
        credit_balance: "0",
        billing_email: "billing@example.test",
      },
    ]);
    recordHourlyBilling.mockImplementation(async () => ({
      status: "insufficient_credits",
    }));
    getOrganizationCreditBalance.mockImplementation(async () => 0);
    shutdownSandbox.mockImplementation(async () => ({ success: true }));
    enqueueAgentSuspendOnce.mockImplementation(async () => ({
      job: { id: "stop-job" },
      created: true,
    }));
    startOrLoadBillingRun.mockImplementation(async (input) => {
      const leaseToken = crypto.randomUUID();
      const databaseNow = new Date();
      const run = {
        id: crypto.randomUUID(),
        invocation_key: input.invocationKey,
        trigger_kind: input.triggerKind,
        schedule: input.schedule,
        scheduled_at: input.scheduledAt,
        status: "started",
        started_at: databaseNow,
        billing_cutoff_at: databaseNow,
        attempt_count: 1,
        lease_token: leaseToken,
        lease_expires_at: new Date(
          databaseNow.getTime() + input.leaseDurationMs,
        ),
        completed_at: null,
        sandboxes_processed: 0,
        sandboxes_billed: 0,
        warnings_sent: 0,
        sandboxes_shutdown: 0,
        errors: 0,
        total_revenue: "0.000000",
        duration_ms: null,
        error_samples: [],
        created_at: databaseNow,
        updated_at: databaseNow,
      };
      startedRuns.set(run.id, run);
      return { run, claimed: true, recovered: false, leaseToken };
    });
  });

  test("queues an immediate stop and signs credits.depleted when balance is insufficient", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        sandboxesProcessed: 1,
        warningsSent: 0,
        sandboxesShutdown: 1,
      },
    });
    expect(recordHourlyBilling).toHaveBeenCalledTimes(1);
    expect(enqueueAgentUnfundedStopForRun).toHaveBeenCalledTimes(1);
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
    expect(webhookFetch).toHaveBeenCalledTimes(1);

    const [url, init] = webhookFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const bodyText = String((init as RequestInit).body);
    const body = JSON.parse(bodyText);
    expect(body).toMatchObject({
      event: "credits.depleted",
      cloudAgentId: runningSandbox.id,
      elizaCloudAgentId: runningSandbox.id,
      agentId: "waifu-agent-1",
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      creditsRemaining: 0,
      requiredCredits: 0.15,
      billingStatus: "active",
      status: "running",
    });
    expect(typeof body.scheduledShutdownAt).toBe("string");
    expectSignedWebhook(init as RequestInit, body.timestamp, bodyText);
  });

  test("rechecks previously scheduled shutdowns and signs the durable stop event", async () => {
    const scheduledShutdownAt = new Date(Date.now() - 60_000);
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [
        {
          ...runningSandbox,
          billing_status: "shutdown_pending",
          shutdown_warning_sent_at: new Date(Date.now() - 49 * 60 * 60_000),
          scheduled_shutdown_at: scheduledShutdownAt,
        },
      ],
      stoppedWithBackups: [],
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        sandboxesProcessed: 1,
        warningsSent: 0,
        sandboxesShutdown: 1,
      },
    });
    expect(recordHourlyBilling).not.toHaveBeenCalled();
    expect(enqueueAgentSuspendOnce).toHaveBeenCalledWith({
      agentId: runningSandbox.id,
      organizationId: "agent-org",
      userId: runningSandbox.user_id,
      authorization: "billing_request",
    });
    expect(shutdownSandbox).not.toHaveBeenCalled();
    expect(suspendSandboxForInsufficientCredits).not.toHaveBeenCalled();
    expect(webhookFetch).toHaveBeenCalledTimes(1);

    const [url, init] = webhookFetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://waifu.example.test/v2/webhooks/eliza-cloud/credits",
    );
    const bodyText = String((init as RequestInit).body);
    const body = JSON.parse(bodyText);
    expect(body).toMatchObject({
      event: "credits.depleted",
      eventId: expect.stringMatching(/^agent-billing:.*:credits.depleted:/),
      cloudAgentId: runningSandbox.id,
      elizaCloudAgentId: runningSandbox.id,
      agentId: "waifu-agent-1",
      organizationId: "agent-org",
      tokenContractAddress: "0x0000000000000000000000000000000000000009",
      tokenAddress: "0x0000000000000000000000000000000000000009",
      tokenChain: "bsc",
      chain: "bsc",
      chainId: 56,
      primaryWalletAddress: "0x0000000000000000000000000000000000000001",
      walletKeyRef: "steward:waifu-agent",
      creditsRemaining: 0,
      requiredCredits: 0.15,
      billingStatus: "shutdown_pending",
      status: "running",
      scheduledShutdownAt: expect.any(String),
    });
    expectSignedWebhook(init as RequestInit, body.timestamp, bodyText);
  });

  test("does not suspend billing if the durable stop enqueue fails", async () => {
    const scheduledShutdownAt = new Date(Date.now() - 60_000);
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [
        {
          ...runningSandbox,
          billing_status: "shutdown_pending",
          shutdown_warning_sent_at: new Date(Date.now() - 49 * 60 * 60_000),
          scheduled_shutdown_at: scheduledShutdownAt,
        },
      ],
      stoppedWithBackups: [],
    }));
    enqueueAgentSuspendOnce.mockImplementationOnce(async () => {
      throw new Error("durable enqueue failed");
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      {
        CRON_SECRET: "cron-secret",
        NEXT_PUBLIC_APP_URL: "https://www.elizacloud.ai",
      },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: {
        sandboxesProcessed: 1,
        sandboxesShutdown: 0,
        errors: 1,
        results: [
          {
            action: "error",
            error: "Sandbox billing processing failed",
          },
        ],
      },
    });
    expect(suspendSandboxForInsufficientCredits).not.toHaveBeenCalled();
    expect(webhookFetch).not.toHaveBeenCalled();
    expect(completeBillingRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        errors: 1,
        errorSamples: [
          {
            code: "sandbox_processing_failed",
            message: "Sandbox billing processing failed",
            sandboxId: runningSandbox.id,
          },
        ],
      }),
    );
  });

  test("creates the started receipt before selection and finalizes an explicit empty run", async () => {
    listBillableSandboxes.mockImplementationOnce(async () => {
      expect(startedRuns.size).toBe(1);
      expect([...startedRuns.values()][0]?.status).toBe("started");
      return { runningSandboxes: [], stoppedWithBackups: [] };
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        triggerKind: "manual",
        status: "empty",
        sandboxesProcessed: 0,
        totalRevenue: "0.000000",
      },
    });
    expect(completeBillingRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ status: "empty", errors: 0 }),
    );
    expect(loggerInfo).toHaveBeenCalledWith(
      "[Agent Billing] No billable sandboxes",
      {
        runId: expect.any(String),
        invocationKey: expect.stringMatching(/^manual:agent-billing:/),
      },
    );
  });

  test("rearms due agent stops and nudges the worker even when no sandbox is billable", async () => {
    const intent = {
      id: "00000000-0000-4000-8000-000000000091",
      agent_id: "00000000-0000-4000-8000-000000000092",
      organization_id: "00000000-0000-4000-8000-000000000093",
      lifecycle_revision: 7,
    };
    listRecoverableAgentComputeStopIntents.mockImplementationOnce(async () => [
      intent as never,
    ]);
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [],
      stoppedWithBackups: [],
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(200);
    expect(rearmRecoverableAgentComputeStopIntentOnce).toHaveBeenCalledWith({
      intentId: intent.id,
      agentId: intent.agent_id,
      organizationId: intent.organization_id,
      lifecycleRevision: 7,
      now: expect.any(Date),
    });
    expect(triggerImmediate).toHaveBeenCalledTimes(1);
  });

  test("returns a structured degraded response when the recovery scan fails", async () => {
    listRecoverableAgentComputeStopIntents.mockRejectedValueOnce(
      new Error("scan secret must not escape"),
    );
    listBillableSandboxes.mockResolvedValueOnce({
      runningSandboxes: [],
      stoppedWithBackups: [],
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("scan secret must not escape");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      code: "agent_stop_recovery_degraded",
      data: {
        status: "empty",
        stopRecovery: {
          status: "degraded",
          scanned: 0,
          rearmed: 0,
          failures: 1,
        },
      },
    });
  });

  test("rescans recovery before replaying a completed degraded invocation", async () => {
    listRecoverableAgentComputeStopIntents.mockRejectedValueOnce(
      new Error("transient recovery scan failure"),
    );
    listBillableSandboxes.mockResolvedValue({
      runningSandboxes: [],
      stoppedWithBackups: [],
    });
    const request = () =>
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      });

    const first = await app.fetch(request(), { CRON_SECRET: "cron-secret" });
    expect(first.status).toBe(500);
    const firstBody = (await first.json()) as { runId: string };
    const completed = startedRuns.get(firstBody.runId);
    if (!completed) throw new Error("Expected completed billing run fixture");
    startOrLoadBillingRun.mockResolvedValueOnce({
      run: completed as never,
      claimed: false,
      recovered: false,
      leaseToken: crypto.randomUUID(),
    });

    const replay = await app.fetch(request(), { CRON_SECRET: "cron-secret" });

    expect(replay.status).toBe(200);
    expect(listRecoverableAgentComputeStopIntents).toHaveBeenCalledTimes(2);
    await expect(replay.json()).resolves.toMatchObject({
      success: true,
      data: {
        replayed: true,
        stopRecovery: { status: "succeeded", failures: 0 },
      },
    });
  });

  test("returns a structured degraded response when one recovery rearm fails", async () => {
    listRecoverableAgentComputeStopIntents.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000094",
        agent_id: "00000000-0000-4000-8000-000000000095",
        organization_id: "00000000-0000-4000-8000-000000000096",
        lifecycle_revision: 8,
      } as never,
    ]);
    rearmRecoverableAgentComputeStopIntentOnce.mockRejectedValueOnce(
      new Error("poison detail must not escape"),
    );
    listBillableSandboxes.mockResolvedValueOnce({
      runningSandboxes: [],
      stoppedWithBackups: [],
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("poison detail must not escape");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      code: "agent_stop_recovery_degraded",
      data: {
        status: "empty",
        stopRecovery: {
          status: "degraded",
          scanned: 1,
          rearmed: 0,
          failures: 1,
        },
      },
    });
  });

  test("finalizes a failed receipt when selection throws and never leaks the raw error", async () => {
    listBillableSandboxes.mockImplementationOnce(async () => {
      throw new Error("sk_live_should_not_escape raw provider payload");
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("sk_live_should_not_escape");
    expect(bodyText).not.toContain("raw provider payload");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      data: { status: "failed", sandboxesProcessed: 0, errors: 1 },
    });
    expect(completeBillingRun).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        errorSamples: [
          {
            code: "billing_run_failed",
            message: "Agent billing run failed",
          },
        ],
      }),
    );
  });

  test("fails closed before selection when the started receipt cannot be stored", async () => {
    startOrLoadBillingRun.mockImplementationOnce(async () => {
      throw new Error("receipt database unavailable");
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    expect(listBillableSandboxes).not.toHaveBeenCalled();
    expect(completeBillingRun).not.toHaveBeenCalled();
  });

  test("fails closed when neither terminal receipt write can be persisted", async () => {
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [],
      stoppedWithBackups: [],
    }));
    completeBillingRun.mockImplementationOnce(async () => {
      throw new Error("terminal receipt unavailable");
    });
    completeBillingRun.mockImplementationOnce(async () => {
      throw new Error("failed receipt unavailable");
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    expect(completeBillingRun).toHaveBeenCalledTimes(2);
  });

  test("uses a new server-generated identity for every authenticated manual GET or POST", async () => {
    listBillableSandboxes.mockImplementation(async () => ({
      runningSandboxes: [],
      stoppedWithBackups: [],
    }));

    for (const method of ["GET", "POST"] as const) {
      const response = await app.fetch(
        new Request("https://api.example.test/", {
          method,
          headers: { "x-cron-secret": "cron-secret" },
        }),
        { CRON_SECRET: "cron-secret" },
      );
      expect(response.status).toBe(200);
    }

    const identities = startOrLoadBillingRun.mock.calls.map(
      ([input]) => input.invocationKey,
    );
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(
      identities.every((identity) =>
        identity.startsWith("manual:agent-billing:"),
      ),
    ).toBe(true);
  });

  test("returns non-2xx with exact revenue and sanitized diagnostics for a mixed run", async () => {
    const secondSandbox = {
      ...runningSandbox,
      id: "223e4567-e89b-42d3-a456-426614174001",
      agent_name: "Second Agent",
    };
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [runningSandbox, secondSandbox],
      stoppedWithBackups: [],
    }));
    listBillingOrganizations.mockImplementationOnce(async () => [
      {
        id: "agent-org",
        name: "Agent Org",
        credit_balance: "100",
        billing_email: "billing@example.test",
      },
    ]);
    recordHourlyBilling.mockImplementationOnce(async () => ({
      status: "billed",
      amount: 0.1,
      amountDecimal: "0.100000",
      newBalance: 99.9,
      transactionId: "transaction-1",
    }));
    recordHourlyBilling.mockImplementationOnce(async () => {
      throw new Error("secret provider response must not persist");
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const bodyText = await response.text();

    expect(response.status).toBe(500);
    expect(bodyText).not.toContain("secret provider response");
    expect(JSON.parse(bodyText)).toMatchObject({
      success: false,
      data: {
        status: "partial_failure",
        sandboxesProcessed: 2,
        sandboxesBilled: 1,
        errors: 1,
        totalRevenue: "0.100000",
      },
    });
  });

  test("never returns stale-owner local results after another owner completes", async () => {
    listBillingOrganizations.mockImplementationOnce(async () => [
      {
        id: "agent-org",
        name: "Agent Org",
        credit_balance: "100",
        billing_email: "billing@example.test",
      },
    ]);
    recordHourlyBilling.mockImplementationOnce(async () => ({
      status: "billed",
      amount: 0.1,
      amountDecimal: "0.100000",
      newBalance: 99.9,
      transactionId: "stale-owner-local-transaction",
    }));
    completeBillingRun.mockImplementationOnce(async (runId) => {
      const started = startedRuns.get(runId);
      if (!started) throw new Error("missing mocked run");
      const winner = {
        ...started,
        status: "succeeded",
        completed_at: new Date(),
        sandboxes_processed: 1,
        sandboxes_billed: 1,
        warnings_sent: 0,
        sandboxes_shutdown: 0,
        errors: 0,
        total_revenue: "0.200000",
        duration_ms: 20,
        error_samples: [],
        lease_expires_at: null,
        updated_at: new Date(),
      };
      return {
        run: winner,
        completedByCaller: false,
        terminalReplay: true,
      };
    });

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );
    const body = (await response.json()) as {
      data: { replayed: boolean; totalRevenue: string; results?: unknown[] };
    };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      replayed: true,
      totalRevenue: "0.200000",
    });
    expect(body.data.results).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("0.100000");
  });

  test("counts a malformed billed amount once as a failed sandbox", async () => {
    listBillableSandboxes.mockImplementationOnce(async () => ({
      runningSandboxes: [runningSandbox],
      stoppedWithBackups: [],
    }));
    listBillingOrganizations.mockImplementationOnce(async () => [
      {
        id: "agent-org",
        name: "Agent Org",
        credit_balance: "100",
        billing_email: "billing@example.test",
      },
    ]);
    recordHourlyBilling.mockImplementationOnce(async () => ({
      status: "billed",
      amount: 0.1,
      amountDecimal: "not-canonical",
      newBalance: 99.9,
      transactionId: "transaction-malformed",
    }));

    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: { "x-cron-secret": "cron-secret" },
      }),
      { CRON_SECRET: "cron-secret" },
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      data: {
        status: "failed",
        sandboxesProcessed: 1,
        sandboxesBilled: 0,
        errors: 1,
        totalRevenue: "0.000000",
      },
    });
  });
});

function expectSignedWebhook(
  init: RequestInit,
  timestamp: string,
  body: string,
) {
  const headers = init.headers as Record<string, string>;
  expect(headers["X-Waifu-Webhook-Signature"]).toBe(
    `sha256=${createHmac("sha256", "test-webhook-secret")
      .update(`${timestamp}.${body}`)
      .digest("hex")}`,
  );
}
