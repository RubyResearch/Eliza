/**
 * Exposes only the renderer's observed current view. Requested destinations
 * remain user intent for the model, never fabricated UI state. Navigation actions
 * expose internal receipts and post-tool evaluation owns visible wording, so a
 * server-side "just switched" stamp is
 * state only and never instructs a later message to repeat an old completion.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { createViewsClient } from "../actions/views-client.js";

const EMPTY: ProviderResult = { text: "", values: {}, data: {} };

export const currentViewProvider: Provider = {
	name: "current_view",
	description:
		"The UI view currently observed by the renderer, not a requested destination or proof of a new navigation effect.",
	contexts: ["general"],
	// Just after available_apps. Composed in the planner state by default; pulled
	// into the Stage-1 response state on switch turns by the compose hook.
	position: -7,
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
	): Promise<ProviderResult> => {
		// UI_CONTEXT already renders this turn's registry-enriched client view.
		// A process-global snapshot may belong to another connected renderer;
		// do not duplicate or contradict the per-message source of truth.
		const metadata = message.content.metadata;
		if (
			metadata &&
			typeof metadata === "object" &&
			"uiView" in metadata &&
			typeof metadata.uiView === "string" &&
			metadata.uiView.trim()
		) {
			return EMPTY;
		}
		try {
			const current = await createViewsClient().getCurrentView();

			if (!current) return EMPTY;

			const section = current.subview ? ` — ${current.subview} section` : "";
			const where = current.viewPath
				? `${current.viewLabel} view (${current.viewPath})${section}`
				: `${current.viewLabel} view${section}`;

			return {
				text: `The user is currently viewing the ${where}. This is background UI state for choosing view and app tools — if they ask to go somewhere else, switch with the VIEWS action. When the message is not about the view itself, answer it directly and do not mention or restate the current view in the reply.`,
				values: {
					currentViewId: current.viewId,
					currentViewLabel: current.viewLabel,
					...(current.subview ? { currentViewSubview: current.subview } : {}),
					viewJustSwitched: false,
				},
				data: { currentView: current },
			};
		} catch (error) {
			// error-policy:J7 prompt diagnostics must not break the reply loop, but
			// the missing renderer state must remain observable to the agent and owner.
			runtime.reportError("app-control.current-view", error, {
				messageId: message.id,
				roomId: message.roomId,
			});
			logger.debug(
				"[current_view] could not resolve current view:",
				error instanceof Error ? error.message : String(error),
			);
			return EMPTY;
		}
	},
};
