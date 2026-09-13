/**
 * Real-DB regression suite for transactional phone account creation and
 * `UsersRepository.linkTelegramAndPhoneIdentity`: both must update the canonical
 * `users` row AND the `user_identities` projection in one transaction, because
 * sessionless auth (`findByTelegramIdWithOrganization`,
 * `findByPhoneNumberWithOrganization`) resolves users through
 * `user_identities` only. Also pins the fail-closed collision behavior (no
 * half-linked state survives a uniqueness violation in either table) and the
 * refusal to overwrite a different already-verified phone number.
 *
 * Runs against an isolated in-process PGlite database (real schema via
 * pushSchema); nothing on the repository is mocked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

// PGlite isolation harness (mirrors agent-billing-numeric.test.ts): the suite
// fails LOUDLY against a shared non-PGlite Postgres.
const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { isUniqueConstraintError } from "../../../lib/utils/db-errors";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import { organizations } from "../../schemas/organizations";
import {
  personalSharedGroupBindings,
  personalSharedGroupJoinChallenges,
  personalSharedGroupParticipants,
} from "../../schemas/personal-shared-groups";
import { userIdentities } from "../../schemas/user-identities";
import { users } from "../../schemas/users";
import { usersRepository } from "../users";

const PGLITE_TIMEOUT = 120_000;

describe("UsersRepository.linkTelegramAndPhoneIdentity (real PGlite)", () => {
  let pgliteReady = true;
  let seq = 0;
  const uniq = (prefix: string): string => {
    seq += 1;
    return `${prefix}-${seq}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const createOrg = async () => {
    const [org] = await dbWrite
      .insert(organizations)
      .values({ name: "Link Org", slug: uniq("org"), credit_balance: "0.00" })
      .returning();
    return org;
  };

  const createUser = async (
    overrides: Partial<typeof users.$inferInsert> = {},
  ): Promise<typeof users.$inferSelect> => {
    const org = await createOrg();
    const [user] = await dbWrite
      .insert(users)
      .values({
        steward_user_id: uniq("steward"),
        name: "Link Test User",
        organization_id: org.id,
        role: "owner",
        is_active: true,
        ...overrides,
      })
      .returning();
    return user;
  };

  beforeAll(async () => {
    if (!CAN_USE_ISOLATED_PGLITE) {
      pgliteReady = false;
      console.warn(
        "[users-link-telegram-phone.test] DATABASE_URL is a non-PGlite Postgres (shared CI DB); pushSchema against a shared connection would mutate the shared schema. Skipping.",
      );
      return;
    }
    try {
      const schema = {
        organizations,
        users,
        userIdentities,
        personalSharedGroupBindings,
        personalSharedGroupParticipants,
        personalSharedGroupJoinChallenges,
      };
      const { apply } = await pushSchema(schema as never, dbWrite as never);
      await apply();
    } catch (error) {
      pgliteReady = false;
      console.error(
        "[users-link-telegram-phone.test] PGlite/pushSchema unavailable — cannot drive UsersRepository against a real DB.",
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

  test("concurrent trusted first texts create one personal unfunded account", async () => {
    const phone = "+14155550100";
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        usersRepository.findOrCreatePhonePersonalAccount({
          phoneNumber: phone,
          displayName: "User ***0100",
          organizationName: "User ***0100's Workspace",
          organizationSlug: uniq(`phone-0100-${index}`),
        }),
      ),
    );

    expect(new Set(attempts.map((result) => result.user.id))).toEqual(
      new Set([attempts[0]?.user.id]),
    );
    expect(attempts.filter((result) => result.isNew)).toHaveLength(1);
    expect(attempts[0]?.organization.credit_balance).toBe("0.000000");
    expect(await dbWrite.select().from(users)).toHaveLength(1);
    expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
    expect(await dbWrite.select().from(organizations)).toHaveLength(1);

    const resolved = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(resolved?.id).toBe(attempts[0]?.user.id);
    expect(resolved?.phone_verified).toBe(true);
  });

  test.each([
    {
      unavailableAccount: "a deleted user",
      userChanges: { deleted_at: new Date("2026-08-12T00:00:00.000Z") },
      organizationActive: true,
      expectedCode: "PHONE_PERSONAL_ACCOUNT_DELETED",
    },
    {
      unavailableAccount: "an inactive user",
      userChanges: { is_active: false },
      organizationActive: true,
      expectedCode: "PHONE_PERSONAL_ACCOUNT_INACTIVE",
    },
    {
      unavailableAccount: "an inactive organization",
      userChanges: {},
      organizationActive: false,
      expectedCode: "PHONE_PERSONAL_ACCOUNT_ORGANIZATION_INACTIVE",
    },
  ])(
    "trusted first-text retry fails closed for $unavailableAccount without verifying or replacing it",
    async ({ userChanges, organizationActive, expectedCode }) => {
      const phone = "+14155550111";
      const original = await usersRepository.findOrCreatePhonePersonalAccount({
        phoneNumber: phone,
        displayName: "User ***0111",
        organizationName: "User ***0111's Workspace",
        organizationSlug: uniq("phone-0111"),
      });
      await dbWrite
        .update(users)
        .set({ ...userChanges, phone_verified: false })
        .where(eq(users.id, original.user.id));
      await dbWrite
        .update(userIdentities)
        .set({ phone_verified: false })
        .where(eq(userIdentities.user_id, original.user.id));
      await dbWrite
        .update(organizations)
        .set({ is_active: organizationActive })
        .where(eq(organizations.id, original.organization.id));

      const error = await usersRepository
        .findOrCreatePhonePersonalAccount({
          phoneNumber: phone,
          displayName: "Replacement",
          organizationName: "Replacement Workspace",
          organizationSlug: uniq("replacement-0111"),
        })
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );

      expect(error).toMatchObject({ code: expectedCode });
      const [canonical] = await dbWrite.select().from(users);
      const [projection] = await dbWrite.select().from(userIdentities);
      const [organization] = await dbWrite.select().from(organizations);
      expect(canonical).toMatchObject({
        id: original.user.id,
        phone_number: phone,
        phone_verified: false,
        ...userChanges,
      });
      expect(projection).toMatchObject({
        user_id: original.user.id,
        phone_number: phone,
        phone_verified: false,
      });
      expect(organization).toMatchObject({
        id: original.organization.id,
        is_active: organizationActive,
      });
      expect(await dbWrite.select().from(users)).toHaveLength(1);
      expect(await dbWrite.select().from(userIdentities)).toHaveLength(1);
      expect(await dbWrite.select().from(organizations)).toHaveLength(1);
    },
  );

  test("linking writes users AND user_identities so sessionless lookups resolve the user", async () => {
    const user = await createUser();
    const telegramId = uniq("tg");
    const phone = "+14155550101";

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(result.status).toBe("linked");

    const byTelegram = await usersRepository.findByTelegramIdWithOrganization(telegramId);
    expect(byTelegram?.id).toBe(user.id);
    expect(user.organization_id).not.toBeNull();
    expect(byTelegram?.organization?.id).toBe(user.organization_id as string);

    const byPhone = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(byPhone?.id).toBe(user.id);

    const canonical = await usersRepository.findById(user.id);
    expect(canonical?.telegram_id).toBe(telegramId);
    expect(canonical?.phone_number).toBe(phone);
    expect(canonical?.phone_verified).toBe(true);
  });

  test("re-linking the same phone is idempotent and refreshes the Telegram profile", async () => {
    const user = await createUser();
    const telegramId = uniq("tg");
    const phone = "+14155550102";

    const first = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "old",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(first.status).toBe("linked");

    const second = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: telegramId,
      telegram_username: "new",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(second.status).toBe("linked");

    const identity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, user.id),
    });
    expect(identity?.telegram_username).toBe("new");
    expect(identity?.phone_number).toBe(phone);
  });

  test("a Telegram identity owned by another user fails the whole link — no half-link in either table", async () => {
    const owner = await createUser();
    const telegramId = uniq("tg");
    const ownerLink = await usersRepository.linkTelegramAndPhoneIdentity(owner.id, {
      telegram_id: telegramId,
      telegram_username: "owner",
      telegram_first_name: "Own",
      phone_number: "+14155550103",
    });
    expect(ownerLink.status).toBe("linked");

    const intruder = await createUser();
    const telegramCollision = await usersRepository
      .linkTelegramAndPhoneIdentity(intruder.id, {
        telegram_id: telegramId,
        telegram_username: "intruder",
        telegram_first_name: "Bad",
        phone_number: "+14155550104",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueConstraintError(telegramCollision)).toBe(true);

    const intruderRow = await usersRepository.findById(intruder.id);
    expect(intruderRow?.telegram_id).toBeNull();
    expect(intruderRow?.phone_number).toBeNull();

    const intruderIdentity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, intruder.id),
    });
    expect(intruderIdentity).toBeUndefined();

    const stillOwner = await usersRepository.findByTelegramIdWithOrganization(telegramId);
    expect(stillOwner?.id).toBe(owner.id);
  });

  test("a phone identity owned by another user fails the whole link — no half-link in either table", async () => {
    const owner = await createUser();
    const phone = "+14155550105";
    const ownerLink = await usersRepository.linkTelegramAndPhoneIdentity(owner.id, {
      telegram_id: uniq("tg"),
      telegram_username: "owner",
      telegram_first_name: "Own",
      phone_number: phone,
    });
    expect(ownerLink.status).toBe("linked");

    const intruder = await createUser();
    const phoneCollision = await usersRepository
      .linkTelegramAndPhoneIdentity(intruder.id, {
        telegram_id: uniq("tg"),
        telegram_username: "intruder",
        telegram_first_name: "Bad",
        phone_number: phone,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(isUniqueConstraintError(phoneCollision)).toBe(true);

    const intruderRow = await usersRepository.findById(intruder.id);
    expect(intruderRow?.telegram_id).toBeNull();
    expect(intruderRow?.phone_number).toBeNull();

    const intruderIdentity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, intruder.id),
    });
    expect(intruderIdentity).toBeUndefined();

    const stillOwner = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(stillOwner?.id).toBe(owner.id);
  });

  test("refuses to overwrite a different verified phone number and mutates nothing", async () => {
    const existingPhone = "+14155550106";
    const user = await createUser({ phone_number: existingPhone, phone_verified: true });

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: uniq("tg"),
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: "+14155550107",
    });

    expect(result).toEqual({ status: "phone_mismatch", existingPhone });

    const canonical = await usersRepository.findById(user.id);
    expect(canonical?.phone_number).toBe(existingPhone);
    expect(canonical?.telegram_id).toBeNull();

    const identity = await dbWrite.query.userIdentities.findFirst({
      where: eq(userIdentities.user_id, user.id),
    });
    expect(identity).toBeUndefined();
  });

  test("an unverified placeholder phone may be replaced", async () => {
    const user = await createUser({ phone_number: "+14155550108", phone_verified: false });
    const phone = "+14155550109";

    const result = await usersRepository.linkTelegramAndPhoneIdentity(user.id, {
      telegram_id: uniq("tg"),
      telegram_username: "sam",
      telegram_first_name: "Sam",
      phone_number: phone,
    });
    expect(result.status).toBe("linked");

    const byPhone = await usersRepository.findByPhoneNumberWithOrganization(phone);
    expect(byPhone?.id).toBe(user.id);
  });

  test("a missing user reports user_not_found", async () => {
    const result = await usersRepository.linkTelegramAndPhoneIdentity(
      "00000000-0000-0000-0000-000000000000",
      {
        telegram_id: uniq("tg"),
        phone_number: "+14155550110",
      },
    );
    expect(result).toEqual({ status: "user_not_found" });
  });
});
