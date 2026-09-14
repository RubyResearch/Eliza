/**
 * Conditional cloud logging utility with structural sensitive-data redaction.
 *
 * Debug/info logs only show when VERBOSE_LOGGING=true to reduce console noise.
 * Audit records remain enabled independently so authorization evidence is not
 * coupled to verbose diagnostics.
 * Every sink pipes its arguments through the core log-sink redactor
 * ({@link redactLogArgs}) before writing, so a secret is masked whether or not
 * the caller wrapped context in {@link redact.context}. Name-based redaction
 * (which field names are secret) is delegated to core's {@link isSensitiveKeyName}
 * so the definition lives in exactly one module shared with the runtime; the
 * `redact.*` helpers below add cloud-specific *display truncation* (tx hashes,
 * IDs, IPs, wallet addresses) that is not a security masking concern.
 */

import { isSensitiveKeyName, redactLogArgs } from "@elizaos/core/security/redact";

const isDev = process.env.NODE_ENV === "development";
// Only show debug/info logs when explicitly enabled via VERBOSE_LOGGING=true
const isVerbose = process.env.VERBOSE_LOGGING === "true";
// Detect Next.js build phase to suppress non-critical logs during build
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Redaction utilities for sensitive data in logs
 * Use these to prevent exposing full transaction hashes, IDs, and other sensitive info
 */
export const redact = {
  /**
   * Truncates a transaction hash for safe logging.
   * Shows first 10 characters + "..." (e.g., "0x1234abcd...")
   * In development, shows more detail for debugging.
   */
  txHash: (hash: string | null | undefined): string => {
    if (!hash) return "[no-hash]";
    if (isDev) return hash.slice(0, 18) + "...";
    return hash.slice(0, 10) + "...";
  },

  /**
   * Truncates a UUID/ID for safe logging.
   * Shows first 8 characters + "..." (e.g., "a1b2c3d4...")
   */
  id: (id: string | null | undefined): string => {
    if (!id) return "[no-id]";
    if (isDev) return id.slice(0, 12) + "...";
    return id.slice(0, 8) + "...";
  },

  /**
   * Truncates an organization ID for safe logging.
   * Alias for id() with semantic meaning.
   */
  orgId: (id: string | null | undefined): string => redact.id(id),

  /**
   * Truncates a user ID for safe logging.
   * Alias for id() with semantic meaning.
   */
  userId: (id: string | null | undefined): string => redact.id(id),

  /**
   * Truncates a payment ID for safe logging.
   * Alias for id() with semantic meaning.
   */
  paymentId: (id: string | null | undefined): string => redact.id(id),

  /**
   * Truncates a track ID (e.g., OxaPay track ID) for safe logging.
   */
  trackId: (id: string | null | undefined): string => {
    if (!id) return "[no-trackid]";
    if (isDev) return id.slice(0, 16) + "...";
    return id.slice(0, 10) + "...";
  },

  /**
   * Masks an IP address for safe logging.
   * Shows first two octets for IPv4 (e.g., "192.168.xxx.xxx")
   * For IPv6, shows first segment.
   */
  ip: (ip: string | null | undefined): string => {
    if (!ip || ip === "unknown") return "[no-ip]";
    if (isDev) return ip; // Full IP in dev for debugging
    // IPv4: mask last two octets
    if (ip.includes(".")) {
      const parts = ip.split(".");
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.xxx.xxx`;
      }
    }
    // IPv6: show first segment only
    if (ip.includes(":")) {
      const firstSegment = ip.split(":")[0];
      return `${firstSegment}:xxxx::`;
    }
    return "[masked-ip]";
  },

  /**
   * Truncates a wallet address for safe logging.
   * Shows first 6 and last 4 characters (e.g., "0x1234...abcd")
   */
  address: (addr: string | null | undefined): string => {
    if (!addr) return "[no-address]";
    if (addr.length < 12) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  },

  /**
   * Creates a redacted version of a log context object.
   * Automatically redacts known sensitive fields.
   */
  context: (ctx: Record<string, unknown>): Record<string, unknown> => {
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(ctx)) {
      if (typeof value !== "string") {
        redacted[key] = value;
        continue;
      }

      // Auto-redact based on field name patterns
      const lowerKey = key.toLowerCase();

      // Sensitive credential fields — always fully redacted. The predicate is
      // owned by core (isSensitiveKeyName) so cloud and runtime agree on which
      // field names are secret; the display-truncation branches below are
      // cloud-specific and stay here.
      if (isSensitiveKeyName(key)) {
        redacted[key] = "[REDACTED]";
      } else if (lowerKey.includes("txhash") || lowerKey.includes("transaction_hash")) {
        redacted[key] = redact.txHash(value);
      } else if (
        lowerKey === "ip" ||
        lowerKey.includes("sourceip") ||
        lowerKey.includes("source_ip")
      ) {
        redacted[key] = redact.ip(value);
      } else if (lowerKey.includes("paymentid") || lowerKey.includes("payment_id")) {
        redacted[key] = redact.paymentId(value);
      } else if (
        lowerKey.includes("organizationid") ||
        lowerKey.includes("organization_id") ||
        lowerKey.includes("orgid")
      ) {
        redacted[key] = redact.orgId(value);
      } else if (lowerKey.includes("userid") || lowerKey.includes("user_id")) {
        redacted[key] = redact.userId(value);
      } else if (lowerKey.includes("trackid") || lowerKey.includes("track_id")) {
        redacted[key] = redact.trackId(value);
      } else if (lowerKey.includes("address") && (value.startsWith("0x") || value.length > 30)) {
        redacted[key] = redact.address(value);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  },
};

export const logger = {
  /** Emits structured audit evidence independently of verbose diagnostics. */
  audit: (message: string, context: object) => {
    console.info(...redactLogArgs([message, context]));
  },
  /**
   * Debug-level logs - only shown when VERBOSE_LOGGING=true
   */
  debug: (...args: unknown[]) => {
    if (isVerbose) {
      console.log(...redactLogArgs(args));
    }
  },

  /**
   * Info-level logs - only shown when VERBOSE_LOGGING=true
   */
  info: (...args: unknown[]) => {
    if (isVerbose) {
      console.info(...redactLogArgs(args));
    }
  },

  /**
   * Error-level logs - always shown (critical for production monitoring)
   */
  error: (...args: unknown[]) => {
    console.error(...redactLogArgs(args));
  },

  /**
   * Warning-level logs - shown except during build phase
   * Build phase warnings are suppressed to reduce noise in `next build` output
   */
  warn: (...args: unknown[]) => {
    if (!isBuildPhase) {
      console.warn(...redactLogArgs(args));
    }
  },

  /**
   * Redaction utilities - use these to sanitize sensitive data before logging.
   * Example: logger.info("Payment", { txHash: redact.txHash(hash) })
   */
  redact,
};
