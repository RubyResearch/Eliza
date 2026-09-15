/**
 * Shared room transcript for the merged post-turn evaluator: connector
 * record-of-send rows retain their distinct provenance, distinct
 * turns with identical wording are kept, hygiene filtering applies, and the
 * read is memoized per message. Runtime doubles; no database or model.
 */
import { describe, expect, it, vi } from "vitest";
import { wrapExternalContent } from "../security/external-content";
import type { IAgentRuntime, Memory, UUID } from "../types";
import {
	formatRecentMessages,
	getRoomTranscript,
} from "./evaluator-transcript";

const AGENT = "00000000-0000-0000-0000-0000000000a0" as UUID;
const USER = "00000000-0000-0000-0000-0000000000b0" as UUID;
const ROOM = "00000000-0000-0000-0000-0000000000c0" as UUID;

function row(
	id: string,
	entityId: UUID,
	text: string,
	createdAt: number,
	extra: Record<string, unknown> = {},
): Memory {
	return {
		id: `00000000-0000-0000-0000-0000000000${id}` as UUID,
		entityId,
		agentId: AGENT,
		roomId: ROOM,
		createdAt,
		content: { text, source: "test" },
		...extra,
	} as Memory;
}

function runtimeWith(memories: Memory[]) {
	const getMemories = vi.fn(async () => memories);
	return {
		runtime: { agentId: AGENT, getMemories } as unknown as IAgentRuntime,
		getMemories,
	};
}

describe("getRoomTranscript", () => {
	it("preserves a connector record-of-send row with distinct provenance", async () => {
		// Live Discord 2026-09-05: core persists the reply, then the connector
		// persists its own copy ~100 ms later with metadata.platformMessageId.
		const memories = [
			row("01", USER, "what is 8*7?", 1000),
			row("02", AGENT, "56", 2000),
			row("03", AGENT, "56", 2100, {
				content: { text: "56", source: "discord" },
				metadata: { type: "message", platformMessageId: "1490" },
			}),
			row("04", USER, "thanks", 3000),
		];
		const { runtime } = runtimeWith(memories);
		const transcript = await getRoomTranscript(
			runtime,
			row("ff", USER, "next", 4000),
		);
		expect(transcript.map((memory) => memory.content.text)).toEqual([
			"what is 8*7?",
			"56",
			"56",
			"thanks",
		]);
		expect(formatRecentMessages(transcript).split("56")).toHaveLength(3);
	});

	it("keeps identical wording from distinct turns", async () => {
		const memories = [
			row("01", USER, "go home", 1000),
			row("02", AGENT, "done — you're on Home.", 2000),
			row("03", USER, "go home", 3000),
			row("04", AGENT, "done — you're on Home.", 4000),
		];
		const { runtime } = runtimeWith(memories);
		const transcript = await getRoomTranscript(
			runtime,
			row("ff", USER, "next", 5000),
		);
		expect(transcript).toHaveLength(4);
	});

	it("reads once per message and orders chronologically", async () => {
		const memories = [
			row("02", AGENT, "second", 2000),
			row("01", USER, "first", 1000),
		];
		const { runtime, getMemories } = runtimeWith(memories);
		const message = row("ff", USER, "next", 3000);
		const [a, b] = await Promise.all([
			getRoomTranscript(runtime, message),
			getRoomTranscript(runtime, message),
		]);
		expect(a).toBe(b);
		expect(getMemories).toHaveBeenCalledTimes(1);
		expect(a.map((memory) => memory.content.text)).toEqual(["first", "second"]);
	});
});

describe("formatRecentMessages", () => {
	it("renders a stored external envelope without replaying the warning block", () => {
		// Live Discord 2026-09-06: 403 webhook rows each replayed the full
		// security notice into the post-turn evaluator prompt (137K tokens,
		// rejected by the provider), so memory extraction failed every turn.
		const payload = "Build 42 passed.\nArtifacts: 3";
		const options = {
			source: "webhook",
			sender: "GitHub",
			subject: "CI",
		} as const;
		const rendered = formatRecentMessages([
			row("01", USER, "hey", 1000, {
				content: { text: "hey", senderName: "nubs", source: "discord" },
			}),
			row("02", USER, "", 2000, {
				content: {
					text: wrapExternalContent(payload, options),
					senderName: "CI Bot",
					source: "discord",
				},
			}),
		]);
		expect(rendered).toBe(
			[
				"- nubs: hey",
				`- CI Bot: ${wrapExternalContent(payload, { ...options, includeWarning: false })}`,
			].join("\n"),
		);
		expect(rendered).not.toContain("SECURITY NOTICE");
	});
});
