/**
 * The EXPERIENCE action: model-driven update/delete over the agent's stored
 * experience records, through the same EXPERIENCE service use cases the
 * Character → Experience view drives via PATCH/DELETE
 * `/api/character/experiences/:id` (#14623). SEARCH_EXPERIENCES owns reads;
 * this action owns the two mutations, so chat/voice can edit or forget a
 * learned experience without a raw selector.
 *
 * Both ops are destructive — update overwrites and re-embeds the record,
 * delete removes it from the graph — so both refuse without `confirm:true`,
 * mirroring the MEMORY update/delete contract
 * (`packages/agent/src/actions/memories.ts`). Delete accepts a `query`
 * fallback for "forget that experience about X": it resolves through the
 * service's own search, requires a strong whole-phrase/all-terms match, and
 * refuses ambiguous matches by listing candidate ids instead of guessing.
 */
import { logger } from "../../../../logger.ts";
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
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../../../utils/well-formed.ts";
import { validateUuid } from "../../../../utils.ts";
import type { ExperienceService } from "../service.ts";
import type { Experience } from "../types.ts";

const EXPERIENCE = "EXPERIENCE";

const EXPERIENCE_OPS = ["update", "delete"] as const;
type ExperienceOp = (typeof EXPERIENCE_OPS)[number];

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

function readScoreParam(
	params: Record<string, unknown>,
	key: string,
): { value?: number; error?: string } {
	const raw = params[key];
	if (raw === undefined || raw === null) return {};
	const parsed =
		typeof raw === "number"
			? raw
			: typeof raw === "string" && raw.trim()
				? Number(raw)
				: Number.NaN;
	if (!Number.isFinite(parsed)) {
		return { error: `${key} must be a number between 0 and 1.` };
	}
	if (parsed < 0 || parsed > 1) {
		return { error: `${key} must be between 0 and 1.` };
	}
	return { value: parsed };
}

/**
 * Tags arrive either as a JSON array (planner) or as one comma-separated
 * string (the same shape the view's edit form accepts before splitting).
 */
