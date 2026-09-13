/**
 * acceptInvite solo-org vacate: fail-closed on a corrupt credit_balance (#13415).
 *
 * `InvitesService.assertOwnerCanVacateSoloOrganization` guards the auto-delete
 * of a vacated solo org: an owner may only move into an inviting org (which
 * deletes their now-empty solo org via `cleanUpVacatedSoloOrganization ->
 * organizationsService.delete`) only if that org holds zero credits — otherwise
 * purchased or promotional balance would be silently destroyed.
 *
 * `credit_balance` is a Postgres NUMERIC (string at read). The previous gate
 * read it through a bare `Number(organization.credit_balance) >
 * zero, which fails OPEN on a corrupt value: `'NaN'::numeric`
 * is a valid Postgres NUMERIC (a migration artifact or manual edit can produce
 * it, and — as this suite's own probe confirms — it even satisfies the
 * `credit_balance >= 0` CHECK because NaN sorts as greatest), and it reads back
 * as the string `"NaN"`. `Number("NaN")` is `NaN`, and `NaN > 0`
 * is FALSE — so the guard was BYPASSED and the org, with whatever real credits
 * it held, was vacated and DELETED, silently losing the balance.
 *
 * Case 1 is the reversion proof: it seeds a corrupt `'NaN'` balance via raw SQL
 * (bypassing the drizzle insert type-guard, mirroring how the corruption arises
 * in prod) and asserts the accept is REJECTED and the org PRESERVED. With the
 * fail-open `Number(...)` restored it fails (the org is deleted). Case 2 is the
 * no-false-block control: a healthy zero balance still vacates.
 *
 * Runs the REAL `InvitesService.acceptInvite` against in-process PGlite (real
 * users/organizations/invites SQL). Fails loudly via the `pgliteReady` guard if
 * PGlite/pushSchema ever fails to initialize — never a silent skip.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

// This proof owns its DB: force an isolated in-memory PGlite regardless of the
// ambient DATABASE_URL / TEST_DATABASE_URL the CI lane exports.
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

// Not the seam under test: `invites.ts` imports the email service at module
// level for createInvite's notification. acceptInvite never sends mail.
mock.module("../email", () => ({
  emailService: {
    sendInviteEmail: mock(async () => false),
  },
}));

const PGLITE_TIMEOUT = 60_000;

let pgliteReady = true;
let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;
let invitesService: typeof import("../invites").invitesService;
let generateInviteToken: typeof import("../../utils/invite-tokens").generateInviteToken;
let hashInviteToken: typeof import("../../utils/invite-tokens").hashInviteToken;
let schemas: {
  organizations: typeof import("../../../db/schemas/organizations").organizations;
  users: typeof import("../../../db/schemas/users").users;
  userIdentities: typeof import("../../../db/schemas/user-identities").userIdentities;
  personalSharedGroupBindings: typeof import("../../../db/schemas/personal-shared-groups").personalSharedGroupBindings;
  personalSharedGroupJoinChallenges: typeof import("../../../db/schemas/personal-shared-groups").personalSharedGroupJoinChallenges;
  personalSharedGroupParticipants: typeof import("../../../db/schemas/personal-shared-groups").personalSharedGroupParticipants;
  organizationInvites: typeof import("../../../db/schemas/organization-invites").organizationInvites;
  userCharacters: typeof import("../../../db/schemas/user-characters").userCharacters;
  conversations: typeof import("../../../db/schemas/conversations").conversations;
  apps: typeof import("../../../db/schemas/apps").apps;
  containers: typeof import("../../../db/schemas/containers").containers;
  agentSandboxes: typeof import("../../../db/schemas/agent-sandboxes").agentSandboxes;
  managedDomains: typeof import("../../../db/schemas/managed-domains").managedDomains;
};

const SOLO_ORG_CREDITS_BLOCK_MESSAGE =
  "You cannot join another organization while your current organization holds credits. Contact support to transfer them first.";

let seq = 0;
function uid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

interface SeedResult {
  inviterOrgId: string;
  inviterUserId: string;
  inviteeOrgId: string;
  inviteeUserId: string;
  inviteId: string;
  token: string;
}

async function seedInviteScenario(options?: {
  inviteeOrgBalance?: string;
  inviteeOrgBalanceRevision?: number;
  invitedRole?: "admin" | "member";
}): Promise<SeedResult> {
  const inviterOrgId = uid();
  const inviterUserId = uid();
  const inviteeOrgId = uid();
  const inviteeUserId = uid();
  const inviteeEmail = `invitee-${inviteeUserId}@example.com`;

  await dbWrite.insert(schemas.organizations).values([
    { id: inviterOrgId, name: "Team Org", slug: `team-${inviterOrgId}` },
    {
      id: inviteeOrgId,
      name: "Solo Org",
      slug: `solo-${inviteeOrgId}`,
      credit_balance: options?.inviteeOrgBalance ?? "5.000000",
      balance_revision: options?.inviteeOrgBalanceRevision ?? 0,
    },
  ]);
  await dbWrite.insert(schemas.users).values([
    {
      id: inviterUserId,
      steward_user_id: `steward-${inviterUserId}`,
      email: `inviter-${inviterUserId}@example.com`,
      organization_id: inviterOrgId,
      role: "owner",
    },
    {
      id: inviteeUserId,
      steward_user_id: `steward-${inviteeUserId}`,
      email: inviteeEmail,
      organization_id: inviteeOrgId,
      role: "owner",
    },
  ]);

  const token = generateInviteToken();
  const inviteId = uid();
  await dbWrite.insert(schemas.organizationInvites).values({
    id: inviteId,
    organization_id: inviterOrgId,
    inviter_user_id: inviterUserId,
    invited_email: inviteeEmail,
    invited_role: options?.invitedRole ?? "member",
    token_hash: hashInviteToken(token),
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
    status: "pending",
  });

  return { inviterOrgId, inviterUserId, inviteeOrgId, inviteeUserId, inviteId, token };
}

async function readUser(userId: string): Promise<{ organization_id: string | null }> {
  const rows = await dbWrite.execute(`SELECT organization_id FROM users WHERE id = '${userId}';`);
  return rows.rows[0] as { organization_id: string | null };
}

async function orgExists(orgId: string): Promise<boolean> {
  const rows = await dbWrite.execute(`SELECT id FROM organizations WHERE id = '${orgId}';`);
  return rows.rows.length > 0;
}

async function readOrgBalance(orgId: string): Promise<string> {
  const rows = await dbWrite.execute(
    `SELECT credit_balance FROM organizations WHERE id = '${orgId}';`,
  );
  return (rows.rows[0] as { credit_balance: string }).credit_balance;
}

beforeAll(async () => {
  try {
    ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
    ({ invitesService } = await import("../invites"));
    ({ generateInviteToken, hashInviteToken } = await import("../../utils/invite-tokens"));

    const { organizations } = await import("../../../db/schemas/organizations");
    const { users } = await import("../../../db/schemas/users");
    const { userIdentities } = await import("../../../db/schemas/user-identities");
    const {
      personalSharedGroupBindings,
      personalSharedGroupJoinChallenges,
      personalSharedGroupParticipants,
    } = await import("../../../db/schemas/personal-shared-groups");
    const { organizationInvites } = await import("../../../db/schemas/organization-invites");
    const { userCharacters } = await import("../../../db/schemas/user-characters");
    const { conversations } = await import("../../../db/schemas/conversations");
    const { apiKeys } = await import("../../../db/schemas/api-keys");
    const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
    const { apps, appDeploymentStatusEnum, appReviewStatusEnum, userDatabaseStatusEnum } =
      await import("../../../db/schemas/apps");
    const { containers } = await import("../../../db/schemas/containers");
    const { agentSandboxes } = await import("../../../db/schemas/agent-sandboxes");
    const {
      domainModerationStatusEnum,
      domainNameserverModeEnum,
      domainRegistrarEnum,
      domainResourceTypeEnum,
      domainStatusEnum,
      managedDomains,
    } = await import("../../../db/schemas/managed-domains");
    const { mcpPricingTypeEnum, mcpStatusEnum, userMcps } = await import(
      "../../../db/schemas/user-mcps"
    );
    schemas = {
      organizations,
      users,
      userIdentities,
      personalSharedGroupBindings,
      personalSharedGroupJoinChallenges,
      personalSharedGroupParticipants,
      organizationInvites,
      userCharacters,
      conversations,
      apps,
      containers,
      agentSandboxes,
      managedDomains,
    };

    const { pushSchema } = await import("../../../db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userIdentities,
        personalSharedGroupBindings,
        personalSharedGroupJoinChallenges,
        personalSharedGroupParticipants,
        organizationInvites,
        userCharacters,
        conversations,
        apiKeys,
        creditTransactions,
        apps,
        containers,
        agentSandboxes,
        managedDomains,
        domainRegistrarEnum,
        domainNameserverModeEnum,
        domainResourceTypeEnum,
        domainModerationStatusEnum,
        domainStatusEnum,
        userMcps,
        mcpPricingTypeEnum,
        mcpStatusEnum,
        appDeploymentStatusEnum,
        appReviewStatusEnum,
        userDatabaseStatusEnum,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    pgliteReady = false;
    console.error("[invite-vacate-credit-fail-closed.test] PGlite/pushSchema unavailable.", error);
  }
}, PGLITE_TIMEOUT);

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe("acceptInvite solo-org vacate — corrupt credit_balance fails closed (#13415)", () => {
  test(
    "a corrupt 'NaN' credit_balance BLOCKS the vacate and preserves the org (fail-open regression)",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();

      // Poison the balance the way prod corruption arises: a raw NUMERIC 'NaN'
      // that the drizzle insert type-guard would reject but the column happily
      // stores (and which satisfies credit_balance >= 0 because NaN sorts as
      // greatest in Postgres NUMERIC). Sanity-check it actually persisted.
      await dbWrite.execute(
        `UPDATE organizations SET credit_balance = 'NaN' WHERE id = '${seeded.inviteeOrgId}';`,
      );
      expect(await readOrgBalance(seeded.inviteeOrgId)).toBe("NaN");

      // With the fail-open Number(...) restored, NaN > grant is false so the
      // guard is bypassed, the accept succeeds, and the org is DELETED. The
      // fail-closed parse throws instead, so the accept is rejected and the org
      // (with its unreadable balance) is preserved.
      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        SOLO_ORG_CREDITS_BLOCK_MESSAGE,
      );

      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an untouched legacy zero balance still vacates (no rollout false block)",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({ inviteeOrgBalance: "0.000000" });

      const accepted = await invitesService.acceptInvite(seeded.token, seeded.inviteeUserId);
      expect(accepted.status).toBe("accepted");

      // Moved into the inviting org; the emptied solo org is deleted as designed.
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviterOrgId);
      expect(await orgExists(seeded.inviteeOrgId)).toBe(false);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "an existing five-dollar balance is preserved instead of treated as a new signup allowance",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario();
      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        SOLO_ORG_CREDITS_BLOCK_MESSAGE,
      );
      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await readOrgBalance(seeded.inviteeOrgId)).toBe("5.000000");
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a transacted balance below the signup grant blocks vacate and preserves purchased credit",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({
        inviteeOrgBalance: "2.000000",
        inviteeOrgBalanceRevision: 42,
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        SOLO_ORG_CREDITS_BLOCK_MESSAGE,
      );

      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await readOrgBalance(seeded.inviteeOrgId)).toBe("2.000000");
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "a transacted five-dollar balance blocks vacate even when it matches the signup grant",
    async () => {
      expect(pgliteReady).toBe(true);
      const seeded = await seedInviteScenario({
        inviteeOrgBalance: "5.000000",
        inviteeOrgBalanceRevision: 43,
      });

      await expect(invitesService.acceptInvite(seeded.token, seeded.inviteeUserId)).rejects.toThrow(
        SOLO_ORG_CREDITS_BLOCK_MESSAGE,
      );

      expect((await readUser(seeded.inviteeUserId)).organization_id).toBe(seeded.inviteeOrgId);
      expect(await readOrgBalance(seeded.inviteeOrgId)).toBe("5.000000");
      expect(await orgExists(seeded.inviteeOrgId)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});
