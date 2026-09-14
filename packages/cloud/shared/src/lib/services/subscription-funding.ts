/**
 * Allocates metered charges across subscription allowance and purchased
 * credits in one organization-scoped transaction, then returns refunds to the
 * exact source that funded the reservation.
 */
import { ElizaError } from "@elizaos/core";
import { and, eq } from "drizzle-orm";
import type { DbTransaction } from "../../db/client";
import { writeTransaction } from "../../db/helpers";
import { readPostLockDatabaseNow } from "../../db/repositories/primary-database-clock";
import { subscriptionAllowanceRepository } from "../../db/repositories/subscription-allowance";
import { readEligibleSubscriptionAllowance } from "../../db/repositories/subscription-allowance-eligibility";
import {
  type CanonicalMoney,
  microsToMoney,
  moneyToMicros,
  subscriptionFundingReservationsRepository,
} from "../../db/repositories/subscription-funding-reservations";
import {
  type BillingFundingReservation,
  billingFundingAllocations,
  billingFundingReservations,
} from "../../db/schemas/billing-funding-reservations";
import { organizations } from "../../db/schemas/organizations";
import { creditsService } from "./credits";
import {
  SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION,
  SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN,
  type SubscriptionFundingOperation,
} from "./subscription-funding-policy";

export const SUBSCRIPTION_FUNDING_INVALID_AMOUNT = "SUBSCRIPTION_FUNDING_INVALID_AMOUNT";
export const SUBSCRIPTION_FUNDING_INSUFFICIENT = "SUBSCRIPTION_FUNDING_INSUFFICIENT";
export const SUBSCRIPTION_FUNDING_REPLAY_CONFLICT = "SUBSCRIPTION_FUNDING_REPLAY_CONFLICT";
export const SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND =
  "SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND";

interface ReserveSubscriptionFundingBaseInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  amount: string;
  description: string;
  metadata?: Record<string, unknown>;
}

export type ReserveSubscriptionFundingInput = ReserveSubscriptionFundingBaseInput &
  ({ expiresAt: Date; reservationTtlMs?: never } | { expiresAt?: never; reservationTtlMs: number });

