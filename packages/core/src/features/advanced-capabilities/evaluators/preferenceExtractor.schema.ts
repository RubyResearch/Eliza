/**
 * Zod schemas and tolerant parser for the passive preference extractor
 * (preference-items.ts). One post-turn LLM call emits ops that route a user's
 * conversationally expressed preferences to the store that can act on them:
 * closed-enum reply-style traits go to the PersonalityStore slot (`set_trait` /
 * `retract_trait`), standing style rules with no trait mapping become custom
 * directives (`add_directive`), and domain/view/interaction-pattern preferences
 * land in the facts table as durable `preference` facts (`add_preference_fact`).
 *
 * `reply_gate` is deliberately unrepresentable here: silencing the agent must
 * never be inferred from conversation (#14675) — it stays PERSONALITY-action-
 * only. Global scope is equally absent; every op targets the speaking user.
 */
import z from "zod";
import { logger } from "../../../logger.ts";
import { toWellFormedUnicode } from "../../../utils/well-formed.ts";
import {
	FORMALITY_VALUES,
	type PersonalityTrait,
	TONE_VALUES,
	VERBOSITY_VALUES,
} from "../personality/types.ts";

/** Traits inference may write. Closed set — `reply_gate` is excluded by design. */
export const PreferenceTraitEnum = z.enum(["verbosity", "tone", "formality"]);

const TRAIT_VALUE_SETS: Record<PersonalityTrait, ReadonlySet<string>> = {
	verbosity: new Set<string>(VERBOSITY_VALUES),
	tone: new Set<string>(TONE_VALUES),
	formality: new Set<string>(FORMALITY_VALUES),
};

// New model requests require scope. Optional parsing preserves previously
// staged outputs and direct legacy callers without rewriting their replay IDs.
export const PREFERENCE_SCOPES = [
	"across_conversations",
	"conversation",
	"task",
	"uncertain",
] as const;
const preferenceScope = z.enum(PREFERENCE_SCOPES).optional();

const SetTraitOpSchema = z.object({
	op: z.literal("set_trait"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	scope: preferenceScope,
	trait: PreferenceTraitEnum,
	value: z.string().min(1),
	confidence: z.number().min(0).max(1),
	evidence: z.string().optional(),
});

const AddDirectiveOpSchema = z.object({
	op: z.literal("add_directive"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	scope: preferenceScope,
	text: z.string().trim().min(1).transform(toWellFormedUnicode),
	confidence: z.number().min(0).max(1),
	evidence: z.string().optional(),
});

const AddPreferenceFactOpSchema = z.object({
	op: z.literal("add_preference_fact"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	scope: preferenceScope,
	claim: z.string().min(1),
	// Every supplied keyword is preserved through prompt parsing. Storage may
	// separately normalize its index representation without changing the claim.
	keywords: z.array(z.string().min(1)).optional(),
	confidence: z.number().min(0).max(1).optional(),
	evidence: z.string().optional(),
});

const RetractTraitOpSchema = z.object({
	op: z.literal("retract_trait"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	scope: preferenceScope,
	trait: PreferenceTraitEnum,
	reason: z.string().optional(),
});

/** Discriminated union of every op the preference extractor may emit. */
export const PreferenceOpSchema = z.discriminatedUnion("op", [
	SetTraitOpSchema,
	AddDirectiveOpSchema,
	AddPreferenceFactOpSchema,
	RetractTraitOpSchema,
]);

export type SetTraitOp = z.infer<typeof SetTraitOpSchema>;
export type AddDirectiveOp = z.infer<typeof AddDirectiveOpSchema>;
export type AddPreferenceFactOp = z.infer<typeof AddPreferenceFactOpSchema>;
export type RetractTraitOp = z.infer<typeof RetractTraitOpSchema>;
export type PreferenceOp = z.infer<typeof PreferenceOpSchema>;

/** Top-level extractor envelope: one object with a single `ops` field. */
export interface PreferenceExtractorOutput {
	ops: PreferenceOp[];
}

/**
 * Parse the extractor envelope tolerantly, op-by-op — same contract as
 * `parseExtractorOutputTolerant` in factExtractor.schema.ts: one malformed op
 * must not discard the rest of the turn's valid ops, and drops are logged HERE
 * because the evaluator `parse` hook has no runtime/logger in scope.
 *
 * Trait/value pairing is validated here rather than in the union: the wire
 * schema advertises one flat `value` enum across all three traits (a per-trait
 * union is not expressible under the strict structured-output invariants), so
 * the model can emit e.g. `trait: "verbosity", value: "warm"` — that op drops
 * with a logged issue instead of silently writing a nonsense trait.
 *
 * Incremental callers require the whole section: dropping an operation would
 * acknowledge its source evidence without applying it. Legacy callers retain
 * tolerant parsing. Returns null for an invalid envelope or incomplete strict
 * section.
 */
export function parsePreferenceOutputTolerant(
	output: unknown,
	options?: { requireComplete?: boolean },
): PreferenceExtractorOutput | null {
	const envelope = z.object({ ops: z.array(z.unknown()) }).safeParse(output);
	if (!envelope.success) return null;
	const ops: PreferenceOp[] = [];
	const issues: string[] = [];
	for (const raw of envelope.data.ops) {
		const parsed = PreferenceOpSchema.safeParse(raw);
		if (!parsed.success) {
			issues.push(
				parsed.error.issues
					.map(
						(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
					)
					.join("; "),
			);
			continue;
		}
		const op = parsed.data;
		if (op.op === "set_trait" && !TRAIT_VALUE_SETS[op.trait].has(op.value)) {
			issues.push(`set_trait: "${op.value}" is not a valid ${op.trait} value`);
			continue;
		}
		ops.push(op);
	}
	if (issues.length > 0) {
		logger.warn(
			{ src: "preferences", count: issues.length, issues },
			options?.requireComplete
				? "rejected incomplete preference section"
				: "dropped malformed preference op(s)",
		);
		if (options?.requireComplete) return null;
	}
	return { ops };
}
