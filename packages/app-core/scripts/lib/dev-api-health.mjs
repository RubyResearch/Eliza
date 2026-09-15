/** Bounded readiness probes with diagnostics safe to include in dev logs. */

/**
 * Confirm a short probe timeout before counting it toward killing the runtime.
 * A loaded development host can serve healthy responses outside the interactive
 * readiness budget. The longer probe still bounds recovery for a stalled child;
 * explicit unhealthy responses and connection failures are never hidden.
 */
export async function probeApiHealthWithConfirmation(
  port,
  // The supervisor's loop also pipes the child's log stream, and on a loaded
  // box a 30 ms endpoint measured 3–6 s (audit 2026-09-13); three such probes
  // restarted a healthy runtime. Budget for the probe, not the endpoint.
  { timeoutMs = 4000, confirmationTimeoutMs = 20_000, ...options } = {},
) {
  const initial = await probeApiHealth(port, { ...options, timeoutMs });
  if (initial.reason !== "timeout") return initial;
  const confirmation = await probeApiHealth(port, {
    ...options,
    timeoutMs: confirmationTimeoutMs,
  });
  return {
    ...confirmation,
    elapsedMs: initial.elapsedMs + confirmation.elapsedMs,
    recheckedAfterTimeout: true,
  };
}

export async function probeApiHealth(
  port,
  { fetchImpl = fetch, timeoutMs = 4000, now = () => performance.now() } = {},
) {
  const startedAt = now();
  const signal = AbortSignal.timeout(timeoutMs);
  let status = null;
  const result = (healthy, reason) => ({
    healthy,
    reason,
    status,
    elapsedMs: Math.max(0, Math.round(now() - startedAt)),
  });

  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal,
    });
    status = response.status;
    if (!response.ok) return result(false, "http_error");
    let body;
    try {
      body = await response.json();
    } catch {
      // error-policy:J4 distinguish a stalled response body from malformed
      // JSON without copying either response content or parser error text.
      return result(false, signal.aborted ? "timeout" : "invalid_json");
    }
    return result(
      body?.ready === true,
      body?.ready === true ? "ready" : "not_ready",
    );
  } catch {
    // error-policy:J4 the supervisor decides restart policy; this boundary
    // preserves why a probe failed without disclosing network error text.
    return result(false, signal.aborted ? "timeout" : "transport_error");
  }
}
