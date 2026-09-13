/**
 * Proves a Telegram DM-created personal account is promoted in place against
 * a real isolated PGlite schema, with retries and ownership conflicts closed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { organizationBalanceRevisionSequence, organizations } from "../../schemas/organizations";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository Telegram account promotion (real PGlite)", () => {
  let pgliteReady = true;
  let sequence = 0;

  const createTelegramAccount = async (telegramId: string) => {
    sequence += 1;
    return usersRepository.findOrCreateMessagingPersonalAccount({
      platform: "telegram",
      telegramId,
      telegramUsername: `telegram_user_${sequence}`,
      telegramFirstName: `Telegram ${sequence}`,
      displayName: `Telegram User ${sequence}`,
      organizationName: `Telegram Workspace ${sequence}`,
      organizationSlug: `telegram-workspace-${sequence}`,
    });
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-promote-telegram-personal-account.test] isolated PGlite is required; refusing to mutate an ambient Postgres database.",
      );
      return;
    }

    try {
      const { apply } = await pushSchema(
        {
          organizationBalanceRevisionSequence,
          organizations,
          users,
          userIdentities,
        } as never,
        dbWrite as never,
      );
      await apply();
    } catch (error) {
      // error-policy:J1 The test boundary records setup failure and every case fails loudly.
      pgliteReady = false;
      console.error(
        "[users-promote-telegram-personal-account.test] PGlite schema setup failed.",
        error,
      );
    }
  }, PGLITE_TIMEOUT);

  beforeEach(async () => {
    expect(pgliteReady).toBe(true);
    await dbWrite.delete(userIdentities);
    await dbWrite.delete(users);
    await dbWrite.delete(organizations);
  });

  afterAll(async () => {
    await closeDatabaseConnectionsForTests();
  });

  test("promotes the continuation-bound account without replacing its user, org, or zero balance", async () => {
    const telegramId = "100000201";
    const provisional = await createTelegramAccount(telegramId);

    const result = await usersRepository.promoteTelegramPersonalAccountToSteward({
      telegramId,
      stewardUserId: "steward-real-201",
      expectedUserId: provisional.user.id,
      expectedOrganizationId: provisional.organization.id,
    });

    expect(result.status).toBe("promoted");
    if (result.status !== "promoted") return;
    expect(result.user.id).toBe(provisional.user.id);
    expect(result.organization.id).toBe(provisional.organization.id);
    expect(result.organization.credit_balance).toBe("0.000000");
    expect(result.user.telegram_id).toBe(telegramId);

    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, provisional.user.id));
    expect(projection).toMatchObject({
      user_id: provisional.user.id,
      steward_user_id: "steward-real-201",
      telegram_id: telegramId,
    });
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
  });

  test("makes retry and concurrent replay converge on the original account", async () => {
    const telegramId = "100000202";
    const provisional = await createTelegramAccount(telegramId);
    const params = {
      telegramId,
      stewardUserId: "steward-real-202",
      expectedUserId: provisional.user.id,
      expectedOrganizationId: provisional.organization.id,
    };

    expect((await usersRepository.promoteTelegramPersonalAccountToSteward(params)).status).toBe(
      "promoted",
    );
    const retries = await Promise.all(
      Array.from({ length: 6 }, () =>
        usersRepository.promoteTelegramPersonalAccountToSteward(params),
      ),
    );

    expect(retries.every((result) => result.status === "already_promoted")).toBe(true);
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
  });

  test("makes concurrent browser login and first DM converge before promotion", async () => {
    const telegramId = "100000208";
    const stewardUserId = "steward-real-208";

    const browserLogin = (async () => {
      const personal = await createTelegramAccount(telegramId);
      return await usersRepository.promoteTelegramPersonalAccountToSteward({
        telegramId,
        stewardUserId,
        expectedUserId: personal.user.id,
        expectedOrganizationId: personal.organization.id,
      });
    })();
    const inboundDm = createTelegramAccount(telegramId);

    const [promotion, dmAccount] = await Promise.all([browserLogin, inboundDm]);
    expect(["promoted", "already_promoted"]).toContain(promotion.status);
    if (promotion.status !== "promoted" && promotion.status !== "already_promoted") {
      return;
    }
    expect(promotion.user.id).toBe(dmAccount.user.id);
    expect(promotion.organization.id).toBe(dmAccount.organization.id);
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);

    const laterDm = await createTelegramAccount(telegramId);
    expect(laterDm.user.id).toBe(promotion.user.id);
    expect(laterDm.organization.id).toBe(promotion.organization.id);
    expect(laterDm.user.steward_user_id).toBe(stewardUserId);
  });

  test("rejects a continuation bound to a different account without mutation", async () => {
    const telegramId = "100000203";
    const provisional = await createTelegramAccount(telegramId);

    const result = await usersRepository.promoteTelegramPersonalAccountToSteward({
      telegramId,
      stewardUserId: "steward-real-203",
      expectedUserId: "00000000-0000-4000-8000-000000000099",
      expectedOrganizationId: provisional.organization.id,
    });

    expect(result).toEqual({ status: "continuation_account_mismatch" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe(`telegram:${telegramId}`);
  });

  test("rejects a Steward subject already owned by another Telegram account", async () => {
    const claimant = await createTelegramAccount("100000204");
    const owner = await createTelegramAccount("100000205");
    expect(
      (
        await usersRepository.promoteTelegramPersonalAccountToSteward({
          telegramId: "100000205",
          stewardUserId: "steward-collision",
          expectedUserId: owner.user.id,
          expectedOrganizationId: owner.organization.id,
        })
      ).status,
    ).toBe("promoted");

    const result = await usersRepository.promoteTelegramPersonalAccountToSteward({
      telegramId: "100000204",
      stewardUserId: "steward-collision",
      expectedUserId: claimant.user.id,
      expectedOrganizationId: claimant.organization.id,
    });

    expect(result).toEqual({ status: "steward_subject_owned_by_other_user" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, claimant.user.id));
    expect(canonical?.steward_user_id).toBe("telegram:100000204");
    expect(await dbWrite.select().from(users)).toHaveLength(2);
    expect(await dbWrite.select().from(organizations)).toHaveLength(2);
  });

  test("rolls back canonical promotion when the identity projection changed", async () => {
    const telegramId = "100000207";
    const provisional = await createTelegramAccount(telegramId);
    await dbWrite
      .update(userIdentities)
      .set({ steward_user_id: "tampered-projected-subject" })
      .where(eq(userIdentities.user_id, provisional.user.id));

    const result = await usersRepository.promoteTelegramPersonalAccountToSteward({
      telegramId,
      stewardUserId: "steward-real-207",
      expectedUserId: provisional.user.id,
      expectedOrganizationId: provisional.organization.id,
    });

    expect(result).toEqual({ status: "identity_projection_conflict" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    const [projection] = await dbWrite
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.user_id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe(`telegram:${telegramId}`);
    expect(projection?.steward_user_id).toBe("tampered-projected-subject");
  });

  test("never reassigns an already-promoted Telegram account to another subject", async () => {
    const telegramId = "100000206";
    const provisional = await createTelegramAccount(telegramId);
    const base = {
      telegramId,
      expectedUserId: provisional.user.id,
      expectedOrganizationId: provisional.organization.id,
    };
    expect(
      (
        await usersRepository.promoteTelegramPersonalAccountToSteward({
          ...base,
          stewardUserId: "steward-owner-206",
        })
      ).status,
    ).toBe("promoted");

    const result = await usersRepository.promoteTelegramPersonalAccountToSteward({
      ...base,
      stewardUserId: "steward-other-206",
    });

    expect(result).toEqual({ status: "telegram_owned_by_mature_account" });
    const [canonical] = await dbWrite.select().from(users).where(eq(users.id, provisional.user.id));
    expect(canonical?.steward_user_id).toBe("steward-owner-206");
  });
});
