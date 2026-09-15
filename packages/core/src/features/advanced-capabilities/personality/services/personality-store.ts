/**
 * Service in the personality capability that owns the structured personality
 * slots (per-user and global) and the named profiles, plus an in-memory audit
 * log of every mutation. Bundled profiles are registered on startup; slot
 * mutations (`applyTrait`, `applyReplyGate`, add/clear directives,
 * `loadProfileIntoGlobal`) return before/after pairs and record an audit entry.
 * Slots are kept in-memory (mirrored as agent memories so state survives a
 * reload). `getPersonalityStore` is the runtime accessor; the store backs the
 * personality provider and the PERSONALITY action.
 */
import { ElizaError } from "../../../../errors.ts";
import { logger } from "../../../../logger.ts";
import type { IAgentRuntime, Memory } from "../../../../types/index.ts";
import { MemoryType } from "../../../../types/memory.ts";
import type { UUID } from "../../../../types/primitives.ts";
import { Service } from "../../../../types/service.ts";
import { stringToUuid, validateUuid } from "../../../../utils.ts";
import {
	emptyPersonalitySlot,
	FORMALITY_VALUES,
	GLOBAL_PERSONALITY_SCOPE,
	PERSONALITY_SLOT_TABLE,
	type PersonalityAuditEntry,
	type PersonalityGatedTrait,
	type PersonalityProfile,
	type PersonalityScope,
	PersonalityServiceType,
	type PersonalitySlot,
	type PersonalitySource,
	REPLY_GATE_VALUES,
	TONE_VALUES,
	TRAIT_VALUES,
	VERBOSITY_VALUES,
} from "../types.ts";

type SlotKey = string;
const PERSONALITY_SLOT_MEMORY_SOURCE = "personality_slot";

function slotKey(
	agentId: UUID,
	userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
): SlotKey {
	return `${agentId}:${userId}`;
}

function clone(slot: PersonalitySlot): PersonalitySlot {
	return {
		...slot,
		custom_directives: [...slot.custom_directives],
		trait_sources: { ...slot.trait_sources },
		...(slot.extraction_evidence_ids
			? { extraction_evidence_ids: [...slot.extraction_evidence_ids] }
			: {}),
	};
}

/**
 * Next per-trait provenance map after writing `trait`. Setting a value stamps
 * the writer; clearing a value (null) drops the key so an unset trait carries
 * no provenance.
 */
function nextTraitSources(
	before: PersonalitySlot,
	trait: PersonalityGatedTrait,
	value: unknown,
	source: PersonalitySource,
): PersonalitySlot["trait_sources"] {
	const next = { ...before.trait_sources };
	if (value === null) delete next[trait];
	else next[trait] = source;
	return next;
}

function serializeSlotForMemory(
	slot: PersonalitySlot,
): Record<string, string | string[] | null | Record<string, string>> {
	return {
		userId: slot.userId,
		agentId: slot.agentId,
		verbosity: slot.verbosity,
		tone: slot.tone,
		formality: slot.formality,
		reply_gate: slot.reply_gate,
		custom_directives: [...slot.custom_directives],
		updated_at: slot.updated_at,
		source: slot.source,
		trait_sources: { ...slot.trait_sources } as Record<string, string>,
		...(slot.extraction_evidence_ids
			? { extraction_evidence_ids: [...slot.extraction_evidence_ids] }
			: {}),
	};
}

function slotMemoryId(
	agentId: UUID,
	userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
): UUID {
	return stringToUuid(`personality-slot:${agentId}:${userId}`);
}

function slotMemoryEntityId(slot: PersonalitySlot): UUID {
	return slot.userId === GLOBAL_PERSONALITY_SCOPE ? slot.agentId : slot.userId;
}

const PERSONALITY_SOURCES: readonly PersonalitySource[] = [
	"user",
	"admin",
	"agent_inferred",
] as const;
const GATED_TRAITS: readonly PersonalityGatedTrait[] = [
	...TRAIT_VALUES,
	"reply_gate",
] as const;

