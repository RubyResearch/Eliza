/**
 * The experience provider for the experience capability: injects the most relevant
 * past learnings into turn context. Queries experiences for the authored request,
 * dedupes by id and renders every match into a
 * `[RELEVANT EXPERIENCES]` block. No EXPERIENCE service, a too-short message, or no
 * matches yields empty output; retrieval errors are explicitly unavailable.
 */

import { logger } from "../../../../logger.ts";
import type { Provider, ProviderResult } from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import { getUserMessageText } from "../../../../utils/message-text";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { ExperienceService } from "../service";
import { formatExperienceForPrompt } from "../utils/experienceFormatter.ts";

/**
 * Simple experience provider that injects relevant experiences into context
 * Similar to the knowledge provider but focused on agent learnings
 */
const spec = requireProviderSpec("experienceProvider");
export const experienceProvider: Provider = {
	name: spec.name,
	description:
		"Provides relevant past experiences and learnings for the current context",

	dynamic: true,
	contexts: ["general"],
	contextGate: { anyOf: ["general"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	async get(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> {
		try {
			const experienceService = runtime.getService(
				"EXPERIENCE",
			) as ExperienceService | null;

			if (!experienceService) {
				return { text: "", data: {}, values: {} };
			}

			// Get message text for context
			const messageText = getUserMessageText(message);
			if (messageText.length < 10) {
				return { text: "", data: {}, values: {} };
			}

			const semanticExperiences = await experienceService.queryExperiences({
				query: messageText,
				minConfidence: 0.6,
				minImportance: 0.5,
				includeRelated: true,
			});
			const relevantExperiences = [
				...new Map(
					semanticExperiences.map((experience) => [experience.id, experience]),
				).values(),
			];

			if (relevantExperiences.length === 0) {
				return { text: "", data: {}, values: {} };
			}

			// Format experiences for context injection
			const experienceText = relevantExperiences
				.map((experience, index) =>
					formatExperienceForPrompt(experience, index),
				)
				.join("\n\n");

			const contextText = `[RELEVANT EXPERIENCES]\n${experienceText}\n[/RELEVANT EXPERIENCES]`;

			logger.debug(
				`[experienceProvider] Injecting ${relevantExperiences.length} relevant experiences`,
			);

			return {
				text: contextText,
				discoveryText: [
					"Past-experience candidates, not current app state. Read experienceProvider for complete learnings and provenance when an earlier situation applies:",
					...relevantExperiences.map(
						(experience) =>
							`${experience.id} [${experience.domain}]: ${experience.context}`,
					),
				].join("\n"),
				data: {
					experiences: relevantExperiences,
					count: relevantExperiences.length,
				},
				values: {
					experienceCount: relevantExperiences.length.toString(),
				},
			};
		} catch (error) {
			// error-policy:J4 experience context becomes explicitly unavailable;
			// a failed query is not a valid zero-experience result.
			runtime.reportError("ExperienceProvider.get", error, {
				roomId: message.roomId,
			});
			return {
				text: "Relevant experiences are unavailable.",
				data: {
					available: false,
					error: error instanceof Error ? error.message : String(error),
				},
				values: { experienceContextAvailable: false },
			};
		}
	},
};
