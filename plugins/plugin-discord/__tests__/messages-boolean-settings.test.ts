/**
 * Pins how `MessageManager` resolves the DISCORD_DRAFT_STREAMING and
 * DISCORD_ENVELOPE_ENABLED flags. The runtime under test delegates to the real
 * `AgentRuntime.prototype.getSetting`, which coerces the strings "true" and
 * "false" to booleans before returning, so the assertions cover the value the
 * production runtime actually hands the manager as well as the raw "1"/"0"
 * forms. Only the Discord service is a stub; no client, token, or network.
 */
import { AgentRuntime, ChannelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { MessageManager } from "../messages.ts";
import type { ICompatRuntime, IDiscordService } from "../types.ts";

const noop = () => {};

function makeRuntime(secrets: Record<string, string>): ICompatRuntime {
	// A real, uninitialized AgentRuntime supplies the production getSetting
	// coercion; the manager only needs the settings surface at construction.
	const real = new AgentRuntime({
		character: { name: "Eliza", bio: [], secrets },
		plugins: [],
	});
	return {
		agentId: real.agentId,
		character: real.character,
		logger: { debug: noop, info: noop, warn: noop, error: noop },
		getSetting: (key: string) => real.getSetting(key),
		getService: () => null,
	} as unknown as ICompatRuntime;
}

function makeDiscordService(): IDiscordService {
	return {
		client: { user: { id: "888000000000000000" } },
		accountId: "default",
		getChannelType: async () => ChannelType.DM,
		discordSettings: {
			autoReply: true,
			dmPolicy: "open",
			shouldIgnoreBotMessages: true,
			shouldIgnoreDirectMessages: false,
			replyToMode: "first",
		},
	} as unknown as IDiscordService;
}

function resolvedFlags(secrets: Record<string, string>) {
	const manager = new MessageManager(
		makeDiscordService(),
		makeRuntime(secrets),
	);
	const { draftStreamingEnabled, envelopeEnabled } = manager as unknown as {
		draftStreamingEnabled: boolean;
		envelopeEnabled: boolean;
	};
	return { draftStreamingEnabled, envelopeEnabled };
}

describe("MessageManager boolean flag settings", () => {
	it("real getSetting coerces the string flags to booleans", () => {
		const runtime = makeRuntime({
			DISCORD_DRAFT_STREAMING: "true",
			DISCORD_ENVELOPE_ENABLED: "false",
		});
		expect(runtime.getSetting("DISCORD_DRAFT_STREAMING")).toBe(true);
		expect(runtime.getSetting("DISCORD_ENVELOPE_ENABLED")).toBe(false);
	});

	it("enables draft streaming and disables envelopes from the coerced booleans", () => {
		expect(
			resolvedFlags({
				DISCORD_DRAFT_STREAMING: "true",
				DISCORD_ENVELOPE_ENABLED: "false",
			}),
		).toEqual({ draftStreamingEnabled: true, envelopeEnabled: false });
	});

	it("keeps the defaults when the flags are unset", () => {
		expect(resolvedFlags({})).toEqual({
			draftStreamingEnabled: false,
			envelopeEnabled: true,
		});
	});

	it("still accepts the numeric string forms", () => {
		expect(
			resolvedFlags({
				DISCORD_DRAFT_STREAMING: "1",
				DISCORD_ENVELOPE_ENABLED: "0",
			}),
		).toEqual({ draftStreamingEnabled: true, envelopeEnabled: false });
		expect(
			resolvedFlags({
				DISCORD_DRAFT_STREAMING: "0",
				DISCORD_ENVELOPE_ENABLED: "1",
			}),
		).toEqual({ draftStreamingEnabled: false, envelopeEnabled: true });
	});

	it("treats an unparseable flag as unset", () => {
		expect(
			resolvedFlags({
				DISCORD_DRAFT_STREAMING: "maybe",
				DISCORD_ENVELOPE_ENABLED: "maybe",
			}),
		).toEqual({ draftStreamingEnabled: false, envelopeEnabled: true });
	});
});