function readTagsParam(params: Record<string, unknown>): string[] | undefined {
	const raw = params.tags;
	if (raw === undefined || raw === null) return undefined;
	const items = Array.isArray(raw)
		? raw
		: typeof raw === "string"
			? raw.split(",")
			: null;
	if (!items) return undefined;
	return items
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeOp(
	params: Record<string, unknown>,
): ExperienceOp | undefined {
	const candidate = readStringParam(
		params,
		"action",
		"subaction",
		"op",
	)?.toLowerCase();
	return candidate && (EXPERIENCE_OPS as readonly string[]).includes(candidate)
		? (candidate as ExperienceOp)
		: undefined;
}

function fail(text: string, error: string): ActionResult {
	return { success: false, text, data: { error } };
}

/**
 * Same strong-match bar MEMORY's delete-by-query uses: 1 for a whole-phrase
 * hit, plus the fraction of query terms present. Deletion requires >= 1
 * (whole phrase, or every term) — search-style partial matches must not be
 * enough to destroy a record.
 */
function scoreText(text: string, query: string): number {
	const t = text.toLowerCase();
	const q = query.toLowerCase();
	if (!t || !q) return 0;
	const terms = q
		.split(/\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length >= 2);
	const whole = t.includes(q) ? 1 : 0;
	if (terms.length === 0) return whole;
	let matches = 0;
	for (const term of terms) if (t.includes(term)) matches += 1;
	return whole + matches / terms.length;
}

function experienceMatchText(experience: Experience): string {
	return [
		experience.learning,
		experience.context,
		experience.result,
		...experience.tags,
	]
		.filter(Boolean)
		.join("\n");
}

async function doUpdate(
	experienceService: ExperienceService,
	params: Record<string, unknown>,
): Promise<ActionResult> {
	const rawId = readStringParam(params, "experienceId", "id");
	const experienceId = validateUuid(rawId);
	if (!experienceId) {
		return fail(
			"experienceId is required and must be a valid UUID. Use SEARCH_EXPERIENCES to find the id first.",
			"EXPERIENCE_INVALID_ID",
		);
	}

	const updates: Partial<Experience> = {};
	const learning = readStringParam(params, "learning");
	if (learning) updates.learning = learning;
	const importance = readScoreParam(params, "importance");
	if (importance.error)
		return fail(importance.error, "EXPERIENCE_INVALID_SCORE");
	if (importance.value !== undefined) updates.importance = importance.value;
	const confidence = readScoreParam(params, "confidence");
	if (confidence.error)
		return fail(confidence.error, "EXPERIENCE_INVALID_SCORE");
	if (confidence.value !== undefined) updates.confidence = confidence.value;
	const tags = readTagsParam(params);
	if (tags !== undefined) updates.tags = tags;

	if (Object.keys(updates).length === 0) {
		return fail(
			"Nothing to update: provide at least one of learning, importance, confidence, or tags.",
			"EXPERIENCE_NO_FIELDS",
		);
	}

	const updated = await experienceService.updateExperience(
		experienceId,
		updates,
	);
	if (!updated) {
		return fail(
			`Experience ${experienceId} was not found.`,
			"EXPERIENCE_NOT_FOUND",
		);
	}

	return {
		success: true,
		text: `Updated experience ${experienceId}: ${toWellFormedUnicode(updated.learning)}`,
		values: { experienceId },
		data: {
			actionName: EXPERIENCE,
			op: "update" as const,
			experienceId,
			experience: updated,
		},
	};
}

async function doDelete(
	experienceService: ExperienceService,
	params: Record<string, unknown>,
): Promise<ActionResult> {
	const rawId = readStringParam(params, "experienceId", "id");
	const query = readStringParam(params, "query");
	if (!rawId && !query) {
		return fail("experienceId or query is required.", "EXPERIENCE_MISSING_ID");
	}

	if (rawId) {
		const experienceId = validateUuid(rawId);
		if (!experienceId) {
			return fail(
				`experienceId "${rawId}" is not a valid UUID. Use SEARCH_EXPERIENCES to find the id first.`,
				"EXPERIENCE_INVALID_ID",
			);
		}
		const deleted = await experienceService.deleteExperience(experienceId);
		if (!deleted) {
			return fail(
				`Experience ${experienceId} was not found.`,
				"EXPERIENCE_NOT_FOUND",
			);
		}
		return {
			success: true,
			text: `Deleted experience ${experienceId}.`,
			values: { experienceId },
			data: { actionName: EXPERIENCE, op: "delete" as const, experienceId },
		};
	}

	if (!query) {
		return fail("experienceId or query is required.", "EXPERIENCE_MISSING_ID");
	}

	const candidates = await experienceService.queryExperiences({
		query,
	});
	const matched = candidates.filter(
		(experience) => scoreText(experienceMatchText(experience), query) >= 1,
	);

	if (matched.length === 0) {
		return fail(
			`No stored experience matches "${query}".`,
			"EXPERIENCE_NOT_FOUND",
		);
	}
	if (matched.length > 1) {
		const lines = matched.map(
			(e) => `- ${e.id}: ${toWellFormedUnicode(e.learning)}`,
		);
		return {
			success: false,
			text: [
				`Query "${query}" matches ${matched.length} experiences. Delete by experienceId instead:`,
				...lines,
			].join("\n"),
			data: { error: "EXPERIENCE_AMBIGUOUS_QUERY" },
		};
	}

	const target = matched[0];
	const deleted = await experienceService.deleteExperience(target.id);
	if (!deleted) {
		return fail(
			`Experience ${target.id} was not found.`,
			"EXPERIENCE_NOT_FOUND",
		);
	}
	return {
		success: true,
		text: `Deleted experience ${target.id}: ${toWellFormedUnicode(target.learning)}`,
		values: { experienceId: target.id },
		data: {
			actionName: EXPERIENCE,
			op: "delete" as const,
			experienceId: target.id,
			query,
		},
	};
}

export const manageExperienceAction: Action = {
	name: EXPERIENCE,
	contexts: ["memory", "documents", "agent_internal"],
	roleGate: { minRole: "OWNER" },
	similes: [
		"UPDATE_EXPERIENCE",
		"EDIT_EXPERIENCE",
		"DELETE_EXPERIENCE",
		"REMOVE_EXPERIENCE",
		"FORGET_EXPERIENCE",
	],
	description:
		"Edit or delete a stored experience record. action:update rewrites learning/importance/confidence/tags by experienceId (requires confirm:true); action:delete removes an experience by experienceId or by query text match (requires confirm:true).",
	descriptionCompressed:
		"edit or delete stored experience records; update by experienceId, delete by experienceId or query; both require confirm:true",
	routingHint:
		"edit or delete the agent's learned experience records -> EXPERIENCE (find ids via SEARCH_EXPERIENCES when unknown); do NOT use for general user-fact memories -> MEMORY",
	parameters: [
		{
			name: "action",
			description: "Operation to perform. One of: update, delete.",
			required: true,
			schema: { type: "string" as const, enum: [...EXPERIENCE_OPS] },
		},
		{
			name: "experienceId",
			description:
				"update/delete: id of the experience to mutate. delete: optional when query is provided.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "learning",
			description: "update: replacement learning text for the experience.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "importance",
			description: "update: importance score from 0 to 1.",
			required: false,
			schema: { type: "number" as const, minimum: 0, maximum: 1 },
		},
		{
			name: "confidence",
			description: "update: confidence score from 0 to 1.",
			required: false,
			schema: { type: "number" as const, minimum: 0, maximum: 1 },
		},
		{
			name: "tags",
			description:
				"update: replacement tag list (array or comma-separated string).",
			required: false,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
		{
			name: "query",
			description:
				"delete: text match against experience learning/context/tags; resolves the record to remove when experienceId is unknown. Refuses ambiguous matches.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "confirm",
			description:
				"update/delete: must be true to proceed with the destructive operation.",
			required: false,
			schema: { type: "boolean" as const },
		},
	],
	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Delete that experience about TypeScript build failures",
					actions: [EXPERIENCE],
				},
			},
			{
				name: "{{agent}}",
				content: { text: "Deleted experience abc-123." },
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Update that learning — lower its confidence, it turned out wrong",
					actions: [EXPERIENCE],
				},
			},
			{
				name: "{{agent}}",
				content: { text: "Updated experience abc-123." },
			},
		],
	] as ActionExample[][],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		if (!runtime.getService("EXPERIENCE")) {
			return false;
		}
		const params = getActionParams(_options);
		if (normalizeOp(params) || readStringParam(params, "experienceId", "id")) {
			return true;
		}
		const text =
			typeof message.content.text === "string"
				? message.content.text.toLowerCase()
				: "";
		return (
			(/\b(experience|experiences|learning|learnings)\b/.test(text) &&
				/\b(delete|remove|forget|edit|update|change|correct|revise)\b/.test(
					text,
				)) ||
			hasActionContext(message, _state, {
				contexts: ["memory", "documents", "agent_internal"],
			})
		);
	},

	async handler(
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<ActionResult> {
		const experienceService = runtime.getService(
			"EXPERIENCE",
		) as ExperienceService | null;
		if (!experienceService) {
			return fail(
				"Experience service is unavailable.",
				"EXPERIENCE_SERVICE_UNAVAILABLE",
			);
		}

		const params = getActionParams(_options);
		const op = normalizeOp(params);
		if (!op) {
			return fail(
				`action is required and must be one of ${EXPERIENCE_OPS.join(", ")}. Use SEARCH_EXPERIENCES for reads.`,
				"EXPERIENCE_INVALID_OP",
			);
		}
		// Strict boolean, mirroring MEMORY: a planner that cannot produce a real
		// `true` must not be able to mutate the experience graph.
		if (params.confirm !== true) {
			return fail(
				`Refusing to ${op}: pass confirm:true to acknowledge this destructive action.`,
				"EXPERIENCE_CONFIRMATION_REQUIRED",
			);
		}

		const result =
			op === "update"
				? await doUpdate(experienceService, params)
				: await doDelete(experienceService, params);

		logger.info(
			`[ManageExperienceAction] ${op} ${result.success ? "succeeded" : "failed"}: ${truncateWellFormed(toWellFormedUnicode(result.text ?? ""), 200)}`,
		);
		return { ...result, transcriptVisibility: "internal" };
	},
};
