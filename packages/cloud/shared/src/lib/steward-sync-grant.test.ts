/** Proves Steward account creation starts unfunded without an automatic credit grant. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mock state captured per test ─────────────────────────────────────────
const addCreditsCalls: unknown[] = [];
const orgCreateCalls: unknown[] = [];
const orgUpdateCalls: Array<{ id: string; data: unknown }> = [];
const orgDeleteCalls: string[] = [];
const loggerErrorCalls: Array<{ message: string; context?: unknown }> = [];
let addCreditsImpl: (params: unknown) => Promise<unknown> = async (params) => {
  addCreditsCalls.push(params);
  return { success: true };
};

const createdOrg = {
  id: "org-new-1",
  name: "alice's Organization",
  slug: "alice-abc123",
  credit_balance: "0.00",
};
const createdUser = {
  id: "user-new-1",
  organization_id: "org-new-1",
  steward_user_id: "steward-123",
  email: "alice@example.com",
  name: "alice",
  wallet_address: null,
  role: "owner",
  email_verified: true,
  wallet_verified: false,
};
const finalUserWithOrg = {
  id: "user-new-1",
  steward_user_id: "steward-123",
  email: "alice@example.com",
  name: "alice",
  wallet_address: null,
  role: "owner",
  email_verified: true,
  wallet_verified: false,
  organization: { id: "org-new-1", name: "alice's Organization" },
};

mock.module("./services/credits", () => ({
  assertCreditRefundWithinReservation: () => {
    throw new Error("credit refund assertion is outside this test path");
  },
  assertValidCreditSettlementCosts: () => {
    throw new Error("credit settlement assertion is outside this test path");
  },
  creditsService: {
    addCredits: (params: unknown) => addCreditsImpl(params),
  },
}));

mock.module("./services/organizations", () => ({
  organizationsService: {
    getBySlug: async () => undefined,
    create: async (data: unknown) => {
      orgCreateCalls.push(data);
      return createdOrg;
    },
    update: async (id: string, data: unknown) => {
      orgUpdateCalls.push({ id, data });
      return { ...createdOrg, ...(data as object) };
    },
    delete: async (id: string) => {
      orgDeleteCalls.push(id);
      return undefined;
    },
  },
}));

mock.module("./services/users", () => ({
  usersService: {
    getByStewardId: async () => undefined,
    getByEmailWithOrganization: async () => undefined,
    getByWalletAddress: async () => undefined,
    getByWalletAddressWithOrganization: async () => undefined,
    getStewardIdentityForWrite: async () => undefined,
    getByStewardIdForWrite: async () => finalUserWithOrg,
    createFreshStewardSignupUser: async () => createdUser,
    initializeFreshStewardIdentity: async () => undefined,
    create: async () => createdUser,
    update: async () => undefined,
    linkStewardId: async () => undefined,
    upsertStewardIdentity: async () => undefined,
  },
}));

mock.module("./services/invites", () => ({
  invitesService: {
    findPendingInviteByEmail: async () => undefined,
  },
}));

mock.module("./services/api-keys", () => ({
  apiKeysService: {
    listByOrganization: async () => [],
    create: async () => ({ id: "key-1" }),
    ensureUserHasApiKey: async () => undefined,
    // steward-sync's new-user path awaits apiKeysService.provisionDefaultApiKey
    // (steward-sync.ts:717); without this stub the grant happy-path test throws
    // `apiKeysService.provisionDefaultApiKey is not a function` and the cloud
    // suite (packages/cloud/shared/src) stays deterministically red. Complements
    // PR #14259 which fixed the same stale stub in steward-sync-default-provisioning.test.ts.
    provisionDefaultApiKey: async () => undefined,
  },
}));

mock.module("./services/characters/characters", () => ({
  charactersService: {
    hasHealthyCloudCharacterMirror: async () => false,
    create: async () => ({ id: "char-1" }),
  },
}));

mock.module("./services/discord", () => ({
  discordService: {
    logUserSignup: async () => undefined,
  },
}));

mock.module("./services/email", () => ({
  emailService: {
    sendWelcomeEmail: async () => undefined,
  },
}));

mock.module("./db/repositories/organization-invites", () => ({
  organizationInvitesRepository: {
    markAsAccepted: async () => undefined,
  },
}));

mock.module("../db/repositories/users", () => ({
  usersRepository: {
    delete: async () => undefined,
    findPendingPhoneTelegramPersonalAccountConvergence: async () => ({
      status: "not_found" as const,
    }),
  },
}));

mock.module("./utils/logger", () => ({
  logger: {
    error: (message: string, context?: unknown) => {
      loggerErrorCalls.push({ message, context });
    },
    warn: () => {},
    info: () => {},
    debug: () => {},
  },
  redact: {
    id: (v: string) => v,
    orgId: (v: string) => v,
    userId: (v: string) => v,
  },
}));

const baseParams = {
  stewardUserId: "steward-123",
  email: "alice@example.com",
  name: "alice",
};

describe("syncUserFromSteward — zero signup credit", () => {
  beforeEach(() => {
    addCreditsCalls.length = 0;
    orgCreateCalls.length = 0;
    orgUpdateCalls.length = 0;
    orgDeleteCalls.length = 0;
    loggerErrorCalls.length = 0;
    addCreditsImpl = async (params) => {
      addCreditsCalls.push(params);
      return { success: true };
    };
  });

  test("creates the account with $0 and no credit transaction", async () => {
    const { syncUserFromSteward } = await import("./steward-sync");

    const result = await syncUserFromSteward(baseParams);

    expect(addCreditsCalls).toHaveLength(0);
    expect(orgCreateCalls).toEqual([expect.objectContaining({ credit_balance: "0.00" })]);
    expect(
      orgUpdateCalls.filter((c) => (c.data as { credit_balance?: string }).credit_balance),
    ).toHaveLength(0);
    expect(orgDeleteCalls).toHaveLength(0);
    expect(loggerErrorCalls).toHaveLength(0);
    expect(result).toMatchObject({
      ...finalUserWithOrg,
      initialCreditsGranted: false,
      initialFreeCreditsUsd: 0,
    });
  });
});
