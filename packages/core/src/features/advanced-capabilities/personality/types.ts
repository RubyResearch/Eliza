/**
 * Type system and constants for the personality capability: the
 * `PersonalitySlot`, `PersonalityProfile`, and `PersonalityAuditEntry` shapes;
 * the verbosity/tone/formality/reply-gate/trait/scope enums and their canonical
 * value lists; memory-table names; the global-scope token; slot/directive
 * limits; and the `ServiceTypeRegistry` augmentation for this capability's
 * services. Shared by the store, providers, actions, and enforcer here.
 */
import type { UUID } from "../../../types/primitives.ts";
import type { ServiceTypeRegistry } from "../../../types/service.ts";

declare module "../../../types/service.ts" {
	interface ServiceTypeRegistry {
		CHARACTER_MANAGEMENT: "CHARACTER_MANAGEMENT";
		PERSONALITY_STORE: "PERSONALITY_STORE";
	}
}

// Export service type constants
export const PersonalityServiceType = {
	CHARACTER_MANAGEMENT: "CHARACTER_MANAGEMENT" as const,
	PERSONALITY_STORE: "PERSONALITY_STORE" as const,
} satisfies Partial<ServiceTypeRegistry>;

/** Legacy memory table for per-user free-text interaction preferences. */
export const USER_PREFS_TABLE = "user_personality_preferences";

/** Maximum number of legacy free-text preferences a single user can store. */
export const MAX_PREFS_PER_USER = 10;

/** New memory table holding structured personality slots (user + global). */
export const PERSONALITY_SLOT_TABLE = "user_personality_slot";

/** Audit log table for every PERSONALITY action mutation. */
export const PERSONALITY_AUDIT_TABLE = "personality_audit_log";

/** Synthetic "user id" used to address the global personality slot. */
export const GLOBAL_PERSONALITY_SCOPE = "global" as const;

export type PersonalityScope = "user" | "global";

export type VerbosityLevel = "terse" | "normal" | "verbose";
export type ToneLevel = "warm" | "neutral" | "direct" | "cold";
export type FormalityLevel = "casual" | "professional" | "formal";
export type ReplyGateMode =
	| "always"
	| "addressed_or_ambient"
	| "on_mention"
	| "never_until_lift";

export type PersonalityTrait = "verbosity" | "tone" | "formality";

export const VERBOSITY_VALUES: readonly VerbosityLevel[] = [
	"terse",
	"normal",
	"verbose",
] as const;
export const TONE_VALUES: readonly ToneLevel[] = [
	"warm",
	"neutral",
	"direct",
	"cold",
] as const;
export const FORMALITY_VALUES: readonly FormalityLevel[] = [
	"casual",
	"professional",
	"formal",
] as const;
export const REPLY_GATE_VALUES: readonly ReplyGateMode[] = [
	"always",
	"addressed_or_ambient",
	"on_mention",
	"never_until_lift",
] as const;
export const TRAIT_VALUES: readonly PersonalityTrait[] = [
	"verbosity",
	"tone",
	"formality",
] as const;
export const SCOPE_VALUES: readonly PersonalityScope[] = [
	"user",
	"global",
] as const;

/** Who authored a personality write. Explicit (user/admin) beats inference. */
export type PersonalitySource = "user" | "admin" | "agent_inferred";

/** Slot fields that carry per-trait provenance in `trait_sources`. */
export type PersonalityGatedTrait = PersonalityTrait | "reply_gate";

/**
 * Structured per-user (or global) personality slot.
 *
 * `userId` is the target this slot applies to. For global slots,
 * `userId` is `GLOBAL_PERSONALITY_SCOPE`.
 */
export interface PersonalitySlot {
	/** Persisted extractor operation receipts; stored beside the profile change. */
	extraction_evidence_ids?: string[];
	userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE;
	agentId: UUID;
	verbosity: VerbosityLevel | null;
	tone: ToneLevel | null;
	formality: FormalityLevel | null;
	reply_gate: ReplyGateMode | null;
	custom_directives: string[];
	updated_at: string;
	/** Last writer of ANY field — display/audit only, never a safety gate. */
	source: PersonalitySource;
	/**
	 * Per-trait provenance: who set each currently-set trait (keys exist only
	 * for set traits). Inference gates MUST read this, not `source`: `source`
	 * is just the last writer, so a single inferred directive write would
	 * otherwise relabel the whole slot and let a later inferred set_trait
	 * overwrite an explicitly-set trait cross-turn.
	 */
	trait_sources: Partial<Record<PersonalityGatedTrait, PersonalitySource>>;
}

/** A named global profile (admin loadable). */
export interface PersonalityProfile {
	name: string;
	description: string;
	verbosity: VerbosityLevel | null;
	tone: ToneLevel | null;
	formality: FormalityLevel | null;
	reply_gate: ReplyGateMode | null;
	custom_directives: string[];
}

/** Audit log entry produced by every PERSONALITY action call. */
export interface PersonalityAuditEntry {
	id?: string;
	actorId: UUID;
	scope: PersonalityScope;
	targetId: UUID | typeof GLOBAL_PERSONALITY_SCOPE;
	action: string;
	before: PersonalitySlot | null;
	after: PersonalitySlot | null;
	timestamp: string;
}

export function emptyPersonalitySlot(
	userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
	agentId: UUID,
): PersonalitySlot {
	return {
		userId,
		agentId,
		verbosity: null,
		tone: null,
		formality: null,
		reply_gate: null,
		custom_directives: [],
		updated_at: new Date(0).toISOString(),
		source: "user",
		trait_sources: {},
	};
}