export interface SettleSubscriptionFundingInput {
  organizationId: string;
  logicalOperationId: string;
  operation: SubscriptionFundingOperation;
  actualAmount: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export interface SubscriptionFundingReservationResult {
  reservation: BillingFundingReservation;
  replayed: boolean;
}

export interface TransactionalFundingReservationResult
  extends SubscriptionFundingReservationResult {
  /** The transaction owner must invalidate credit caches after committing this debit. */
  purchasedCreditDebited: boolean;
}

export interface SubscriptionFundingSettlementResult extends SubscriptionFundingReservationResult {
  collectedAmount: CanonicalMoney;
  uncollectedOverageAmount: CanonicalMoney;
}

export interface FundingSourceSplit {
  allowanceAmount: CanonicalMoney;
  purchasedCreditAmount: CanonicalMoney;
}

/** Returns the exact allowance-first split used by the transactional writer. */
export function splitSubscriptionFundingSources(params: {
  requestedAmount: CanonicalMoney;
  availableAllowance: CanonicalMoney;
  fundingClass: "allowance_eligible" | "cash_only";
}): FundingSourceSplit {
  const requested = moneyToMicros(params.requestedAmount, "requestedAmount");
  const available = moneyToMicros(params.availableAllowance, "availableAllowance");
  const allowance =
    params.fundingClass === "allowance_eligible"
      ? requested < available
        ? requested
        : available
      : 0n;
  return {
    allowanceAmount: microsToMoney(allowance),
    purchasedCreditAmount: microsToMoney(requested - allowance),
  };
}

export function capSubscriptionFundingSettlement(params: {
  requestedActualAmount: CanonicalMoney;
  reservedAmount: CanonicalMoney;
}): { collectedAmount: CanonicalMoney; uncollectedOverageAmount: CanonicalMoney } {
  const requested = moneyToMicros(params.requestedActualAmount, "requestedActualAmount");
  const reserved = moneyToMicros(params.reservedAmount, "reservedAmount");
  const collected = requested < reserved ? requested : reserved;
  return {
    collectedAmount: microsToMoney(collected),
    uncollectedOverageAmount: microsToMoney(requested - collected),
  };
}

function fundingError(code: string, message: string, context: Record<string, unknown>): never {
  throw new ElizaError(message, { code, context, severity: "fatal" });
}

function canonicalMoney(value: string, field: string, allowZero: boolean): CanonicalMoney {
  const micros = moneyToMicros(value, field);
  if (!allowZero && micros === 0n) {
    fundingError(SUBSCRIPTION_FUNDING_INVALID_AMOUNT, "Funding amount must be positive", { field });
  }
  return microsToMoney(micros, field);
}

async function requestDigest(parts: readonly string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\u001f"));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateOperationId(value: string): void {
  if (!SUBSCRIPTION_FUNDING_LOGICAL_OPERATION_KEY_PATTERN.test(value)) {
    fundingError(
      SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
      "Subscription funding logical operation id is invalid",
      { keyLength: value.length },
    );
  }
}

async function lockOrganization(tx: DbTransaction, organizationId: string): Promise<void> {
  const [row] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
    .for("update");
  if (!row) {
    fundingError(
      SUBSCRIPTION_FUNDING_ORGANIZATION_NOT_FOUND,
      "Subscription funding organization does not exist",
      { organizationId },
    );
  }
}

function reservationExpiry(input: ReserveSubscriptionFundingInput, now: Date): Date {
  if (input.expiresAt) return input.expiresAt;
  if (!Number.isFinite(input.reservationTtlMs) || input.reservationTtlMs <= 0) {
    fundingError(
      SUBSCRIPTION_FUNDING_INVALID_AMOUNT,
      "Subscription funding reservation TTL must be positive",
      {},
    );
  }
  return new Date(now.getTime() + input.reservationTtlMs);
}

async function findReservation(
  tx: DbTransaction,
  organizationId: string,
  logicalOperationId: string,
): Promise<BillingFundingReservation> {
  const [reservation] = await tx
    .select()
    .from(billingFundingReservations)
    .where(
      and(
        eq(billingFundingReservations.organization_id, organizationId),
        eq(billingFundingReservations.logical_operation_id, logicalOperationId),
      ),
    )
    .limit(1);
  if (!reservation) {
    fundingError(SUBSCRIPTION_FUNDING_REPLAY_CONFLICT, "Funding reservation was not found", {
      organizationId,
      logicalOperationId,
    });
  }
  return reservation;
}

export class SubscriptionFundingService {
  async reserve(
    input: ReserveSubscriptionFundingInput,
  ): Promise<SubscriptionFundingReservationResult> {
    const result = await writeTransaction((tx) => this.reserveInTransaction(tx, input));
    if (result.purchasedCreditDebited) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return { reservation: result.reservation, replayed: result.replayed };
  }