function isOneOf<T extends string>(
	value: unknown,
	values: readonly T[],
): value is T {
	return typeof value === "string" && values.includes(value as T);
}

function isValidPersistedSlot(value: unknown): value is PersonalitySlot {
	if (!value || typeof value !== "object") return false;
	const slot = value as Partial<PersonalitySlot>;
	if (
		slot.userId !== GLOBAL_PERSONALITY_SCOPE &&
		(typeof slot.userId !== "string" || validateUuid(slot.userId) === null)
	) {
		return false;
	}
	if (typeof slot.agentId !== "string" || validateUuid(slot.agentId) === null) {
		return false;
	}
	if (slot.verbosity !== null && !isOneOf(slot.verbosity, VERBOSITY_VALUES)) {
		return false;
	}
	if (slot.tone !== null && !isOneOf(slot.tone, TONE_VALUES)) {
		return false;
	}
	if (slot.formality !== null && !isOneOf(slot.formality, FORMALITY_VALUES)) {
		return false;
	}
	if (
		slot.reply_gate !== null &&
		!isOneOf(slot.reply_gate, REPLY_GATE_VALUES)
	) {
		return false;
	}
	if (
		!Array.isArray(slot.custom_directives) ||
		!slot.custom_directives.every((directive) => typeof directive === "string")
	) {
		return false;
	}
	if (typeof slot.updated_at !== "string") return false;
	if (
		slot.extraction_evidence_ids !== undefined &&
		(!Array.isArray(slot.extraction_evidence_ids) ||
			!slot.extraction_evidence_ids.every((id) => typeof id === "string"))
	)
		return false;
	if (!isOneOf(slot.source, PERSONALITY_SOURCES)) return false;
	const traitSources = slot.trait_sources;
	if (
		traitSources === null ||
		typeof traitSources !== "object" ||
		Array.isArray(traitSources)
	) {
		return false;
	}
	for (const [trait, source] of Object.entries(traitSources)) {
		if (!isOneOf(trait, GATED_TRAITS)) return false;
		if (!isOneOf(source, PERSONALITY_SOURCES)) return false;
	}
	return true;
}

/**
 * Structured store for personality slots (user + global) and named profiles.
 *
 * Persistence is in-memory, mirrored as agent memories so state survives a
 * runtime reload.
 */
export class PersonalityStore extends Service {
	static serviceType = PersonalityServiceType.PERSONALITY_STORE;

	capabilityDescription =
		"Structured personality slot store (user + global) with named profiles";

	private slots: Map<SlotKey, PersonalitySlot> = new Map();
	private profiles: Map<string, PersonalityProfile> = new Map();
	private audit: PersonalityAuditEntry[] = [];
	// Every slot mutation is read-modify-write across the durable upsert await,
	// so concurrent same-slot writers (PERSONALITY action, preference inference,
	// bench seeding) could interleave and silently drop a change. This chain
	// serializes writers per slot; readers stay synchronous on the cache.
	private slotWriteChains: Map<SlotKey, Promise<unknown>> = new Map();

	static async start(runtime: IAgentRuntime): Promise<PersonalityStore> {
		const store = new PersonalityStore(runtime);
		await store.initialize();
		return store;
	}

	private async initialize(): Promise<void> {
		await this.loadProfilesFromDisk();
		await this.hydrateSlotsFromMemory();
		logger.debug(
			{
				profileCount: this.profiles.size,
				slotCount: this.slots.size,
			},
			"PersonalityStore initialized",
		);
	}

	private async loadProfilesFromDisk(): Promise<void> {
		// Profiles are bundled JSON shipped next to this file. Avoid runtime
		// fs access entirely so this works in browser/mobile bundles too.
		// New profiles can be added to ../profiles/<name>.json and registered here.
		const { defaultProfiles } = await import("../profiles/index.ts");
		for (const profile of defaultProfiles) {
			this.profiles.set(profile.name, profile);
		}
	}

