/** Renders complete routing catalogs and refreshes requested references for later
 * planning and completion. The provider event participates in normal replacement
 * on context restoration so revoked definitions are not retained. */
import type { ContextEvent } from "../../types/context-object";
import type { ContextDefinition } from "../../types/contexts";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import {
	listAvailableContextsForRole,
	resolveStage1SenderRole,
} from "./addressing.js";

export const CONTEXT_CATALOG_REFERENCE = "CONTEXT_CATALOG";

/** Retain every complete authorized definition and its routing metadata. */
export function formatAvailableContextsForPrompt(
	contexts: readonly ContextDefinition[],
): string {
	if (contexts.length === 0) {
		return "(no contexts registered)";
	}
	return contexts
		.map((definition) => {
			const description = definition.description?.trim();
			// Authorization has already filtered this catalog. Cache policy and
			// enforcement metadata do not help the model select a task context.
			const metadata = [
				definition.label && definition.label !== definition.id
					? `label=${definition.label}`
					: undefined,
				definition.aliases?.length
					? `aliases=${definition.aliases.join(",")}`
					: undefined,
				definition.parent
					? `parent=${definition.parent}`
					: definition.parents?.length
						? `parents=${definition.parents.join(",")}`
						: undefined,
				definition.sensitivity
					? `sensitivity=${definition.sensitivity}`
					: undefined,
			].filter(Boolean);
			const suffix = metadata.length > 0 ? ` [${metadata.join("; ")}]` : "";
			return description
				? `- ${definition.id}${suffix}: ${description}`
				: `- ${definition.id}${suffix}`;
		})
		.join("\n");
}

/** Use current authorization and registrations, never a prior model's catalog copy. */
export async function createContextCatalogReadEvent(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<ContextEvent> {
	const role = await resolveStage1SenderRole(runtime, message);
	const catalog = formatAvailableContextsForPrompt(
		listAvailableContextsForRole(runtime.contexts, role),
	);
	return {
		id: "context-catalog:loaded",
		type: "provider",
		source: "composeState",
		name: CONTEXT_CATALOG_REFERENCE,
		text: `context_loaded: ${CONTEXT_CATALOG_REFERENCE}\nThe complete authorized routing-context reference follows. This is the context catalog, not the action/tool catalog.\n${catalog}`,
		cacheStable: false,
	};
}
