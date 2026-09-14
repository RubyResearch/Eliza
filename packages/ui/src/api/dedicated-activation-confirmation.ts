import { ElizaError } from "@elizaos/core";

export interface DedicatedActivationConfirmationQuote {
  quoteId: string;
  sourceAgentId: string;
  hourlyRateUsd: number;
  minimumActivationChargeUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  canActivate: true;
  requiresConfirmation: true;
  action: "activate_dedicated";
}

export type DedicatedActivationConfirmationRequester = (
  quote: DedicatedActivationConfirmationQuote,
  context: { signal?: AbortSignal },
) => Promise<{ action: "activate_dedicated"; quoteId: string } | null>;

function isFiniteAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate the terms that the UI must show before starting billable compute. */
export function parseDedicatedActivationConfirmationQuote(
  value: Record<string, unknown>,
  sourceAgentId: string,
): DedicatedActivationConfirmationQuote {
  if (
    typeof value.quoteId !== "string" ||
    !value.quoteId.trim() ||
    value.sourceAgentId !== sourceAgentId ||
    value.action !== "activate_dedicated" ||
    value.requiresConfirmation !== true ||
    value.canActivate !== true ||
    !isFiniteAmount(value.hourlyRateUsd) ||
    !isFiniteAmount(value.minimumActivationChargeUsd) ||
    value.minimumActivationChargeUsd < 0 ||
    !isFiniteAmount(value.dailyRateUsd) ||
    !isFiniteAmount(value.minimumBalanceUsd) ||
    !isFiniteAmount(value.minimumRunwayDays) ||
    !isFiniteAmount(value.balanceUsd) ||
    !isFiniteAmount(value.deficitUsd)
  ) {
    throw new ElizaError(
      "Cloud returned an incomplete Dedicated hosting quote. Try again.",
      {
        code: "CLOUD_DEDICATED_ACTIVATION_QUOTE_INVALID",
        context: { phase: "activation-confirmation" },
      },
    );
  }
  return {
    quoteId: value.quoteId,
    sourceAgentId,
    hourlyRateUsd: value.hourlyRateUsd,
    minimumActivationChargeUsd: value.minimumActivationChargeUsd,
    dailyRateUsd: value.dailyRateUsd,
    minimumBalanceUsd: value.minimumBalanceUsd,
    minimumRunwayDays: value.minimumRunwayDays,
    balanceUsd: value.balanceUsd,
    deficitUsd: value.deficitUsd,
    canActivate: true,
    requiresConfirmation: true,
    action: "activate_dedicated",
  };
}

export async function confirmDedicatedActivation(
  quote: DedicatedActivationConfirmationQuote,
  request: DedicatedActivationConfirmationRequester | undefined,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!request) {
    throw new ElizaError(
      "Review Dedicated hosting and confirm before starting your agent.",
      {
        code: "CLOUD_DEDICATED_ACTIVATION_CONFIRMATION_REQUIRED",
        context: { phase: "activation-confirmation" },
      },
    );
  }
  const decision = await request(quote, { ...(signal ? { signal } : {}) });
  signal?.throwIfAborted();
  if (decision?.action !== quote.action || decision.quoteId !== quote.quoteId) {
    throw new ElizaError("Dedicated setup was not started.", {
      code: "CLOUD_DEDICATED_ACTIVATION_NOT_CONFIRMED",
      context: { phase: "activation-confirmation" },
    });
  }
}
