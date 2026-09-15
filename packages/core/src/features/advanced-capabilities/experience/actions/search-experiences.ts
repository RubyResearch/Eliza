/**
 * The SEARCH_EXPERIENCES action for the experience capability: queries the agent's
 * experience graph through the EXPERIENCE service and returns compact, ranked
 * learnings plus a small related graph, with a copy-to-clipboard follow-up action
 * for chaining. Validates on a structured `query`/`q` param, on experience/search
 * intent in free text, or on an in-scope action context, and derives a query from
 * the message when none is supplied. Complete results remain planner evidence;
 * the completion path owns the user-facing answer.
 */
import { logger } from "../../../../logger.ts";
import { unwrapUserMessageText } from "../../../../security/incoming-message-security.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { State } from "../../../../types/state.ts";
import { hasActionContext } from "../../../../utils/action-validation.ts";
import {
	describeUserReference,
	userReferenceLogView as queryLogView,
} from "../../../../utils/reference-echo.ts";
import type { ExperienceService } from "../service.ts";
import { formatExperienceForPrompt } from "../utils/experienceFormatter.ts";

const SEARCH_EXPERIENCES = "SEARCH_EXPERIENCES";

function getActionParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function readStringParam(
	params: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = params[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function readNumberParam(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

// Blob-safe rendering rationale lives in utils/reference-echo.ts.
const describeQuery = (query: string): string =>
	describeUserReference(query, "that request");

export const searchExperiencesAction: Action = {
	name: SEARCH_EXPERIENCES,
	contexts: ["memory", "documents", "agent_internal"],
	roleGate: { minRole: "USER" },
	similes: [
		"FIND_EXPERIENCES",
		"SEARCH_MEMORY_GRAPH",
		"EXPLORE_EXPERIENCES",
		"WHAT_HAVE_I_LEARNED",
	],
	description:
		"Search the agent's experience graph, return compact learnings, and provide follow-up actions for copying or chaining results.",
	parameters: [
		{
			name: "query",
			description: "Experience graph search query.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "limit",
			description: "Maximum matching experiences to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 20, default: 7 },
		},
		{
			name: "minConfidence",
			description: "Minimum confidence threshold from 0 to 1.",
			required: false,
			schema: { type: "number" as const, minimum: 0, maximum: 1, default: 0.3 },
		},
	],
	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Search experiences about TypeScript build failures",
					actions: [SEARCH_EXPERIENCES],
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I found matching experiences and a small related graph.",
				},
			},
		],
	] as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		// Unwrapped so intent matching runs on the user's words, not the
		// external-content security envelope around them.
		const text = unwrapUserMessageText(message).toLowerCase();
		if (!runtime.getService("EXPERIENCE")) {
			return false;
		}
		const params = getActionParams(_options);
		const hasStructuredQuery = Boolean(readStringParam(params, "query", "q"));
		return (
			hasStructuredQuery ||
			(/\b(experience|experiences|learned|learning|memory graph)\b/.test(
				text,
			) &&
				/\b(search|find|explore|what|show|recall|know)\b/.test(text)) ||
			hasActionContext(message, _state, {
				contexts: ["memory", "documents", "agent_internal"],
			})
		);
	},

	async handler(
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<ActionResult> {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) {
			return {
				success: false,
				text: "Experience service is unavailable.",
			};
		}

		const params = getActionParams(_options);
		const query =
			readStringParam(params, "query", "q") ??
			extractExperienceSearchQuery(message);
		const limit = Math.min(
			20,
			Math.max(1, Math.floor(readNumberParam(params.limit) ?? 7)),
		);
		const minConfidence = Math.min(
			1,
			Math.max(0, readNumberParam(params.minConfidence) ?? 0.3),
		);
		const experiences = await experienceService.queryExperiences({
			query,
			limit,
			minConfidence,
			includeRelated: true,
		});
		const graph = await experienceService.getExperienceGraph({
			query,
			limit: Math.max(20, limit),
			minConfidence,
			includeRelated: true,
		});

		const resultText =
			experiences.length > 0
				? experiences
						.map((experience, index) =>
							formatExperienceForPrompt(experience, index),
						)
						.join("\n\n")
				: `No experiences found for ${describeQuery(query)}.`;

		const text = `[EXPERIENCE SEARCH]\nQuery: ${JSON.stringify(query)}\nMatches: ${experiences.length}\nGraph: ${graph.nodes.length} nodes, ${graph.links.length} links\n\n${resultText}`;

		logger.info(
			`[SearchExperiencesAction] Returned ${experiences.length} experiences for query "${queryLogView(query)}"`,
		);

		// An empty search is still a valid result. The planner, not the match
		// count, decides whether the user's remaining work is complete.
		return {
			success: true,
			transcriptVisibility: "internal",
			text,
			data: {
				query,
				experiences,
				graph,
				postActions: [
					{
						id: "copy-experience-results",
						label: "Copy experience search results",
						action: "CLIPBOARD_WRITE",
						input: {
							title: `Experience search: ${queryLogView(query)}`,
							content: resultText,
							tags: ["experience-search", "experience-graph"],
						},
					},
				],
			},
			values: {
				experienceSearchQuery: query,
				experienceSearchCount: String(experiences.length),
			},
		};
	},
};

function extractExperienceSearchQuery(message: Memory): string {
	// Unwrapped: on hardened connectors the raw content.text is the whole
	// external-content security envelope, not the user's request.
	const text = unwrapUserMessageText(message);
	const normalized = text
		.replace(
			/^\s*(?:please\s+)?(?:search|find|explore|show|recall)\s+(?:my\s+|the\s+)?(?:experience|experiences|memory graph|learnings?)\s*(?:for|about|on)?\s*/i,
			"",
		)
		.replace(
			/^\s*what\s+(?:do\s+you|have\s+you|did\s+you)\s+(?:know|learn|remember)\s+(?:about|on)?\s*/i,
			"",
		)
		.trim();

	return normalized || text.trim() || "recent useful experiences";
}
