/**
 * Shared jsonb sanitizer for SQL writes. Strips NULs (PostgreSQL rejects
 * JSON.stringify's `\u0000` escape), breaks cycles, and fails closed on
 * hostile nesting and output size so a log/memory body cannot exhaust the
 * adapter before its jsonb bind.
 *
 * `utils.ts`, `utils.node.ts`, and `utils.browser.ts` re-export this so the
 * three platform builds cannot drift.
 */
import { ElizaError } from "@elizaos/core";

/** Nesting ceiling. Honest log/memory bodies are a handful of objects deep. */
export const MAX_SQL_JSON_SANITIZE_DEPTH = 64;
/** Logical values copied into one jsonb bind before the write fails closed. */
export const MAX_SQL_JSON_SANITIZE_NODES = 10_000;
/** Maximum UTF-8 bytes in the JSON text passed to one jsonb bind. */
export const MAX_SQL_JSON_SANITIZE_BYTES = 1_048_576;
/** Maximum escaped UTF-8 bytes contributed by one string value. */
export const MAX_SQL_JSON_SANITIZE_STRING_BYTES = MAX_SQL_JSON_SANITIZE_BYTES;
/** Document content budget matches the supported 32 MiB upload envelope. */
const MAX_DOCUMENT_JSON_BYTES = 32 * 1_048_576;
/** Maximum escaped UTF-8 bytes contributed by one property key. */
export const MAX_SQL_JSON_SANITIZE_KEY_BYTES = 65_536;
/** Maximum decimal digits projected from one BigInt value. */
export const MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS = 4_096;
export const SQL_JSON_SANITIZE_UNBOUNDED = "SQL_JSON_SANITIZE_UNBOUNDED";

const BIGINT_DECIMAL_LIMIT = 10n ** BigInt(MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS);
const NUL = String.fromCharCode(0);

function failUnbounded(context: Record<string, unknown>, cause?: unknown): never {
  throw new ElizaError("sql json sanitize exceeded its safe structural budget", {
    code: SQL_JSON_SANITIZE_UNBOUNDED,
    context,
    cause,
    severity: "fatal",
  });
}

interface SanitizeContext {
  seen: WeakSet<object>;
  visits: number;
  bytes: number;
  rejectNul?: boolean;
  maxBytes?: number;
  documentText?: boolean;
}

function rejectUnsupportedNul(value: string, context: SanitizeContext): void {
  if (context.rejectNul && value.includes(NUL)) {
    throw new ElizaError(
      "Memory JSON contains NUL, which PostgreSQL jsonb cannot preserve; remove it explicitly before retrying the unchanged write",
      { code: "SQL_JSON_UNSUPPORTED_NUL", severity: "fatal" }
    );
  }
}

function chargeBytes(context: SanitizeContext, bytes: number, reason: string): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    failUnbounded({ reason, bytes: "invalid" });
  }
  context.bytes += bytes;
  const maxBytes = context.maxBytes ?? MAX_SQL_JSON_SANITIZE_BYTES;
  if (context.bytes > maxBytes) {
    failUnbounded({
      reason: "serialized-bytes",
      bytes: context.bytes,
      max: maxBytes,
      source: reason,
    });
  }
}

/**
 * Count the exact UTF-8 bytes JSON.stringify emits inside a quoted string.
 * This scans without allocating an encoded copy and stops at the scalar bound.
 */
function measureJsonStringBytes(value: string, max: number, reason: string): number {
  if (value.length > max) {
    failUnbounded({ reason, codeUnits: value.length, max });
  }

  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) continue;

    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
    } else if (codeUnit <= 0x1f) {
      bytes +=
        codeUnit === 0x08 ||
        codeUnit === 0x09 ||
        codeUnit === 0x0a ||
        codeUnit === 0x0c ||
        codeUnit === 0x0d
          ? 2
          : 6;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON.stringify escapes a lone surrogate as `\ud800`.
        bytes += 6;
      }
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }

    if (bytes > max) {
      failUnbounded({ reason, bytes, max });
    }
  }
  return bytes + 2;
}

function reflectOrFail<T>(operation: () => T, reason: string): T {
  try {
    return operation();
  } catch (cause) {
    // error-policy:J2 reflection failures are wrapped at the exact operation;
    // never inspect an attacker-thrown value with instanceof or property Gets.
    failUnbounded({ reason }, cause);
  }
}

/**
 * Prepare a value for `JSON.stringify` + `$1::jsonb`. Circular references
 * become `null`. Depth past {@link MAX_SQL_JSON_SANITIZE_DEPTH} fails closed.
 */
