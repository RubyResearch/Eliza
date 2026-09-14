/** Shares funded runtime limits between the transactional billing authority and the independent host guard. */

export const AGENT_COMPUTE_FUNDING_WINDOW_MS = 2 * 60 * 60_000;
export const AGENT_COMPUTE_STOP_MARGIN_MS = 60_000;
/** Leave capture and stop time before the independent host guard revokes compute. */
export const AGENT_COMPUTE_RETIREMENT_LEAD_MS = 2 * AGENT_COMPUTE_STOP_MARGIN_MS;
export const AGENT_COMPUTE_AUTH_CLOCK_SKEW_MS = 10_000;
