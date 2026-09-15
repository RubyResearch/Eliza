/** Keep authorized provider references deferred across planning and completion.
 * The original events remain intact for the existing tool-free restoration
 * protocol. Only providers that explicitly publish an index participate. */
import type { ContextObject } from "../types/context-object";

export function projectDeferredProviders(context: ContextObject): {
	context: ContextObject;
	available: string[];
} {
	const available: string[] = [];
	if (context.metadata?.providerDiscoveryEnabled !== true)
		return { context, available };
	const loaded = context.metadata.loadedContextProviders;
	const events = context.events.map((event) => {
		if (
			event.type !== "provider" ||
			!("discoveryText" in event) ||
			typeof event.discoveryText !== "string" ||
			!event.discoveryText.trim() ||
			!("text" in event) ||
			typeof event.text !== "string" ||
			event.discoveryText.length >= event.text.length ||
			!("name" in event) ||
			typeof event.name !== "string" ||
			(Array.isArray(loaded) && loaded.includes(event.name))
		)
			return event;
		available.push(event.name);
		return { ...event, text: event.discoveryText };
	});
	return { context: { ...context, events }, available };
}
