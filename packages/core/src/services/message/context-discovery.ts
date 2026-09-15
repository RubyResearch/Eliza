/** Projects provider-owned discovery notices only for Stage 1. Every requested
 * body is restored in full from freshly authorized provider state; discovery
 * never executes actions, dispatches a draft, or changes the source context. */
import { ElizaError } from "../../errors";
import type { ContextEvent, ContextObject } from "../../types/context-object";
import type { JSONSchema } from "../../types/model";
import type { State } from "../../types/state";

/** Match native reference choices to the validator when every legal name is
 * enumerable. Callers with literal history search must retain the open schema. */
export function withAvailableContextRequests(
	schema: JSONSchema,
	available: ReadonlySet<string>,
): JSONSchema {
	const requests = schema.properties?.contextRequests;
	const items = requests?.items;
	if (
		requests?.type !== "array" ||
		requests.enum !== undefined ||
		!items ||
		Array.isArray(items) ||
		items.type !== "string"
	)
		return schema;
	const names = [...available].filter(
		(name) =>
			!Array.isArray(items.enum) || items.enum.some((value) => value === name),
	);
	return {
		...schema,
		properties: {
			...schema.properties,
			contextRequests: {
				...requests,
				...(names.length
					? { items: { ...items, enum: names } }
					: { enum: [[]] }),
			},
		},
	};
}

export function projectDiscoverableContext(
	context: ContextObject,
	state: State,
	loaded: ReadonlySet<string> = new Set(),
): { context: ContextObject; available: Set<string> } {
	const available = new Set<string>();
	const providers = state.data?.providers;
	const events = context.events.flatMap((event): ContextEvent[] => {
		if (
			event.type !== "provider" ||
			!providers ||
			!("name" in event) ||
			typeof event.name !== "string" ||
			!("text" in event) ||
			typeof event.text !== "string"
		)
			return [event];
		const result = providers[event.name];
		if (
			!result ||
			typeof result !== "object" ||
			typeof result.discoveryText !== "string" ||
			!result.discoveryText.trim() ||
			typeof result.text !== "string" ||
			result.text.trim() !== event.text.trim() ||
			result.discoveryText.length >= result.text.length
		)
			return [event];
		if (loaded.has(event.name)) {
			if (!("cacheStable" in event) || event.cacheStable !== true)
				return [event];
			// Preserve the original stable notice and append the complete read to
			// dynamic context. Replacing a notice early in the system prefix would
			// invalidate all later cached instructions for this same-turn read.
			return [
				{ ...event, text: result.discoveryText },
				{
					...event,
					id: `${event.id}:loaded`,
					name: `${event.name}:loaded`,
					text: `context_loaded: ${event.name}\nThe complete requested reference follows; do not request it again.\n${event.text}`,
					cacheStable: false,
				},
			];
		}
		available.add(event.name);
		return [{ ...event, text: result.discoveryText }];
	});
	return { context: { ...context, events }, available };
}

/** Validate model-requested names against this exact authorized turn, before
 * any response-handler field processors or action routing can run. */
export function readContextRequests(
	raw: Record<string, unknown> | null,
	available: ReadonlySet<string>,
): string[] {
	const requested = raw?.contextRequests;
	if (requested === undefined) return [];
	if (
		!Array.isArray(requested) ||
		requested.some((name) => typeof name !== "string" || !available.has(name))
	) {
		throw new ElizaError(
			"Request only context providers listed as available for this turn.",
			{
				code: "CONTEXT_DISCOVERY_INVALID_REQUEST",
			},
		);
	}
	return [...new Set(requested as string[])];
}
