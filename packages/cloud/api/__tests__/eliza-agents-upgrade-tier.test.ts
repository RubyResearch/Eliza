/**
 * GET/POST /api/v1/eliza/agents/:agentId/upgrade-tier — the server-owned
 * Shared→Dedicated quote and explicitly confirmed activation contract.
 * Coverage includes the rowless personal Shared identity, org-scoped
 * ownership, hosting-runway credit gate, server-side identity copy,
 * single-flight target creation, and idempotent reattachment.
 *
 * Real route module + real sandbox/billing/provisioning services + real
 * repositories against in-process PGlite; the only mocked seam is
 * `requireAuthOrApiKeyWithOrg` (same pattern as eliza-agents-restore-body-guard).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { installOrganizationPolicyTestSchema } from "@/db/repositories/organization-policy-test-fixture";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import * as realAuth from "@/lib/auth";
import { runWithCloudBindings } from "@/lib/runtime/cloud-bindings";
import { SandboxTransport } from "@/lib/services/eliza-sandbox/bridge/transport";
import {
  personalSharedAgent,
  personalSharedAgentId,
} from "@/lib/services/shared-runtime/personal-shared-agent";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_A_OPERATOR = "aaaaaaaa-2222-4222-8222-222222222222";
const USER_B = "bbbbbbbb-1111-4111-8111-111111111111";
const CHARACTER_A = "eeeeeeee-1111-4111-8111-111111111111";
const SHARED_A = "cccccccc-1111-4111-8111-111111111111";
const SHARED_A_STOPPED = "cccccccc-3333-4333-8333-333333333333";
const DEDICATED_A = "cccccccc-4444-4444-8444-444444444444";
const SHARED_RESUME = "cccccccc-7777-4777-8777-777777777777";
const STOPPED_TARGET = "cccccccc-8888-4888-8888-888888888888";
const SLEEPING_TARGET = "cccccccc-9999-4999-8999-999999999999";
const ERROR_TARGET = "cccccccc-eeee-4eee-8eee-eeeeeeeeeeee";
const SHARED_CONCURRENT = "cccccccc-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SHARED_B = "cccccccc-2222-4222-8222-222222222222";
const MISSING = "dddddddd-9999-4999-8999-999999999999";
const ORG_FULL = "33333333-3333-4333-8333-333333333333";
const USER_FULL = "bbbbbbbb-2222-4222-8222-222222222222";
const SHARED_FULL = "cccccccc-ffff-4fff-8fff-ffffffffffff";
const SHARED_SELECTED = "cccccccc-f111-4f11-8f11-111111111111";
const SELECTED_EXISTING = "dddddddd-f111-4f11-8f11-111111111111";
const SELECTED_STALE = "dddddddd-f222-4f22-8f22-222222222222";
const SHARED_RETAINED_AUTHORITY = "cccccccc-f333-4f33-8f33-333333333333";
const MISSING_RETAINED_TARGET = "dddddddd-f333-4f33-8f33-333333333333";
const PERSONAL_A = personalSharedAgentId({
  userId: USER_A,
  organizationId: ORG_A,
});
const PERSONAL_B = personalSharedAgentId({
  userId: USER_B,
  organizationId: ORG_B,
});
const ORG_C = "44444444-4444-4444-8444-444444444444";
const USER_C = "aaaaaaaa-4444-4444-8444-444444444444";
const CUTOVER_TARGET = "cccccccc-4444-4555-8555-555555555555";
const PERSONAL_C = personalSharedAgentId({
  userId: USER_C,
  organizationId: ORG_C,
});

// Caller identity is switchable so both cross-org denial and same-org
// operator lineage authority are exercised through the real route.
const currentUser = {
  id: USER_A,
  email: "owner-a@test.test",
  organization_id: ORG_A,
  organization: { id: ORG_A, name: "Org A", is_active: true },
  is_active: true,
  role: "owner",
  telegram_id: null as string | null,
  discord_id: null as string | null,
};

// VALUE snapshot at module evaluation + mock installed in beforeAll — never at
// module scope: `bun test` evaluates every test file's module scope up front,
// so a module-scope mock would patch the shared auth module under every OTHER
// suite in a multi-file run (the coverage lane co-runs changed suites, #15943).
const realAuthSnapshot = { ...realAuth };

let cutoverHistory = [
  {
    id: "lifecycle-1",
    role: "system" as const,
    content: "The signed-in mobile session started.",
    createdAt: 5,
  },
  { id: "u1", role: "user" as const, content: "hello", createdAt: 10 },
  {
    id: "a1",
    role: "assistant" as const,
    content: "hello back",
    createdAt: 20,
  },
];
const cutoverCoordinatorOperations: string[] = [];
const cutoverCoordinatorTokens: string[] = [];
let cutoverSealToken: string | null = null;
let cutoverSealCommitted = false;
let cutoverCommitFailuresRemaining = 0;
let observeMarkerAtCommit = false;
let markerObservedAtCommit: unknown;
const cutoverCoordinatorFetch = mock(
  async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      operation: string;
      token?: string;
    };
    cutoverCoordinatorOperations.push(body.operation);
    if (body.token) cutoverCoordinatorTokens.push(body.token);
    if (body.operation === "cutover-seal") {
      if (cutoverSealToken && cutoverSealToken !== body.token) {
        return Response.json(
          { success: false, code: "personal_cutover_in_progress" },
          { status: 423 },
        );
      }
      cutoverSealToken = body.token ?? null;
      return Response.json({ success: true, history: cutoverHistory });
    }
    if (body.operation === "cutover-release") {
      if (!cutoverSealCommitted && cutoverSealToken === body.token) {
        cutoverSealToken = null;
      }
      return Response.json({ success: true });
    }
    if (body.operation === "cutover-commit") {
      if (observeMarkerAtCommit) {
        const { dbWrite } = await import("@/db/client");
        const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
        const [target] = await dbWrite
          .select()
          .from(agentSandboxes)
          .where(eq(agentSandboxes.id, CUTOVER_TARGET));
        markerObservedAtCommit = (
          target?.agent_config as Record<string, unknown> | null
        )?.__agentPersonalCutover;
      }
      if (cutoverCommitFailuresRemaining > 0) {
        cutoverCommitFailuresRemaining -= 1;
        return Response.json(
          { success: false, code: "temporary_commit_failure" },
          { status: 503 },
        );
      }
      if (!cutoverSealToken || cutoverSealToken !== body.token) {
        return Response.json(
          { success: false, code: "personal_cutover_seal_lost" },
          { status: 409 },
        );
      }
      cutoverSealCommitted = true;
    }
    return Response.json({ success: true });
  },
);
const cutoverNamespace = {
  getByName: mock(() => ({ fetch: cutoverCoordinatorFetch })),
};
const invalidatedDeliveryProjections: string[] = [];
const personalDeliveryProjectionNamespace = {
  getByName: mock((name: string) => ({
    fetch: mock(async () => {
      invalidatedDeliveryProjections.push(name);
      return Response.json({ success: true });
    }),
  })),
};
const ENV = {
  NODE_ENV: "test",
  SHARED_RUNTIME_CONVERSATIONS: cutoverNamespace,
  PERSONAL_DELIVERY_PROJECTIONS: personalDeliveryProjectionNamespace,
  ELIZA_CLOUD_AGENT_BASE_DOMAIN: "dedicated-cutover.test",
  AGENT_ROUTER_ORIGIN_HOST: "router-cutover.test",
} as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

async function setOrgBalance(orgId: string, balance: string): Promise<void> {
  const { dbWrite } = await import("@/db/client");
  const { organizations } = await import("@/db/schemas/organizations");
  await dbWrite
    .update(organizations)
    .set({ credit_balance: balance })
    .where(eq(organizations.id, orgId));
}

beforeAll(async () => {
  try {
    mock.module("@/lib/auth", () => ({
      ...realAuthSnapshot,
      requireAuthOrApiKeyWithOrg: mock(async () => ({ user: currentUser })),
    }));

    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    // Plain DDL instead of drizzle-kit pushSchema: the coverage lane co-runs
    // every changed suite in ONE bun process, and drizzle-kit answers internal
    // errors there with a silent process.exit(1) that kills the whole run.
    const { TIER_UPGRADE_TEST_TABLES } = await import(
      "@/lib/services/__tests__/tier-upgrade-pglite-schema"
    );
    for (const ddl of TIER_UPGRADE_TEST_TABLES) {
      await dbWrite.execute(ddl);
    }
    const { getPgliteClientForTests } = await import("@/db/client");
    await installOrganizationPolicyTestSchema((query) =>
      getPgliteClientForTests().exec(query),
    );
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");

    await dbWrite.insert(organizations).values([
      // Above the create minimum ($0.30) but BELOW the 3-day hosting runway
      // ($10.80) — the exact gap the upgrade gate exists to close.
      { id: ORG_A, name: "Org A", slug: "org-a", credit_balance: "0.50" },
      { id: ORG_B, name: "Org B", slug: "org-b", credit_balance: "100" },
    ]);
    await dbWrite.insert(users).values([
      {
        id: USER_A,
        email: "owner-a@test.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${USER_A}`,
      },
      {
        id: USER_A_OPERATOR,
        email: "operator-a@test.test",
        organization_id: ORG_A,
        role: "member",
        steward_user_id: `steward-${USER_A_OPERATOR}`,
      },
      {
        id: USER_B,
        email: "owner-b@test.test",
        organization_id: ORG_B,
        role: "owner",
        steward_user_id: `steward-${USER_B}`,
      },
    ]);
    await dbWrite.insert(userCharacters).values([
      {
        id: CHARACTER_A,
        organization_id: ORG_A,
        user_id: USER_A,
        name: "Aurora",
        bio: ["An autonomous AI agent."],
        character_data: { name: "Aurora", system: "Shared front persona." },
      },
    ]);

    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Aurora Front",
        character_id: CHARACTER_A,
        agent_config: {
          character: { name: "Aurora", system: "Shared front persona." },
          bio: ["An autonomous AI agent."],
        },
        environment_vars: {
          MY_CUSTOM_VAR: "keep-me",
          OPENAI_API_KEY: "sk-byo-test",
          // Platform-owned identity values bound to the SHARED row — the copy
          // must NOT inherit them (the dedicated target mints its own).
          ELIZA_API_TOKEN: "agent_shared_platform_token",
          ELIZA_CLOUD_AGENT_ID: SHARED_A,
        },
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      {
        id: SHARED_A_STOPPED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Broken Shared",
        execution_tier: "shared",
        status: "error",
        database_status: "none",
      },
      {
        id: DEDICATED_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Already Dedicated",
        // A separate custom Dedicated row is not an eligible personal
        // same-row adoption candidate and must not block Shared upgrades.
        execution_tier: "custom",
        status: "running",
        database_status: "none",
      },
      {
        id: SHARED_B,
        organization_id: ORG_B,
        user_id: USER_B,
        agent_name: "Org B Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
    ]);

    const upgradeTierRoute = (
      await import("../v1/eliza/agents/[agentId]/upgrade-tier/route")
    ).default;
    const cutoverRoute = (
      await import("../v1/eliza/agents/[agentId]/upgrade-tier/cutover/route")
    ).default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId/upgrade-tier", upgradeTierRoute);
    app.route(
      "/api/v1/eliza/agents/:agentId/upgrade-tier/cutover",
      cutoverRoute,
    );
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-upgrade-tier.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
  // Hand the pristine module back to whatever test file runs after this one in
  // the same process — a leaked module mock patches itself into later suites'
  // imports.
  mock.module("@/lib/auth", () => realAuthSnapshot);
});

function quote(agentId: string) {
  return app.request(
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`,
    { method: "GET" },
    ENV,
  );
}

function cutover(agentId: string, dedicatedAgentId: string) {
  return runWithCloudBindings(ENV, () =>
    app.request(
      `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier/cutover`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer steward-test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ dedicatedAgentId }),
      },
      ENV,
    ),
  );
}

async function upgrade(
  agentId: string,
  executionCtx?: Parameters<Hono<AppEnv>["request"]>[3],
) {
  const quoted = await quote(agentId);
  const body = (await quoted
    .clone()
    .json()
    .catch(() => null)) as {
    data?: { quoteId?: string };
  } | null;
  return app.request(
    `/api/v1/eliza/agents/${encodeURIComponent(agentId)}/upgrade-tier`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "activate_dedicated",
        minimumActivationChargeUsd: 0.3,
        quoteId: body?.data?.quoteId ?? "0".repeat(64),
      }),
    },
    ENV,
    executionCtx,
  );
}

async function upgradeWithRetainedNudge(agentId: string, failure?: Error) {
  const { provisioningJobService } = await import(
    "@/lib/services/provisioning-jobs"
  );
  const pending = Promise.withResolvers<void>();
  const trigger = spyOn(
    provisioningJobService,
    "triggerImmediate",
  ).mockReturnValue(pending.promise);
  const retained: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => retained.push(promise),
    passThroughOnException: () => undefined,
    props: {},
  };
  try {
    const response = await upgrade(agentId, executionCtx);
    expect(response.status).toBe(202);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(retained).toHaveLength(1);
    // The response is available while dispatch is unresolved. The Worker owns
    // its completion, including failures after the durable job was committed.
    if (failure) pending.reject(failure);
    else pending.resolve();
    await Promise.all(retained);
    return response;
  } finally {
    pending.resolve();
    trigger.mockRestore();
  }
}

describe("POST /api/v1/eliza/agents/:agentId/upgrade-tier", () => {
  test("unknown agent id is a 404", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(MISSING);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Agent not found");
  });

  test("another org's shared agent is indistinguishable from a missing one (404, no oracle)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_B);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Agent not found");
  });

  test("a dedicated agent is refused with a typed 409 (tier validation)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(DEDICATED_A);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_shared_tier");
  });

  test("a non-running shared agent is refused with a typed 409", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_A_STOPPED);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("agent_not_running");
  });

  test("refuses compute activation without an explicit quoted confirmation", async () => {
    expect(pgliteReady).toBe(true);
    const res = await app.request(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_A)}/upgrade-tier`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      ENV,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: "dedicated_confirmation_required",
    });
  });

  test("rejects activation when the minimum charge is missing or differs from the reviewed terms", async () => {
    const quoted = (await (await quote(PERSONAL_A)).json()) as {
      data: { quoteId: string; minimumActivationChargeUsd: number };
    };
    expect(quoted.data.minimumActivationChargeUsd).toBe(0.3);
    const { dbWrite } = await import("@/db/client");
    const { jobs } = await import("@/db/schemas/jobs");
    const before = await dbWrite.select().from(jobs);
    for (const minimumActivationChargeUsd of [undefined, 0, 0.29, 0.31]) {
      const response = await app.request(
        `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_A)}/upgrade-tier`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "activate_dedicated",
            quoteId: quoted.data.quoteId,
            minimumActivationChargeUsd,
          }),
        },
        ENV,
      );
      expect(response.status).toBe(400);
    }
    expect(await dbWrite.select().from(jobs)).toEqual(before);
  });

  test("a same-org operator cannot bypass another user's retained source authority", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { jobs } = await import("@/db/schemas/jobs");
    const { personalDedicatedUpgradeAuthorities } = await import(
      "@/db/schemas/personal-dedicated-upgrade-authorities"
    );
    await setOrgBalance(ORG_A, "20");
    await dbWrite.insert(agentSandboxes).values({
      id: SHARED_RETAINED_AUTHORITY,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Retained authority source",
      execution_tier: "shared",
      status: "running",
      database_status: "none",
    });
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SHARED_RETAINED_AUTHORITY,
      dedicated_agent_id: MISSING_RETAINED_TARGET,
    });

    const agentsBefore = await dbWrite.select().from(agentSandboxes);
    const keysBefore = await dbWrite.select().from(apiKeys);
    const previousUserId = currentUser.id;
    const previousEmail = currentUser.email;
    currentUser.id = USER_A_OPERATOR;
    currentUser.email = "operator-a@test.test";
    try {
      const response = await upgrade(SHARED_RETAINED_AUTHORITY);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false,
        code: "dedicated_activation_reset_required",
        retryable: false,
      });
      expect(await dbWrite.select().from(agentSandboxes)).toEqual(agentsBefore);
      expect(await dbWrite.select().from(apiKeys)).toEqual(keysBefore);
      expect(
        await dbWrite
          .select()
          .from(jobs)
          .where(eq(jobs.agent_id, MISSING_RETAINED_TARGET)),
      ).toHaveLength(0);
      expect(
        await dbWrite
          .select()
          .from(personalDedicatedUpgradeAuthorities)
          .where(
            eq(
              personalDedicatedUpgradeAuthorities.source_agent_id,
              SHARED_RETAINED_AUTHORITY,
            ),
          ),
      ).toHaveLength(1);
    } finally {
      currentUser.id = previousUserId;
      currentUser.email = previousEmail;
      await dbWrite
        .delete(personalDedicatedUpgradeAuthorities)
        .where(
          eq(
            personalDedicatedUpgradeAuthorities.source_agent_id,
            SHARED_RETAINED_AUTHORITY,
          ),
        );
      await dbWrite
        .delete(agentSandboxes)
        .where(eq(agentSandboxes.id, SHARED_RETAINED_AUTHORITY));
      await setOrgBalance(ORG_A, "0.50");
    }
  });

  test("quotes Dedicated from server-owned pricing for only the caller's personal Eliza", async () => {
    expect(pgliteReady).toBe(true);
    const res = await quote(PERSONAL_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        quoteId: string;
        sourceAgentId: string;
        hourlyRateUsd: number;
        dailyRateUsd: number;
        minimumBalanceUsd: number;
        minimumRunwayDays: number;
        balanceUsd: number;
        deficitUsd: number;
        canActivate: boolean;
        requiresConfirmation: boolean;
        action: string;
      };
    };
    expect(body.data).toMatchObject({
      sourceAgentId: PERSONAL_A,
      hourlyRateUsd: 0.15,
      dailyRateUsd: 3.6,
      minimumBalanceUsd: 10.8,
      minimumRunwayDays: 3,
      balanceUsd: 0.5,
      deficitUsd: 10.3,
      canActivate: false,
      requiresConfirmation: true,
      action: "activate_dedicated",
    });
    expect(body.data.quoteId).toMatch(/^[a-f0-9]{64}$/);

    const hidden = await quote(PERSONAL_B);
    expect(hidden.status).toBe(404);
  });

  test("a balance above the create minimum but below the hosting runway is a canonical 402", async () => {
    expect(pgliteReady).toBe(true);

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(402);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      error: string;
      requiredBalance: number;
      currentBalance: number;
    };
    expect(body.success).toBe(false);
    expect(body.code).toBe("insufficient_credits");
    // The 402 carries the ENFORCED runway threshold ($10.80 = 3 × $3.60/day),
    // not the create/provision minimum ($0.30) — the client renders these.
    expect(body.requiredBalance).toBe(10.8);
    expect(body.currentBalance).toBe(0.5);
    expect(body.error).toContain("3 days of hosting");

    // Nothing was minted on the denied path.
    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const agents = await agentSandboxesRepository.listByOrganization(ORG_A);
    expect(agents.map((a) => a.id).sort()).toEqual(
      [SHARED_A, SHARED_A_STOPPED, DEDICATED_A].sort(),
    );
  });

  test("normal activation cannot bypass selected or unselected same-row inventory", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { jobs } = await import("@/db/schemas/jobs");
    const { personalDedicatedAdoptionSelections } = await import(
      "@/db/schemas/personal-dedicated-adoption-selections"
    );
    await setOrgBalance(ORG_A, "20");
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_SELECTED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Selection source",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      {
        id: SELECTED_EXISTING,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Selected existing",
        execution_tier: "dedicated-always",
        status: "error",
        database_status: "ready",
      },
      {
        id: SELECTED_STALE,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Preserved stale",
        execution_tier: "dedicated-always",
        status: "error",
        database_status: "ready",
      },
    ]);
    await dbWrite.insert(personalDedicatedAdoptionSelections).values({
      organization_id: ORG_A,
      user_id: USER_A,
      source_agent_id: SHARED_SELECTED,
      dedicated_agent_id: SELECTED_EXISTING,
      selection_reason: "duplicate_owned_dedicated_inventory",
      state_disposition: "fresh_boot_no_verified_backup",
      activation_kind: "fresh_boot",
      activation_backup_id: null,
      inventory_fingerprint: "a".repeat(64),
      candidate_count: 2,
    });

    const before = await dbWrite.select().from(agentSandboxes);
    const quoted = await quote(SHARED_SELECTED);
    const quoteBody = (await quoted.json()) as { data: { quoteId: string } };
    const response = await app.request(
      `/api/v1/eliza/agents/${SHARED_SELECTED}/upgrade-tier`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "activate_dedicated",
          minimumActivationChargeUsd: 0.3,
          quoteId: quoteBody.data.quoteId,
        }),
      },
      ENV,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "dedicated_adoption_selection_required",
    });
    expect(await dbWrite.select().from(agentSandboxes)).toEqual(before);
    expect(
      await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.agent_id, SELECTED_EXISTING)),
    ).toHaveLength(0);

    await dbWrite.delete(personalDedicatedAdoptionSelections);
    const unselectedResponse = await upgrade(SHARED_SELECTED);
    expect(unselectedResponse.status).toBe(409);
    expect(await unselectedResponse.json()).toMatchObject({
      success: false,
      code: "dedicated_adoption_selection_required",
    });
    expect(await dbWrite.select().from(agentSandboxes)).toEqual(before);

    for (const id of [SHARED_SELECTED, SELECTED_EXISTING, SELECTED_STALE]) {
      await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, id));
    }
    await setOrgBalance(ORG_A, "0.50");
  });

  test("error, stopped, and sleeping targets cannot restart below the hosting runway", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { jobs } = await import("@/db/schemas/jobs");
    const { personalDedicatedUpgradeAuthorities } = await import(
      "@/db/schemas/personal-dedicated-upgrade-authorities"
    );
    await dbWrite.insert(agentSandboxes).values({
      id: SHARED_RESUME,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Resume Source",
      execution_tier: "shared",
      status: "running",
      database_status: "none",
    });

    for (const [targetId, status] of [
      [ERROR_TARGET, "error"],
      [STOPPED_TARGET, "stopped"],
      [SLEEPING_TARGET, "sleeping"],
    ] as const) {
      await dbWrite.insert(agentSandboxes).values({
        id: targetId,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: `Resume ${status}`,
        agent_config: { __agentUpgradedFrom: SHARED_RESUME },
        execution_tier: "dedicated-always",
        status,
        database_status: "none",
      });
      await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
        organization_id: ORG_A,
        user_id: USER_A,
        source_agent_id: SHARED_RESUME,
        dedicated_agent_id: targetId,
      });

      const res = await upgrade(SHARED_RESUME);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("insufficient_credits");
      const targetJobs = await dbWrite
        .select()
        .from(jobs)
        .where(eq(jobs.agent_id, targetId));
      expect(targetJobs).toHaveLength(0);

      await dbWrite
        .delete(personalDedicatedUpgradeAuthorities)
        .where(
          eq(personalDedicatedUpgradeAuthorities.dedicated_agent_id, targetId),
        );
      await dbWrite
        .delete(agentSandboxes)
        .where(eq(agentSandboxes.id, targetId));
    }
  });

  test("a rowless personal Eliza rejects a stale quote, then mints one singleton Dedicated target", async () => {
    expect(pgliteReady).toBe(true);
    await setOrgBalance(ORG_A, "20");
    const firstQuote = await quote(PERSONAL_A);
    const firstBody = (await firstQuote.json()) as {
      data: { quoteId: string };
    };
    await setOrgBalance(ORG_A, "21");

    const stale = await app.request(
      `/api/v1/eliza/agents/${encodeURIComponent(PERSONAL_A)}/upgrade-tier`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "activate_dedicated",
          minimumActivationChargeUsd: 0.3,
          quoteId: firstBody.data.quoteId,
        }),
      },
      ENV,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "dedicated_quote_changed",
      data: { balanceUsd: 21 },
    });

    const activated = await upgrade(PERSONAL_A);
    expect(activated.status).toBe(202);
    const activatedBody = (await activated.json()) as {
      data: {
        dedicatedAgentId: string;
        sharedAgentId: string;
        agentName: string;
      };
    };
    expect(activatedBody.data.sharedAgentId).toBe(PERSONAL_A);
    expect(activatedBody.data.agentName).toBe("Eliza");

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const target = await agentSandboxesRepository.findByIdAndOrg(
      activatedBody.data.dedicatedAgentId,
      ORG_A,
    );
    expect(target?.execution_tier).toBe("dedicated-always");
    const sharedCharacter = (
      personalSharedAgent({ userId: USER_A, organizationId: ORG_A })
        .agent_config as {
        character: { system: string; bio: string[] };
      }
    ).character;
    const targetConfig = target?.agent_config as Record<string, unknown>;
    expect(targetConfig.system).toBe(sharedCharacter.system);
    expect(targetConfig.bio).toEqual(sharedCharacter.bio);
    expect(
      (target?.agent_config as Record<string, unknown> | null)
        ?.__agentUpgradedFrom,
    ).toBe(PERSONAL_A);
    expect(
      (await agentSandboxesRepository.listByOrganization(ORG_A)).some(
        (row) => row.id === PERSONAL_A,
      ),
    ).toBe(false);

    const retry = await upgrade(PERSONAL_A);
    const retryBody = (await retry.json()) as {
      created: boolean;
      alreadyInProgress: boolean;
      data: { dedicatedAgentId: string };
    };
    expect(retryBody.created).toBe(false);
    expect(retryBody.alreadyInProgress).toBe(true);
    expect(retryBody.data.dedicatedAgentId).toBe(
      activatedBody.data.dedicatedAgentId,
    );
  });

  test("funded upgrade mints a dedicated-always target with the identity copied server-side", async () => {
    expect(pgliteReady).toBe(true);
    await setOrgBalance(ORG_A, "20");

    const res = await upgradeWithRetainedNudge(SHARED_A);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      success: boolean;
      created: boolean;
      data: {
        id: string;
        dedicatedAgentId: string;
        sharedAgentId: string;
        agentName: string;
        jobId: string;
        executionTier: string;
      };
      polling: { endpoint: string };
    };
    expect(body.success).toBe(true);
    expect(body.created).toBe(true);
    expect(body.data.sharedAgentId).toBe(SHARED_A);
    expect(body.data.dedicatedAgentId).not.toBe(SHARED_A);
    expect(body.data.agentName).toBe("Aurora Front");
    expect(body.data.executionTier).toBe("dedicated-always");
    expect(body.data.jobId).toBeTruthy();
    expect(body.polling.endpoint).toBe(`/api/v1/jobs/${body.data.jobId}`);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const dedicated = await agentSandboxesRepository.findByIdAndOrg(
      body.data.dedicatedAgentId,
      ORG_A,
    );
    expect(dedicated).toBeTruthy();
    if (!dedicated) throw new Error("dedicated row missing");

    // Identity copy: name, linked character, character config.
    expect(dedicated.agent_name).toBe("Aurora Front");
    expect(dedicated.character_id).toBe(CHARACTER_A);
    expect(dedicated.execution_tier).toBe("dedicated-always");
    expect(dedicated.status).toBe("pending");
    const config = dedicated.agent_config as Record<string, unknown>;
    expect(config.character).toEqual({
      name: "Aurora",
      system: "Shared front persona.",
    });
    // Reattach marker recorded server-side (reserved namespace — client input
    // can never set it).
    expect(config.__agentUpgradedFrom).toBe(SHARED_A);

    // Env copy: BYO values survive; the shared row's platform-owned identity
    // values were NOT inherited (a fresh ELIZA_API_TOKEN was minted, and the
    // cloud-agent id binds to the NEW record).
    const env = dedicated.environment_vars as Record<string, string>;
    expect(env.MY_CUSTOM_VAR).toBe("keep-me");
    expect(env.OPENAI_API_KEY).toBe("sk-byo-test");
    expect(env.ELIZA_API_TOKEN).toBeTruthy();
    expect(env.ELIZA_API_TOKEN).not.toBe("agent_shared_platform_token");
    expect(env.ELIZA_CLOUD_AGENT_ID).toBe(dedicated.id);

    // The shared source is untouched — the user keeps chatting on it until the
    // client handoff confirms the switch.
    const shared = await agentSandboxesRepository.findByIdAndOrg(
      SHARED_A,
      ORG_A,
    );
    expect(shared?.execution_tier).toBe("shared");
    expect(shared?.status).toBe("running");

    // A real agent_provision job exists for the target.
    const { dbWrite } = await import("@/db/client");
    const { jobs } = await import("@/db/schemas/jobs");
    const jobRows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, dedicated.id));
    expect(jobRows.length).toBe(1);
    expect(jobRows[0]?.type).toBe("agent_provision");
  });

  test("a retry reattaches to the SAME in-flight target instead of minting a second one", async () => {
    expect(pgliteReady).toBe(true);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const before = await agentSandboxesRepository.listByOrganization(ORG_A);
    const target = before.find(
      (a) =>
        (a.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_A,
    );
    expect(target).toBeTruthy();
    if (!target) throw new Error("no in-flight target");

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      created: boolean;
      alreadyInProgress: boolean;
      data: { dedicatedAgentId: string; jobId: string };
    };
    expect(body.created).toBe(false);
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.dedicatedAgentId).toBe(target.id);

    // No second agent row, and still exactly one active provision job.
    const after = await agentSandboxesRepository.listByOrganization(ORG_A);
    expect(after.length).toBe(before.length);
    const { dbWrite } = await import("@/db/client");
    const { jobs } = await import("@/db/schemas/jobs");
    const jobRows = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, target.id));
    expect(jobRows.length).toBe(1);
    expect(body.data.jobId).toBe(jobRows[0]?.id ?? "");
  });

  test("retains a failed reactivation nudge without losing the new durable job", async () => {
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const { jobs } = await import("@/db/schemas/jobs");
    const target = (
      await agentSandboxesRepository.listByOrganization(ORG_A)
    ).find(
      (agent) =>
        (agent.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_A,
    );
    if (!target) throw new Error("The funded activation target is missing");
    await agentSandboxesRepository.update(target.id, { status: "stopped" });
    await dbWrite
      .update(jobs)
      .set({ status: "failed" })
      .where(eq(jobs.agent_id, target.id));
    const response = await upgradeWithRetainedNudge(
      SHARED_A,
      new Error("control plane unavailable"),
    );
    const body = (await response.json()) as {
      data: { dedicatedAgentId: string; jobId: string };
    };
    expect(body.data.dedicatedAgentId).toBe(target.id);
    const [job] = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.id, body.data.jobId));
    expect(job?.agent_id).toBe(target.id);
    expect(job?.status).toBe("pending");
  });

  test("concurrent upgrades atomically converge on one target, one job, one credential set", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { jobs } = await import("@/db/schemas/jobs");
    await dbWrite.insert(agentSandboxes).values({
      id: SHARED_CONCURRENT,
      organization_id: ORG_A,
      user_id: USER_A,
      agent_name: "Concurrent Source",
      execution_tier: "shared",
      status: "running",
      database_status: "none",
    });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => upgrade(SHARED_CONCURRENT)),
    );
    expect(responses.every((response) => response.status === 202)).toBe(true);
    const bodies = (await Promise.all(
      responses.map((response) => response.json()),
    )) as Array<{ data: { dedicatedAgentId: string; jobId: string } }>;
    const targetIds = new Set(bodies.map((body) => body.data.dedicatedAgentId));
    const jobIds = new Set(bodies.map((body) => body.data.jobId));
    expect(targetIds.size).toBe(1);
    expect(jobIds.size).toBe(1);

    const targets = (await dbWrite.select().from(agentSandboxes)).filter(
      (agent) =>
        (agent.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_CONCURRENT,
    );
    expect(targets).toHaveLength(1);
    const targetJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, targets[0]!.id));
    expect(targetJobs).toHaveLength(1);
    expect(targetJobs[0]?.id).toBe([...jobIds][0]);

    // Exactly one credential set: the winner's key is bound to the committed
    // target, and every race loser revoked its own candidate (#15943 — the
    // pre-#16042 route re-minted credentials per loser after a 10s poll).
    const targetKeys = await dbWrite
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.name, `agent-sandbox:${targets[0]!.id}`));
    expect(targetKeys).toHaveLength(1);
    expect(targetKeys[0]?.is_active).toBe(true);
  });

  test("an org at its non-terminal cap gets the typed 429 quota body before any credential is minted", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { apiKeys } = await import("@/db/schemas/api-keys");
    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");

    // Balance 20 clears the hosting runway and allows 100 sandboxes. Fill
    // that cap (including the source) so the funded upgrade reaches the
    // org-serialized quota
    // check in the single-flight service — mapped by the route to 429.
    await dbWrite.insert(organizations).values({
      id: ORG_FULL,
      name: "Org Full",
      slug: "org-full",
      credit_balance: "20.00",
    });
    await dbWrite.insert(users).values({
      id: USER_FULL,
      email: "owner-full@test.test",
      organization_id: ORG_FULL,
      role: "owner",
      steward_user_id: `steward-${USER_FULL}`,
    });
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_FULL,
        organization_id: ORG_FULL,
        user_id: USER_FULL,
        agent_name: "Full Org Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      ...Array.from({ length: 99 }, (_unused, index) => ({
        id: `dddddddd-${String(index + 1).padStart(4, "0")}-4111-8111-111111111111`,
        organization_id: ORG_FULL,
        user_id: USER_FULL,
        agent_name: `Filler ${index + 1}`,
        // Custom Dedicated capacity counts toward quota but is not eligible
        // for personal same-row adoption.
        execution_tier: "custom" as const,
        status: "running" as const,
        database_status: "none" as const,
      })),
    ]);

    currentUser.id = USER_FULL;
    currentUser.organization_id = ORG_FULL;
    currentUser.organization = {
      id: ORG_FULL,
      name: "Org Full",
      is_active: true,
    };
    try {
      const res = await upgrade(SHARED_FULL);
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        success: boolean;
        code: string;
        currentAgents: number;
        maxAgents: number;
      };
      expect(body.success).toBe(false);
      expect(body.code).toBe("agent_quota_exceeded");
      expect(body.currentAgents).toBe(100);
      expect(body.maxAgents).toBe(100);

      // Refused in phase 1, BEFORE credential preparation: no target row and
      // no candidate api key were ever minted for this org.
      const orgRows = (await dbWrite.select().from(agentSandboxes)).filter(
        (row) => row.organization_id === ORG_FULL,
      );
      expect(orgRows).toHaveLength(100);
      const orgKeys = (await dbWrite.select().from(apiKeys)).filter(
        (key) => key.organization_id === ORG_FULL,
      );
      expect(orgKeys).toHaveLength(0);
    } finally {
      currentUser.id = USER_A;
      currentUser.organization_id = ORG_A;
      currentUser.organization = { id: ORG_A, name: "Org A", is_active: true };
    }
  });

  test("a RUNNING in-flight target reattaches without a job (client goes straight to handoff)", async () => {
    expect(pgliteReady).toBe(true);

    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    const agents = await agentSandboxesRepository.listByOrganization(ORG_A);
    const target = agents.find(
      (a) =>
        (a.agent_config as Record<string, unknown> | null)
          ?.__agentUpgradedFrom === SHARED_A,
    );
    if (!target) throw new Error("no in-flight target");
    await agentSandboxesRepository.update(target.id, { status: "running" });

    const res = await upgrade(SHARED_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alreadyInProgress: boolean;
      data: { dedicatedAgentId: string; status: string; jobId?: string };
    };
    expect(body.alreadyInProgress).toBe(true);
    expect(body.data.dedicatedAgentId).toBe(target.id);
    expect(body.data.status).toBe("running");
    expect(body.data.jobId).toBeUndefined();
  });

  test("a forged marker on a shared-tier agent is NOT a live target — fresh mint, never reattach", async () => {
    expect(pgliteReady).toBe(true);

    const SHARED_C = "cccccccc-5555-4555-8555-555555555555";
    const FORGED_SHARED = "cccccccc-6666-4666-8666-666666666666";
    const { dbWrite } = await import("@/db/client");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    await dbWrite.insert(agentSandboxes).values([
      {
        id: SHARED_C,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Second Shared",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
      {
        id: FORGED_SHARED,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Marker Forgery",
        execution_tier: "shared",
        status: "running",
        database_status: "none",
      },
    ]);
    // Plant the reattach marker on the SHARED row via a config update — the
    // same write shape a config PATCH produces. Tier, not marker, must decide.
    const { agentSandboxesRepository } = await import(
      "@/db/repositories/agent-sandboxes"
    );
    await agentSandboxesRepository.update(FORGED_SHARED, {
      agent_config: { __agentUpgradedFrom: SHARED_C },
    });

    const res = await upgrade(SHARED_C);
    // Without the dedicated-always tier check this would 200-reattach onto the
    // forged running shared row; the fresh-mint 202 proves it was ignored.
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      created: boolean;
      data: { dedicatedAgentId: string; executionTier: string };
    };
    expect(body.created).toBe(true);
    expect(body.data.dedicatedAgentId).not.toBe(FORGED_SHARED);
    expect(body.data.executionTier).toBe("dedicated-always");

    // The forged row is untouched: still shared-tier and owns no provision job.
    const forged = await agentSandboxesRepository.findByIdAndOrg(
      FORGED_SHARED,
      ORG_A,
    );
    expect(forged?.execution_tier).toBe("shared");
    const { jobs } = await import("@/db/schemas/jobs");
    const forgedJobs = await dbWrite
      .select()
      .from(jobs)
      .where(eq(jobs.agent_id, FORGED_SHARED));
    expect(forgedJobs.length).toBe(0);
  });

  test("a personal cutover activates only after the authoritative history import succeeds", async () => {
    expect(pgliteReady).toBe(true);
    const { dbWrite } = await import("@/db/client");
    const { organizations } = await import("@/db/schemas/organizations");
    const { personalAccountConvergences } = await import(
      "@/db/schemas/personal-account-convergences"
    );
    const { users } = await import("@/db/schemas/users");
    const { agentSandboxes } = await import("@/db/schemas/agent-sandboxes");
    const { personalDedicatedUpgradeAuthorities } = await import(
      "@/db/schemas/personal-dedicated-upgrade-authorities"
    );
    await dbWrite.insert(organizations).values({
      id: ORG_C,
      name: "Cutover Org",
      slug: "cutover-org",
      credit_balance: "20",
    });
    await dbWrite.insert(users).values({
      id: USER_C,
      email: "cutover@test.test",
      organization_id: ORG_C,
      role: "owner",
      steward_user_id: `steward-${USER_C}`,
      telegram_id: "919191",
    });
    await dbWrite.insert(agentSandboxes).values({
      id: CUTOVER_TARGET,
      organization_id: ORG_C,
      user_id: USER_C,
      agent_name: "Eliza",
      agent_config: { __agentUpgradedFrom: PERSONAL_C },
      execution_tier: "dedicated-always",
      status: "running",
      database_status: "none",
      bridge_url: "https://dedicated-cutover.test/chat",
      environment_vars: { ELIZA_API_TOKEN: "agent_cutover_transport" },
    });
    await dbWrite.insert(personalDedicatedUpgradeAuthorities).values({
      organization_id: ORG_C,
      user_id: USER_C,
      source_agent_id: PERSONAL_C,
      dedicated_agent_id: CUTOVER_TARGET,
    });

    const originalFetch = globalThis.fetch;
    const workerRuntime = spyOn(
      SandboxTransport.prototype,
      "isCloudflareWorkerRuntime",
    ).mockReturnValue(true);
    const importFetch = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ error: "not ready" }, { status: 503 }),
    );
    globalThis.fetch = importFetch as unknown as typeof fetch;
    currentUser.id = USER_C;
    currentUser.email = "cutover@test.test";
    currentUser.organization_id = ORG_C;
    currentUser.organization = {
      id: ORG_C,
      name: "Cutover Org",
      is_active: true,
    };
    currentUser.telegram_id = "919191";
    const convergenceToken = `phone-telegram:source:${USER_C}`;
    const { createSharedTodoStore, sharedTodoStorageScope } = await import(
      "@/lib/services/shared-runtime/shared-todos"
    );
    const cutoverTodoStore = createSharedTodoStore();
    const cutoverTodoScope = sharedTodoStorageScope({
      sourceAgentId: PERSONAL_C,
      ownerId: USER_C,
    });
    let cutoverTodoId: string | null = null;

    try {
      cutoverCoordinatorOperations.length = 0;
      invalidatedDeliveryProjections.length = 0;
      cutoverCoordinatorTokens.length = 0;
      cutoverSealToken = null;
      cutoverSealCommitted = false;
      cutoverCommitFailuresRemaining = 0;
      observeMarkerAtCommit = false;
      markerObservedAtCommit = undefined;
      await dbWrite.insert(personalAccountConvergences).values({
        token: convergenceToken,
        source_user_id: "aaaaaaaa-5555-4555-8555-555555555555",
        source_organization_id: "44444444-5555-4555-8555-555555555555",
        source_agent_id: "personal:source-phone-room",
        target_user_id: USER_C,
        target_organization_id: ORG_C,
        target_agent_id: PERSONAL_C,
        phone_number: "+14155550199",
        telegram_id: "919191",
        steward_user_id: `steward-${USER_C}`,
      });
      const linking = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(linking.status).toBe(409);
      expect(await linking.json()).toMatchObject({
        code: "personal_identity_convergence_in_progress",
      });
      expect(cutoverCoordinatorOperations).toEqual([]);
      await dbWrite
        .delete(personalAccountConvergences)
        .where(eq(personalAccountConvergences.token, convergenceToken));
      await dbWrite.execute(sql`
        INSERT INTO app_scheduling.life_scheduled_tasks (
          id, agent_id, kind, prompt_instructions, trigger_json, priority,
          respects_global_pause, state_json, source, created_by, owner_visible,
          metadata_json, next_fire_at, created_at, updated_at
        ) VALUES (
          'cutover-reminder', ${PERSONAL_C}, 'reminder', 'call mom',
          '{"kind":"once","atIso":"2026-08-15T17:00:00.000Z"}',
          'medium', TRUE, '{"status":"scheduled","followupCount":0}',
          'user_chat', ${USER_C}, TRUE,
          '{"delivery":{"platform":"telegram","project":"eliza-app","chatId":"919191"}}',
          '2026-08-15T17:00:00.000Z',
          '2026-08-14T17:00:00.000Z',
          '2026-08-14T17:00:00.000Z'
        )
      `);
      await dbWrite.execute(sql`
        INSERT INTO app_scheduling.life_scheduled_tasks (
          id, agent_id, kind, prompt_instructions, trigger_json, priority,
          respects_global_pause, state_json, source, created_by, owner_visible,
          metadata_json, next_fire_at, created_at, updated_at
        ) VALUES (
          'cutover-inflight', ${PERSONAL_C}, 'reminder', 'drink water',
          '{"kind":"interval","everyMinutes":60}',
          'medium', TRUE,
          '{"status":"fired","firedAt":"2026-08-14T17:00:00.000Z","followupCount":0}',
          'user_chat', ${USER_C}, TRUE,
          '{"delivery":{"platform":"telegram","project":"eliza-app","chatId":"919191"}}',
          NULL,
          '2026-08-14T16:00:00.000Z',
          '2026-08-14T17:00:00.000Z'
        )
      `);
      const cutoverTodoMutation = await cutoverTodoStore.applyMutation({
        scope: cutoverTodoScope,
        idempotencyKey: "cutover-api-test:create",
        mutation: {
          action: "create",
          input: {
            roomId: "a5150000-0000-4000-8000-000000000002",
            content: "Call mom before Friday",
            activeForm: "Calling mom before Friday",
            status: "pending",
            metadata: { source: "cutover-api-test" },
          },
        },
      });
      if (cutoverTodoMutation.result.action !== "create") {
        throw new Error("Todo setup did not return its created row");
      }
      const cutoverTodo = cutoverTodoMutation.result.todo;
      cutoverTodoId = cutoverTodo.id;

      await dbWrite
        .update(agentSandboxes)
        .set({ environment_vars: { ELIZAOS_API_KEY: "eliza_cloud_key_only" } })
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      const noTransport = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(noTransport.status).toBe(503);
      expect(await noTransport.json()).toMatchObject({
        code: "dedicated_transport_unavailable",
      });
      expect(cutoverCoordinatorOperations).toEqual([]);
      expect(importFetch).not.toHaveBeenCalled();
      await dbWrite
        .update(agentSandboxes)
        .set({
          environment_vars: { ELIZA_API_TOKEN: "agent_cutover_transport" },
        })
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));

      const refused = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(refused.status).toBe(503);
      expect(await refused.json()).toMatchObject({
        code: "dedicated_history_import_failed",
      });
      const [before] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      expect(
        (before?.agent_config as Record<string, unknown> | null)
          ?.__agentPersonalCutover,
      ).toBeUndefined();
      expect(cutoverCoordinatorOperations).toEqual([
        "cutover-seal",
        "cutover-release",
      ]);
      const releasedRows = (await dbWrite.execute(sql`
        SELECT id, transfer_status
          FROM app_scheduling.life_scheduled_tasks
         WHERE id IN ('cutover-inflight', 'cutover-reminder')
         ORDER BY id
      `)) as {
        rows: Array<{ id: string; transfer_status: string | null }>;
      };
      expect(releasedRows.rows).toEqual([
        { id: "cutover-inflight", transfer_status: null },
        { id: "cutover-reminder", transfer_status: null },
      ]);

      await dbWrite.execute(sql`
        UPDATE app_scheduling.life_scheduled_tasks
           SET transfer_token = ${`personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`},
               transfer_holder_token = NULL,
               transfer_target_agent_id = ${CUTOVER_TARGET},
               transfer_status = 'reserved',
               updated_at = NOW()
         WHERE id IN ('cutover-inflight', 'cutover-reminder')
      `);
      const competing = await cutover(PERSONAL_C, CUTOVER_TARGET);
      const competingBody = await competing.json();
      expect(competingBody).toMatchObject({
        code: "personal_reminder_cutover_in_progress",
      });
      expect(competing.status).toBe(423);
      const competingRows = (await dbWrite.execute(sql`
        SELECT DISTINCT transfer_token, transfer_holder_token, transfer_target_agent_id
          FROM app_scheduling.life_scheduled_tasks
         WHERE id IN ('cutover-inflight', 'cutover-reminder')
      `)) as {
        rows: Array<{
          transfer_token: string;
          transfer_holder_token: string | null;
          transfer_target_agent_id: string;
        }>;
      };
      expect(competingRows.rows).toEqual([
        {
          transfer_token: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
          transfer_holder_token: null,
          transfer_target_agent_id: CUTOVER_TARGET,
        },
      ]);
      await dbWrite.execute(sql`
        UPDATE app_scheduling.life_scheduled_tasks
           SET updated_at = '2000-01-01T00:00:00.000Z'
         WHERE id IN ('cutover-inflight', 'cutover-reminder')
      `);

      importFetch.mockImplementation(async () =>
        Response.json({
          complete: true,
          sourceMessageCount: 2,
          inserted: 2,
          skipped: 0,
          sourceScheduledTaskCount: 2,
          importedScheduledTasks: 2,
          skippedScheduledTasks: 0,
          activatedScheduledTasks: 0,
          skippedActivatedScheduledTasks: 0,
        }),
      );
      cutoverCoordinatorOperations.length = 0;
      const missingTodoReceipt = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(missingTodoReceipt.status).toBe(503);
      expect(await missingTodoReceipt.json()).toMatchObject({
        code: "dedicated_history_receipt_invalid",
      });
      const [withoutTodoReceipt] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      expect(
        (withoutTodoReceipt?.agent_config as Record<string, unknown> | null)
          ?.__agentPersonalCutover,
        "a message/reminder receipt cannot flip the route without Todo proof",
      ).toBeUndefined();
      expect(cutoverCoordinatorOperations).toEqual([
        "cutover-seal",
        "cutover-release",
      ]);

      importFetch.mockImplementation(async (_input, init) => {
        const requestBody = JSON.parse(String(init?.body)) as {
          activateScheduledTasks?: boolean;
          messages: unknown[];
          todoSnapshot: {
            todos: unknown[];
            mutations: unknown[];
            digest: string;
          };
        };
        const messageCount = requestBody.messages.length;
        const todoCount = requestBody.todoSnapshot.todos.length;
        const todoMutationCount = requestBody.todoSnapshot.mutations.length;
        return Response.json({
          complete: true,
          sourceMessageCount: messageCount,
          inserted: requestBody.activateScheduledTasks ? 0 : messageCount,
          skipped: requestBody.activateScheduledTasks ? messageCount : 0,
          sourceScheduledTaskCount: 2,
          importedScheduledTasks: requestBody.activateScheduledTasks ? 0 : 2,
          skippedScheduledTasks: requestBody.activateScheduledTasks ? 2 : 0,
          activatedScheduledTasks: requestBody.activateScheduledTasks ? 2 : 0,
          skippedActivatedScheduledTasks: 0,
          sourceTodoCount: todoCount,
          importedTodos: requestBody.activateScheduledTasks ? 0 : todoCount,
          repairedTodos: 0,
          skippedTodos: requestBody.activateScheduledTasks ? todoCount : 0,
          removedStaleTodos: 0,
          sourceTodoMutationCount: todoMutationCount,
          importedTodoMutations: requestBody.activateScheduledTasks
            ? 0
            : todoMutationCount,
          skippedTodoMutations: requestBody.activateScheduledTasks
            ? todoMutationCount
            : 0,
          sourceTodoDigest: requestBody.todoSnapshot.digest,
          targetTodoDigest: requestBody.todoSnapshot.digest,
        });
      });
      cutoverCommitFailuresRemaining = 1;
      observeMarkerAtCommit = true;
      markerObservedAtCommit = undefined;
      cutoverCoordinatorOperations.length = 0;
      const commitRefused = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(commitRefused.status).toBe(503);
      expect(await commitRefused.json()).toMatchObject({
        success: false,
        code: "shared_history_unavailable",
      });
      const [afterCommitFailure] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      expect(
        (afterCommitFailure?.agent_config as Record<string, unknown> | null)
          ?.__agentPersonalCutover,
      ).toMatchObject({
        sourceAgentId: PERSONAL_C,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        sharedMessageCount: 2,
        sharedTodoCount: 1,
        sharedTodoMutationCount: 1,
        sharedTodoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(cutoverCoordinatorOperations).toEqual([
        "cutover-seal",
        "cutover-commit",
      ]);
      expect(markerObservedAtCommit).toMatchObject({
        sourceAgentId: PERSONAL_C,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        sharedMessageCount: 2,
        sharedTodoCount: 1,
        sharedTodoMutationCount: 1,
        sharedTodoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      markerObservedAtCommit = undefined;
      cutoverCoordinatorOperations.length = 0;
      const activated = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(activated.status).toBe(200);
      expect(await activated.json()).toMatchObject({
        success: true,
        data: {
          personalElizaId: PERSONAL_C,
          activeAgentId: CUTOVER_TARGET,
          runtime: "dedicated",
          apiBase: `https://${CUTOVER_TARGET}.dedicated-cutover.test`,
          importedMessages: 2,
          importedScheduledTasks: 2,
          importedTodos: 1,
          importedTodoMutations: 1,
        },
      });
      expect(importFetch).toHaveBeenLastCalledWith(
        `https://router-cutover.test/api/conversations/${encodeURIComponent(PERSONAL_C)}/import`,
        expect.objectContaining({
          method: "POST",
          redirect: "manual",
          headers: expect.objectContaining({
            Authorization: "Bearer agent_cutover_transport",
            "X-API-Key": "agent_cutover_transport",
            "X-Forwarded-Host": `${CUTOVER_TARGET}.dedicated-cutover.test`,
            "X-Forwarded-Proto": "https",
          }),
        }),
      );
      const importInit = importFetch.mock.calls.findLast((call) => {
        const body = JSON.parse(
          String((call[1] as RequestInit | undefined)?.body),
        );
        return body.activateScheduledTasks !== true && body.messages.length > 0;
      })?.[1] as RequestInit | undefined;
      expect(JSON.parse(String(importInit?.body))).toMatchObject({
        messages: [
          { sourceId: "u1", role: "user", text: "hello", timestamp: 10 },
          {
            sourceId: "a1",
            role: "assistant",
            text: "hello back",
            timestamp: 20,
          },
        ],
        scheduledTasks: [
          {
            taskId: "cutover-inflight",
            kind: "reminder",
            promptInstructions: "drink water",
            state: { status: "fired", followupCount: 0 },
            escalation: {
              steps: [{ delayMinutes: 0, channelKey: "shared_gateway_dm" }],
            },
          },
          {
            taskId: "cutover-reminder",
            kind: "reminder",
            promptInstructions: "call mom",
            state: { status: "scheduled", followupCount: 0 },
            escalation: {
              steps: [{ delayMinutes: 0, channelKey: "shared_gateway_dm" }],
            },
          },
        ],
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        todoSnapshot: {
          version: 2,
          sourceAgentId: PERSONAL_C,
          todos: [
            {
              sourceId: cutoverTodo.id,
              roomId: "a5150000-0000-4000-8000-000000000002",
              content: "Call mom before Friday",
              activeForm: "Calling mom before Friday",
              status: "pending",
              metadata: { source: "cutover-api-test" },
            },
          ],
          mutations: [
            expect.objectContaining({
              version: 1,
              idempotencyKey: "cutover-api-test:create",
              operation: "create",
              applied: true,
            }),
          ],
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      const activationInit = importFetch.mock.calls.at(-1)?.[1] as
        | RequestInit
        | undefined;
      expect(JSON.parse(String(activationInit?.body))).toMatchObject({
        messages: [],
        activateScheduledTasks: true,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        todoSnapshot: {
          version: 2,
          sourceAgentId: PERSONAL_C,
          todos: [{ sourceId: cutoverTodo.id }],
          mutations: [
            expect.objectContaining({
              idempotencyKey: "cutover-api-test:create",
            }),
          ],
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(cutoverCoordinatorOperations).toEqual(["cutover-commit"]);
      expect(invalidatedDeliveryProjections).toContain("telegram:919191");
      expect(markerObservedAtCommit).toMatchObject({
        sourceAgentId: PERSONAL_C,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        sharedMessageCount: 2,
        sharedScheduledTaskCount: 2,
        sharedTodoCount: 1,
        sharedTodoMutationCount: 1,
        sharedTodoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(new Set(cutoverCoordinatorTokens).size).toBe(1);

      const [after] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      const marker = (after?.agent_config as Record<string, unknown> | null)
        ?.__agentPersonalCutover as
        | {
            sourceAgentId?: string;
            cutoverToken?: string;
            sharedMessageCount?: number;
            sharedScheduledTaskCount?: number;
            sharedTodoCount?: number;
            sharedTodoMutationCount?: number;
            sharedTodoDigest?: string;
            activatedAt?: string;
          }
        | undefined;
      expect(marker).toMatchObject({
        sourceAgentId: PERSONAL_C,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        sharedMessageCount: 2,
        sharedScheduledTaskCount: 2,
        sharedTodoCount: 1,
        sharedTodoMutationCount: 1,
        sharedTodoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(marker?.activatedAt).toBeTruthy();

      cutoverCoordinatorOperations.length = 0;
      const retried = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(retried.status).toBe(200);
      expect(cutoverCoordinatorOperations).toEqual(["cutover-commit"]);
      expect(importFetch).toHaveBeenCalledTimes(5);
      const [afterRetry] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      expect(
        (
          (afterRetry?.agent_config as Record<string, unknown> | null)
            ?.__agentPersonalCutover as { activatedAt?: string } | undefined
        )?.activatedAt,
      ).toBe(marker?.activatedAt);

      const interruptedConfig = {
        ...((afterRetry?.agent_config as Record<string, unknown> | null) ?? {}),
      };
      delete interruptedConfig.__agentPersonalCutover;
      await dbWrite
        .update(agentSandboxes)
        .set({ agent_config: interruptedConfig })
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      importFetch.mockImplementation(async (_input, init) => {
        const requestBody = JSON.parse(String(init?.body)) as {
          activateScheduledTasks?: boolean;
          messages: unknown[];
          todoSnapshot: {
            todos: unknown[];
            mutations: unknown[];
            digest: string;
          };
        };
        const messageCount = requestBody.messages.length;
        const todoCount = requestBody.todoSnapshot.todos.length;
        const todoMutationCount = requestBody.todoSnapshot.mutations.length;
        return Response.json({
          complete: true,
          sourceMessageCount: messageCount,
          inserted: 0,
          skipped: messageCount,
          sourceScheduledTaskCount: 2,
          importedScheduledTasks: 0,
          skippedScheduledTasks: 2,
          activatedScheduledTasks: 0,
          skippedActivatedScheduledTasks: requestBody.activateScheduledTasks
            ? 2
            : 0,
          sourceTodoCount: todoCount,
          importedTodos: 0,
          repairedTodos: 0,
          skippedTodos: todoCount,
          removedStaleTodos: 0,
          sourceTodoMutationCount: todoMutationCount,
          importedTodoMutations: 0,
          skippedTodoMutations: todoMutationCount,
          sourceTodoDigest: requestBody.todoSnapshot.digest,
          targetTodoDigest: requestBody.todoSnapshot.digest,
        });
      });
      cutoverCoordinatorOperations.length = 0;
      const recoveredAfterCommit = await cutover(PERSONAL_C, CUTOVER_TARGET);
      expect(recoveredAfterCommit.status).toBe(200);
      // Initial import, activation, and committed retry must all use the
      // origin. A public UUID-host fetch from a Worker bypasses its own proxy.
      for (const [url, init] of importFetch.mock.calls) {
        expect(new URL(String(url)).hostname).toBe("router-cutover.test");
        expect(new Headers(init?.headers).get("X-Forwarded-Host")).toBe(
          `${CUTOVER_TARGET}.dedicated-cutover.test`,
        );
        expect(init?.redirect).toBe("manual");
      }
      expect(cutoverCoordinatorOperations).toEqual(["cutover-commit"]);
      const [afterCommittedRecovery] = await dbWrite
        .select()
        .from(agentSandboxes)
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      expect(
        (afterCommittedRecovery?.agent_config as Record<string, unknown> | null)
          ?.__agentPersonalCutover,
      ).toMatchObject({
        sourceAgentId: PERSONAL_C,
        cutoverToken: `personal-cutover:${PERSONAL_C}:${CUTOVER_TARGET}`,
        sharedMessageCount: 2,
        sharedScheduledTaskCount: 2,
        sharedTodoCount: 1,
        sharedTodoMutationCount: 1,
        sharedTodoDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const committedRows = (await dbWrite.execute(sql`
        SELECT id, transfer_status
          FROM app_scheduling.life_scheduled_tasks
         WHERE id IN ('cutover-inflight', 'cutover-reminder')
         ORDER BY id
      `)) as { rows: Array<{ id: string; transfer_status: string }> };
      expect(committedRows.rows).toEqual([
        { id: "cutover-inflight", transfer_status: "committed" },
        { id: "cutover-reminder", transfer_status: "committed" },
      ]);

      await dbWrite
        .update(agentSandboxes)
        .set({ status: "stopped" })
        .where(eq(agentSandboxes.id, CUTOVER_TARGET));
      const { findActivePersonalDedicatedTarget } = await import(
        "@/lib/services/agent-tier-upgrade-target"
      );
      expect(
        (await findActivePersonalDedicatedTarget(ORG_C, USER_C, PERSONAL_C))
          ?.id,
      ).toBe(CUTOVER_TARGET);
      expect(
        (await dbWrite.select().from(agentSandboxes)).some(
          (row) => row.id === PERSONAL_C,
        ),
      ).toBe(false);
    } finally {
      if (cutoverTodoId) {
        await cutoverTodoStore.delete(cutoverTodoScope, cutoverTodoId);
      }
      await dbWrite
        .delete(personalAccountConvergences)
        .where(eq(personalAccountConvergences.token, convergenceToken));
      globalThis.fetch = originalFetch;
      workerRuntime.mockRestore();
      currentUser.id = USER_A;
      currentUser.email = "owner-a@test.test";
      currentUser.organization_id = ORG_A;
      currentUser.organization = {
        id: ORG_A,
        name: "Org A",
        is_active: true,
      };
      currentUser.telegram_id = null;
      cutoverHistory = [
        {
          id: "lifecycle-1",
          role: "system",
          content: "The signed-in mobile session started.",
          createdAt: 5,
        },
        { id: "u1", role: "user", content: "hello", createdAt: 10 },
        {
          id: "a1",
          role: "assistant",
          content: "hello back",
          createdAt: 20,
        },
      ];
      cutoverCoordinatorOperations.length = 0;
      cutoverCoordinatorTokens.length = 0;
      cutoverSealToken = null;
      cutoverSealCommitted = false;
      cutoverCommitFailuresRemaining = 0;
      observeMarkerAtCommit = false;
      markerObservedAtCommit = undefined;
    }
  });
});