  /**
   * Binds a reservation to its caller's durable work admission. The caller
   * owns workload locks before this method takes the organization lock, and
   * must invalidate credit caches after commit when purchasedCreditDebited is
   * true. A rejected admission rolls back its funding in the same transaction.
   */
  async reserveInTransaction(
    tx: DbTransaction,
    input: ReserveSubscriptionFundingInput,
  ): Promise<TransactionalFundingReservationResult> {
    validateOperationId(input.logicalOperationId);
    const requestedAmount = canonicalMoney(input.amount, "amount", false);
    const digest = await requestDigest([
      "reserve",
      input.organizationId,
      input.logicalOperationId,
      input.operation,
      requestedAmount,
    ]);
    let purchasedDebit = false;
    // Cash-only reservations never enter the allowance repository, so this is their sole organization lock.
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const fundingClass = SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation];
    // Replay is pinned to the original allocation, even after its period or source changes.
    const [existing] = await tx
      .select()
      .from(billingFundingReservations)
      .where(
        and(
          eq(billingFundingReservations.organization_id, input.organizationId),
          eq(billingFundingReservations.logical_operation_id, input.logicalOperationId),
        ),
      )
      .for("update");
    if (existing) {
      if (
        existing.request_digest !== digest ||
        existing.requested_amount !== requestedAmount ||
        existing.funding_class !== fundingClass
      )
        fundingError(
          SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
          "Reservation replay differs from its immutable request",
          { organizationId: input.organizationId },
        );
      const [allowanceAllocation] = await tx
        .select({ id: billingFundingAllocations.id })
        .from(billingFundingAllocations)
        .where(
          and(
            eq(billingFundingAllocations.reservation_id, existing.id),
            eq(billingFundingAllocations.source, "allowance"),
          ),
        );
      if (!allowanceAllocation) {
        const requestedExpiry = reservationExpiry(input, now);
        if (
          !Number.isFinite(requestedExpiry.getTime()) ||
          (input.expiresAt && existing.expires_at.getTime() !== input.expiresAt.getTime())
        )
          fundingError(
            SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
            "Reservation replay changes or invalidates its expiry",
            { organizationId: input.organizationId },
          );
      }
      return { reservation: existing, replayed: true, purchasedCreditDebited: false };
    }
    let period: Awaited<ReturnType<typeof readEligibleSubscriptionAllowance>> | undefined;
    if (fundingClass === "allowance_eligible") {
      period = await readEligibleSubscriptionAllowance(tx, input.organizationId, now, true);
    }
    const split = splitSubscriptionFundingSources({
      requestedAmount,
      availableAllowance: period
        ? canonicalMoney(period.available_amount, "period.availableAmount", true)
        : microsToMoney(0n),
      fundingClass,
    });
    const allowance = moneyToMicros(split.allowanceAmount, "allowanceAmount");
    const purchased = moneyToMicros(split.purchasedCreditAmount, "purchasedCreditAmount");
    let purchasedTransactionId: string | null = null;
    if (purchased > 0n) {
      const debit = await creditsService.reserveAndDeductCredits({
        organizationId: input.organizationId,
        amount: Number(microsToMoney(purchased)),
        description: `${input.description} (purchased credit reservation)`,
        metadata: input.metadata,
        stripePaymentIntentId: `subscription-funding:reserve:${digest}`,
        db: tx,
        deferPostCommitEffects: true,
      });
      if (!debit.success || !debit.transaction) {
        fundingError(
          SUBSCRIPTION_FUNDING_INSUFFICIENT,
          "Subscription allowance and purchased credits are insufficient",
          { organizationId: input.organizationId, requestedAmount },
        );
      }
      purchasedTransactionId = debit.transaction.id;
      purchasedDebit = !debit.transaction.settled_at;
    }
    const common = {
      organizationId: input.organizationId,
      logicalOperationId: input.logicalOperationId,
      requestDigest: digest,
      requestedAmount,
      allowanceAmount: microsToMoney(allowance),
      purchasedCreditAmount: microsToMoney(purchased),
      purchasedCreditReservationTransactionId: purchasedTransactionId,
    };
    const authority =
      period && allowance > 0n
        ? await subscriptionAllowanceRepository.reserve(tx, { ...common, periodId: period.id })
        : await subscriptionFundingReservationsRepository.createPrerequisite(tx, {
            ...common,
            fundingClass,
            allowancePeriodId: null,
            expiresAt: reservationExpiry(input, now),
          });
    return {
      reservation: authority.reservation,
      replayed: authority.replayed,
      purchasedCreditDebited: purchasedDebit && !authority.replayed,
    };
  }

  async settle(
    input: SettleSubscriptionFundingInput,
  ): Promise<SubscriptionFundingSettlementResult> {
    const result = await writeTransaction((tx) => this.settleInTransaction(tx, input));
    if (result.purchasedCreditRefunded) {
      await creditsService.invalidateCreditCaches(input.organizationId);
    }
    return {
      reservation: result.reservation,
      replayed: result.replayed,
      collectedAmount: result.collectedAmount,
      uncollectedOverageAmount: result.uncollectedOverageAmount,
    };
  }

