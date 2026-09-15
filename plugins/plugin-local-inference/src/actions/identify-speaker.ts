/**
 * @module plugin-local-inference/actions/identify-speaker
 *
 * `IDENTIFY_SPEAKER` agent action — the explicit, user-driven half of the
 * voice → entity binding (issue #8234, shape #2).
 *
 * When the OWNER names a voice the agent just heard but hasn't identified
 * ("that was Jill", "this is my friend Sam"), this action binds the most
 * recently observed *unidentified* speaker profile to a named person. It
 * does not touch the entity graph directly — it emits `VOICE_TURN_OBSERVED`
 * so the merge engine (plugin-lifeops) creates/merges the Entity, then the
 * round-trip `VOICE_ENTITY_BOUND` handler persists `entityId` back onto the
 * voice profile. If no merge-engine plugin is loaded the action is inert
 * beyond logging intent.
 *
 * Target selection: an explicit `profileId` option wins; otherwise the
 * single most-recently-observed profile whose `entityId` is still `null`
 * (i.e. "the person who just spoke and isn't known yet").
 *
 * `name` and `profileId` are declared `parameters` so core's tool-argument
 * validator lets the planner pass them; validated values arrive nested under
 * `options.parameters`, while direct callers may still pass them top-level.
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type IAgentRuntime,
	logger,
	type Memory,
	type VoiceSpeakerNameInferencePayload,
} from "@elizaos/core";
import {
	inferSpeakerName,
	type SpeakerNameEvidence,
} from "../runtime/speaker-name-inference.js";
import {
	emitVoiceTurnObserved,
	getVoiceProfileStore,
} from "../runtime/voice-entity-binding.js";
import type { VoiceProfileRecord } from "../services/voice/profile-store.js";

function extractMessageText(message: Memory | null | undefined): string {
	const content = message?.content;
	if (!content) return "";
	const text = (content as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

/**
 * Extract a person name the owner is attaching to a heard voice. Mirrors
 * the trigger phrases lifeops' `extractSelfNameClaim` understands so the
 * downstream entity gets the same `preferredName`. Returns the name or
 * `null`.
 */
const NAME = "[A-Z][A-Za-z'.-]{1,40}(?:\\s+[A-Z][A-Za-z'.-]{1,40}){0,2}";
const SPEAKER_NAME_PATTERNS: RegExp[] = [
	new RegExp(`\\bthat\\s+(?:was|is)\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bthis\\s+is\\s+(?:my\\s+\\w+\\s+)?(${NAME})\\b`, "i"),
	new RegExp(`\\bcall\\s+(?:him|her|them)\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\b(?:his|her|their)\\s+name\\s+is\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bnamed?\\s+(${NAME})\\b`, "i"),
	new RegExp(`\\bspeaker\\s+(?:was|is)\\s+(${NAME})\\b`, "i"),
];

export function extractSpeakerName(text: string): string | null {
	for (const pattern of SPEAKER_NAME_PATTERNS) {
		const m = pattern.exec(text);
		if (m?.[1]) {
			let end = m[1].length;
			while (end > 0 && ".,;:!?".includes(m[1][end - 1] ?? "")) end -= 1;
			const cleaned = m[1].slice(0, end).trim();
			if (cleaned.length > 0) return cleaned;
		}
	}
	return null;
}

function pickTarget(
	records: VoiceProfileRecord[],
	explicitProfileId: string | null,
): VoiceProfileRecord | null {
	if (explicitProfileId) {
		return records.find((r) => r.profileId === explicitProfileId) ?? null;
	}
	const unbound = records
		.filter((r) => r.entityId === null)
		.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt));
	return unbound[0] ?? null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

/** Read a string option from `options.<key>`, then `options.parameters.<key>`. */
function optionString(options: unknown, key: string): string | null {
	if (!options || typeof options !== "object") return null;
	const record = options as Record<string, unknown>;
	const direct = nonEmptyString(record[key]);
	if (direct) return direct;
	const parameters = record.parameters;
	if (!parameters || typeof parameters !== "object") return null;
	return nonEmptyString((parameters as Record<string, unknown>)[key]);
}

function metadataLabel(record: VoiceProfileRecord): string | null {
	const label = record.metadata?.label;
	return typeof label === "string" && label.trim() ? label.trim() : null;
}

