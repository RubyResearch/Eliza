/** Provider retry metadata shared by transport retries and durable memory jobs.
 * Only structural status/header fields establish a deadline; prose never does.
 */
/**
 * Read the provider's retry delay once for both retry admission and cooldowns.
 * The millisecond header takes precedence over Retry-After seconds/date, matching
 * the SDK transport contract. Invalid values fall through to the other header;
 * missing or invalid hints leave the bounded exponential policy in control.
 */
export function providerRetryAfterMs(
	error: unknown,
	now = Date.now(),
): number | undefined {
	const headers = (error as { responseHeaders?: unknown } | undefined)
		?.responseHeaders;
	if (!headers || typeof headers !== "object") return undefined;
	let milliseconds: string | undefined;
	let secondsOrDate: string | undefined;
	for (const [key, value] of Object.entries(
		headers as Record<string, unknown>,
	)) {
		const raw = Array.isArray(value) ? value[0] : value;
		if (typeof raw !== "string" || raw.trim().length === 0) continue;
		if (key.toLowerCase() === "retry-after-ms") milliseconds = raw.trim();
		if (key.toLowerCase() === "retry-after") secondsOrDate = raw.trim();
	}
	const explicitMilliseconds =
		milliseconds === undefined ? Number.NaN : Number(milliseconds);
	if (Number.isFinite(explicitMilliseconds) && explicitMilliseconds >= 0)
		return explicitMilliseconds;
	if (secondsOrDate === undefined) return undefined;
	const seconds = Number(secondsOrDate);
	if (Number.isFinite(seconds))
		return seconds >= 0 && Number.isFinite(seconds * 1000)
			? seconds * 1000
			: undefined;
	const at = Date.parse(secondsOrDate);
	return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** Explicit credit exhaustion is not a temporary rate-limit window. */
export function isPermanentQuotaError(error: unknown): boolean {
	const codes = new Set(["insufficient_quota", "credit_balance_exhausted"]);
	const inspect = (value: unknown): boolean => {
		if (typeof value !== "object" || value === null) return false;
		const record = value as Record<string, unknown>;
		return (
			(typeof record.code === "string" && codes.has(record.code)) ||
			(typeof record.type === "string" && codes.has(record.type)) ||
			(typeof record.error === "object" &&
				record.error !== null &&
				["code", "type"].some((key) => {
					const field = (record.error as Record<string, unknown>)[key];
					return typeof field === "string" && codes.has(field);
				}))
		);
	};
	if (typeof error !== "object" || error === null) return false;
	const record = error as Record<string, unknown>;
	if (inspect(record) || inspect(record.data)) return true;
	if (typeof record.responseBody !== "string") return false;
	try {
		return inspect(JSON.parse(record.responseBody));
	} catch {
		// error-policy:J3 malformed provider bodies cannot establish permanent quota exhaustion.
		return false;
	}
}

/** Absolute deadline survives evaluator processing before task persistence. */
export function providerRateLimitRetryAt(
	error: unknown,
	now = Date.now(),
): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const record = error as Record<string, unknown>;
	if (
		(record.statusCode ?? record.status) !== 429 ||
		isPermanentQuotaError(error)
	)
		return undefined;
	const explicit = record.retryAfterMs;
	const delay =
		typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0
			? explicit
			: providerRetryAfterMs(error, now);
	const deadline = delay === undefined ? NaN : now + delay;
	return Number.isFinite(deadline) && deadline > now ? deadline : undefined;
}
