import {
	SHARED_NAV_TARGETS,
	type SharedNavTarget,
} from "@elizaos/shared/views/shared-nav-targets";

/** Resolve an explicit structured destination, never a user utterance. */
export function resolveCanonicalViewTarget(
	target: string,
): SharedNavTarget | undefined {
	return Object.entries(SHARED_NAV_TARGETS).find(
		([id, entry]) =>
			id.toLowerCase() === target.toLowerCase() ||
			entry.label.toLowerCase() === target.toLowerCase(),
	)?.[1];
}