	private async hydrateSlotsFromMemory(): Promise<void> {
		const memories = await this.runtime.getMemories({
			tableName: PERSONALITY_SLOT_TABLE,
			roomId: this.runtime.agentId,
			metadata: { source: PERSONALITY_SLOT_MEMORY_SOURCE },
			count: 10_000,
		});
		for (const memory of memories) {
			const slot = this.slotFromMemory(memory);
			if (slot.agentId !== this.runtime.agentId) continue;
			this.cacheSlot(slot);
		}
	}

	private slotFromMemory(memory: Memory): PersonalitySlot {
		const metadata = memory.metadata as Record<string, unknown> | undefined;
		const slot = metadata?.slot;
		if (!isValidPersistedSlot(slot)) {
			throw new ElizaError("Invalid persisted personality slot memory", {
				code: "PERSONALITY_SLOT_MEMORY_INVALID",
				severity: "fatal",
				context: {
					memoryId: memory.id,
					agentId: this.runtime.agentId,
				},
			});
		}
		return clone(slot);
	}

	private cacheSlot(slot: PersonalitySlot): void {
		this.slots.set(slotKey(slot.agentId, slot.userId), clone(slot));
	}

	private async persistSlot(slot: PersonalitySlot): Promise<void> {
		const persisted = clone(slot);
		const timestamp = Date.parse(persisted.updated_at);
		const createdAt = Number.isFinite(timestamp) ? timestamp : Date.now();
		await this.runtime.upsertMemory(
			{
				id: slotMemoryId(persisted.agentId, persisted.userId),
				entityId: slotMemoryEntityId(persisted),
				roomId: persisted.agentId,
				agentId: persisted.agentId,
				content: {
					text: `personality_slot ${persisted.userId}`,
					source: PERSONALITY_SLOT_MEMORY_SOURCE,
				},
				metadata: {
					type: MemoryType.CUSTOM,
					source: PERSONALITY_SLOT_MEMORY_SOURCE,
					timestamp: createdAt,
					personalitySlotKey: slotKey(persisted.agentId, persisted.userId),
					personalityUserId: persisted.userId,
					personalityAgentId: persisted.agentId,
					slot: serializeSlotForMemory(persisted),
				},
				createdAt,
			},
			PERSONALITY_SLOT_TABLE,
		);
	}

	/**
	 * Append a write to the slot's chain so read-modify-write mutations never
	 * interleave. The returned promise carries the write's own outcome
	 * (including rejection) to its caller; the stored tail is settled so one
	 * failed write cannot poison every later write to the same slot.
	 */
	private enqueueSlotWrite<T>(
		key: SlotKey,
		write: () => Promise<T>,
	): Promise<T> {
		const previous = this.slotWriteChains.get(key) ?? Promise.resolve();
		const next = previous.then(write, write);
		// error-policy:J5 the rejection is observed by this write's caller via
		// `next`; the stored tail exists only to sequence the next writer.
		this.slotWriteChains.set(
			key,
			next.catch(() => {}),
		);
		return next;
	}

	private async persistAndCache(slot: PersonalitySlot): Promise<void> {
		await this.persistSlot(slot);
		this.cacheSlot(slot);
	}

