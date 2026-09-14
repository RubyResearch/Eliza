/** Verifies trusted messaging convergence into a platform-funded rowless turn. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { OnboardingChatInput } from "@/lib/services/eliza-app/onboarding-chat";
import {
  groupParticipantLabel,
  resolveGroupParticipantDisplayName,
} from "@/lib/services/shared-runtime/group-participant-labels";
import { logger } from "@/lib/utils/logger";
import { markPreverifiedPersonalSharedRequest } from "../preverified-auth";

let activeTarget: {
  id: string;
  status: "running" | "sleeping" | "stopped";
  bridge_url?: string;
} | null = null;
let personalDeliveryIsNew = false;
const resolvePersonalDelivery = mock(async () => ({
  userId: "00000000-0000-4000-8000-000000000002",
  organizationId: "00000000-0000-4000-8000-000000000001",
  dedicatedTarget: activeTarget,
  isNew: personalDeliveryIsNew,
  resolution: "single-query-repeat" as const,
}));
const sharedRestMessageSend = mock(async () => ({ text: "hello from Eliza" }));
const prewarmPersonalSharedAgentTurnCaches = mock(async () => undefined);
const runOnboardingChat = mock(async (_input: OnboardingChatInput) => ({
  loginUrl:
    "https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token",
}));
const findActivePersonalDedicatedTarget = mock(async () => activeTarget);
let creditGateResult: { allowed: boolean; balance: number; error?: string } = {
  allowed: true,
  balance: 10,
};
const checkAgentCreditGate = mock(async () => creditGateResult);
let workerHealthResult:
  | { ok: true; required: false }
  | {
      ok: false;
      required: true;
      status: 503;
      code: "PROVISIONING_WORKER_UNHEALTHY";
      error: string;
    } = { ok: true, required: false };
const enqueueAgentResumeOnce = mock(async () => ({
  created: true,
  job: { id: "resume-job-1" },
}));
const enqueueAgentWakeOnce = mock(async () => ({
  created: true,
  job: { id: "wake-job-1" },
  appliedRestoreBackupId: null,
  appliedForceFreshBoot: false,
}));
const triggerImmediate = mock(async () => undefined);
type BridgeResponse =
  | {
      jsonrpc: "2.0";
      id: string;
      result: { text: string };
    }
  | {
      jsonrpc: "2.0";
      id: string;
      error: { code: number; message: string };
    };
const bridge = mock(
  async (): Promise<BridgeResponse> => ({
    jsonrpc: "2.0" as const,
    id: "telegram:eliza:42",
    result: { text: "hello from Dedicated" },
  }),
);
type ImportReceipt = {
  complete: true;
  sourceMessageCount: number;
  inserted: number;
  skipped: number;
};
const importCanonicalConversation = mock(
  async (
    _agentId: string,
    _orgId: string,
    _conversationId: string,
    _messages: Array<{
      sourceId: string;
      role: "user" | "assistant";
      text: string;
      timestamp?: number;
    }>,
  ): Promise<ImportReceipt | null> => ({
    complete: true,
    sourceMessageCount: 2,
    inserted: 2,
    skipped: 0,
  }),
);
const coordinateSharedHistory = mock(async () => [
  { id: "source-1", role: "user" as const, content: "before", createdAt: 100 },
  {
    id: "source-2",
    role: "assistant" as const,
    content: "after",
    createdAt: 101,
  },
]);
const issueGroupClaim = mock(async () => undefined);
const consumeGroupClaimAndBind = mock(
  async (): Promise<
    | { status: "invalid" }
    | { status: "already_bound" }
    | { status: "bound"; binding: Record<string, unknown> }
  > => ({ status: "invalid" }),
);
const resolveGroupBinding = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const setGroupResponsePolicy = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const revokeGroupBinding = mock(async () => false);
const applyGroupMembershipChange = mock(
  async (): Promise<Record<string, unknown> | null> => null,
);
const authorizeGroupDelivery = mock(
  async (): Promise<{
    authorized: boolean;
    leaseToken: string | null;
    expiresAt: string | null;
  }> => ({
    authorized: false,
    leaseToken: null,
    expiresAt: null,
  }),
);
const commitGroupDelivery = mock(async () => false);
const recordGroupDeliveryReceipts = mock(async () => ({
  recorded: false,
  inserted: 0,
}));
const hasGroupDeliveryReceipt = mock(async () => false);
const namespace = {
  getByName: mock(() => ({ fetch: mock(async () => new Response()) })),
};
const runtimeWaitUntil = mock((_promise: Promise<unknown>) => undefined);
const runtimeExecutionCtx = { waitUntil: runtimeWaitUntil };

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppUserService: {
    resolvePersonalDelivery,
  },
}));
// The real serializer, not a re-implementation: mocking it meant the header
// this route exists to emit was never actually produced by the code under
// test, so the whole route-layer claim went unexercised.
const { sharedTurnServerTiming } = await import(
  "@/lib/services/shared-runtime/shared-rest-adapter"
);
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestMessageSend,
  sharedTurnServerTiming,
}));
mock.module("@/lib/services/shared-runtime/prewarm-shared-agent", () => ({
  prewarmPersonalSharedAgentTurnCaches,
}));
mock.module("@/lib/services/eliza-app/onboarding-chat", () => ({
  runOnboardingChat,
}));
mock.module("@/lib/services/agent-tier-upgrade-target", () => ({
  findActivePersonalDedicatedTarget,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth: async () => workerHealthResult,
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentResumeOnce,
    enqueueAgentWakeOnce,
    triggerImmediate,
  },
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { bridge, importCanonicalConversation },
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory,
}));
// In-memory stand-in for the participant identity registry: ordinals are
// assigned per binding in first-seen order and names go through the real
// resolution rules, exactly as the repository does, so the label a turn
// produces is deterministic in tests.
type StubParticipant = {
  platformUserId: string;
  ordinal: number;
  displayName: string | null;
};
const groupParticipantOrdinals = new Map<
  string,
  Map<string, StubParticipant>
>();
const recordGroupParticipantTurn = mock(
  async ({
    bindingId,
    platformUserId,
    displayName,
  }: {
    bindingId: string;
    platformUserId: string;
    displayName?: string | null;
  }) => {
    let binding = groupParticipantOrdinals.get(bindingId);
    if (!binding) {
      binding = new Map<string, StubParticipant>();
      groupParticipantOrdinals.set(bindingId, binding);
    }
    const resolved = resolveGroupParticipantDisplayName({
      candidate: displayName,
      platformUserId,
      roster: [...binding.values()],
    });
    const existing = binding.get(platformUserId);
    binding.set(platformUserId, {
      platformUserId,
      ordinal: existing?.ordinal ?? binding.size + 1,
      displayName: resolved,
    });
    const roster = [...binding.values()];
    const actor = roster.find((p) => p.platformUserId === platformUserId);
    if (!actor) throw new Error("participant registry stub lost its actor");
    return { actor, roster };
  },
);
mock.module("@/db/repositories/personal-shared-groups", () => ({
  personalSharedGroupsRepository: {
    issueClaim: issueGroupClaim,
    consumeClaimAndBind: consumeGroupClaimAndBind,
    resolveBinding: resolveGroupBinding,
    setResponsePolicy: setGroupResponsePolicy,
    revokeBinding: revokeGroupBinding,
    applyMembershipChange: applyGroupMembershipChange,
    authorizeDelivery: authorizeGroupDelivery,
    commitDelivery: commitGroupDelivery,
    recordDeliveryReceipts: recordGroupDeliveryReceipts,
    hasDeliveryReceipt: hasGroupDeliveryReceipt,
  },
}));
mock.module("@/db/repositories/personal-shared-group-participants", () => ({
  personalSharedGroupParticipantsRepository: {
    recordTurn: recordGroupParticipantTurn,
  },
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedRuntimeWorkerRequestContext: () => ({
    namespace,
    executionCtx: runtimeExecutionCtx,
  }),
}));

const { default: app } = await import("./route");
const executionCtx = { waitUntil() {}, passThroughOnException() {}, props: {} };

function request(
  body: unknown,
  authorization = "Bearer test-secret",
  traceId = "11111111-1111-4111-8111-111111111111",
) {
  return app.request(
    "/",
    {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-eliza-trace-id": traceId,
      },
      body: JSON.stringify(body),
    },
    {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      WHISPER_STT_URL: "https://whisper.test",
    } as never,
    executionCtx as never,
  );
}

const valid = {
  platform: "telegram",
  project: "eliza-app",
  connectorAccountId: "telegram:test-bot",
  chatId: "123456789",
  telegramUserId: "123456789",
  telegramUsername: "nubs",
  displayName: "Nubs",
  messageId: "telegram:eliza:42",
  message: "hello",
};

const validPhone = {
  platform: "blooio",
  project: "eliza-app",
  connectorAccountId: "blooio:test-number",
  phoneNumber: "+15551234567",
  messageId: "blooio:eliza:message-42",
  message: "hello from Messages",
};

const canonicalGroupBinding = {
  id: "00000000-0000-4000-8000-000000000030",
  organization_id: "00000000-0000-4000-8000-000000000001",
  owner_user_id: "00000000-0000-4000-8000-000000000002",
  personal_agent_id: "personal:3e91680e-2611-5ff5-b759-c16b990967bd",
  platform: "telegram",
  project: "eliza-app",
  connector_account_id: "telegram:test-bot",
  provider_chat_id: "-100123456789",
  conversation_id: "group:00000000-0000-5000-8000-000000000030",
  state: "active",
  response_policy: "mention_only",
  created_by_platform_user_id: "123456789",
  authority_version: 7,
};

const canonicalBlooioGroupBinding = {
  ...canonicalGroupBinding,
  id: "00000000-0000-4000-8000-000000000031",
  platform: "blooio",
  connector_account_id: "blooio:test-number",
  provider_chat_id: "chat_group_123",
  conversation_id: "group:00000000-0000-5000-8000-000000000031",
  created_by_platform_user_id: "+15551234567",
};

const validGroup = {
  platform: "telegram",
  chatType: "supergroup",
  project: "eliza-app",
  connectorAccountId: "telegram:test-bot",
  chatId: "-100123456789",
  actor: {
    platformUserId: "123456789",
    displayName: "Nubs",
    role: "administrator",
  },
  messageId: "telegram:eliza:group-42",
  message: "@ElizaIsNotABot hello",
  invocation: "mention",
};

const validBlooioGroup = {
  platform: "blooio",
  chatType: "group",
  project: "eliza-app",
  connectorAccountId: "blooio:test-number",
  chatId: "chat_group_123",
  actor: {
    platformUserId: "+15551234567",
    displayName: "Nubs",
    role: "possessor",
  },
  messageId: "blooio:eliza:group-42",
  message: "Eliza hello",
  invocation: "mention",
};

describe("personal Shared messaging deliveries", () => {
  beforeEach(() => {
    groupParticipantOrdinals.clear();
    recordGroupParticipantTurn.mockClear();
    activeTarget = null;
    personalDeliveryIsNew = false;
    resolvePersonalDelivery.mockClear();
    findActivePersonalDedicatedTarget.mockClear();
    sharedRestMessageSend.mockClear();
    prewarmPersonalSharedAgentTurnCaches.mockClear();
    runtimeWaitUntil.mockClear();
    runOnboardingChat.mockClear();
    bridge.mockClear();
    importCanonicalConversation.mockClear();
    coordinateSharedHistory.mockClear();
    issueGroupClaim.mockClear();
    consumeGroupClaimAndBind.mockClear();
    resolveGroupBinding.mockClear();
    setGroupResponsePolicy.mockClear();
    revokeGroupBinding.mockClear();
    applyGroupMembershipChange.mockClear();
    authorizeGroupDelivery.mockClear();
    commitGroupDelivery.mockClear();
    recordGroupDeliveryReceipts.mockClear();
    hasGroupDeliveryReceipt.mockClear();
    applyGroupMembershipChange.mockImplementation(async () => null);
    authorizeGroupDelivery.mockImplementation(async () => ({
      authorized: false,
      leaseToken: null,
      expiresAt: null,
    }));
    commitGroupDelivery.mockImplementation(async () => false);
    recordGroupDeliveryReceipts.mockImplementation(async () => ({
      recorded: false,
      inserted: 0,
    }));
    hasGroupDeliveryReceipt.mockImplementation(async () => false);
    setGroupResponsePolicy.mockImplementation(
      async () => canonicalGroupBinding,
    );
    revokeGroupBinding.mockImplementation(async () => true);
    enqueueAgentResumeOnce.mockClear();
    enqueueAgentWakeOnce.mockClear();
    triggerImmediate.mockClear();
    checkAgentCreditGate.mockClear();
    creditGateResult = { allowed: true, balance: 10 };
    workerHealthResult = { ok: true, required: false };
  });

  test("requires internal gateway authentication", async () => {
    expect((await request(valid, "")).status).toBe(401);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  test("accepts an in-isolate preverified identity at the real route boundary", async () => {
    const preverifiedRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    markPreverifiedPersonalSharedRequest(preverifiedRequest, {
      podName: "gateway-1",
      service: "discord-gateway",
    });
    const env = {
      INTERNAL_SECRET: "test-secret",
      SHARED_RUNTIME_CONVERSATIONS: namespace,
      WHISPER_STT_URL: "https://whisper.test",
    } as never;

    expect(
      (
        await app.request(
          preverifiedRequest,
          undefined,
          env,
          executionCtx as never,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          new Request("http://localhost/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(valid),
          }),
          undefined,
          env,
          executionCtx as never,
        )
      ).status,
    ).toBe(401);
  });

  test("keeps the caller allowlist fail-closed for a preverified identity", async () => {
    const preverifiedRequest = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    markPreverifiedPersonalSharedRequest(preverifiedRequest, {
      podName: "agent-server-1",
      service: "agent-server",
    });

    const response = await app.request(
      preverifiedRequest,
      undefined,
      {
        INTERNAL_SECRET: "test-secret",
        SHARED_RUNTIME_CONVERSATIONS: namespace,
        WHISPER_STT_URL: "https://whisper.test",
      } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(403);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  test("uses one account-native identity and platform funding", async () => {
    const response = await request(valid);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string } };
    };
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "telegram",
      telegramId: "123456789",
      username: "nubs",
      displayName: "Nubs",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="single-query-repeat", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
    expect(body.data.identity.id).toMatch(/^personal:/);
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "telegram:eliza:42",
      "platform",
      {
        platform: "telegram",
        project: "eliza-app",
        connectorAccountId: "telegram:test-bot",
        chatId: "123456789",
      },
      "hello",
    );
  });

  test("reuses one Personal Shared identity across Telegram and Blooio DMs", async () => {
    const telegramResponse = await request(valid);
    const blooioResponse = await request(validPhone);
    const telegramBody = (await telegramResponse.json()) as {
      data: { identity: { id: string }; account: { userId: string } };
    };
    const blooioBody = (await blooioResponse.json()) as {
      data: { identity: { id: string }; account: { userId: string } };
    };

    expect(telegramResponse.status).toBe(200);
    expect(blooioResponse.status).toBe(200);
    expect(blooioBody.data.identity.id).toBe(telegramBody.data.identity.id);
    expect(blooioBody.data.account.userId).toBe(
      telegramBody.data.account.userId,
    );
    expect(resolvePersonalDelivery).toHaveBeenNthCalledWith(1, {
      platform: "telegram",
      telegramId: "123456789",
      username: "nubs",
      displayName: "Nubs",
    });
    expect(resolvePersonalDelivery).toHaveBeenNthCalledWith(2, {
      platform: "phone",
      phoneNumber: "+15551234567",
    });
  });

  test("warms a newly auto-registered personal account before its first turn", async () => {
    personalDeliveryIsNew = true;
    const order: string[] = [];
    prewarmPersonalSharedAgentTurnCaches.mockImplementationOnce(async () => {
      order.push("prewarm");
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      order.push("turn");
      return { text: "hello from Eliza" };
    });

    const response = await request({
      ...valid,
      telegramUserId: "99008152237",
      chatId: "99008152237",
      messageId: "QA815-LAT8-COLD",
    });

    expect(response.status).toBe(200);
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
      }),
      namespace,
      { warmConversation: true },
    );
    expect(order).toEqual(["prewarm", "turn"]);
    expect(runtimeWaitUntil).toHaveBeenCalledTimes(1);
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="[^"]+", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
  });

  test("prewarms established personal turns before inference admission", async () => {
    const response = await request(valid);

    expect(response.status).toBe(200);
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
      }),
      namespace,
      { warmConversation: false },
    );
    expect(runtimeWaitUntil).toHaveBeenCalledTimes(1);
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="[^"]+", prewarm;dur=\d+\.\d, shared;dur=\d+\.\d$/,
    );
  });

  test("correlates a Shared failure without logging its sensitive message", async () => {
    const errorLog = mock(() => undefined);
    const originalError = logger.error;
    logger.error = errorLog;
    const failure = new TypeError("provider body must remain private");
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      const response = await request(
        valid,
        "Bearer test-secret",
        "22222222222242228222222222222222",
      );

      expect(response.status).toBe(500);
      expect(response.headers.get("x-eliza-failure-stage")).toBe(
        "shared_runtime",
      );
      expect(response.headers.get("x-eliza-failure-name")).toBe("TypeError");
      expect(response.headers.get("x-eliza-retryable")).toBe("false");
      expect(errorLog).toHaveBeenCalledWith(
        "[personal-shared-messaging] delivery failed",
        {
          traceId: "22222222222242228222222222222222",
          stage: "shared_runtime",
          errorName: "TypeError",
          retryable: false,
        },
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "provider body must remain private",
      );
    } finally {
      logger.error = originalError;
    }
  });

  test("preserves cache warming as a retryable 503 at the internal boundary", async () => {
    const { SharedRuntimeCacheWarmingError } = await import(
      "@/lib/services/shared-runtime/shared-runtime-errors"
    );
    const warming = new SharedRuntimeCacheWarmingError(
      "private cold-gate detail",
    );
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw warming;
    });

    const response = await request(valid);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("x-eliza-failure-stage")).toBe(
      "shared_runtime",
    );
    expect(response.headers.get("x-eliza-failure-name")).toBe(
      "SharedRuntimeCacheWarmingError",
    );
    expect(response.headers.get("x-eliza-retryable")).toBe("true");
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Shared Eliza is warming. Retry this turn shortly.",
      code: "service_unavailable",
      retryable: true,
    });
  });

  test("preserves a transient AgentRuntime cause as a retryable 503", async () => {
    const { SharedRuntimeTurnError } = await import(
      "@/lib/services/shared-runtime/shared-runtime-errors"
    );
    const provider = Object.assign(new Error("private provider body"), {
      name: "AI_APICallError",
      statusCode: 503,
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw new SharedRuntimeTurnError("private turn identity", provider);
    });

    const response = await request(valid);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(response.headers.get("x-eliza-failure-name")).toBe(
      "SharedRuntimeTurnError",
    );
    expect(response.headers.get("x-eliza-failure-cause-name")).toBe(
      "SharedRuntimeProviderUnavailableError",
    );
    expect(response.headers.get("x-eliza-retryable")).toBe("true");
    expect(await response.text()).not.toContain("private provider body");
  });

  test("keeps an action-contract failure terminal and sanitized", async () => {
    const { SharedRuntimeTurnError } = await import(
      "@/lib/services/shared-runtime/shared-runtime-errors"
    );
    const cause = new Error(
      "Eliza Shared runtime completed an executable REMINDERS request without an action result",
    );
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw new SharedRuntimeTurnError("private turn identity", cause);
    });

    const response = await request(valid);

    expect(response.status).toBe(500);
    expect(response.headers.get("x-eliza-failure-name")).toBe(
      "SharedRuntimeTurnError",
    );
    expect(response.headers.get("x-eliza-failure-cause-name")).toBe(
      "SharedRuntimeActionContractError",
    );
    expect(response.headers.get("x-eliza-retryable")).toBe("false");
    expect(await response.text()).not.toContain("REMINDERS");
  });

  test("classifies a both-path account resolution failure as a retryable 503", async () => {
    const { PersonalDeliveryAccountResolutionError } = await import(
      "@/api-app/personal-delivery-projection"
    );
    const errorLog = mock(() => undefined);
    const originalError = logger.error;
    logger.error = errorLog;
    resolvePersonalDelivery.mockImplementationOnce(async () => {
      throw new PersonalDeliveryAccountResolutionError(
        "status-502:TypeError",
        new Error("private SQL detail"),
      );
    });

    try {
      const response = await request(valid);

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(response.headers.get("x-eliza-failure-stage")).toBe(
        "account_resolution",
      );
      expect(response.headers.get("x-eliza-failure-name")).toBe(
        "PersonalDeliveryAccountResolutionError",
      );
      await expect(response.json()).resolves.toEqual({
        success: false,
        error:
          "Account resolution is temporarily unavailable. Retry this turn shortly.",
        code: "service_unavailable",
        retryable: true,
      });
      expect(errorLog).toHaveBeenCalledWith(
        "[personal-shared-messaging] delivery failed",
        expect.objectContaining({
          stage: "account_resolution",
          errorName: "PersonalDeliveryAccountResolutionError",
          projectionFailure: "status-502:TypeError",
        }),
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "private SQL detail",
      );
    } finally {
      logger.error = originalError;
    }
  });

  test("redacts an unrecognized error name from headers and logs", async () => {
    const errorLog = mock(() => undefined);
    const originalError = logger.error;
    logger.error = errorLog;
    const failure = new Error("private");
    failure.name = "CallerSelectedSecretName";
    sharedRestMessageSend.mockImplementationOnce(async () => {
      throw failure;
    });

    try {
      const response = await request(valid);
      expect(response.status).toBe(500);
      expect(response.headers.get("x-eliza-failure-name")).toBe("OtherError");
      expect(errorLog).toHaveBeenCalledWith(
        "[personal-shared-messaging] delivery failed",
        expect.objectContaining({ errorName: "OtherError" }),
      );
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
        "CallerSelectedSecretName",
      );
    } finally {
      logger.error = originalError;
    }
  });

  test("transcribes a Telegram voice note before the Shared turn", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) => {
      const outbound = new Request(input, init);
      expect(outbound.url).toBe("https://whisper.test/v1/audio/transcriptions");
      const form = await outbound.formData();
      const file = form.get("file");
      expect(file).toBeInstanceOf(File);
      expect((file as File).type).toBe("audio/ogg");
      return Response.json({ text: "remember the red bicycle" });
    }) as unknown as typeof fetch;
    const bytes = Buffer.from("OggSvoice-note");
    try {
      const response = await request({
        ...valid,
        message: "please verify it",
        voiceNote: {
          bytesBase64: bytes.toString("base64"),
          mimeType: "audio/ogg",
          filename: "telegram-42.ogg",
          sizeBytes: bytes.length,
          durationSeconds: 4,
        },
      });

      expect(response.status).toBe(200);
      expect(sharedRestMessageSend).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^personal:/),
        "please verify it\n\n[Voice note transcript]\nremember the red bicycle",
        "Eliza",
        runtimeExecutionCtx,
        namespace,
        "telegram:eliza:42",
        "platform",
        {
          platform: "telegram",
          project: "eliza-app",
          connectorAccountId: "telegram:test-bot",
          chatId: "123456789",
        },
        "please verify it\nremember the red bicycle",
      );
      await expect(response.json()).resolves.toMatchObject({
        data: { reply: "hello from Eliza" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("overlaps new-account prewarm with Telegram voice transcription", async () => {
    personalDeliveryIsNew = true;
    const order: string[] = [];
    prewarmPersonalSharedAgentTurnCaches.mockImplementationOnce(async () => {
      order.push("prewarm");
    });
    sharedRestMessageSend.mockImplementationOnce(async () => {
      order.push("turn");
      return { text: "hello from Eliza" };
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      order.push("transcription");
      return Response.json({ text: "remember the red bicycle" });
    }) as unknown as typeof fetch;
    const bytes = Buffer.from("OggSvoice-note");

    try {
      const response = await request({
        ...valid,
        message: undefined,
        voiceNote: {
          bytesBase64: bytes.toString("base64"),
          mimeType: "audio/ogg",
          filename: "telegram-42.ogg",
          sizeBytes: bytes.length,
          durationSeconds: 4,
        },
      });

      expect(response.status).toBe(200);
      expect(order).toEqual(["prewarm", "transcription", "turn"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a forged voice payload before identity, storage, or inference", async () => {
    const response = await request({
      ...valid,
      message: undefined,
      voiceNote: {
        bytesBase64: Buffer.from("not ogg").toString("base64"),
        mimeType: "audio/ogg",
        filename: "telegram-42.ogg",
        sizeBytes: 7,
        durationSeconds: 4,
      },
    });

    expect(response.status).toBe(400);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("issues an account-bound Telegram claim without entering runtime or provisioning", async () => {
    const response = await request({ ...valid, message: "/connect" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        account: {
          userId: "00000000-0000-4000-8000-000000000002",
          organizationId: "00000000-0000-4000-8000-000000000001",
        },
        reply:
          "Sign in to connect this Telegram chat to your Eliza account: https://cloud-staging.eliza.app/get-started?onboardingSession=claim-token&accountClaim=telegram",
      },
    });
    expect(runOnboardingChat).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(
        /^platform:telegram-claim:[0-9a-f]{64}$/,
      ),
      platform: "telegram",
      platformUserId: "123456789",
      platformDisplayName: "Nubs",
      authenticatedUser: {
        userId: "00000000-0000-4000-8000-000000000002",
        organizationId: "00000000-0000-4000-8000-000000000001",
        telegramId: "123456789",
      },
      trustedPlatformIdentity: true,
      statusOnly: true,
      idempotencyKey: "telegram-account-claim:telegram:eliza:42",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
  });

  test("accepts Telegram's bot-qualified /connect command idempotently", async () => {
    const response = await request({
      ...valid,
      message: "/connect@elizaisnotabot",
      messageId: "telegram:eliza:43",
    });

    expect(response.status).toBe(200);
    expect(runOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.stringMatching(
          /^platform:telegram-claim:[0-9a-f]{64}$/,
        ),
        idempotencyKey: "telegram-account-claim:telegram:eliza:43",
        statusOnly: true,
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("isolates each new /connect delivery without changing retry identity", async () => {
    await request({ ...valid, message: "/connect" });
    await request({ ...valid, message: "/connect" });
    await request({
      ...valid,
      message: "/connect",
      messageId: "telegram:eliza:44",
    });

    const firstSession = runOnboardingChat.mock.calls[0]?.[0].sessionId;
    const retrySession = runOnboardingChat.mock.calls[1]?.[0].sessionId;
    const renewedSession = runOnboardingChat.mock.calls[2]?.[0].sessionId;
    expect(firstSession).toBe(retrySession);
    expect(renewedSession).not.toBe(firstSession);
  });

  test("issues a one-time owner-bound group claim without entering inference", async () => {
    const response = await request({ ...valid, message: "/group" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_issued",
        reply: expect.stringMatching(
          /Add Eliza to the group[\s\S]*\/eliza_link [A-Z0-9]{8}[\s\S]*same Telegram account/,
        ),
      },
    });
    expect(issueGroupClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: "00000000-0000-4000-8000-000000000002",
        platform: "telegram",
        connectorAccountId: "telegram:test-bot",
        issuedToPlatformUserId: "123456789",
        codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("gives Blooio owners iMessage-specific group-link instructions", async () => {
    const response = await request({ ...validPhone, message: "/group" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_issued",
        reply: expect.stringMatching(
          /Add Eliza to the group[\s\S]*Eliza link [A-Z0-9]{8}[\s\S]*same iMessage identity/,
        ),
      },
    });
    expect(issueGroupClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "blooio",
        connectorAccountId: "blooio:test-number",
        issuedToPlatformUserId: "+15551234567",
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("binds a Blooio group through the requesting iMessage possessor", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "bound" as const,
      binding: canonicalBlooioGroupBinding,
    }));
    const response = await request({
      ...validBlooioGroup,
      message: "Eliza link ABCD2345",
      invocation: "command",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_bound",
        identity: {
          id: canonicalBlooioGroupBinding.personal_agent_id,
          runtime: "shared",
        },
        account: {
          userId: canonicalBlooioGroupBinding.owner_user_id,
          organizationId: canonicalBlooioGroupBinding.organization_id,
        },
        reply: expect.stringContaining(
          "explicit mentions, commands, and replies",
        ),
      },
    });
    expect(consumeGroupClaimAndBind).toHaveBeenCalledWith({
      codeHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "blooio:test-number",
      providerChatId: "chat_group_123",
      actorPlatformUserId: "+15551234567",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("fails a mismatched Blooio group claimant closed", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "invalid" as const,
    }));
    const response = await request({
      ...validBlooioGroup,
      actor: {
        ...validBlooioGroup.actor,
        platformUserId: "+15557654321",
      },
      message: "Eliza link ABCD2345",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_invalid",
        reply: expect.stringContaining("not valid for this account or sender"),
      },
    });
    expect(consumeGroupClaimAndBind).toHaveBeenCalledWith(
      expect.objectContaining({ actorPlatformUserId: "+15557654321" }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("guides a suspended Blooio group through owner reconnect", async () => {
    resolveGroupBinding.mockImplementationOnce(async () => ({
      ...canonicalBlooioGroupBinding,
      state: "suspended",
    }));
    const response = await request(validBlooioGroup);

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_suspended",
        reply: expect.stringMatching(/owner.*DM Eliza `\/group`.*reconnect/i),
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("fails a Telegram group link closed without verified admin authority", async () => {
    const response = await request({
      ...validGroup,
      actor: { ...validGroup.actor, role: "unknown" },
      message: "/eliza_link 23456789",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_admin_required",
        groupDelivery: { kind: "control" },
      },
    });
    expect(consumeGroupClaimAndBind).not.toHaveBeenCalled();
  });

  test("binds a verified Telegram admin to the pre-existing owner identity", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "bound" as const,
      binding: canonicalGroupBinding,
    }));
    const response = await request({
      ...validGroup,
      message: "/eliza_link 23456789",
      invocation: "command",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_bound",
        account: {
          userId: canonicalGroupBinding.owner_user_id,
          organizationId: canonicalGroupBinding.organization_id,
        },
        groupDelivery: {
          kind: "binding",
          authority: {
            bindingId: canonicalGroupBinding.id,
            ownerUserId: canonicalGroupBinding.owner_user_id,
            personalAgentId: canonicalGroupBinding.personal_agent_id,
            version: canonicalGroupBinding.authority_version,
          },
        },
      },
    });
    expect(consumeGroupClaimAndBind).toHaveBeenCalledWith(
      expect.objectContaining({
        providerChatId: "-100123456789",
        actorPlatformUserId: "123456789",
      }),
    );
  });

  test("does not let a second administrator take over an active owner binding", async () => {
    consumeGroupClaimAndBind.mockImplementationOnce(async () => ({
      status: "already_bound" as const,
    }));
    const response = await request({
      ...validGroup,
      message: "/eliza_link 23456789",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_claim_already_bound",
        reply: expect.stringContaining("already linked to another Eliza owner"),
        groupDelivery: { kind: "control" },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("routes a bound mention in its stable group conversation", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    const response = await request(validGroup);

    expect(response.status).toBe(200);
    await expect(response.clone().json()).resolves.toMatchObject({
      data: {
        groupDelivery: {
          kind: "binding",
          authority: {
            bindingId: canonicalGroupBinding.id,
            ownerUserId: canonicalGroupBinding.owner_user_id,
            personalAgentId: canonicalGroupBinding.personal_agent_id,
            version: canonicalGroupBinding.authority_version,
          },
        },
      },
    });
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({ id: canonicalGroupBinding.personal_agent_id }),
      namespace,
      {
        warmConversation: true,
        conversationId: canonicalGroupBinding.conversation_id,
      },
    );
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: canonicalGroupBinding.personal_agent_id }),
      canonicalGroupBinding.conversation_id,
      `${groupParticipantLabel({
        ordinal: 1,
        displayName: validGroup.actor.displayName,
      })}: ${validGroup.message}`,
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      validGroup.messageId,
      "platform",
      {
        platform: "telegram",
        kind: "group",
        project: "eliza-app",
        connectorAccountId: "telegram:test-bot",
        chatId: "-100123456789",
        ownerLabel: "Nubs",
        authority: {
          bindingId: canonicalGroupBinding.id,
          ownerUserId: canonicalGroupBinding.owner_user_id,
          personalAgentId: canonicalGroupBinding.personal_agent_id,
          version: canonicalGroupBinding.authority_version,
        },
      },
      validGroup.message,
      { type: "GROUP", source: "telegram" },
    );
  });

  test("keeps mention-only groups silent for ambient traffic", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    const response = await request({ ...validGroup, invocation: "ambient" });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_silent", reply: "" },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("does not report a policy update after the active binding changed", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    setGroupResponsePolicy.mockImplementationOnce(async () => null);
    const response = await request({
      ...validGroup,
      message: "Eliza ambient on",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_changed",
        groupDelivery: { kind: "control" },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("does not report a disconnect after the active binding changed", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    revokeGroupBinding.mockImplementationOnce(async () => false);
    const response = await request({
      ...validGroup,
      message: "Eliza leave",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_changed",
        groupDelivery: { kind: "control" },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("returns the incremented binding authority with a policy confirmation", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    const updated = { ...canonicalGroupBinding, authority_version: 8 };
    setGroupResponsePolicy.mockImplementationOnce(async () => updated);
    const response = await request({
      ...validGroup,
      message: "Eliza ambient on",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_policy_updated",
        groupDelivery: {
          kind: "binding",
          authority: {
            bindingId: updated.id,
            ownerUserId: updated.owner_user_id,
            personalAgentId: updated.personal_agent_id,
            version: 8,
          },
        },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("marks a successful revoke confirmation as explicit control egress", async () => {
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );
    revokeGroupBinding.mockImplementationOnce(async () => true);
    const response = await request({
      ...validGroup,
      message: "Eliza leave",
      invocation: "command",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_binding_revoked",
        groupDelivery: { kind: "control" },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("suspends and restores only an existing Telegram group binding", async () => {
    applyGroupMembershipChange.mockImplementation(
      async () => canonicalGroupBinding,
    );
    const response = await request({
      eventType: "membership",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      chatId: "-100123456789",
      messageId: "telegram:membership:42",
      membershipChange: "removed",
    });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_membership_removed", reply: "" },
    });
    expect(applyGroupMembershipChange).toHaveBeenCalledWith({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      providerChatId: "-100123456789",
      membershipChange: "removed",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("reports a live delivery reservation without fabricating membership removal", async () => {
    applyGroupMembershipChange.mockImplementationOnce(async () => {
      throw Object.assign(new Error("internal delivery state"), {
        code: "PERSONAL_SHARED_GROUP_DELIVERY_PENDING",
      });
    });
    const response = await request({
      eventType: "membership",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      chatId: "-100123456789",
      messageId: "telegram:membership:pending",
      membershipChange: "removed",
    });

    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      success: false,
      error:
        "A provider delivery reservation is still active. Group authority was not changed; retry shortly.",
      code: "group_delivery_pending",
      retryable: true,
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("records provider egress receipts without entering inference", async () => {
    recordGroupDeliveryReceipts.mockImplementationOnce(async () => ({
      recorded: true,
      inserted: 1,
    }));
    const response = await request({
      eventType: "delivery_receipt",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "blooio:test-number",
      chatId: "chat_group_123",
      sourceMessageId: "blooio:eliza-app:incoming-42",
      providerMessageIds: ["outgoing-42"],
      leaseToken: "00000000-0000-4000-8000-000000000097",
      authority: {
        bindingId: canonicalGroupBinding.id,
        ownerUserId: canonicalGroupBinding.owner_user_id,
        personalAgentId: canonicalGroupBinding.personal_agent_id,
        version: canonicalGroupBinding.authority_version,
      },
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_delivery_receipt_recorded",
        recorded: true,
        inserted: 1,
      },
    });
    expect(recordGroupDeliveryReceipts).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("accepts the full shared source-message boundary for delivery receipts", async () => {
    recordGroupDeliveryReceipts.mockImplementationOnce(async () => ({
      recorded: true,
      inserted: 1,
    }));
    const sourceMessageId = "s".repeat(240);
    const response = await request({
      eventType: "delivery_receipt",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "blooio:test-number",
      chatId: "chat_group_123",
      sourceMessageId,
      providerMessageIds: ["outgoing-boundary"],
      leaseToken: "00000000-0000-4000-8000-000000000095",
      authority: {
        bindingId: canonicalGroupBinding.id,
        ownerUserId: canonicalGroupBinding.owner_user_id,
        personalAgentId: canonicalGroupBinding.personal_agent_id,
        version: canonicalGroupBinding.authority_version,
      },
    });

    expect(response.status).toBe(200);
    expect(recordGroupDeliveryReceipts).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMessageId }),
    );

    const rejected = await request({
      eventType: "delivery_receipt",
      platform: "blooio",
      project: "eliza-app",
      connectorAccountId: "blooio:test-number",
      chatId: "chat_group_123",
      sourceMessageId: "s".repeat(241),
      providerMessageIds: ["outgoing-over-boundary"],
      leaseToken: "00000000-0000-4000-8000-000000000094",
      authority: {
        bindingId: canonicalGroupBinding.id,
        ownerUserId: canonicalGroupBinding.owner_user_id,
        personalAgentId: canonicalGroupBinding.personal_agent_id,
        version: canonicalGroupBinding.authority_version,
      },
    });
    expect(rejected.status).toBe(400);
    expect(recordGroupDeliveryReceipts).toHaveBeenCalledTimes(1);
  });

  test("revalidates the exact binding generation before provider egress", async () => {
    const leaseToken = "00000000-0000-4000-8000-000000000099";
    authorizeGroupDelivery.mockImplementationOnce(async () => ({
      authorized: true,
      leaseToken,
      expiresAt: "2026-08-22T01:00:00.000Z",
    }));
    const authority = {
      bindingId: canonicalGroupBinding.id,
      ownerUserId: canonicalGroupBinding.owner_user_id,
      personalAgentId: canonicalGroupBinding.personal_agent_id,
      version: canonicalGroupBinding.authority_version,
    };
    const response = await request({
      eventType: "delivery_authorization",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      chatId: "-100123456789",
      sourceMessageId: "telegram:eliza-app:source-1",
      leaseToken,
      invocation: "ambient",
      authority,
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        code: "group_delivery_authorization",
        authorized: true,
        leaseToken,
      },
    });
    expect(authorizeGroupDelivery).toHaveBeenCalledWith({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      providerChatId: "-100123456789",
      sourceMessageId: "telegram:eliza-app:source-1",
      leaseToken,
      invocation: "ambient",
      authority,
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("commits only the exact delivery reservation before provider egress", async () => {
    const leaseToken = "00000000-0000-4000-8000-000000000096";
    commitGroupDelivery.mockImplementationOnce(async () => true);
    const authority = {
      bindingId: canonicalGroupBinding.id,
      ownerUserId: canonicalGroupBinding.owner_user_id,
      personalAgentId: canonicalGroupBinding.personal_agent_id,
      version: canonicalGroupBinding.authority_version,
    };
    const response = await request({
      eventType: "delivery_commit",
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      chatId: "-100123456789",
      sourceMessageId: "telegram:eliza-app:source-1",
      leaseToken,
      authority,
    });

    await expect(response.json()).resolves.toMatchObject({
      data: { code: "group_delivery_committed", committed: true },
    });
    expect(commitGroupDelivery).toHaveBeenCalledWith({
      platform: "telegram",
      project: "eliza-app",
      connectorAccountId: "telegram:test-bot",
      providerChatId: "-100123456789",
      sourceMessageId: "telegram:eliza-app:source-1",
      leaseToken,
      authority,
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("auto-registers a first phone message without provisioning an agent row", async () => {
    personalDeliveryIsNew = true;
    const response = await request(validPhone);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string }; account: { userId: string } };
    };
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "phone",
      phoneNumber: "+15551234567",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(body.data.identity.id).toMatch(/^personal:/);
    expect(body.data.account.userId).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
      }),
      namespace,
      { warmConversation: true },
    );
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({
        id: body.data.identity.id,
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
        execution_tier: "shared",
      }),
      body.data.identity.id,
      "hello from Messages",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "blooio:eliza:message-42",
      "platform",
      {
        platform: "blooio",
        project: "eliza-app",
        phoneNumber: "+15551234567",
      },
      "hello from Messages",
    );
  });

  test("routes a phone transport to the same Dedicated primary after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };

    const response = await request(validPhone);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        identity: {
          runtime: "dedicated",
          activeAgentId: activeTarget.id,
        },
        reply: "hello from Dedicated",
      },
    });
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "phone",
      phoneNumber: "+15551234567",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  test("returns binding authority with a Dedicated group reply after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    resolveGroupBinding.mockImplementationOnce(
      async () => canonicalGroupBinding,
    );

    const response = await request(validGroup);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        identity: {
          runtime: "dedicated",
          activeAgentId: activeTarget.id,
        },
        reply: "hello from Dedicated",
        groupDelivery: {
          kind: "binding",
          authority: {
            bindingId: canonicalGroupBinding.id,
            ownerUserId: canonicalGroupBinding.owner_user_id,
            personalAgentId: canonicalGroupBinding.personal_agent_id,
            version: canonicalGroupBinding.authority_version,
          },
        },
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(
      activeTarget.id,
      canonicalGroupBinding.organization_id,
      expect.objectContaining({
        params: expect.objectContaining({
          roomId: canonicalGroupBinding.conversation_id,
          conversationId: canonicalGroupBinding.conversation_id,
        }),
      }),
    );
  });

  test("keeps a Blooio reminder on Dedicated after cutover without Shared prewarm", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    const reminder = "Remind me in 2 minutes to stretch";

    const response = await request({
      ...validPhone,
      messageId: "blooio:reminder-42",
      message: reminder,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        account: {
          userId: "00000000-0000-4000-8000-000000000002",
          organizationId: "00000000-0000-4000-8000-000000000001",
        },
        reply: "hello from Dedicated",
      },
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "blooio:reminder-42",
        method: "message.send",
        params: expect.objectContaining({
          text: reminder,
          roomId: expect.stringMatching(/^personal:/),
          conversationId: expect.stringMatching(/^personal:/),
          clientMessageId: "blooio:reminder-42",
          platformName: "blooio",
          source: "blooio",
        }),
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(runtimeWaitUntil).not.toHaveBeenCalled();
  });

  test("auto-registers a first Discord DM in the same personal room", async () => {
    personalDeliveryIsNew = true;
    const discordUserId = ["123456789", "012345678"].join("");
    const response = await request({
      platform: "discord",
      discordUserId,
      discordUsername: "shaw",
      displayName: "Shaw",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
      messageId: "discord:message-42",
      message: "continue our conversation",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { identity: { id: string } };
    };
    expect(resolvePersonalDelivery).toHaveBeenCalledWith({
      platform: "discord",
      discordId: discordUserId,
      username: "shaw",
      globalName: "Shaw",
      avatarUrl: "https://cdn.discordapp.com/avatar.png",
    });
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
        user_id: "00000000-0000-4000-8000-000000000002",
      }),
      namespace,
      { warmConversation: true },
    );
    expect(sharedRestMessageSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: body.data.identity.id }),
      body.data.identity.id,
      "continue our conversation",
      "Eliza",
      runtimeExecutionCtx,
      namespace,
      "discord:message-42",
      "platform",
      {
        platform: "discord",
        discordUserId: "123456789012345678",
      },
      "continue our conversation",
    );
  });

  test("routes Telegram to the server-owned Dedicated primary after cutover", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };

    const response = await request(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        reply: "hello from Dedicated",
      },
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(findActivePersonalDedicatedTarget).not.toHaveBeenCalled();
    expect(response.headers.get("server-timing")).toMatch(
      /^account;dur=\d+\.\d;desc="single-query-repeat", dedicated;dur=\d+\.\d$/,
    );
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "telegram:eliza:42",
        method: "message.send",
        params: expect.objectContaining({
          text: "hello",
          roomId: expect.stringMatching(/^personal:/),
          conversationId: expect.stringMatching(/^personal:/),
          canonicalBridgeBase:
            "http://127.0.0.1:9876/api/compat/agents/sandbox",
          clientMessageId: "telegram:eliza:42",
          platformName: "telegram",
          source: "telegram",
        }),
      }),
    );
  });

  test("keeps a Telegram reminder on Dedicated after cutover without reopening Shared", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    const reminder = "Remind me in 2 minutes to stretch";

    const response = await request({
      ...valid,
      message: reminder,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        reply: "hello from Dedicated",
      },
    });
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "telegram:eliza:42",
        method: "message.send",
        params: expect.objectContaining({
          text: reminder,
          roomId: expect.stringMatching(/^personal:/),
          conversationId: expect.stringMatching(/^personal:/),
          clientMessageId: "telegram:eliza:42",
          platformName: "telegram",
          source: "telegram",
        }),
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(runtimeWaitUntil).not.toHaveBeenCalled();
  });

  test("keeps a Discord reminder on Dedicated after cutover without reopening Shared", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
      bridge_url: "http://127.0.0.1:9876/api/compat/agents/sandbox",
    };
    const discordUserId = ["123456789", "012345678"].join("");
    const reminder = "Remind me in 2 minutes to stretch";
    bridge.mockImplementationOnce(async () => ({
      jsonrpc: "2.0" as const,
      id: "discord:reminder-42",
      result: { text: "hello from Dedicated" },
    }));

    const response = await request({
      platform: "discord",
      discordUserId,
      discordUsername: "shaw",
      displayName: "Shaw",
      messageId: "discord:reminder-42",
      message: reminder,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          runtime: "dedicated",
          activeAgentId: "00000000-0000-4000-8000-000000000020",
        },
        reply: "hello from Dedicated",
      },
    });
    expect(bridge).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        id: "discord:reminder-42",
        method: "message.send",
        params: expect.objectContaining({
          text: reminder,
          roomId: expect.stringMatching(/^personal:/),
          conversationId: expect.stringMatching(/^personal:/),
          clientMessageId: "discord:reminder-42",
          platformName: "discord",
          source: "discord",
        }),
      }),
    );
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
    expect(prewarmPersonalSharedAgentTurnCaches).not.toHaveBeenCalled();
    expect(runtimeWaitUntil).not.toHaveBeenCalled();
  });

  for (const status of ["stopped", "sleeping"] as const) {
    for (const balance of [0, 10]) {
      test(`${status} Dedicated requires app price review even with balance ${balance}`, async () => {
        activeTarget = { id: "00000000-0000-4000-8000-000000000020", status };
        creditGateResult = { allowed: balance > 0, balance };
        const response = await request(valid);
        expect(response.status).toBe(428);
        expect(await response.json()).toMatchObject({
          code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
          error:
            "Open Eliza to review the current price and start your Dedicated agent.",
          retryable: false,
        });
        expect(response.headers.get("retry-after")).toBeNull();
        expect(checkAgentCreditGate).not.toHaveBeenCalled();
        expect(enqueueAgentResumeOnce).not.toHaveBeenCalled();
        expect(enqueueAgentWakeOnce).not.toHaveBeenCalled();
        expect(triggerImmediate).not.toHaveBeenCalled();
        expect(sharedRestMessageSend).not.toHaveBeenCalled();
        expect(bridge).not.toHaveBeenCalled();
      });
    }
  }

  test("surfaces a Dedicated bridge failure without reopening Shared", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge.mockImplementationOnce(async () => ({
      jsonrpc: "2.0" as const,
      id: "telegram:eliza:42",
      error: { code: -32_603, message: "Dedicated unavailable" },
    }));

    const response = await request(valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
    });
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("repairs a missing cutover conversation from authoritative Shared history", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        error: { code: -32_000, message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        result: { text: "repaired Dedicated reply" },
      }));

    const response = await request(valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { reply: "repaired Dedicated reply" },
    });
    expect(coordinateSharedHistory).toHaveBeenCalledWith(
      expect.stringMatching(/^personal:/),
      expect.stringMatching(/^personal:/),
      { namespace },
    );
    expect(importCanonicalConversation).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000020",
      "00000000-0000-4000-8000-000000000001",
      expect.stringMatching(/^personal:/),
      [
        { sourceId: "source-1", role: "user", text: "before", timestamp: 100 },
        {
          sourceId: "source-2",
          role: "assistant",
          text: "after",
          timestamp: 101,
        },
      ],
    );
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("recreates an empty canonical conversation when history import is unavailable", async () => {
    activeTarget = {
      id: "00000000-0000-4000-8000-000000000020",
      status: "running",
    };
    bridge
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        error: { code: -32_000, message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({
        jsonrpc: "2.0" as const,
        id: "telegram:eliza:42",
        result: { text: "available Dedicated reply" },
      }));
    importCanonicalConversation
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({
        complete: true as const,
        sourceMessageCount: 0,
        inserted: 0,
        skipped: 0,
      }));

    const response = await request(valid);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { reply: "available Dedicated reply" },
    });
    expect(importCanonicalConversation).toHaveBeenCalledTimes(2);
    expect(importCanonicalConversation.mock.calls[1]?.[3]).toEqual([]);
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  test.each([
    { ...validPhone, phoneNumber: "15551234567" },
    { ...valid, telegramUserId: "not-a-number" },
    {
      platform: "discord",
      discordUserId: "not-a-snowflake",
      discordUsername: "shaw",
      messageId: "discord:invalid",
      message: "hello",
    },
    { ...valid, message: "" },
  ])("rejects malformed deliveries before account creation", async (body) => {
    expect((await request(body)).status).toBe(400);
    expect(resolvePersonalDelivery).not.toHaveBeenCalled();
  });

  // The route's headline claim is that a provider timing receipt reaches the
  // client as a `shared_model` Server-Timing segment. Every other test here
  // returns no `timing`, so that segment was never produced — this drives the
  // real serializer with a real receipt.
  test("emits the shared_model segment when the turn carries a timing receipt", async () => {
    sharedRestMessageSend.mockResolvedValueOnce({
      text: "hello from Eliza",
      timing: {
        replayed: false,
        durationMs: 1234.5,
        callCount: 2,
        fallbackCount: 1,
        selectedProvider: "openrouter",
        callsTruncated: false,
        clamped: false,
        calls: [],
      },
    } as never);

    const response = await request(valid);
    expect(response.status).toBe(200);

    const serverTiming = response.headers.get("server-timing") ?? "";
    expect(serverTiming).toContain("shared_model;dur=1234.5");
    expect(serverTiming).toContain("provider=openrouter");
    expect(serverTiming).toContain("calls=2");
    expect(serverTiming).toContain("fallbacks=1");
    expect(serverTiming).toContain("replayed=0");
    expect(serverTiming).toContain("clamped=0");
  });
});
