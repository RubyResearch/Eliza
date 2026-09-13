import { beforeEach, expect, mock, test } from "bun:test";

const addCredits = mock(async () => ({ newBalance: 99 }));
const incrementReferrals = mock(async () => undefined);
const markBonusCredited = mock(async () => undefined);
const addSignupEarnings = mock(async () => undefined);
const addQualifiedEarnings = mock(async () => undefined);
const markQualified = mock(async () => true);
const createShare = mock(async () => ({ id: "share-1" }));
const markVerified = mock(async () => undefined);
const createSignup = mock(async () => ({ id: "signup-1" }));
const findSignup = mock(async (): Promise<{ referral_code_id: string } | undefined> => undefined);
mock.module("../../db/repositories/referrals", () => ({
  referralCodesRepository: {
    findByCode: async () => ({ id: "code-1", user_id: "referrer", is_active: true }),
    incrementReferrals,
    addSignupEarnings,
    addQualifiedEarnings,
  },
  referralSignupsRepository: {
    findByReferredUserId: findSignup,
    create: createSignup,
    markBonusCredited,
    findUnqualifiedByReferredUserId: async () => ({
      id: "signup-1",
      referrer_user_id: "referrer",
      referral_code_id: "code-1",
    }),
    markQualified,
  },
  socialShareRewardsRepository: {
    createIfNotClaimedToday: createShare,
    markVerified,
    hasClaimedToday: async () => false,
    getTotalEarnings: async () => 12.5,
  },
}));
mock.module("../../db/repositories/users", () => ({
  usersRepository: { findById: async () => ({ organization_id: "referrer-org" }) },
}));
mock.module("./credits", () => ({ creditsService: { addCredits } }));
mock.module("../utils/logger", () => ({ logger: { info() {}, warn() {}, error() {} } }));
const { referralsService, socialRewardsService, REWARDS } = await import("./referrals");

beforeEach(() => {
  for (const call of [
    addCredits,
    incrementReferrals,
    markBonusCredited,
    addSignupEarnings,
    addQualifiedEarnings,
    markQualified,
    createShare,
    markVerified,
    createSignup,
    findSignup,
  ]) {
    call.mockClear();
  }
  findSignup.mockResolvedValue(undefined);
});

test("unpaid referral records attribution without minting either organization's credit", async () => {
  expect(await referralsService.applyReferralCode("new-user", "new-org", "referral")).toMatchObject(
    {
      success: true,
      bonusAmount: 0,
    },
  );
  expect(createSignup).toHaveBeenCalledTimes(1);
  expect(incrementReferrals).toHaveBeenCalledWith("code-1");
  expect(addCredits).not.toHaveBeenCalled();
  expect(markBonusCredited).not.toHaveBeenCalled();
  expect(addSignupEarnings).not.toHaveBeenCalled();
});

test("repeated referral application preserves attribution without creating another signup", async () => {
  findSignup.mockResolvedValue({ referral_code_id: "code-1" });
  expect(await referralsService.applyReferralCode("new-user", "new-org", "referral")).toMatchObject(
    { success: true },
  );
  expect(createSignup).not.toHaveBeenCalled();
  expect(incrementReferrals).not.toHaveBeenCalled();
  expect(addCredits).not.toHaveBeenCalled();
});

test("social qualification cannot fund compute without a payment", async () => {
  expect(await referralsService.checkAndQualifyReferral("new-user")).toEqual({
    qualified: true,
    bonusAwarded: 0,
  });
  expect(markQualified).toHaveBeenCalledWith("signup-1", 0);
  expect(addCredits).not.toHaveBeenCalled();
  expect(addQualifiedEarnings).not.toHaveBeenCalled();
});

test("share clicks cannot mint credits or record a promised reward", async () => {
  for (const platform of ["x", "farcaster", "telegram", "discord"] as const) {
    expect(
      await socialRewardsService.claimShareReward("new-user", "new-org", platform, "invite_share"),
    ).toMatchObject({ success: false, amount: 0 });
  }
  expect(createShare).not.toHaveBeenCalled();
  expect(markVerified).not.toHaveBeenCalled();
  expect(addCredits).not.toHaveBeenCalled();
  expect(Object.values(REWARDS).every((amount) => amount === 0)).toBe(true);
});

test("current rewards show zero while historical earned amounts remain readable", async () => {
  const status = await socialRewardsService.getShareStatus("existing-user");
  expect(Object.values(status).every((reward) => reward.amount === 0)).toBe(true);
  expect(await socialRewardsService.getTotalEarnings("existing-user")).toBe(12.5);
});
