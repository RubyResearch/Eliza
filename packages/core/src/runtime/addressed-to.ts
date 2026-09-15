/**
 * Resolves and persists the message handler's `addressedTo` targets. Upserts
 * "addressed" relationship edges from the speaker to each resolved participant,
 * and decides whether an inbound turn is directed at another participant (so the
 * agent is merely overhearing and should not act on it). All name/id resolution
 * runs against the room's entity list, without an LLM call.
 */
import type { Entity, UUID } from "../types/index";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

/**
 * Post-parse persistence for the messageHandler's `extract.addressedTo`
 * field. No LLM call: each UUID or participant name is resolved against
 * the room's entity list and the known conversation identities. For each
 * resolved target we upsert an "addressed" relationship edge from the
 * speaker to the target.
 *
 * The point of folding this into Stage 1 is precisely that it does NOT
 * require its own LLM call — every inbound message already runs the
 * messageHandler, so picking up addressee data is free.
 */

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ADDRESSED_RELATIONSHIP_TAGS = ["addressed", "addressed:auto"] as const;
const ADDRESSED_METADATA_SOURCE = "message_handler_addressedTo";

export interface ApplyAddressedToArgs {
	runtime: IAgentRuntime;
	message: Memory;
	addressedTo: readonly string[];
}

export interface ApplyAddressedToResult {
	created: number;
	updated: number;
	resolved: UUID[];
}

export async function applyAddressedTo(
	args: ApplyAddressedToArgs,
): Promise<ApplyAddressedToResult> {
	const { runtime, message, addressedTo } = args;
	const empty: ApplyAddressedToResult = {
		created: 0,
		updated: 0,
		resolved: [],
	};
	if (!addressedTo || addressedTo.length === 0) {
		return empty;
	}
	const speakerId = message.entityId as UUID | undefined;
	if (!speakerId) {
		return empty;
	}

	const targets = await resolveAddressedTargets({
		runtime,
		message,
		addressedTo,
	});
	if (targets.length === 0) {
		return empty;
	}

	const resolved: UUID[] = [];
	let created = 0;
	let updated = 0;
	const nowIso = new Date().toISOString();

	for (const targetId of targets) {
		if (targetId === speakerId) {
			continue;
		}
		resolved.push(targetId);

		const existingList = await runtime.getRelationships({
			entityIds: [speakerId],
			tags: [ADDRESSED_RELATIONSHIP_TAGS[0]],
		});
		const existing = existingList.find(
			(rel) =>
				rel.sourceEntityId === speakerId && rel.targetEntityId === targetId,
		);

		if (existing) {
			const existingMetadata =
				(existing.metadata as Record<string, unknown> | undefined) ?? {};
			await runtime.updateRelationship({
				...existing,
				tags: dedupeTags([...existing.tags, ...ADDRESSED_RELATIONSHIP_TAGS]),
				metadata: {
					...existingMetadata,
					lastInteractionAt: nowIso,
					source: ADDRESSED_METADATA_SOURCE,
				},
			});
			updated += 1;
			continue;
		}

		await runtime.createRelationship({
			sourceEntityId: speakerId,
			targetEntityId: targetId,
			tags: [...ADDRESSED_RELATIONSHIP_TAGS],
			metadata: {
				lastInteractionAt: nowIso,
				source: ADDRESSED_METADATA_SOURCE,
			},
		});
		created += 1;
	}

	return { created, updated, resolved };
}

interface ResolveTargetsArgs {
	runtime: IAgentRuntime;
	message: Memory;
	addressedTo: readonly string[];
}

/**
 * True only when a turn is verifiably directed at a resolvable OTHER room
 * participant. Three invariants bound the answer, because a positive here
 * converts the turn into deliberate silence:
 *
 *  - addressed to US (by name, id, or platform alias) never gates;
 *  - a tag that resolves to the message's own AUTHOR never gates (a message
 *    cannot be addressed to its own speaker — that is a Stage-1 extraction
 *    error);
 *  - corroboration: the gate may only silence on evidence it can verify
 *    itself — the message text must actually address the tagged participant
 *    by one of their names. An uncorroborated model tag never gates.
 *
 * Fails SAFE (returns false) whenever it cannot positively confirm all of the
 * above: empty `addressedTo`, unresolvable bare names, DMs and undirected
 * asks all return false and the agent keeps acting on requests meant for it.
 */
