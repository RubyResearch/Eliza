/**
 * Zod schemas for the unified fact extractor.
 *
 * One LLM call per message produces a list of operations that mutate the
 * fact store: insert a new durable/current fact, strengthen or decay an
 * existing one, or queue a contradiction for review. The schema is
 * discriminated on the `op` field so a single `safeParse` validates every
 * variant in one pass.
 *
 * Reflection items own the prompt and processors that consume this parse shape.
 */

import z from "zod";
import { logger } from "../../../logger.ts";

/**
 * Categories that durable facts can belong to. Closed set — the extractor
 * must pick exactly one. Mirrors {@link DurableFactCategory} in
 * `types/memory.ts`.
 */
export const DurableCategoryEnum = z.enum([
	"identity",
	"health",
	"relationship",
	"life_event",
	"business_role",
	"preference",
	"goal",
]);

export type DurableCategory = z.infer<typeof DurableCategoryEnum>;

/**
 * Categories that current (time-bound) facts can belong to. Closed set.
 * Mirrors {@link CurrentFactCategory} in `types/memory.ts`.
 */
export const CurrentCategoryEnum = z.enum([
	"feeling",
	"physical_state",
	"working_on",
	"going_through",
	"schedule_context",
]);

export type CurrentCategory = z.infer<typeof CurrentCategoryEnum>;

/**
 * Verification provenance for a newly extracted fact. Defaults to
 * `self_reported`; the model only emits `confirmed` when the message itself
 * cites external corroboration (a lab result, a calendar entry, etc.).
 */
export const VerificationStatusEnum = z.enum([
	"self_reported",
	"confirmed",
	"contradicted",
]);

export type VerificationStatus = z.infer<typeof VerificationStatusEnum>;

/**
 * Structured fields the model can attach to an insert. Kept open as a record
 * because the keys differ per category (e.g. `going_through` carries
 * `{situation: "divorce"}`; `health` may carry `{condition: "asthma",
 * pattern: "recurring"}`). The extractor prompt enumerates the expected
 * keys per category — runtime keeps this loose to avoid blocking valid
 * insertions on schema drift.
 */
const StructuredFieldsSchema = z.record(z.string(), z.unknown());
// Trim instead of reject: the wire schema can no longer advertise a max
// (strict structured-output validators reject `maxItems`), so an over-long
// keyword list from the model must degrade to the first 16 rather than
// failing the whole op. Storage re-caps via MAX_KEYWORDS anyway.
const KeywordsSchema = z.array(z.string().min(1)).optional();

