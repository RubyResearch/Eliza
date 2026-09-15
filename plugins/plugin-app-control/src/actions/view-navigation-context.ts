/**
 * Shares the authorized view reference used before and after navigation.
 * Interaction schemas remain in the fresh VIEWS list read; destination,
 * capability identities/descriptions and scoped actions stay complete inline.
 */
import type { ViewSummary } from "./views-client.js";

export const NAVIGATION_CAPABILITY_READ_INSTRUCTION =
	"Capability entries marked paramsDeferred are an index, not callable parameter schemas. Before using one through VIEWS interact, read its complete current schema with VIEWS action=list. Navigation show/open needs no capability schema. Domain actions retain their own complete schemas; never invent interaction parameters.";

export function navigationDestinationReference(view: ViewSummary) {
	return {
		...view,
		...(view.capabilities && {
			capabilities: view.capabilities.map(({ params, ...capability }) =>
				params === undefined
					? capability
					: { ...capability, paramsDeferred: true },
			),
		}),
	};
}