function buildSpeakerNameInference(args: {
	name: string;
	message: Memory;
	target: VoiceProfileRecord;
	records: VoiceProfileRecord[];
}): VoiceSpeakerNameInferencePayload {
	const evidence: SpeakerNameEvidence[] = [
		{
			source: "user_correction",
			name: args.name,
			confidence: 1,
			profileId: args.target.profileId,
			...(typeof args.message.id === "string"
				? { evidenceId: args.message.id }
				: {}),
		},
	];
	const targetLabel = metadataLabel(args.target);
	if (targetLabel) {
		evidence.push({
			source: "voice_profile",
			name: targetLabel,
			confidence: args.target.confidence,
			profileId: args.target.profileId,
			...(args.target.entityId ? { entityId: args.target.entityId } : {}),
		});
	}
	for (const record of args.records) {
		if (
			record.profileId === args.target.profileId ||
			record.imprintClusterId !== args.target.imprintClusterId
		) {
			continue;
		}
		const label = metadataLabel(record);
		if (!label) continue;
		evidence.push({
			source: "speaker_memory",
			name: label,
			confidence: record.confidence,
			profileId: record.profileId,
			...(record.entityId ? { entityId: record.entityId } : {}),
			observedAt: record.lastObservedAt,
		});
	}
	const inferred = inferSpeakerName({
		speakerId: args.target.profileId,
		imprintClusterId: args.target.imprintClusterId,
		evidence,
	});
	return {
		resolution: inferred.resolution,
		...(inferred.displayName ? { displayName: inferred.displayName } : {}),
		confidence: inferred.confidence,
		candidateNames: inferred.candidateNames,
		provenance: inferred.provenance,
		reasonCodes: inferred.reasonCodes,
		requiresReview: inferred.requiresReview,
	};
}

async function handler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: unknown,
	options?: unknown,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const text = extractMessageText(message);
	const name = optionString(options, "name") ?? extractSpeakerName(text);
	if (!name) {
		const out =
			'Tell me the name to attach to the voice you just heard — e.g. "that was Jill".';
		await callback?.({ text: out });
		return { success: false, text: out };
	}

	const store = await getVoiceProfileStore();
	const records = await store.list();
	const target = pickTarget(records, optionString(options, "profileId"));
	if (!target) {
		const out = `I don't have an unidentified recent voice to attach "${name}" to yet.`;
		await callback?.({ text: out });
		return { success: false, text: out };
	}
	const speakerNameInference = buildSpeakerNameInference({
		name,
		message,
		target,
		records,
	});
	if (
		speakerNameInference.resolution !== "confirmed" ||
		!speakerNameInference.displayName
	) {
		const out = `I need confirmation before binding that voice to ${name}.`;
		await callback?.({ text: out });
		return {
			success: false,
			text: out,
			data: { speakerNameInference },
		};
	}

	// Drive the merge engine through the event seam. `emitEvent` awaits all
	// handlers, so when this resolves the round-trip binding has run.
	try {
		await emitVoiceTurnObserved(runtime, {
			turnId: typeof message.id === "string" ? message.id : undefined,
			text: `This is ${name}.`,
			imprintClusterId: target.imprintClusterId,
			matchConfidence: 1,
			matchedEntityId: null,
			isOwner: false,
			speakerNameInference,
		});
	} catch (err) {
		logger.error(
			{ err, profileId: target.profileId, name },
			"[IDENTIFY_SPEAKER] failed to emit voice-turn observation",
		);
		const out = `I couldn't save ${name}'s voice just now.`;
		await callback?.({ text: out });
		return { success: false, text: out, error: out };
	}

	const updated = await store.get(target.profileId);
	const entityId = updated?.entityId ?? null;
	if (!entityId) {
		const out = `I couldn't bind ${name}'s voice because identity sync is unavailable.`;
		await callback?.({ text: out });
		return {
			success: false,
			text: out,
			error: out,
			data: {
				profileId: target.profileId,
				imprintClusterId: target.imprintClusterId,
				entityId,
				name,
				speakerNameInference,
			},
		};
	}
	const out = `Got it — I'll remember ${name}'s voice from now on.`;
	await callback?.({ text: out });
	return {
		success: true,
		text: out,
		data: {
			profileId: target.profileId,
			imprintClusterId: target.imprintClusterId,
			entityId,
			name,
			speakerNameInference,
		},
	};
}

async function validate(
	_runtime: IAgentRuntime,
	message: Memory,
): Promise<boolean> {
	return extractMessageText(message).trim().length > 0;
}

export const identifySpeakerAction: Action = {
	name: "IDENTIFY_SPEAKER",
	similes: ["NAME_SPEAKER", "REMEMBER_VOICE", "THIS_IS_SPEAKER", "TAG_VOICE"],
	description:
		'Attach a name to the most recently heard, still-unidentified voice so the agent recognizes that person across sessions. Use when the owner says who a recent speaker is ("that was Jill", "this is my friend Sam").',
	routingHint:
		"owner names a recent unknown speaker -> IDENTIFY_SPEAKER; not for naming the owner themselves or contacts unrelated to a heard voice",
	parameters: [
		{
			name: "name",
			description:
				"Name to attach to the heard voice, exactly as the owner said it (for example Jill, Bob Smith). Omit to extract it from the message text.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "profileId",
			description:
				"Id of the voice profile to bind. Omit to target the most recently heard voice that is still unidentified.",
			required: false,
			aliases: ["profile_id", "voiceProfileId"],
			schema: { type: "string" },
		},
	],
	validate,
	handler,
	examples: [],
};
