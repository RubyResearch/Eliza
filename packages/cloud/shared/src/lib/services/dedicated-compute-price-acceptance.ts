/** Blocks stale clients before a new paid start, without changing no-op or Shared requests. */
import {
  AGENT_PRICING,
  DEDICATED_COMPUTE_PRICE_HEADER,
  getDedicatedComputePriceAcceptance,
} from "@elizaos/cloud-sdk/browser-contracts";

export function requireDedicatedComputePriceAcceptance(request: Request): Response | null {
  const accepted = request.headers.get(DEDICATED_COMPUTE_PRICE_HEADER);
  const current = getDedicatedComputePriceAcceptance();
  if (accepted === current) return null;
  return Response.json(
    {
      success: false,
      code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
      error:
        "Refresh the app and review the current Dedicated price before starting. No compute was started.",
      pricing: {
        currency: "USD",
        hourlyRateUsd: AGENT_PRICING.RUNNING_HOURLY_RATE,
        minimumActivationChargeUsd: AGENT_PRICING.MINIMUM_ACTIVATION_CHARGE,
        acceptanceHeader: DEDICATED_COMPUTE_PRICE_HEADER,
        acceptanceValue: current,
      },
    },
    { status: 428 },
  );
}