const AddDurableOpSchema = z.object({
	op: z.literal("add_durable"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	claim: z.string().min(1),
	category: DurableCategoryEnum,
	// `.default({})`, NOT required: the advertised wire schema
	// (reflection-items factOpsSchema) keeps structured_fields optional so
	// claim-only fact ops still parse. A required schema here rejected those ops
	// — and because the whole `ops` array was parsed atomically, one omission
	// silently discarded EVERY fact op for the turn. The default keeps the
	// inferred type a non-optional record so downstream applyAddDurable stays
	// type-safe.
	structured_fields: StructuredFieldsSchema.default({}),
	keywords: KeywordsSchema,
	verification_status: VerificationStatusEnum.optional(),
	reason: z.string().optional(),
});

const AddCurrentOpSchema = z.object({
	op: z.literal("add_current"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	claim: z.string().min(1),
	category: CurrentCategoryEnum,
	// See AddDurableOpSchema: wire-optional → default, not required.
	structured_fields: StructuredFieldsSchema.default({}),
	keywords: KeywordsSchema,
	/**
	 * ISO timestamp of when the state began. Optional in the schema because
	 * the extractor defaults to `now` when the model omits it.
	 */
	valid_at: z.string().optional(),
	reason: z.string().optional(),
});

const StrengthenOpSchema = z.object({
	op: z.literal("strengthen"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	factId: z.string().min(1),
	reason: z.string().optional(),
});

const DecayOpSchema = z.object({
	op: z.literal("decay"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	factId: z.string().min(1),
	reason: z.string().optional(),
});

const ContradictOpSchema = z.object({
	op: z.literal("contradict"),
	sourceMessageIds: z.array(z.string().min(1)).optional(),
	factId: z.string().min(1),
	/**
	 * Complete model-authored correction supported by the user, including
	 * unchanged details. It is proposed for review, not applied to the fact.
	 */
	proposedText: z.string().refine((text) => text.trim().length > 0, {
		message: "proposedText must contain the complete corrected claim",
	}),
	reason: z.string().min(1),
});

/**
 * Discriminated union of every op the extractor may emit, keyed on `op`.
 */
export const OpSchema = z.discriminatedUnion("op", [
	AddDurableOpSchema,
	AddCurrentOpSchema,
	StrengthenOpSchema,
	DecayOpSchema,
	ContradictOpSchema,
]);

export type AddDurableOp = z.infer<typeof AddDurableOpSchema>;
export type AddCurrentOp = z.infer<typeof AddCurrentOpSchema>;
export type StrengthenOp = z.infer<typeof StrengthenOpSchema>;
export type DecayOp = z.infer<typeof DecayOpSchema>;
export type ContradictOp = z.infer<typeof ContradictOpSchema>;
export type ExtractorOp = z.infer<typeof OpSchema>;

/**
 * Top-level shape the extractor LLM must return: one structured object with
 * a single `ops` field.
 */
export const ExtractorOutputSchema = z.object({
	ops: z.array(OpSchema),
});

export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

function unwrapJsonFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```")) return trimmed;
	const firstLineEnd = trimmed.indexOf("\n");
	if (firstLineEnd < 0) return "";
	const closingFence = trimmed.lastIndexOf("```");
	if (closingFence <= firstLineEnd) return "";
	return trimmed.slice(firstLineEnd + 1, closingFence).trim();
}

function coerceExtractorOutput(output: unknown): unknown {
	if (typeof output !== "string") return output;
	const candidate = unwrapJsonFence(output);
	if (!candidate) return output;
	try {
		return JSON.parse(candidate);
	} catch {
		// error-policy:J3 Model output may be plain text; invalid JSON falls through to the typed invalid parse result.
		return output;
	}
}

function normalizeExtractorOp(raw: unknown): unknown {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const record = raw as Record<string, unknown>;
	if (record.op !== undefined || typeof record.type !== "string") return raw;
	return { ...record, op: record.type };
}

/**
 * Parse the extractor envelope tolerantly, op-by-op.
 *
 * `ExtractorOutputSchema` parses the whole `ops` array atomically, so a single
 * malformed op (the model occasionally hallucinates one bad entry among good
 * ones — a missing `factId` on a strengthen, a `contradict` with no `reason`)
 * fails `safeParse` and silently discards EVERY fact op for the turn. That is
 * real, launch-critical memory loss.
 *
 * This validates the envelope leniently (`{ ops: [...] }`), then validates each
 * op independently, keeping only the ones that pass. Drops are logged HERE
 * (one aggregate warn with per-op issues) — the only production caller is an
 * evaluator `parse` hook (`parse?(output): TOutput | null`,
 * `types/evaluator.ts`) which has no runtime/logger in scope, so a returned
 * drop count could never be reported and per-op loss stayed silent in prod.
 * Returns null only when the envelope itself is not `{ ops: array }` (a
 * genuinely malformed section).
 */
export function parseExtractorOutputTolerant(
	output: unknown,
): ExtractorOutput | null {
	const envelope = z
		.object({ ops: z.array(z.unknown()) })
		.safeParse(coerceExtractorOutput(output));
	if (!envelope.success) return null;
	const ops: ExtractorOp[] = [];
	const issues: string[] = [];
	for (const raw of envelope.data.ops) {
		const parsed = OpSchema.safeParse(normalizeExtractorOp(raw));
		if (parsed.success) {
			ops.push(parsed.data);
		} else {
			issues.push(
				parsed.error.issues
					.map(
						(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
					)
					.join("; "),
			);
		}
	}
	if (issues.length > 0) {
		logger.warn(
			{ src: "factMemory", count: issues.length, issues },
			"dropped malformed extractor op(s)",
		);
	}
	return { ops };
}
