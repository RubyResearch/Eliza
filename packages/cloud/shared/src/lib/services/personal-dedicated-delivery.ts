/**
 * Prepares an authoritative personal Dedicated runtime for a connector turn.
 *
 * Connector delivery may arrive while paid compute is stopped or sleeping.
 * Delivery may use an already-running runtime, but cannot authorize a new
 * paid session. Stopped targets require price review in the Eliza app.
 */

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";

export const PERSONAL_DEDICATED_RETRY_AFTER_SECONDS = 5;

export type PersonalDedicatedDeliveryPreparation =
  | { state: "ready" }
  | {
      state: "unavailable";
      code:
        | "dedicated_starting"
        | "dedicated_state_unavailable"
        | "DEDICATED_PRICE_CONFIRMATION_REQUIRED";
      error: string;
      retryable: boolean;
      status: 428 | 503;
      retryAfterSeconds?: number;
    };

/**
 * Return ready only for a running runtime. Stopped and sleeping targets keep
 * their server-owned cutover authority without creating a job or reopening
 * Shared. The owner must explicitly start another paid session in the app.
 */
export async function preparePersonalDedicatedDelivery(
  target: Pick<AgentSandbox, "id" | "status">,
): Promise<PersonalDedicatedDeliveryPreparation> {
  if (target.status === "running") return { state: "ready" };

  if (target.status === "pending" || target.status === "provisioning") {
    return {
      state: "unavailable",
      code: "dedicated_starting",
      error: "Dedicated Eliza is still starting.",
      retryable: true,
      status: 503,
      retryAfterSeconds: PERSONAL_DEDICATED_RETRY_AFTER_SECONDS,
    };
  }

  if (target.status !== "stopped" && target.status !== "sleeping") {
    return {
      state: "unavailable",
      code: "dedicated_state_unavailable",
      error: "Dedicated Eliza is temporarily unavailable.",
      retryable: false,
      status: 503,
    };
  }

  return {
    state: "unavailable",
    code: "DEDICATED_PRICE_CONFIRMATION_REQUIRED",
    error: "Open Eliza to review the current price and start your Dedicated agent.",
    retryable: false,
    status: 428,
  };
}
