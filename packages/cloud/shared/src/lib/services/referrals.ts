/** Coordinates referral lookup and exact revenue-split calculation behind service callers. */
import * as crypto from "crypto";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import {
  type ReferralCode,
  type ReferralSignup,
  referralCodesRepository,
  referralSignupsRepository,
  type SocialShareReward,
  socialShareRewardsRepository,
} from "../../db/repositories/referrals";
import { usersRepository } from "../../db/repositories/users";
import { referralCodes, referralSignups } from "../../db/schemas/referrals";
import { logger } from "../utils/logger";

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);

    if (current instanceof Error) {
      const code = Reflect.get(current, "code");
      if (code === "23505") {
        return true;
      }

      const message = current.message.toLowerCase();
      if (
        message.includes("unique constraint") ||
        message.includes("duplicate key value violates unique constraint")
      ) {
        return true;
      }

      current = Reflect.get(current, "cause");
      continue;
    }

    if (typeof current === "object") {
      const code = Reflect.get(current, "code");
      if (code === "23505") {
        return true;
      }
      current = Reflect.get(current, "cause");
      continue;
    }

    break;
  }

  return false;
}

/**
 * Referral attribution, paid-purchase revenue splits and historical rewards.
 *
 * WHY two concepts in one module: Referral codes drive signups and tie revenue to
 * a 50/40/10 split on purchase. Historical social rewards remain readable, but
 * unpaid acquisition events no longer create credit.
 */

/**
 * Context for app-specific operations.
 * WHY appOwnerId/creatorId: When a user signs up via a miniapp or embed, we need to
 * attribute the 40% and 10% shares to the app owner and creator for calculateRevenueSplits.
 * App context does not authorize a signup or share credit grant.
 */
interface AppContext {
  appId?: string;
  appOwnerId?: string;
  creatorId?: string;
}

/**
 * Unpaid acquisition events never fund hosted compute. Referral attribution and
 * revenue splits on actual purchases remain available; signup, social linking
 * and share clicks grant no spendable credit. Historical earnings are retained.
 */
const REWARDS = {
  SIGNUP_BONUS: 0,
  REFERRED_BONUS: 0,
  QUALIFIED_BONUS: 0,
  SHARE_X: 0,
  SHARE_FARCASTER: 0,
  SHARE_TELEGRAM: 0,
  SHARE_DISCORD: 0,
} as const;

/**
 * Referral revenue split (must sum to 1.0). Used by calculateRevenueSplits.
 * WHY single source of truth: So we never over- or under-allocate; changing one
 * number without fixing the others would break the invariant. Assertions below
 * enforce 50+40+10=100% and 8+2=10% at startup.
 * - ELIZA_CLOUD: platform share
 * - APP_OWNER: app owner share (or ELIZA_CLOUD if no app_owner_id)
 * - CREATOR: creator share; with multi-tier this becomes CREATOR_TIER + EDITOR_TIER
 */
export const REFERRAL_REVENUE_SPLITS = {
  ELIZA_CLOUD: 0.5,
  APP_OWNER: 0.4,
  CREATOR: 0.1,
  /** Multi-tier: creator gets 8%, editor (parent) gets 2% of purchase */
  CREATOR_TIER: 0.08,
  EDITOR_TIER: 0.02,
} as const;

const SPLITS_TOTAL =
  REFERRAL_REVENUE_SPLITS.ELIZA_CLOUD +
  REFERRAL_REVENUE_SPLITS.APP_OWNER +
  REFERRAL_REVENUE_SPLITS.CREATOR;
if (Math.abs(SPLITS_TOTAL - 1) > 1e-9) {
  throw new Error(
    `Referral revenue splits must sum to 1.0 (got ${SPLITS_TOTAL}). Fix REFERRAL_REVENUE_SPLITS.`,
  );
}
const MULTI_TIER_TOTAL = REFERRAL_REVENUE_SPLITS.CREATOR_TIER + REFERRAL_REVENUE_SPLITS.EDITOR_TIER;
if (Math.abs(MULTI_TIER_TOTAL - REFERRAL_REVENUE_SPLITS.CREATOR) > 1e-9) {
  throw new Error(
    `Multi-tier creator split must equal CREATOR (${REFERRAL_REVENUE_SPLITS.CREATOR}); got ${MULTI_TIER_TOTAL}.`,
  );
}

/**
 * Social platform identifier.
 */
type SocialPlatform = "x" | "farcaster" | "telegram" | "discord";

/**
 * Share type identifier.
 */
type ShareType = "app_share" | "character_share" | "invite_share";

