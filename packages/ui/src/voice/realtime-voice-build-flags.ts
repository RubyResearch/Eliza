/**
 * Build-time realtime voice capability flags shared by the Talk controller and
 * Settings serving-truth copy. Vite statically replaces literal `VITE_*`
 * member reads, so keep these reads explicit rather than indexing env keys.
 */

function isTruthyBuildFlag(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Whether this build explicitly force-arms the realtime voice gateway. */
export function isRealtimeVoiceForceEnabled(): boolean {
  try {
    return isTruthyBuildFlag(import.meta.env?.VITE_VOICE_REALTIME_FORCE);
  } catch {
    // error-policy:J4 An unreadable build flag leaves force-arming disabled.
    return false;
  }
}

/** Paired runtimes may prove realtime availability by default; explicit opt-out wins. */
export function isRealtimeVoiceSelfHostedEnabled(): boolean {
  try {
    const raw = import.meta.env?.VITE_VOICE_REALTIME_SELF_HOSTED;
    return raw === undefined || isTruthyBuildFlag(raw);
  } catch {
    // error-policy:J4 An unreadable build stamp leaves self-hosted realtime disabled.
    return false;
  }
}