export async function messageAddressedToOtherParticipant(
	args: ApplyAddressedToArgs,
): Promise<boolean> {
	const { runtime, message, addressedTo } = args;
	if (!addressedTo || addressedTo.length === 0) {
		return false;
	}

	const normalize = (value: string) =>
		value.trim().toLowerCase().replace(/^@/, "");
	const self = new Set<string>();
	const selfId = runtime.agentId;
	if (selfId) self.add(selfId.toLowerCase());
	const selfName = runtime.character?.name;
	if (selfName) self.add(normalize(selfName));
	const selfUsername = runtime.character?.username;
	if (selfUsername) self.add(normalize(selfUsername));

	const cleaned = addressedTo
		.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
		.filter((entry) => entry.length > 0);
	if (cleaned.length === 0) {
		return false;
	}

	// Addressed to us by literal name/id → handle normally, never suppress.
	if (cleaned.some((entry) => self.has(normalize(entry)))) {
		return false;
	}

	// Resolve names→ids against the room. This also maps the agent's OWN entity
	// aliases (platform handles like @samantha_ai_bot that connectors store on
	// the agent's entity) to selfId, so a turn addressed to us by an alias is NOT
	// mistaken for an other-participant address.
	const targets = await resolveAddressedTargets({
		runtime,
		message,
		addressedTo,
	});
	if (selfId && targets.some((id) => id === selfId)) {
		return false;
	}

	// A message cannot be addressed to its own author: a tag that resolves to
	// the SPEAKER is a Stage-1 extraction error, never an other-participant
	// address (live 2026-08-22: "hello?" / "did u see what i said?" were tagged
	// with the asker's own name and silently suppressed).
	const speakerId = message.entityId;
	const others = speakerId ? targets.filter((id) => id !== speakerId) : targets;
	if (others.length === 0) {
		return false;
	}

	// Corroboration invariant: a deterministic gate may only SILENCE a turn on
	// evidence it can verify itself. The Stage-1 tag picks WHO, but suppression
	// additionally requires the message text to actually address that
	// participant by one of their names ("Hey Eliza …" corroborates a tag of
	// Eliza). An uncorroborated tag — the model hallucinating an addressee the
	// text never names (live 2026-08-22: "nubilio whats the setting …" tagged
	// as addressed to shaw) — must never convert a turn into silence.
	const participants = await runtime.getEntitiesForRoom(message.roomId);
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	const othersSet = new Set(others);
	const corroborated = participants.some((participant) => {
		if (!participant.id || !othersSet.has(participant.id)) return false;
		return (participant.names ?? []).some((name) => {
			const candidate = normalize(name ?? "");
			if (candidate.length < 2) return false;
			return new RegExp(
				`(^|[^\\p{L}\\p{N}])@?${candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^\\p{L}\\p{N}])`,
				"iu",
			).test(text);
		});
	});
	return corroborated;
}