/**
 * Generates a unique referral code for a user.
 *
 * @param userId - User ID.
 * @returns Referral code string.
 */
function generateReferralCode(userId: string): string {
  const prefix = userId.substring(0, 4).toUpperCase();
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${random}`;
}

/**
 * Service for managing referral programs and social sharing rewards.
 */
export class ReferralsService {
  /**
   * Ensures the user has exactly one `referral_codes` row (generated string).
   * Exposed to HTTP clients via GET `/api/v1/referrals`. WHY idempotent create here: Dashboard can
   * call repeatedly from header + Affiliates without a separate "create code" mutation.
   *
   * Concurrency: `user_id` is UNIQUE; two parallel first-time callers may both miss `findByUserId`
   * and one INSERT can hit 23505—handled by re-fetching by `user_id` and retrying code generation.
   */
  async getOrCreateCode(userId: string): Promise<ReferralCode> {
    const existing = await referralCodesRepository.findByUserId(userId);
    if (existing) return existing;

    let attempts = 0;

    while (attempts < 10) {
      const code = generateReferralCode(userId);
      const existingCode = await referralCodesRepository.findByCode(code);
      if (existingCode) {
        attempts++;
        continue;
      }

      try {
        return await referralCodesRepository.create({
          user_id: userId,
          code,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const concurrentCode = await referralCodesRepository.findByUserId(userId);
          if (concurrentCode) {
            return concurrentCode;
          }
          attempts++;
          continue;
        }
        throw error;
      }
    }

    throw new Error("Failed to generate a unique referral code");
  }

  async getCodeByUser(userId: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByUserId(userId);
  }

  async findByCode(code: string): Promise<ReferralCode | null> {
    return referralCodesRepository.findByCode(code.trim().toUpperCase());
  }

  async applyReferralCode(
    referredUserId: string,
    _organizationId: string,
    code: string,
    appContext?: AppContext,
  ): Promise<{ success: boolean; message: string; bonusAmount?: number }> {
    const normalizedCode = code.trim().toUpperCase();

    const existingSignup = await referralSignupsRepository.findByReferredUserId(referredUserId);
    if (existingSignup) {
      const existingCode = await referralCodesRepository.findByCode(normalizedCode);
      if (existingCode && existingSignup.referral_code_id === existingCode.id) {
        return { success: true, message: "Referral code already applied" };
      }
      return { success: false, message: "Already used a referral code" };
    }

    const referralCode = await referralCodesRepository.findByCode(normalizedCode);
    if (!referralCode) {
      return { success: false, message: "Invalid referral code" };
    }

    if (!referralCode.is_active) {
      return { success: false, message: "Referral code is no longer active" };
    }

    if (referralCode.user_id === referredUserId) {
      return { success: false, message: "Cannot use your own referral code" };
    }

    // Prevent self-referral abuse via app owner revenue share
    if (appContext?.appOwnerId === referredUserId) {
      return {
        success: false,
        message: "Cannot claim app owner revenue from your own purchase",
      };
    }

    // Require a valid referrer organization for attribution.
    const referrer = await usersRepository.findById(referralCode.user_id);
    if (!referrer?.organization_id) {
      logger.warn("[Referrals] Referrer has no organization", {
        referrerId: referralCode.user_id,
      });
      return { success: false, message: "Referral code is invalid" };
    }

    // Create the signup record
    try {
      await referralSignupsRepository.create({
        referral_code_id: referralCode.id,
        referrer_user_id: referralCode.user_id,
        referred_user_id: referredUserId,
        app_owner_id: appContext?.appOwnerId || null,
        creator_id: appContext?.creatorId || referralCode.user_id,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrentSignup =
          await referralSignupsRepository.findByReferredUserId(referredUserId);
        if (concurrentSignup?.referral_code_id === referralCode.id) {
          return { success: true, message: "Referral code already applied" };
        }
        return { success: false, message: "Already used a referral code" };
      }
      throw error;
    }

    // Attribution is independent of funding. Do not mint credit or record an
    // awarded bonus merely because another account supplied a referral code.
    await referralCodesRepository.incrementReferrals(referralCode.id);

    logger.info("[Referrals] Referral code applied", {
      referredUserId,
      referrerId: referralCode.user_id,
      code: normalizedCode,
      referredBonus: REWARDS.REFERRED_BONUS,
      referrerBonus: REWARDS.SIGNUP_BONUS,
      appId: appContext?.appId,
    });

    return {
      success: true,
      message: "Referral code applied. Add funds to use hosted agents.",
      bonusAmount: REWARDS.REFERRED_BONUS,
    };
  }

  /**
   * Calculates the revenue splits for a purchase based on the 50/40/10 structure
   * and multi-tier "referrals of referrals" logic.
   * WHY assert total === purchaseAmount: Prevents logic bugs (e.g. missing branch)
   * from silently over- or under-paying; fail fast instead of wrong payouts.
   */
  async calculateRevenueSplits(
    userId: string,
    purchaseAmount: number,
    transaction?: DbTransaction,
  ): Promise<{
    elizaCloudAmount: number;
    splits: Array<{
      userId: string;
      role: "app_owner" | "creator" | "editor";
      amount: number;
    }>;
  }> {
    const exact = await this.calculateRevenueSplitsExact(
      userId,
      new Decimal(purchaseAmount).toFixed(),
      transaction,
    );
    return {
      elizaCloudAmount: Number(exact.elizaCloudAmount),
      splits: exact.splits.map((split) => ({ ...split, amount: Number(split.amount) })),
    };
  }

  /** Exact-decimal split used by settlement code before any provider amount reaches SQL. */
  async calculateRevenueSplitsExact(
    userId: string,
    purchaseAmount: string,
    transaction?: DbTransaction,
  ): Promise<{
    elizaCloudAmount: string;
    splits: Array<{
      userId: string;
      role: "app_owner" | "creator" | "editor";
      amount: string;
    }>;
  }> {
    const providerAmount = new Decimal(purchaseAmount);
    if (!providerAmount.isFinite() || !providerAmount.gt(0)) {
      throw new Error("Referral revenue split purchase amount must be positive");
    }
    // Settlement ledgers are six-decimal. Provider dust below that boundary is
    // retained on the payment audit row, never manufactured into a float or a
    // payout that the ledger cannot represent.
    const amount = providerAmount.toDecimalPlaces(6);
    const signup = transaction
      ? (
          await transaction
            .select()
            .from(referralSignups)
            .where(eq(referralSignups.referred_user_id, userId))
            .limit(1)
        )[0]
      : await referralSignupsRepository.findByReferredUserId(userId);

    // Default: 100% to ElizaCloud if no referrer
    if (!signup) {
      return { elizaCloudAmount: amount.toFixed(6), splits: [] };
    }

    const { APP_OWNER, CREATOR, CREATOR_TIER, EDITOR_TIER } = REFERRAL_REVENUE_SPLITS;
    const ledgerShare = (ratio: number) =>
      amount.mul(ratio).toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6);
    const appOwnerAmount = ledgerShare(APP_OWNER);
    const baseCreatorAmount = ledgerShare(CREATOR);

    const splits: Array<{
      userId: string;
      role: "app_owner" | "creator" | "editor";
      amount: string;
    }> = [];

    if (signup.app_owner_id) {
      splits.push({
        userId: signup.app_owner_id,
        role: "app_owner",
        amount: appOwnerAmount,
      });
    }

    const creatorId = signup.creator_id || signup.referrer_user_id;

    const referralCode = transaction
      ? (
          await transaction
            .select()
            .from(referralCodes)
            .where(eq(referralCodes.id, signup.referral_code_id))
            .limit(1)
        )[0]
      : await referralCodesRepository.findById(signup.referral_code_id);
    if (referralCode && referralCode.parent_referral_id) {
      const parentCode = transaction
        ? (
            await transaction
              .select()
              .from(referralCodes)
              .where(eq(referralCodes.id, referralCode.parent_referral_id))
              .limit(1)
          )[0]
        : await referralCodesRepository.findById(referralCode.parent_referral_id);
      if (parentCode) {
        splits.push({
          userId: creatorId,
          role: "creator",
          amount: ledgerShare(CREATOR_TIER),
        });
        splits.push({
          userId: parentCode.user_id,
          role: "editor",
          amount: ledgerShare(EDITOR_TIER),
        });
      } else {
        splits.push({
          userId: creatorId,
          role: "creator",
          amount: baseCreatorAmount,
        });
      }
    } else {
      splits.push({
        userId: creatorId,
        role: "creator",
        amount: baseCreatorAmount,
      });
    }

    const splitsSum = splits.reduce((sum, split) => sum.add(split.amount), new Decimal(0));
    const elizaCloudAmount = amount.minus(splitsSum);
    if (elizaCloudAmount.isNegative()) {
      throw new Error("Referral revenue splits exceed the quantized settlement amount");
    }

    return { elizaCloudAmount: elizaCloudAmount.toFixed(6), splits };
  }

  async getReferralStats(userId: string): Promise<{
    code: string | null;
    totalReferrals: number;
    totalEarnings: number;
    signupEarnings: number;
    qualifiedEarnings: number;
    commissionEarnings: number;
    recentReferrals: ReferralSignup[];
  }> {
    // PERFORMANCE: Fetch code and recent referrals in parallel
    const [referralCode, recentReferrals] = await Promise.all([
      referralCodesRepository.findByUserId(userId),
      referralSignupsRepository.listByReferrerId(userId, 10),
    ]);

    if (!referralCode) {
      return {
        code: null,
        totalReferrals: 0,
        totalEarnings: 0,
        signupEarnings: 0,
        qualifiedEarnings: 0,
        commissionEarnings: 0,
        recentReferrals: [],
      };
    }

    return {
      code: referralCode.code,
      totalReferrals: referralCode.total_referrals,
      totalEarnings:
        Number(referralCode.total_signup_earnings) +
        Number(referralCode.total_qualified_earnings) +
        Number(referralCode.total_commission_earnings),
      signupEarnings: Number(referralCode.total_signup_earnings),
      qualifiedEarnings: Number(referralCode.total_qualified_earnings),
      commissionEarnings: Number(referralCode.total_commission_earnings),
      recentReferrals,
    };
  }

  /**
   * Check and qualify a referral when the referred user links a social account.
   * Retains qualification attribution without awarding unpaid credit.
   *
   * Call this when a user links Farcaster, Twitter, or a wallet.
   */
  async checkAndQualifyReferral(
    referredUserId: string,
  ): Promise<{ qualified: boolean; bonusAwarded?: number }> {
    // Find unqualified referral for this user
    const signup = await referralSignupsRepository.findUnqualifiedByReferredUserId(referredUserId);

    if (!signup) {
      return { qualified: false };
    }

    // Require a valid referrer organization for qualification attribution.
    const referrer = await usersRepository.findById(signup.referrer_user_id);
    if (!referrer?.organization_id) {
      logger.warn("[Referrals] Referrer has no organization for qualification", {
        referrerId: signup.referrer_user_id,
      });
      return { qualified: false };
    }

    const marked = await referralSignupsRepository.markQualified(
      signup.id,
      REWARDS.QUALIFIED_BONUS,
    );
    if (!marked) {
      return { qualified: false };
    }

    logger.info("[Referrals] Referral qualified", {
      referredUserId,
      referrerId: signup.referrer_user_id,
      bonus: REWARDS.QUALIFIED_BONUS,
    });

    return { qualified: true, bonusAwarded: REWARDS.QUALIFIED_BONUS };
  }
}

export class SocialRewardsService {
  /**
   * Sharing is not payment and cannot create spendable credit. Keep the public
   * response boundary for existing clients, with no reward record or ledger write.
   */
  async claimShareReward(
    _userId: string,
    _organizationId: string,
    _platform: SocialPlatform,
    _shareType: ShareType,
    _shareUrl?: string,
    _appContext?: AppContext,
  ): Promise<{
    success: boolean;
    message: string;
    amount?: number;
    alreadyAwarded?: boolean;
  }> {
    return {
      success: false,
      message: "Share credit rewards are unavailable. Add funds to use hosted agents.",
      amount: 0,
      alreadyAwarded: false,
    };
  }

  async getShareStatus(
    userId: string,
  ): Promise<Record<SocialPlatform, { claimed: boolean; amount: number }>> {
    const platforms: SocialPlatform[] = ["x", "farcaster", "telegram", "discord"];

    // PERFORMANCE: Check all platforms in parallel instead of sequential loop
    const claimedStatuses = await Promise.all(
      platforms.map((platform) => socialShareRewardsRepository.hasClaimedToday(userId, platform)),
    );

    return {
      x: { claimed: claimedStatuses[0], amount: REWARDS.SHARE_X },
      farcaster: {
        claimed: claimedStatuses[1],
        amount: REWARDS.SHARE_FARCASTER,
      },
      telegram: { claimed: claimedStatuses[2], amount: REWARDS.SHARE_TELEGRAM },
      discord: { claimed: claimedStatuses[3], amount: REWARDS.SHARE_DISCORD },
    };
  }

  async getTotalEarnings(userId: string): Promise<number> {
    return socialShareRewardsRepository.getTotalEarnings(userId);
  }

  async getRewardHistory(userId: string, limit = 50): Promise<SocialShareReward[]> {
    return socialShareRewardsRepository.listByUserId(userId, limit);
  }
}

export const referralsService = new ReferralsService();
export const socialRewardsService = new SocialRewardsService();

export { REWARDS };
