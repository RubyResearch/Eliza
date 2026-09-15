/**
 * MESSAGE connector account resolution. A connector service registers a
 * legacy source-level route beside one route per account, so a single
 * account is two connectors aliasing the same source; only distinct accounts
 * are ambiguous.
 */
import { describe, expect, it } from "vitest";
import type { Room } from "../../../types/environment";
import {
	DEFAULT_RECENT_READ_LIMIT,
	rankLocalChannelRooms,
	recentReadLimit,
	selectConnectorForOp,
	soleConnectorFamily,
} from "./message";

type Connector = Parameters<typeof selectConnectorForOp>[0][number];

function connector(
	overrides: Partial<Connector> & Pick<Connector, "source" | "label">,
): Connector {
	return {
		capabilities: ["send_message"],
		supportedTargetKinds: [],
		contexts: [],
		...overrides,
	} as Connector;
}

describe("selectConnectorForOp", () => {
	const legacy = connector({ source: "discord", label: "Discord" });
	const scoped = connector({
		source: "discord",
		label: "Discord (default)",
		accountId: "default",
	});

	it("resolves a single account registered beside its legacy source route (live: read #general from the owner API)", () => {
		const selection = selectConnectorForOp(
			[legacy, scoped],
			"discord",
			"agent_message_api",
			"read_channel",
		);
		expect(selection).toMatchObject({
			connector: { source: "discord", accountId: "default" },
		});
	});

	it("still honours an explicit account", () => {
		expect(
			selectConnectorForOp(
				[legacy, scoped],
				"discord",
				undefined,
				"read_channel",
				"default",
			),
		).toMatchObject({ connector: { accountId: "default" } });
	});

	it("keeps two distinct accounts ambiguous without an account", () => {
		const team = connector({
			source: "discord",
			label: "Discord (team)",
			accountId: "team",
		});
		const selection = selectConnectorForOp(
			[legacy, scoped, team],
			"discord",
			undefined,
			"read_channel",
		);
		expect(selection).toMatchObject({
			error: { success: false, values: { error: "SOURCE_AMBIGUOUS" } },
		});
	});

	it("treats a legacy route beside its single account route as one connector family", () => {
		expect(soleConnectorFamily([legacy, scoped])).toBe(scoped);
		expect(soleConnectorFamily([scoped])).toBe(scoped);
		expect(soleConnectorFamily([])).toBeUndefined();
		const team = connector({
			source: "discord",
			label: "Discord (team)",
			accountId: "team",
		});
		expect(soleConnectorFamily([legacy, scoped, team])).toBeUndefined();
		const telegram = connector({ source: "telegram", label: "Telegram" });
		expect(soleConnectorFamily([scoped, telegram])).toBeUndefined();
	});
});

describe("rankLocalChannelRooms", () => {
	const room = (overrides: Partial<Room> & { name: string }): Room =>
		({ id: overrides.name, source: "discord", ...overrides }) as Room;

	it("prefers the exact text channel over a same-named voice channel and over substring matches (live: #general read 0 messages from the voice room)", () => {
		const voice = room({
			name: "General",
			type: "VOICE_GROUP" as Room["type"],
		});
		const text = room({ name: "general", type: "GROUP" as Room["type"] });
		const partial = room({
			name: "general-announcements",
			type: "GROUP" as Room["type"],
		});
		expect(
			rankLocalChannelRooms([voice, partial, text], undefined, "#general").map(
				(entry) => entry.name,
			),
		).toEqual(["general", "General", "general-announcements"]);
		expect(rankLocalChannelRooms([voice], undefined, "general")).toEqual([
			voice,
		]);
		expect(rankLocalChannelRooms([text], "telegram", "general")).toEqual([]);
	});

	it("bounds a recent read with no limit and honors explicit limits and dated ranges", () => {
		expect(recentReadLimit(undefined, undefined)).toBe(
			DEFAULT_RECENT_READ_LIMIT,
		);
		expect(recentReadLimit("recent", undefined)).toBe(
			DEFAULT_RECENT_READ_LIMIT,
		);
		expect(recentReadLimit("recent", 3)).toBe(3);
		expect(recentReadLimit("dates", undefined)).toBeUndefined();
	});
});