export function sanitizeJsonObject(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  return sanitizeJsonValue(value, { seen, visits: 0, bytes: 0 }, 0);
}

/** Serialize memory JSON without silently removing unsupported NUL characters. */
export function serializeJsonb(
  value: unknown,
  options: { documentText?: boolean } = {}
): string | undefined {
  return serializeJsonbWithBudget(value, MAX_SQL_JSON_SANITIZE_BYTES, options.documentText);
}

/** Preserve complete document content within the supported upload envelope. */
export function serializeDocumentJsonb(value: unknown): string | undefined {
  return serializeJsonbWithBudget(value, MAX_DOCUMENT_JSON_BYTES);
}

function serializeJsonbWithBudget(
  value: unknown,
  maxBytes: number,
  documentText = false
): string | undefined {
  // Decode legacy JSON for structural validation; keep its original numeric
  // tokens so arbitrary-precision jsonb numbers never round through JS Number.
  let decoded = value;
  if (typeof value === "string") {
    // Check before JSON.parse allocates a second tree. The code-unit guard
    // bounds the UTF-8 measurement allocation as well as the decoded input.
    if (value.length > maxBytes) {
      failUnbounded({
        reason: "encoded-json-bytes",
        codeUnits: value.length,
        max: maxBytes,
      });
    }
    const bytes = new TextEncoder().encode(value).byteLength;
    if (bytes > maxBytes) {
      failUnbounded({ reason: "encoded-json-bytes", bytes, max: maxBytes });
    }
    try {
      decoded = JSON.parse(value);
    } catch {
      // error-policy:J3 malformed legacy JSON is rejected without retaining
      // parser diagnostics, which can quote credential-bearing input text.
      throw new ElizaError("sql json input is not valid JSON", {
        code: "SQL_JSON_INVALID",
        severity: "fatal",
      });
    }
    sanitizeJsonValue(
      decoded,
      { seen: new WeakSet(), visits: 0, bytes: 0, rejectNul: true, maxBytes, documentText },
      0
    );
    return value;
  }
  return JSON.stringify(
    sanitizeJsonValue(
      decoded,
      { seen: new WeakSet(), visits: 0, bytes: 0, rejectNul: true, maxBytes, documentText },
      0
    )
  );
}