	/**
	 * One canonical serialized mutation path: read the current slot, build the
	 * next one, persist durably, cache, audit. All public mutators route here
	 * so the write ordering and audit discipline cannot diverge per operation.
	 */
	private mutateSlot(args: {
		scope: PersonalityScope;
		targetId: UUID | typeof GLOBAL_PERSONALITY_SCOPE;
		agentId: UUID;
		actorId: UUID;
		build: (before: PersonalitySlot) => PersonalitySlot;
		action: (after: PersonalitySlot) => string;
		extractionEvidenceId?: string;
	}): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.enqueueSlotWrite(
			slotKey(args.agentId, args.targetId),
			async () => {
				const before = this.getSlot(args.targetId, args.agentId);
				if (
					args.extractionEvidenceId &&
					before.extraction_evidence_ids?.includes(args.extractionEvidenceId)
				)
					return { before, after: clone(before) };
				const after = args.build(before);
				if (args.extractionEvidenceId)
					after.extraction_evidence_ids = [
						...(before.extraction_evidence_ids ?? []),
						args.extractionEvidenceId,
					];
				await this.persistAndCache(after);
				this.recordAudit({
					actorId: args.actorId,
					scope: args.scope,
					targetId: args.targetId,
					action: args.action(after),
					before,
					after,
					timestamp: after.updated_at,
				});
				return { before, after };
			},
		);
	}

	getSlot(
		userId: UUID | typeof GLOBAL_PERSONALITY_SCOPE,
		agentId: UUID = this.runtime.agentId,
	): PersonalitySlot {
		const existing = this.slots.get(slotKey(agentId, userId));
		if (existing) return clone(existing);
		return emptyPersonalitySlot(userId, agentId);
	}

	async setSlot(slot: PersonalitySlot): Promise<void> {
		await this.enqueueSlotWrite(slotKey(slot.agentId, slot.userId), () =>
			this.persistAndCache(slot),
		);
	}

	listProfiles(): PersonalityProfile[] {
		return Array.from(this.profiles.values()).map((profile) => ({
			...profile,
			custom_directives: [...profile.custom_directives],
		}));
	}

	getProfile(name: string): PersonalityProfile | null {
		const profile = this.profiles.get(name);
		if (!profile) return null;
		return { ...profile, custom_directives: [...profile.custom_directives] };
	}

	saveProfile(profile: PersonalityProfile): void {
		this.profiles.set(profile.name, {
			...profile,
			custom_directives: [...profile.custom_directives],
		});
	}

	async loadProfileIntoGlobal(
		profile: PersonalityProfile,
		agentId: UUID = this.runtime.agentId,
		actorId: UUID = this.runtime.agentId,
	): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.mutateSlot({
			scope: "global",
			targetId: GLOBAL_PERSONALITY_SCOPE,
			agentId,
			actorId,
			build: () => {
				const trait_sources: PersonalitySlot["trait_sources"] = {};
				if (profile.verbosity !== null) trait_sources.verbosity = "admin";
				if (profile.tone !== null) trait_sources.tone = "admin";
				if (profile.formality !== null) trait_sources.formality = "admin";
				if (profile.reply_gate !== null) trait_sources.reply_gate = "admin";
				return {
					userId: GLOBAL_PERSONALITY_SCOPE,
					agentId,
					verbosity: profile.verbosity,
					tone: profile.tone,
					formality: profile.formality,
					reply_gate: profile.reply_gate,
					custom_directives: [...profile.custom_directives],
					updated_at: new Date().toISOString(),
					source: "admin",
					trait_sources,
				};
			},
			action: () => `load_profile:${profile.name}`,
		});
	}

	snapshotSlotAsProfile(
		slot: PersonalitySlot,
		name: string,
		description: string,
	): PersonalityProfile {
		const profile: PersonalityProfile = {
			name,
			description,
			verbosity: slot.verbosity,
			tone: slot.tone,
			formality: slot.formality,
			reply_gate: slot.reply_gate,
			custom_directives: [...slot.custom_directives],
		};
		this.saveProfile(profile);
		return profile;
	}

	recordAudit(entry: PersonalityAuditEntry): void {
		this.audit.push(entry);
		// Cap audit log size in-memory so a chatty agent doesn't OOM.
		if (this.audit.length > 1_000) {
			this.audit.splice(0, this.audit.length - 1_000);
		}
	}

	getRecentAudit(limit = 25): PersonalityAuditEntry[] {
		return this.audit.slice(-limit).reverse();
	}

	/**
	 * Drop every personality slot and audit entry. Bundled profile defaults are
	 * preserved (they are loaded from disk on initialize and never mutated by
	 * slot operations).
	 *
	 * Used by the benchmark harness's `/api/benchmark/reset` route so that
	 * personality state seeded by one scenario does not leak into the next
	 * scenario sharing the same runtime process.
	 */
	async clear(): Promise<void> {
		// Drain in-flight slot writes first so a racing mutation cannot
		// re-persist a slot after the wipe below (stored tails never reject).
		await Promise.all([...this.slotWriteChains.values()]);
		this.slotWriteChains.clear();
		const memories = await this.runtime.getMemories({
			tableName: PERSONALITY_SLOT_TABLE,
			roomId: this.runtime.agentId,
			metadata: { source: PERSONALITY_SLOT_MEMORY_SOURCE },
			count: 10_000,
		});
		for (const memory of memories) {
			if (memory.id) await this.runtime.deleteMemory(memory.id);
		}
		this.slots.clear();
		this.audit.length = 0;
	}

	/**
	 * Apply a trait change with audit. Returns the slot before and after.
	 */
	async applyTrait(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		trait: "verbosity" | "tone" | "formality";
		value: string | null;
		source?: PersonalitySlot["source"];
		extractionEvidenceId?: string;
	}): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.mutateSlot({
			extractionEvidenceId: args.extractionEvidenceId,
			scope: args.scope,
			targetId:
				args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId,
			agentId: args.agentId,
			actorId: args.actorId,
			build: (before) => {
				const source =
					args.source ?? (args.scope === "global" ? "admin" : "user");
				return {
					...before,
					[args.trait]: args.value,
					updated_at: new Date().toISOString(),
					source,
					trait_sources: nextTraitSources(
						before,
						args.trait,
						args.value,
						source,
					),
				};
			},
			action: () => `set_trait:${args.trait}=${args.value ?? "null"}`,
		});
	}

	async applyReplyGate(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		mode: PersonalitySlot["reply_gate"];
		source?: PersonalitySlot["source"];
	}): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.mutateSlot({
			scope: args.scope,
			targetId:
				args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId,
			agentId: args.agentId,
			actorId: args.actorId,
			build: (before) => {
				const source =
					args.source ?? (args.scope === "global" ? "admin" : "user");
				return {
					...before,
					reply_gate: args.mode,
					updated_at: new Date().toISOString(),
					source,
					trait_sources: nextTraitSources(
						before,
						"reply_gate",
						args.mode,
						source,
					),
				};
			},
			action: () => `set_reply_gate:${args.mode ?? "null"}`,
		});
	}

	async addDirective(args: {
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
		directive: string;
		source?: PersonalitySlot["source"];
		extractionEvidenceId?: string;
	}): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.mutateSlot({
			extractionEvidenceId: args.extractionEvidenceId,
			scope: "user",
			targetId: args.userId,
			agentId: args.agentId,
			actorId: args.actorId,
			build: (before) => {
				const next = [...before.custom_directives, args.directive];
				return {
					...before,
					custom_directives: next,
					updated_at: new Date().toISOString(),
					source: args.source ?? "user",
				};
			},
			action: () => `add_directive:${args.directive}`,
		});
	}

	async clearDirectives(args: {
		scope: PersonalityScope;
		userId: UUID;
		agentId: UUID;
		actorId: UUID;
	}): Promise<{ before: PersonalitySlot; after: PersonalitySlot }> {
		return this.mutateSlot({
			scope: args.scope,
			targetId:
				args.scope === "global" ? GLOBAL_PERSONALITY_SCOPE : args.userId,
			agentId: args.agentId,
			actorId: args.actorId,
			build: (before) => ({
				...before,
				custom_directives: [],
				updated_at: new Date().toISOString(),
				source: args.scope === "global" ? "admin" : "user",
			}),
			action: () => "clear_directives",
		});
	}

	async stop(): Promise<void> {
		logger.debug("PersonalityStore stopped");
	}
}

export function getPersonalityStore(
	runtime: IAgentRuntime,
): PersonalityStore | null {
	const store = runtime.getService<PersonalityStore>(
		PersonalityServiceType.PERSONALITY_STORE,
	);
	return store ?? null;
}
