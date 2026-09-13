/**
 * Pins fail-closed identity linking with deterministic service fixtures: real
 * write failures propagate, phone and Telegram-plus-phone writes use the atomic
 * repository boundaries, and only cosmetic Discord refreshes may degrade.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const findByDiscordIdWithOrganization = mock();
const findByCanonicalDiscordIdWithOrganization = mock();
const findByPhoneNumberWithOrganization = mock();
const update = mock();
const linkVerifiedPhone = mock();
const findOrCreatePhonePersonalAccount = mock();
const linkTelegramAndPhoneIdentity = mock();
const refreshDiscordProjectionForWrite = mock();
const linkDiscordIdentity = mock();
const createUser = mock();
const createOrganization = mock();
const createApiKey = mock();
const addCredits = mock();

mock.module("../../../db/repositories/users", () => ({
  usersRepository: {
    findByDiscordIdWithOrganization,
    findByCanonicalDiscordIdWithOrganization,
    findByPhoneNumberWithOrganization,
    findByTelegramIdWithOrganization: mock(),
    findByEmailWithOrganization: mock(),
    findByWhatsAppIdWithOrganization: mock(),
    findWithOrganization: mock(),
    update,
    linkVerifiedPhone,
    findOrCreatePhonePersonalAccount,
    linkTelegramAndPhoneIdentity,
    refreshDiscordProjectionForWrite,
    linkDiscordIdentity,
    create: createUser,
  },
}));

mock.module("../../../db/repositories/organizations", () => ({
  organizationsRepository: {
    findBySlug: mock(async () => undefined),
    create: createOrganization,
  },
}));

mock.module("../../utils/email-validation", () => ({
  isValidEmail: mock(() => true),
  maskEmailForLogging: mock((email: string) => email),
}));

mock.module("../../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

mock.module("../../utils/phone-normalization", () => ({
  normalizePhoneNumber: mock((phone: string) => phone),
  isValidE164: mock(() => true),
}));

mock.module("../api-keys", () => ({ apiKeysService: { create: createApiKey } }));
mock.module("../credits", () => ({
  creditsService: { addCredits },
  COST_BUFFER: 1.5,
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
  MIN_RESERVATION: 0.000001,
  ReservationNotFoundError: class ReservationNotFoundError extends Error {},
  RESERVATION_SWEEP_GRACE_MS: 7_200_000,
}));
mock.module("../signup-code", () => ({ redeemSignupCode: mock() }));

const { elizaAppUserService } = await import(
  `./user-service.ts?test=user-service-error-policy-${Date.now()}`
);

describe("ElizaAppUserService account opening balance", () => {
  beforeEach(() => {
    findOrCreatePhonePersonalAccount.mockReset();
    findByPhoneNumberWithOrganization.mockReset();
    createOrganization.mockReset();
    createUser.mockReset();
    createApiKey.mockReset();
    addCredits.mockReset();
  });

  test("creates a phone-first personal account without signup credit", async () => {
    findOrCreatePhonePersonalAccount.mockResolvedValue({
      user: { id: "user-new", phone_number: "+15551234567" },
      organization: { id: "org-new", credit_balance: "0.00" },
      isNew: true,
    });

    const result = await elizaAppUserService.findOrCreateByPhone("+15551234567");

    expect(result.isNew).toBe(true);
    expect(result.organization.credit_balance).toBe("0.00");
    expect(findOrCreatePhonePersonalAccount).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: "+15551234567" }),
    );
    expect(addCredits).not.toHaveBeenCalled();
  });

  test("reuses a verified active phone account without entering the locked writer", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "user-repeat",
      phone_number: "+15551234567",
      phone_verified: true,
      is_active: true,
      deleted_at: null,
      organization: { id: "org-repeat", is_active: true, credit_balance: "0.00" },
    });

    const result = await elizaAppUserService.findOrCreateByPhone("+15551234567");

    expect(result).toMatchObject({
      isNew: false,
      user: { id: "user-repeat" },
      organization: { id: "org-repeat" },
    });
    expect(findOrCreatePhonePersonalAccount).not.toHaveBeenCalled();
  });

  test("falls back to the locked repair boundary for an inconsistent projection", async () => {
    findByPhoneNumberWithOrganization.mockResolvedValue({
      id: "user-stale",
      phone_number: "+15550000000",
      phone_verified: true,
      is_active: true,
      deleted_at: null,
      organization: { id: "org-stale", is_active: true },
    });
    findOrCreatePhonePersonalAccount.mockResolvedValue({
      user: { id: "user-repaired", phone_number: "+15551234567" },
      organization: { id: "org-repaired", credit_balance: "0.00" },
      isNew: false,
    });

    const result = await elizaAppUserService.findOrCreateByPhone("+15551234567");

    expect(result.user.id).toBe("user-repaired");
    expect(findOrCreatePhonePersonalAccount).toHaveBeenCalledTimes(1);
  });
});

function uniqueConstraintError(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

describe("ElizaAppUserService.findOrCreateByDiscordId error policy", () => {
  beforeEach(() => {
    findByDiscordIdWithOrganization.mockReset();
    findByCanonicalDiscordIdWithOrganization.mockReset();
    findByPhoneNumberWithOrganization.mockReset();
    update.mockReset();
    linkVerifiedPhone.mockReset();
    refreshDiscordProjectionForWrite.mockReset();
    refreshDiscordProjectionForWrite.mockResolvedValue(undefined);
    // No canonical-only legacy link by default.
    findByCanonicalDiscordIdWithOrganization.mockResolvedValue(undefined);
    // Phone is unowned by default so the phone-link branch is reachable.
    findByPhoneNumberWithOrganization.mockResolvedValue(undefined);
  });

  test("converges a canonical-only legacy Discord link into the projection instead of forking a second account", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue(undefined);
    findByCanonicalDiscordIdWithOrganization.mockResolvedValue({
      id: "legacy-user",
      discord_id: "d-legacy",
      organization: { id: "org-legacy" },
    });

    const result = await elizaAppUserService.findOrCreateByDiscordId("d-legacy", {
      username: "legacy",
    });

    expect(result.isNew).toBe(false);
    expect(result.user.id).toBe("legacy-user");
    expect(refreshDiscordProjectionForWrite).toHaveBeenCalledWith("legacy-user");
  });

  test("propagates a real DB failure while linking a phone (fail closed)", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      discord_id: "d1",
      discord_username: "olduser",
      phone_number: null,
      organization: { id: "org-1" },
    });
    update.mockRejectedValue(new Error("connection terminated unexpectedly"));

    await expect(
      elizaAppUserService.findOrCreateByDiscordId("d1", { username: "newuser" }, "+15551234567"),
    ).rejects.toThrow("connection terminated unexpectedly");

    expect(update).toHaveBeenCalledTimes(1);
  });

  test("maps a unique-constraint collision on the phone link to PHONE_ALREADY_LINKED", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-1",
      discord_id: "d1",
      discord_username: "olduser",
      phone_number: null,
      organization: { id: "org-1" },
    });
    update.mockRejectedValue(uniqueConstraintError());

    await expect(
      elizaAppUserService.findOrCreateByDiscordId("d1", { username: "newuser" }, "+15551234567"),
    ).rejects.toThrow("PHONE_ALREADY_LINKED");
  });

  test("degrades a cosmetic-only profile-refresh failure to success (distinguishable)", async () => {
    findByDiscordIdWithOrganization.mockResolvedValue({
      id: "user-2",
      discord_id: "d2",
      discord_username: "old-name",
      phone_number: "+15550000000",
      organization: { id: "org-2" },
    });
    update.mockRejectedValue(new Error("connection terminated unexpectedly"));

    const result = await elizaAppUserService.findOrCreateByDiscordId("d2", {
      username: "new-name",
    });

    expect(result.isNew).toBe(false);
    expect(result.user.id).toBe("user-2");
    expect(update).toHaveBeenCalledTimes(1);
  });

  test("links a phone through the atomic routing-identity repository contract", async () => {
    linkVerifiedPhone.mockResolvedValue({ id: "user-3" });

    await expect(elizaAppUserService.linkPhoneToUser("user-3", "+15551234567")).resolves.toEqual({
      success: true,
    });

    expect(linkVerifiedPhone).toHaveBeenCalledWith("user-3", "+15551234567");
    expect(update).not.toHaveBeenCalled();
  });

  test("fails when phone linking cannot find an identity owner", async () => {
    linkVerifiedPhone.mockResolvedValue(undefined);

    await expect(
      elizaAppUserService.linkPhoneToUser("missing-user", "+15551234567"),
    ).rejects.toThrow("missing-user");
  });
});

describe("ElizaAppUserService.linkTelegramAndPhoneToUser", () => {
  beforeEach(() => {
    update.mockReset();
    linkTelegramAndPhoneIdentity.mockReset();
  });

  test("delegates the Telegram and phone identity pair to the atomic repository boundary", async () => {
    linkTelegramAndPhoneIdentity.mockResolvedValue({
      status: "linked",
      user: { id: "user-1" },
    });

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        username: "sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result).toEqual({ success: true });
    expect(linkTelegramAndPhoneIdentity).toHaveBeenCalledTimes(1);
    expect(linkTelegramAndPhoneIdentity).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        telegram_id: "123456789",
        telegram_username: "sam",
        phone_number: "+14155550123",
      }),
    );
    // The atomic repository boundary owns both writes; the service must not
    // issue a separate canonical update around it.
    expect(update).not.toHaveBeenCalled();
  });

  test("reports an atomic repository uniqueness race without a compensating write", async () => {
    linkTelegramAndPhoneIdentity.mockRejectedValue(uniqueConstraintError());

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("already linked");
    expect(linkTelegramAndPhoneIdentity).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  test("refuses to overwrite a different verified phone number", async () => {
    linkTelegramAndPhoneIdentity.mockResolvedValue({
      status: "phone_mismatch",
      existingPhone: "+14155550999",
    });

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("different verified phone number");
  });

  test("reports a vanished account as a failed link", async () => {
    linkTelegramAndPhoneIdentity.mockResolvedValue({ status: "user_not_found" });

    const result = await elizaAppUserService.linkTelegramAndPhoneToUser(
      "user-1",
      {
        id: 123456789,
        first_name: "Sam",
        auth_date: 1_786_224_000,
        hash: "a".repeat(64),
      },
      "+14155550123",
    );

    expect(result).toEqual({ success: false, error: "The account no longer exists" });
  });
});

describe("ElizaAppUserService.linkDiscordToUser", () => {
  beforeEach(() => {
    linkDiscordIdentity.mockReset();
  });

  test("uses the atomic canonical-plus-projection repository boundary", async () => {
    linkDiscordIdentity.mockResolvedValue({ id: "user-1" });
    const result = await elizaAppUserService.linkDiscordToUser("user-1", {
      discordId: "d-100",
      username: "sam",
    });
    expect(result).toEqual({ success: true });
    expect(linkDiscordIdentity).toHaveBeenCalledWith("user-1", {
      discord_id: "d-100",
      discord_username: "sam",
      discord_global_name: null,
      discord_avatar_url: null,
    });
  });

  test("reports a concurrent uniqueness conflict as a real decline", async () => {
    linkDiscordIdentity.mockRejectedValue(
      Object.assign(new Error("duplicate key"), { code: "23505" }),
    );
    const result = await elizaAppUserService.linkDiscordToUser("user-1", {
      discordId: "d-100",
      username: "sam",
    });
    expect(result).toEqual({
      success: false,
      error: "This Discord account is already linked to another account",
    });
  });

  test("propagates atomic transaction infrastructure failures", async () => {
    linkDiscordIdentity.mockRejectedValue(new Error("connection terminated unexpectedly"));
    await expect(
      elizaAppUserService.linkDiscordToUser("user-1", {
        discordId: "d-100",
        username: "sam",
      }),
    ).rejects.toThrow("connection terminated unexpectedly");
  });
});