  /**
   * Settles a pinned reservation in the caller's work-completion transaction.
   * The caller takes workload locks first and invalidates credit caches only
   * after commit when purchasedCreditRefunded is true.
   */
  async settleInTransaction(
    tx: DbTransaction,
    input: SettleSubscriptionFundingInput,
  ): Promise<SubscriptionFundingSettlementResult & { purchasedCreditRefunded: boolean }> {
    validateOperationId(input.logicalOperationId);
    const actualAmount = canonicalMoney(input.actualAmount, "actualAmount", true);
    const digest = await requestDigest([
      "settle",
      input.organizationId,
      input.logicalOperationId,
      input.operation,
      actualAmount,
      input.occurredAt.toISOString(),
    ]);
    let purchasedMutation = false;
    await lockOrganization(tx, input.organizationId);
    const now = await readPostLockDatabaseNow(tx);
    const reservation = await findReservation(tx, input.organizationId, input.logicalOperationId);
    if (reservation.funding_class !== SUBSCRIPTION_FUNDING_CLASS_BY_OPERATION[input.operation]) {
      fundingError(
        SUBSCRIPTION_FUNDING_REPLAY_CONFLICT,
        "Settlement operation does not match its reservation policy",
        { logicalOperationId: input.logicalOperationId },
      );
    }
    const locked = await subscriptionFundingReservationsRepository.lockById(
      tx,
      input.organizationId,
      reservation.id,
    );
    const allowanceAllocation = locked.allocations.find((row) => row.source === "allowance");
    const purchasedAllocation = locked.allocations.find((row) => row.source === "purchased_credit");
    const allowanceReserved = allowanceAllocation
      ? moneyToMicros(allowanceAllocation.reserved_amount, "allowanceReserved")
      : 0n;
    const purchasedReserved = purchasedAllocation
      ? moneyToMicros(purchasedAllocation.reserved_amount, "purchasedReserved")
      : 0n;
    const reserved = allowanceReserved + purchasedReserved;
    const settlementCap = capSubscriptionFundingSettlement({
      requestedActualAmount: actualAmount,
      reservedAmount: microsToMoney(reserved),
    });
    const collected = moneyToMicros(settlementCap.collectedAmount, "collectedAmount");
    const uncollectedOverage = moneyToMicros(
      settlementCap.uncollectedOverageAmount,
      "uncollectedOverageAmount",
    );
    const actualAllowance = collected < allowanceReserved ? collected : allowanceReserved;
    const actualPurchased = collected - actualAllowance;
    let refundId: string | null = null;
    if (purchasedReserved > actualPurchased) {
      const refund = await creditsService.refundCredits({
        organizationId: input.organizationId,
        amount: microsToMoney(purchasedReserved - actualPurchased),
        description: "Subscription funding purchased-credit refund",
        metadata: input.metadata,
        stripePaymentIntentId: `subscription-funding:refund:${digest}`,
        db: tx,
        deferCacheInvalidation: true,
      });
      refundId = refund.transaction.id;
      purchasedMutation = true;
    }
    const terminalInput = {
      organizationId: input.organizationId,
      reservationId: reservation.id,
      idempotencyKey: `settle.${digest}`,
      requestDigest: digest,
      actualAllowanceAmount: microsToMoney(actualAllowance),
      actualPurchasedCreditAmount: microsToMoney(actualPurchased),
      uncollectedOverageAmount: microsToMoney(uncollectedOverage),
      purchasedCreditSettlementTransactionId:
        actualPurchased > 0n
          ? (purchasedAllocation?.purchased_credit_reservation_transaction_id ?? null)
          : null,
      purchasedCreditRefundTransactionId: refundId,
    };
    if (allowanceAllocation) {
      const terminal = await subscriptionAllowanceRepository.finalize(tx, terminalInput);
      return {
        reservation: terminal.reservation,
        replayed: terminal.replayed,
        purchasedCreditRefunded: purchasedMutation && !terminal.replayed,
        collectedAmount: microsToMoney(collected),
        uncollectedOverageAmount: microsToMoney(uncollectedOverage),
      };
    }
    const terminal = await subscriptionFundingReservationsRepository.persistTerminal(tx, locked, {
      kind: "settlement",
      key: terminalInput.idempotencyKey,
      digest,
      actualAllowanceAmount: terminalInput.actualAllowanceAmount,
      actualPurchasedCreditAmount: terminalInput.actualPurchasedCreditAmount,
      uncollectedOverageAmount: terminalInput.uncollectedOverageAmount,
      allowanceExpired: false,
      purchasedCreditSettlementTransactionId: terminalInput.purchasedCreditSettlementTransactionId,
      purchasedCreditRefundTransactionId: refundId,
      databaseNow: now,
    });
    return {
      reservation: terminal.reservation,
      replayed: terminal.replayed,
      purchasedCreditRefunded: purchasedMutation && !terminal.replayed,
      collectedAmount: microsToMoney(collected),
      uncollectedOverageAmount: microsToMoney(uncollectedOverage),
    };
  }
}

export const subscriptionFundingService = new SubscriptionFundingService();
