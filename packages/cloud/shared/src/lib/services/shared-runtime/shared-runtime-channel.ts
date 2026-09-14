/**
 * Defines and validates trusted transport semantics crossing the Shared
 * coordinator boundary before they are projected into runtime memories.
 */

import { ChannelType } from "@elizaos/core/types/primitives";

export interface SharedRuntimeChannel {
  type: ChannelType;
  source: string;
}

const CHANNEL_TYPES = new Set<string>(Object.values(ChannelType));
const CHANNEL_SOURCE = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_CHANNEL_SOURCE_LENGTH = 64;

/** Reject malformed boundary data instead of allowing arbitrary metadata. */
export function parseSharedRuntimeChannel(value: unknown): SharedRuntimeChannel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { type?: unknown; source?: unknown };
  if (typeof candidate.type !== "string" || !CHANNEL_TYPES.has(candidate.type)) return null;
  if (
    typeof candidate.source !== "string" ||
    candidate.source.length === 0 ||
    candidate.source.length > MAX_CHANNEL_SOURCE_LENGTH ||
    !CHANNEL_SOURCE.test(candidate.source)
  ) {
    return null;
  }
  return { type: candidate.type as ChannelType, source: candidate.source };
}