export async function resolveAddressedTargets(
	args: ResolveTargetsArgs,
): Promise<UUID[]> {
	const { runtime, message, addressedTo } = args;
	const cleaned = Array.from(
		new Set(
			addressedTo
				.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
				.filter((entry) => entry.length > 0),
		),
	);
	if (cleaned.length === 0) {
		return [];
	}

	// A syntactically valid model-generated UUID is not evidence that an entity
	// exists or participates in this room. Resolve it at the same boundary as names.
	const uuids = new Set<UUID>();
	const names: string[] = [];
	for (const entry of cleaned) {
		if (UUID_PATTERN.test(entry)) {
			uuids.add(entry.toLowerCase() as UUID);
		} else {
			names.push(entry);
		}
	}

	if (names.length > 0 || uuids.size > 0) {
		const participants = await runtime.getEntitiesForRoom(message.roomId);
		const participantIds = new Set([
			runtime.agentId,
			message.entityId,
			...participants.map((entity) => entity.id),
		]);
		for (const id of uuids) {
			if (!participantIds.has(id)) uuids.delete(id);
		}
		const normalize = (value: string) => value.trim().toLowerCase();
		const byName = new Map<string, UUID>();
		const agentName = runtime.character.name;
		if (agentName) {
			byName.set(normalize(agentName), runtime.agentId);
		}
		for (const entity of participants) {
			const id = entity.id as UUID | undefined;
			if (!id) continue;
			for (const name of entityNames(entity)) {
				byName.set(normalize(name), id);
			}
		}
		for (const name of names) {
			const stripped = name.replace(/^@/, "");
			const hit = byName.get(normalize(stripped));
			if (hit) {
				uuids.add(hit);
			}
		}
	}

	return Array.from(uuids);
}

function entityNames(entity: Entity): string[] {
	const names = entity.names;
	if (!Array.isArray(names)) return [];
	return names.filter(
		(n): n is string => typeof n === "string" && n.length > 0,
	);
}

function dedupeTags(tags: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const tag of tags) {
		if (typeof tag !== "string" || tag.length === 0) continue;
		if (seen.has(tag)) continue;
		seen.add(tag);
		result.push(tag);
	}
	return result;
}

/**
 * Structural vocative detection: true when the message TEXT opens by
 * addressing another room participant by name — "hey eliza", "eliza, can you
 * …", "gm sol" — and that participant is not us. This needs no Stage-1 tag:
 * a leading vocative is evidence the gate can verify itself, so an
 * interjection-prone model that leaves `addressedTo` empty (live 2026-08-22:
 * "hey eliza" → tags []; the agent answered "hey. you alright?") no longer
 * fails open. Deliberately narrow: only a name in the vocative position at
 * the very start (optionally after a greeting word) counts — "i was talking
 * to eliza" or "can you ping eliza for me" never match, because a mid-text
 * name is a mention, not an address.
 */
export async function messageVocativelyAddressesOtherParticipant(args: {
	runtime: IAgentRuntime;
	message: Memory;
}): Promise<boolean> {
	const { runtime, message } = args;
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	if (!text.trim()) return false;

	const normalize = (value: string) =>
		value.trim().toLowerCase().replace(/^@/, "");
	const self = new Set<string>();
	if (runtime.agentId) self.add(runtime.agentId.toLowerCase());
	for (const name of [runtime.character?.name, runtime.character?.username]) {
		const candidate = name?.trim();
		if (!candidate) continue;
		self.add(normalize(candidate));
		for (const token of candidate.split(/\s+/u)) {
			if (token.length >= 4) self.add(normalize(token));
		}
	}

	const participants = await runtime.getEntitiesForRoom(message.roomId);
	const speakerId = message.entityId;
	for (const participant of participants) {
		if (!participant.id) continue;
		if (participant.id === runtime.agentId) continue;
		if (speakerId && participant.id === speakerId) continue;
		for (const rawName of participant.names ?? []) {
			const name = normalize(rawName ?? "");
			if (name.length < 2 || self.has(name)) continue;
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			const vocative = new RegExp(
				`^\\s*(?:hey|hi|yo|sup|hello|gm|gn|ok|okay)?\\s*[,–—-]?\\s*@?${escaped}(?=$|[^\\p{L}\\p{N}])`,
				"iu",
			);
			if (vocative.test(text)) {
				// A leading vocative of OUR name keeps
				// the turn ours ("nubilio, ask eliza …" opens with us, not them).
				const oursFirst = [...self].some((own) => {
					const ownEscaped = own.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
					return new RegExp(
						`^\\s*(?:hey|hi|yo|sup|hello|gm|gn|ok|okay)?\\s*[,–—-]?\\s*@?${ownEscaped}(?=$|[^\\p{L}\\p{N}])`,
						"iu",
					).test(text);
				});
				if (!oursFirst) return true;
			}
		}
	}
	return false;
}