function sanitizeJsonValue(value: unknown, context: SanitizeContext, depth: number): unknown {
  if (depth > MAX_SQL_JSON_SANITIZE_DEPTH) {
    failUnbounded({ depth, max: MAX_SQL_JSON_SANITIZE_DEPTH });
  }

  context.visits += 1;
  if (context.visits > MAX_SQL_JSON_SANITIZE_NODES) {
    failUnbounded({
      visits: context.visits,
      max: MAX_SQL_JSON_SANITIZE_NODES,
    });
  }

  if (value === null || value === undefined) {
    chargeBytes(context, 4, value === null ? "null" : "undefined");
    return value;
  }

  if (typeof value === "string") {
    rejectUnsupportedNul(value, context);
    // Strips NUL characters: PostgreSQL/PGlite jsonb rejects the `\u0000`
    // escape JSON.stringify emits for them. Nothing else needs rewriting here —
    // the value is serialized with JSON.stringify, which already escapes
    // backslashes and control characters correctly; re-escaping them here
    // would corrupt already-escaped strings (e.g. "C:\Users") on a
    // write/read round-trip.
    chargeBytes(
      context,
      measureJsonStringBytes(
        value,
        context.maxBytes ?? MAX_SQL_JSON_SANITIZE_STRING_BYTES,
        "string-bytes"
      ),
      "string"
    );
    return value.includes(NUL) ? value.replaceAll(NUL, "") : value;
  }

  if (typeof value === "bigint") {
    if (value >= BIGINT_DECIMAL_LIMIT || value <= -BIGINT_DECIMAL_LIMIT) {
      failUnbounded({
        reason: "bigint-digits",
        max: MAX_SQL_JSON_SANITIZE_BIGINT_DIGITS,
      });
    }
    const projected = value.toString();
    chargeBytes(
      context,
      measureJsonStringBytes(projected, MAX_SQL_JSON_SANITIZE_STRING_BYTES, "bigint-bytes"),
      "bigint"
    );
    return projected;
  }

  if (typeof value === "number") {
    chargeBytes(context, Number.isFinite(value) ? String(value).length : 4, "number");
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean") {
    chargeBytes(context, value ? 4 : 5, "boolean");
    return value;
  }

  if (typeof value === "object") {
    if (context.seen.has(value)) {
      chargeBytes(context, 4, "cycle");
      return null;
    }
    context.seen.add(value);

    try {
      let dateTimestamp: number | undefined;
      try {
        // Native Date brand checking is constant-work. `instanceof Date` would
        // walk an arbitrarily deep caller-controlled prototype chain per node.
        dateTimestamp = Date.prototype.getTime.call(value);
      } catch {
        // error-policy:J3 an incompatible native receiver is simply not a Date;
        // no caller code or Proxy getPrototypeOf trap is invoked by this probe.
        dateTimestamp = undefined;
      }
      if (dateTimestamp !== undefined) {
        if (!Number.isFinite(dateTimestamp)) {
          chargeBytes(context, 4, "invalid-date");
          return null;
        }
        const iso = Date.prototype.toISOString.call(value);
        chargeBytes(
          context,
          measureJsonStringBytes(iso, MAX_SQL_JSON_SANITIZE_STRING_BYTES, "date-bytes"),
          "date"
        );
        return iso;
      }

      if (reflectOrFail(() => Array.isArray(value), "array-check")) {
        const lengthDescriptor = reflectOrFail(
          () => Object.getOwnPropertyDescriptor(value, "length"),
          "array-length-descriptor"
        );
        const length = lengthDescriptor?.value;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          length > MAX_SQL_JSON_SANITIZE_NODES - context.visits
        ) {
          failUnbounded({
            reason: "array-length",
            length: typeof length === "number" ? length : "invalid",
            max: MAX_SQL_JSON_SANITIZE_NODES,
          });
        }
        const result: unknown[] = [];
        chargeBytes(context, 2 + Math.max(0, length - 1), "array-syntax");
        for (let index = 0; index < length; index += 1) {
          const descriptor = reflectOrFail(
            () => Object.getOwnPropertyDescriptor(value, String(index)),
            "array-item-descriptor"
          );
          if (descriptor && ("get" in descriptor || "set" in descriptor)) {
            failUnbounded({ reason: "array-accessor", index });
          }
          result.push(sanitizeJsonValue(descriptor?.value, context, depth + 1));
        }
        return result;
      }

      const keys = reflectOrFail(() => Reflect.ownKeys(value), "object-keys");
      if (keys.length > MAX_SQL_JSON_SANITIZE_NODES - context.visits) {
        failUnbounded({
          reason: "object-keys",
          keys: keys.length,
          max: MAX_SQL_JSON_SANITIZE_NODES,
        });
      }
      const result = Object.create(null) as Record<string, unknown>;
      chargeBytes(context, 2, "object-syntax");
      let serializedProperties = 0;
      for (const key of keys) {
        if (typeof key !== "string") continue;
        const descriptor = reflectOrFail(
          () => Object.getOwnPropertyDescriptor(value, key),
          "object-property-descriptor"
        );
        if (!descriptor?.enumerable) continue;
        rejectUnsupportedNul(key, context);
        if ("get" in descriptor || "set" in descriptor) {
          failUnbounded({ reason: "object-accessor" });
        }
        chargeBytes(
          context,
          measureJsonStringBytes(key, MAX_SQL_JSON_SANITIZE_KEY_BYTES, "key-bytes") +
            1 +
            (serializedProperties > 0 ? 1 : 0),
          "object-property-syntax"
        );
        serializedProperties += 1;
        const sanitizedKey = key.includes(NUL) ? key.replaceAll(NUL, "") : key;
        // Document source text is intentionally source-sized. Keep the generic
        // structural/metadata budget, but do not impose a log-body byte ceiling
        // on this one known scalar. Accessors were rejected above; JSON.stringify
        // still escapes the exact text, and unsupported NULs still fail closed.
        const sourceText =
          context.documentText &&
          depth === 0 &&
          key === "text" &&
          typeof descriptor.value === "string";
        if (sourceText) rejectUnsupportedNul(descriptor.value, context);
        const sanitizedValue = sourceText
          ? descriptor.value
          : sanitizeJsonValue(descriptor.value, context, depth + 1);
        if (sanitizedKey === "toJSON" && typeof sanitizedValue === "function") {
          failUnbounded({ reason: "custom-toJSON" });
        }
        if (Object.hasOwn(result, sanitizedKey)) {
          failUnbounded({ reason: "key-collision" });
        }
        Object.defineProperty(result, sanitizedKey, {
          value: sanitizedValue,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return result;
    } finally {
      // Only an ancestor is a cycle. A shared object in two sibling fields
      // must be serialized twice, just as JSON.stringify did before sanitizing.
      context.seen.delete(value);
    }
  }

  // JSON.stringify omits these values in objects and writes null in arrays.
  // Charging four bytes is conservative without changing their legacy shape.
  chargeBytes(context, 4, typeof value);
  return value;
}
