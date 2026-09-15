/**
 * Provider in the personality capability that injects a user's structured
 * personality slot (verbosity, tone, formality, reply-gate, custom directives),
 * the global slot, and any legacy free-text preferences into the prompt, so the
 * agent adapts its style per-user without editing the character definition.
 * Reads slots from `PersonalityStore`; the export doc below covers the
 * global-then-user prompt-precedence rule.
 */
import { logger } from "../../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../../types/index.ts";
import { getPersonalityStore } from "../services/personality-store.ts";
import { type PersonalitySlot, USER_PREFS_TABLE } from "../types.ts";

function renderSlot(
	slot: PersonalitySlot,
	header: string,
	footer: string,
): string | null {
	const lines: string[] = [];
	if (slot.verbosity) lines.push(`- verbosity: ${slot.verbosity}`);
	if (slot.tone) lines.push(`- tone: ${slot.tone}`);
	if (slot.formality) lines.push(`- formality: ${slot.formality}`);
	if (slot.reply_gate && slot.reply_gate !== "always") {
		lines.push(`- reply_gate: ${slot.reply_gate}`);
	}
	if (slot.custom_directives.length > 0) {
		lines.push("- custom directives:");
		slot.custom_directives.forEach((directive, index) => {
			lines.push(`  ${index + 1}. ${directive}`);
		});
	}
	if (lines.length === 0) return null;
	const inferredTraits = Object.entries(slot.trait_sources)
		.filter(([, source]) => source === "agent_inferred")
		.map(([trait]) => trait);
	if (inferredTraits.length > 0 || slot.source === "agent_inferred") {
		// Name the inferred traits when per-trait provenance identifies them
		// (directive-only inference falls back to a blanket note). The model
		// should treat inferred style as an observation it can explain and
		// offer to undo, not a user order.
		const what =
			inferredTraits.length > 0 ? inferredTraits.join(", ") : "some of these";
		lines.push(
			`- provenance: ${what} inferred from conversation, not explicitly set; offer to adjust if the user objects`,
		);
	}
	return [header, ...lines, footer].join("\n");
}

/**
 * Injects per-user interaction preferences (structured slot + legacy free-text)
 * so the agent adapts its style for each individual user without changing the
 * global character definition.
 *
 * Resolution rule: GLOBAL slot is rendered first (lower precedence in the
 * model's eye), then USER slot. When both set the same trait, the user's
 * value wins because it appears later in the prompt and is labeled as
 * applying to THIS user.
 */
export const userPersonalityProvider: Provider = {
	name: "userPersonalityPreferences",
	description:
		"Injects per-user and global structured personality slots plus any legacy free-text preferences",
	dynamic: true,
	// Reply style applies before routing; context selection must not hide it
	// from the first response. The USER gate still protects personal data.
	alwaysInResponseState: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		// Skip for agent's own messages (e.g. evolution evaluator)
		if (message.entityId === runtime.agentId) {
			return { text: "", values: {}, data: {} };
		}

		const blocks: string[] = [];
		const store = getPersonalityStore(runtime);

		if (store) {
			const globalSlot = store.getSlot("global");
			const globalBlock = renderSlot(
				globalSlot,
				"[GLOBAL PERSONALITY]",
				"[/GLOBAL PERSONALITY]",
			);
			if (globalBlock) blocks.push(globalBlock);

			const userSlot = store.getSlot(message.entityId);
			const userBlock = renderSlot(
				userSlot,
				"[PERSONALITY for THIS user]",
				"[/PERSONALITY for THIS user]",
			);
			if (userBlock) blocks.push(userBlock);
		}

		// Legacy free-text preferences (kept for backward compatibility).
		let legacyCount = 0;
		try {
			const preferences = await runtime.getMemories({
				entityId: message.entityId,
				authorEntityIds: [message.entityId],
				roomId: runtime.agentId,
				tableName: USER_PREFS_TABLE,
			});
			const prefTexts = preferences
				.map((p) => p.content.text)
				.filter((t): t is string => typeof t === "string" && t.length > 0);
			if (prefTexts.length > 0) {
				legacyCount = prefTexts.length;
				blocks.push(
					[
						"[USER INTERACTION PREFERENCES]",
						"The following preferences apply ONLY when responding to THIS specific user:",
						...prefTexts.map((t, i) => `${i + 1}. ${t}`),
						"[/USER INTERACTION PREFERENCES]",
					].join("\n"),
				);
			}
		} catch (error) {
			// error-policy:J4 Legacy preferences are optional compatibility context;
			// current profile blocks remain explicit and authoritative.
			runtime.reportError("UserPersonalityProvider.legacyPreferences", error, {
				entityId: message.entityId,
			});
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to load legacy user personality preferences",
			);
		}

		if (blocks.length === 0) {
			return { text: "", values: {}, data: {} };
		}

		const contextText = blocks.join("\n\n");
		return {
			text: contextText,
			values: {
				hasUserPreferences: true,
				userPreferenceCount: legacyCount,
			},
			data: {
				userId: message.entityId,
			},
		};
	},
};
