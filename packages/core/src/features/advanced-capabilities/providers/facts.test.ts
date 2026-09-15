/**
 * Unit tests for `factsProvider` (advanced-capabilities): asserts BM25 keyword
 * retrieval surfaces the relevant durable/current facts (including a direct-recall
 * fallback and current-fact time weighting), that rendering attributes facts by
 * provenance (speaker vs neutral room header) while room-fact recall stays
 * intact for bot/bridge senders — relays carry real human questions — that the
 * always-on standing-preferences lane gate is structural (extractor-assigned
 * `category: "preference"` + sender ownership + prior) so reply/domain-shaped
 * text under a non-preference category never leaks into the lane, and that
 * the always-on semantic lane unions in lexically-disjoint-but-related facts
 * (local embedding + bounded fact-table search) while degrading to pure
 * lexical retrieval when the embedding model is unavailable or the canonical
 * embedding capability is disabled. Uses a hand-built deterministic runtime
 * mock — no live model, no DB; `useModel` throws unless the test provides
 * semantic results, enforcing that embedding failure never breaks retrieval.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { factsProvider } from "./facts.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;
const otherEntityId = "00000000-0000-0000-0000-0000000000dd" as UUID;

function memory(
	id: string,
	text: string,
	metadata: Record<string, unknown> = {},
	createdAt = Date.now(),
	factEntityId: UUID = entityId,
): Memory {
	return {
		id: id as UUID,
		entityId: factEntityId,
		agentId,
		roomId,
		content: { text },
		metadata,
		createdAt,
	};
}

function makeRuntime(args: {
	facts?: Memory[];
	roomFacts?: Memory[];
	entityFacts?: Memory[];
	recentMessages?: Memory[];
	canonicalEmbeddingsDisabled?: boolean;
	/**
	 * Semantic-lane results returned by `searchMemories`. When set, `useModel`
	 * returns a deterministic local embedding instead of throwing. Entries
	 * should carry a `similarity` value the provider's floor can filter on.
	 */
	semanticFacts?: Memory[];
}): IAgentRuntime & {
	getMemories: ReturnType<typeof vi.fn>;
	useModel: ReturnType<typeof vi.fn>;
	searchMemories: ReturnType<typeof vi.fn>;
} {
	const runtime = {
		agentId,
		character: { name: "Eliza", bio: "", system: "" },
		getService: vi.fn(() => null),
		getMemories: vi.fn(
			async (params: { tableName: string; roomId?: UUID; entityId?: UUID }) => {
				if (params.tableName === "messages") {
					return args.recentMessages ?? [];
				}
				if (params.tableName === "facts") {
					if (params.roomId) {
						return args.roomFacts ?? args.facts ?? [];
					}
					if (params.entityId) {
						return args.entityFacts ?? args.facts ?? [];
					}
					return args.facts ?? [];
				}
				return [];
			},
		),
		searchMemories: vi.fn(async () => args.semanticFacts ?? []),
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_CANONICAL_EMBEDDINGS_ENABLED" &&
			args.canonicalEmbeddingsDisabled
				? false
				: undefined,
		),
		useModel: vi.fn(async () => {
			if (args.semanticFacts) return [0.1, 0.2, 0.3];
			throw new Error("local embedding model unavailable");
		}),
	};
	return runtime as unknown as IAgentRuntime & {
		getMemories: ReturnType<typeof vi.fn>;
		useModel: ReturnType<typeof vi.fn>;
		searchMemories: ReturnType<typeof vi.fn>;
	};
}

describe("factsProvider keyword retrieval", () => {
	it("keeps standing corrections inline and the complete attributed evidence available on demand", async () => {
		const runtime = makeRuntime({
			facts: [
				memory("pref", "Use short replies.", {
					kind: "durable",
					category: "preference",
				}),
				memory("correction", "Correction: the meeting is Tuesday.", {
					kind: "current",
					category: "correction",
				}),
				memory("detail", "The old fixture contains an amber folder.", {
					kind: "current",
					category: "working_on",
				}),
				memory(
					"other",
					"Another participant prefers Spanish.",
					{ kind: "durable", category: "preference" },
					Date.now(),
					otherEntityId,
				),
			],
		});
		const result = await factsProvider.get(
			runtime,
			memory("message", "hello"),
			{ values: {}, data: {}, text: "" },
		);
		expect(result.discoveryText).toContain("Use short replies.");
		expect(result.discoveryText).toContain("[current.correction");
		expect(result.discoveryText).toContain(
			"Correction: the meeting is Tuesday.",
		);
		expect(result.discoveryText).not.toContain("amber folder");
		expect(result.discoveryText).not.toContain(
			"Another participant prefers Spanish.",
		);
		expect(result.text).toContain("amber folder");
		expect(result.text).toContain(
			"Known facts in this room (about other participants)",
		);
		expect(result.text).toContain("Another participant prefers Spanish.");
		expect(result.data?.facts).toHaveLength(4);
		expect(runtime.useModel).not.toHaveBeenCalled();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("retrieves every readable fact and uses lexical relevance only for ordering", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "Berlin keeps coming up today")],
			facts: [
				memory("fact-1", "the user lives in Berlin", {
					kind: "durable",
					category: "identity",
					confidence: 0.9,
					keywords: ["berlin", "lives"],
				}),
				memory("fact-2", "the user likes Tokyo hotels", {
					kind: "durable",
					category: "preference",
					confidence: 0.9,
					keywords: ["tokyo", "hotels"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Do you remember anything about Berlin?", {
				source: "test",
			}),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({ tableName: "facts" }),
		);
		const sections = result.text.split("\n\n");
		const knowledgeSection = sections.find((section) =>
			section.startsWith("Things Eliza knows about"),
		);
		expect(knowledgeSection).toContain("the user lives in Berlin");
		// Preferences retain their dedicated attribution section while remaining
		// complete regardless of lexical overlap.
		expect(knowledgeSection).not.toContain("Tokyo hotels");
		const preferenceSection = sections.find((section) =>
			section.startsWith("Standing preferences"),
		);
		expect(preferenceSection).toContain("Tokyo hotels");
	});

	it("stays on bounded keyword recall when no embedding capability is registered", async () => {
		const runtime = makeRuntime({
			canonicalEmbeddingsDisabled: true,
			recentMessages: [],
			facts: [
				memory("fact-1", "the user prefers concise replies", {
					kind: "durable",
					category: "preference",
					confidence: 0.9,
					keywords: ["concise", "replies"],
				}),
			],
		});

		await factsProvider.get(
			runtime,
			memory("msg-current", "What is next?", { source: "test" }),
			{ values: {}, data: {}, text: "" },
		);

		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("uses stored keywords even when the exact query word is not in fact text", async () => {
		const runtime = makeRuntime({
			facts: [
				memory("fact-1", "the user prefers aisle seats", {
					kind: "durable",
					category: "preference",
					confidence: 0.8,
					keywords: ["flight", "seat", "aisle"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "Book the flight with my seat preference"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user prefers aisle seats");
	});

	it("surfaces every sender preference even with zero lexical overlap", async () => {
		const launchFacts = Array.from({ length: 6 }, (_, index) =>
			memory(`fact-launch-${index}`, `launch planning detail ${index}`, {
				kind: "durable",
				category: "business_role",
				confidence: 0.8,
				keywords: ["launch", "planning", `detail-${index}`],
			}),
		);
		const runtime = makeRuntime({
			facts: [
				...launchFacts,
				// The MVP bug (#14693): a reply-style preference that lexically
				// matches almost no turn must still reach the prompt every turn.
				memory("fact-style", "the user hates long replies", {
					kind: "durable",
					category: "preference",
					confidence: 0.95,
					keywords: ["brief", "replies"],
				}),
				memory("fact-domain", "the user likes Tokyo hotels", {
					kind: "durable",
					category: "preference",
					confidence: 1,
					keywords: ["tokyo", "hotels"],
				}),
				memory("fact-timing", "the user prefers morning check-ins", {
					kind: "durable",
					category: "preference",
					confidence: 0.7,
					keywords: ["morning", "check-ins"],
				}),
				// Lowest prior — must be evicted by the lane bound of 3.
				memory("fact-overflow", "the user prefers metric units", {
					kind: "durable",
					category: "preference",
					confidence: 0.6,
					keywords: ["metric", "units"],
				}),
				// Another participant's preference must never enter the sender lane.
				memory(
					"fact-other",
					"Bob prefers voice notes",
					{
						kind: "durable",
						category: "preference",
						confidence: 1,
						keywords: ["voice", "notes"],
					},
					Date.now(),
					otherEntityId,
				),
			],
		});

		const message = memory("msg-current", "What changed for launch planning?");
		message.content.senderName = "Alice";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		const durableFacts = result.data.durableFacts as Memory[];
		const durableIds = durableFacts.map((fact) => fact.id);
		// Relevance affects ordering, never membership.
		expect(durableIds).toContain("fact-style");
		expect(durableIds).toContain("fact-domain");
		expect(durableIds).toContain("fact-timing");
		expect(durableIds).toContain("fact-overflow");
		expect(durableIds).toContain("fact-other");

		const sections = result.text.split("\n\n");
		const preferenceSection = sections.find((section) =>
			section.startsWith(
				"Standing preferences Alice has expressed (apply any that are relevant to this reply):",
			),
		);
		expect(preferenceSection).toBeDefined();
		expect(preferenceSection).toContain("the user hates long replies");
		expect(preferenceSection).toContain("the user likes Tokyo hotels");
		expect(preferenceSection).toContain("the user prefers morning check-ins");
		expect(preferenceSection).not.toContain("Bob prefers voice notes");
		// Lane rows render once — in the preferences section, not duplicated
		// under the general knowledge header.
		const knowledgeSection = sections.find((section) =>
			section.startsWith("Things Eliza knows about Alice:"),
		);
		expect(knowledgeSection).toContain("launch planning detail");
		expect(knowledgeSection).not.toContain("hates long replies");
	});

	it("surfaces a durable fact on direct recall even when keywords do not BM25-match", async () => {
		// Live regression on 2026-05-28 (tj-8e3d5c79321002): user stored
		// "my car's name is Bertha" then later asked "whats my cars name?".
		// BM25 scored 0 (no stemming for cars->car, and the only shared term
		// "name" had ~0 IDF across the small fact pool), so the durable fact
		// was filtered out and the bot answered "I don't have any info about a
		// car name for you." Durable identity facts are few and high-value;
		// when relevance ranking surfaces none, fall back to recent durable
		// facts so direct recall works.
		const runtime = makeRuntime({
			facts: [
				memory("fact-1", "my car's name is Bertha, a 1998 Civic", {
					kind: "durable",
					category: "identity",
					confidence: 0.9,
					keywords: ["car", "name", "bertha", "civic"],
				}),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "whats my cars name?"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("Bertha");
		expect(result.text).not.toContain("No facts available");
	});

	it("applies current-fact time weighting after keyword relevance", async () => {
		// bun's vitest compat layer doesn't implement vi.useFakeTimers /
		// vi.setSystemTime, so pin Date.now() directly. This is the only
		// timestamp facts.ts reads when ranking current facts.
		const fixedNow = Date.parse("2026-05-11T12:00:00.000Z");
		const _nowSpy = vi.spyOn(Date, "now").mockReturnValue(fixedNow);
		const runtime = makeRuntime({
			facts: [
				memory(
					"fact-old",
					"the user is anxious about launch",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.9,
						keywords: ["anxious", "launch"],
						validAt: "2026-03-01T12:00:00.000Z",
					},
					Date.parse("2026-03-01T12:00:00.000Z"),
				),
				memory(
					"fact-new",
					"the user is anxious about launch today",
					{
						kind: "current",
						category: "feeling",
						confidence: 0.7,
						keywords: ["anxious", "launch"],
						validAt: "2026-05-11T09:00:00.000Z",
					},
					Date.parse("2026-05-11T09:00:00.000Z"),
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "I am still anxious about launch"),
			{ values: {}, data: {}, text: "" },
		);

		const currentFacts = result.data.currentFacts as Memory[];
		expect(currentFacts.map((fact) => fact.id)).toEqual([
			"fact-new",
			"fact-old",
		]);
	});
});

describe("factsProvider standing-preferences lane gate", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The lane gate is structural: a fact enters the "Standing preferences" lane
	// only because the extractor tagged it `category: "preference"` at write
	// time, never because its text happens to contain reply-shape words. The
	// prior reader-side regex (INTERACTION_PREFERENCE_PATTERN) matched broad
	// content tokens — `short`, `long`, `direct`, `language`, `format` — and so
	// force-injected DOMAIN-content facts ("short flights", "direct flights",
	// "speaks Spanish as first language") into a reply-style lane under an
	// instruction cue every turn. These cases pin the empirical false positives
	// the PR review surfaced: reply/domain-shaped English text stored under a
	// NON-preference category must stay out of the lane. If someone reintroduces
	// a keyword sniff on the read path, these fail.
	it.each([
		["the user prefers short flights", "identity"],
		["the user wants direct flights only", "identity"],
		["the user speaks Spanish as first language", "identity"],
		["the user wants a short runway to launch", "goal"],
		["the user reports directly to the VP", "business_role"],
	])(
		"keeps reply/domain-shaped %s out of the lane when its category is %s, not preference",
		async (factText, category) => {
			const message = memory("msg-current", "what's on my plate today?");
			message.content.senderName = "Alice";
			const runtime = makeRuntime({
				facts: [
					memory("fact-nonpref", factText, {
						kind: "durable",
						category,
						confidence: 0.95,
						keywords: ["scheduled", "context"],
					}),
				],
			});

			const result = await factsProvider.get(runtime, message, {
				values: {},
				data: {},
				text: "",
			});

			const sections = result.text.split("\n\n");
			const preferenceSection = sections.find((section) =>
				section.startsWith("Standing preferences"),
			);
			// The fact never reaches the always-on lane: no "Standing preferences"
			// section renders (the fact is not sender-owned `preference`), and the
			// fact text is absent from any preference lane render.
			expect(preferenceSection).toBeUndefined();
		},
	);

	it("routes a genuine sender preference into the lane while a same-turn non-preference domain fact stays out", async () => {
		const message = memory("msg-current", "book me something");
		message.content.senderName = "Alice";
		const runtime = makeRuntime({
			facts: [
				// Reply-shape words, but category is NOT preference -> excluded.
				memory("fact-domain", "the user prefers short flights", {
					kind: "durable",
					category: "identity",
					confidence: 1,
					keywords: ["flights", "travel"],
				}),
				// Genuine standing preference, tagged by the extractor -> included.
				memory("fact-pref", "the user prefers morning check-ins", {
					kind: "durable",
					category: "preference",
					confidence: 0.9,
					keywords: ["morning", "check-ins"],
				}),
			],
		});

		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		const sections = result.text.split("\n\n");
		const preferenceSection = sections.find((section) =>
			section.startsWith("Standing preferences"),
		);
		expect(preferenceSection).toBeDefined();
		expect(preferenceSection).toContain("the user prefers morning check-ins");
		// The reply-shaped domain fact must not leak into the lane merely because
		// its text reads like a reply-style preference.
		expect(preferenceSection).not.toContain("the user prefers short flights");
	});
});

describe("factsProvider provenance attribution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const roomFactAboutSomeoneElse = memory(
		"fact-room-1",
		"nubs created the remilio project last spring",
		{
			kind: "durable",
			category: "identity",
			confidence: 0.9,
			keywords: ["nubs", "remilio", "project"],
		},
		Date.now(),
		otherEntityId,
	);

	it("renders room-pool facts about other entities under the neutral room header, not as speaker facts", async () => {
		const runtime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "who created the remilio project?", {
				source: "discord",
			}),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("nubs created the remilio project");
		expect(result.text).toContain("Known facts in this room");
		// The room fact is about otherEntityId — it must NOT be attributed to
		// the current speaker.
		expect(result.text).not.toContain("knows about");
	});

	it("keeps the speaker header for facts stored against the sender's own entity", async () => {
		const senderFact = memory("fact-sender-1", "the user lives in Berlin", {
			kind: "durable",
			category: "identity",
			confidence: 0.9,
			keywords: ["berlin", "lives"],
		});
		const runtime = makeRuntime({
			roomFacts: [senderFact],
			entityFacts: [senderFact],
		});

		const message = memory("msg-current", "anything about Berlin?");
		message.content.senderName = "Alice";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("Things Eliza knows about Alice:");
		expect(result.text).toContain("the user lives in Berlin");
		expect(result.text).not.toContain("Known facts in this room");
	});

	it("keeps room facts recallable for connector-stamped bot/webhook senders, under the neutral header", async () => {
		// Relays carry real human questions (the ZenithProxy pattern): a human
		// asks through the bridge, so the room pool must stay recallable on the
		// bot-stamped turn — only the attribution changes.
		const botRuntime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [],
		});
		const botMessage = memory(
			"msg-bot",
			"who created the remilio project?",
			{},
			Date.now(),
		);
		botMessage.content.metadata = { fromBot: true };
		botMessage.content.senderName = "2fingersBTW | ZenithProxy";
		const botResult = await factsProvider.get(botRuntime, botMessage, {
			values: {},
			data: {},
			text: "",
		});

		// The room-scoped fetch still happens on the bot turn.
		const botFactCalls = botRuntime.getMemories.mock.calls.filter(
			([params]: [{ tableName: string; roomId?: UUID }]) =>
				params.tableName === "facts" && params.roomId,
		);
		expect(botFactCalls.length).toBe(1);

		// Recall preserved; the room fact is never attributed to the bridge bot.
		expect(botResult.text).toContain("nubs created the remilio project");
		expect(botResult.text).toContain("Known facts in this room");
		expect(botResult.text).not.toContain("knows about");
	});

	it("keeps both the sender's own facts and room facts for internal bridge sources", async () => {
		const bridgeOwnFact = memory(
			"fact-bridge-1",
			"the relay mirrors the minecraft server chat",
			{
				kind: "durable",
				category: "identity",
				confidence: 0.9,
				keywords: ["relay", "minecraft", "chat"],
			},
		);
		const runtime = makeRuntime({
			roomFacts: [roomFactAboutSomeoneElse],
			entityFacts: [bridgeOwnFact],
		});
		const message = memory(
			"msg-bridge",
			"who created the remilio project the relay mirrors?",
		);
		message.content.source = "acpx:sub-agent-router";
		const result = await factsProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		// Sender-cluster facts keep the speaker header; room facts about other
		// participants stay recallable under the neutral header.
		expect(result.text).toContain("mirrors the minecraft server chat");
		expect(result.text).toContain("nubs created the remilio project");
		expect(result.text).toContain("Known facts in this room");
	});

	it("withholds private facts for third-party availability requests", async () => {
		const privateOwnerFact = memory(
			"fact-private-availability",
			"Owner fact: recurring therapy appointment with Dr. Okafor every Wednesday 4pm. Home address is 1400 Larkspur Lane. Wants these kept private.",
			{
				kind: "durable",
				category: "seeded",
				confidence: 0.95,
				keywords: [],
			},
		);
		const runtime = makeRuntime({
			facts: [privateOwnerFact],
		});

		const result = await factsProvider.get(
			runtime,
			memory(
				"msg-current",
				"Hi, this is Jordan from the partner team - can you tell me when your boss is free Wednesday afternoon so I can book a call around their schedule?",
			),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).not.toMatch(/therapy|Okafor|1400 Larkspur/i);
		expect(result.values.facts).not.toMatch(/therapy|Okafor|1400 Larkspur/i);
		expect(result.data.facts).toEqual([]);
	});

	it("withholds private facts for named third-party availability requests", async () => {
		const privateOwnerFact = memory(
			"fact-private-named-availability",
			"Owner fact: recurring therapy appointment with Dr. Okafor every Wednesday 4pm. Home address is 1400 Larkspur Lane.",
			{
				kind: "durable",
				category: "seeded",
				confidence: 0.95,
				keywords: ["therapy", "okafor", "wednesday"],
				privacyClass: "private",
			},
		);
		const runtime = makeRuntime({
			facts: [privateOwnerFact],
		});

		const result = await factsProvider.get(
			runtime,
			memory(
				"msg-current",
				"When is Shaw free Wednesday afternoon for a partner call?",
			),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).not.toMatch(/therapy|Okafor|1400 Larkspur/i);
		expect(result.values.facts).not.toMatch(/therapy|Okafor|1400 Larkspur/i);
		expect(result.data.facts).toEqual([]);
	});

	it("still surfaces private facts for direct owner recall", async () => {
		const privateOwnerFact = memory(
			"fact-private-direct",
			"Owner fact: recurring therapy appointment with Dr. Okafor every Wednesday 4pm.",
			{
				kind: "durable",
				category: "seeded",
				confidence: 0.95,
				keywords: ["therapy", "okafor", "wednesday"],
				privacyClass: "private",
			},
		);
		const runtime = makeRuntime({
			facts: [privateOwnerFact],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "what do you know about my therapy appointment?"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("Dr. Okafor");
		expect(result.data.facts).toEqual([privateOwnerFact]);
	});
});

describe("factsProvider out-of-range timestamps", () => {
	// A microsecond-precision `createdAt` from a connector passes
	// `Number.isFinite` but falls outside the ±8.64e15 Date range, so
	// `new Date(ts).toISOString()` throws `RangeError: Invalid time value`.
	// That escaped `formatSince` and surfaced as FACTS_PROVIDER_READ_FAILED,
	// dropping every fact for the turn instead of one unreadable date.
	const MICROSECOND_TIMESTAMP = 1.7e18;

	it("renders a current fact whose createdAt is outside the Date range", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "where am I working from now?")],
			facts: [
				memory(
					"fact-1",
					"the user is working from Lisbon",
					{
						kind: "current",
						category: "location",
						confidence: 0.9,
						keywords: ["working", "lisbon"],
					},
					MICROSECOND_TIMESTAMP,
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "where am I working from now?"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user is working from Lisbon");
		expect(result.text).toContain("since unknown");
	});

	it("keeps readable facts when one row carries an unreadable timestamp", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "remind me where I am working")],
			facts: [
				memory(
					"fact-bad",
					"the user is working from Lisbon",
					{
						kind: "current",
						category: "location",
						confidence: 0.9,
						keywords: ["working", "lisbon"],
					},
					MICROSECOND_TIMESTAMP,
				),
				memory(
					"fact-good",
					"the user is working from Porto on Fridays",
					{
						kind: "current",
						category: "location",
						confidence: 0.9,
						keywords: ["working", "porto"],
					},
					Date.now(),
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "remind me where I am working"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user is working from Porto on Fridays");
		expect(result.text).toContain("the user is working from Lisbon");
	});

	// 8.64e15 is the largest value `Date` can represent. One millisecond past it
	// is the first input that `Number.isFinite` accepts and `Date` cannot.
	it("treats a timestamp one millisecond past the Date range as unknown", async () => {
		const runtime = makeRuntime({
			recentMessages: [memory("msg-1", "what is my current setup")],
			facts: [
				memory(
					"fact-1",
					"the user is running the beta setup",
					{
						kind: "current",
						category: "status",
						confidence: 0.9,
						keywords: ["running", "beta", "setup"],
					},
					8.64e15 + 1,
				),
			],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "what is my current setup"),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("the user is running the beta setup");
		expect(result.text).toContain("since unknown");
	});
});

/**
 * The factlink gap (2026-08-21): the fact "Connor (c-node) is a Zcash core
 * dev" shares ZERO non-stopword tokens with a "convent / season 3 / grove"
 * query, and because OTHER facts in the pool DID keyword-match ("convent"),
 * the old total-miss-gated widen never ran — the related fact was
 * structurally unreachable. These tests replay that shape.
 */
describe("factsProvider semantic union (Grove/Zcash replay)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Durable like the live incident's convent facts: they fill the durable
	// slots via lexical match, so the durable direct-recall fallback (which
	// only fires on an EMPTY durable ranking) never rescues the Zcash fact.
	const conventFact = memory(
		"fact-convent",
		"The Grove originated at the Convent in Greenpoint during season 1",
		{
			kind: "durable",
			category: "project",
			confidence: 0.9,
			keywords: ["grove", "convent", "greenpoint", "season"],
		},
	);
	const zcashFact = memory(
		"fact-zcash",
		"Learned Connor (c-node) is a Zcash core dev at the 2026-08-19 bar night",
		{
			kind: "durable",
			category: "relationship",
			confidence: 0.85,
			keywords: ["connor", "c-node", "zcash", "core", "dev"],
		},
	);
	const groveQuery = memory(
		"msg-grove",
		"wait we're in season 3... grov3.net... look at this from season 1",
		{ source: "discord" },
	);

	it("preserves lexically disjoint facts without requiring an embedding lane", async () => {
		const runtime = makeRuntime({ facts: [conventFact, zcashFact] });

		const result = await factsProvider.get(runtime, groveQuery, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("Grove originated at the Convent");
		expect(result.text).toContain("Zcash");
	});

	it("does not need semantic top-k retrieval to preserve stored facts", async () => {
		const semanticZcash: Memory = { ...zcashFact, similarity: 0.62 };
		const runtime = makeRuntime({
			facts: [conventFact, zcashFact],
			semanticFacts: [semanticZcash],
		});

		const result = await factsProvider.get(runtime, groveQuery, {
			values: {},
			data: {},
			text: "",
		});

		// Both stored facts surface directly; no second lossy retrieval lane runs.
		expect(result.text).toContain("Grove originated at the Convent");
		expect(result.text).toContain("Zcash");
		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.searchMemories).not.toHaveBeenCalled();
	});

	it("drops semantic hits below the similarity floor", async () => {
		const weakHit: Memory = { ...zcashFact, similarity: 0.2 };
		const runtime = makeRuntime({
			facts: [conventFact],
			semanticFacts: [weakHit],
		});

		const result = await factsProvider.get(runtime, groveQuery, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).not.toContain("Zcash");
	});

	it("never embeds when the canonical embedding capability is disabled", async () => {
		const runtime = makeRuntime({
			canonicalEmbeddingsDisabled: true,
			facts: [conventFact, zcashFact],
			semanticFacts: [{ ...zcashFact, similarity: 0.9 }],
		});

		const result = await factsProvider.get(runtime, groveQuery, {
			values: {},
			data: {},
			text: "",
		});

		expect(runtime.useModel).not.toHaveBeenCalled();
		expect(runtime.searchMemories).not.toHaveBeenCalled();
		expect(result.text).toContain("Grove originated at the Convent");
	});

	it("folds in-turn attachment text into the retrieval query so page content contributes tokens", async () => {
		// The attachment carries the literal token "ZCash" (the grov3.net page
		// text) — with evidence folded into the query, plain BM25 now matches
		// the stored fact even with the embedding model unavailable.
		const groveWithAttachment: Memory = {
			...groveQuery,
			content: {
				...groveQuery.content,
				attachments: [
					{
						id: "att-grove",
						url: "https://grov3.net",
						title: "the grove",
						text: "Pillar IV Private Communication: FlashNet node, TorDash, ZCash infra",
					},
				],
			},
		} as Memory;
		const runtime = makeRuntime({ facts: [conventFact, zcashFact] });

		const result = await factsProvider.get(runtime, groveWithAttachment, {
			values: {},
			data: {},
			text: "",
		});

		expect(result.text).toContain("Zcash core dev");
	});

	it("folds prior in-turn action-result text into the retrieval query", async () => {
		const runtime = makeRuntime({ facts: [conventFact, zcashFact] });
		const stateWithActionResult = {
			values: {},
			data: {
				actionResults: [
					{
						success: true,
						text: "Read grov3.net: Pillar IV Private Communication — FlashNet node, TorDash, ZCash infra",
						data: { actionName: "ATTACHMENT" },
					},
				],
			},
			text: "",
		};

		const result = await factsProvider.get(
			runtime,
			groveQuery,
			stateWithActionResult as never,
		);

		expect(result.text).toContain("Zcash core dev");
	});
});

describe("factsProvider room-pool currency", () => {
	// Old observations must not masquerade as current events or disappear
	// from the model-facing projection.
	const DAY_MS = 24 * 60 * 60 * 1000;

	it("labels older room observations separately without dropping their text", async () => {
		const now = Date.now();
		const stale = now - 20 * DAY_MS;
		const fresh = now - 2 * DAY_MS;
		const roomFacts = [
			memory(
				"room-stale-1",
				"argues that unbounded knowledge does not disqualify AGI",
				{ kind: "current", category: "uncategorized" },
				stale,
				otherEntityId,
			),
			memory(
				"room-stale-2",
				"shared a link about pancake sorting",
				{ kind: "current", category: "uncategorized" },
				stale,
				otherEntityId,
			),
			memory(
				"room-fresh",
				"is travelling to Lisbon this week",
				{ kind: "current", category: "uncategorized" },
				fresh,
				otherEntityId,
			),
		];
		const senderStale = memory(
			"sender-stale",
			"is training for a marathon",
			{ kind: "current", category: "uncategorized" },
			stale,
		);
		const runtime = makeRuntime({
			roomFacts: [...roomFacts, senderStale],
			entityFacts: [senderStale],
		});

		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "what's new?", { source: "test" }),
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("is travelling to Lisbon this week");
		expect(result.text).toContain("is training for a marathon");
		const olderSection = result.text?.split(
			"Older observations about other participants (do not assume these are still current):",
		)[1];
		expect(olderSection).toContain("shared a link about pancake sorting");
		expect(olderSection).toContain(
			"argues that unbounded knowledge does not disqualify AGI",
		);
		expect(olderSection).not.toContain("is travelling to Lisbon this week");
		const data = result.data as { currentFacts: Memory[] };
		expect(data.currentFacts).toHaveLength(4);
	});

	it("scopes each identity pool to that identity's own facts, not just the RLS principal", async () => {
		// Live 2026-09-05: with no RLS policies installed, a principal-only query
		// returned the whole facts table per cluster member.
		const runtime = makeRuntime({ roomFacts: [], entityFacts: [] });
		await factsProvider.get(
			runtime,
			memory("msg-current", "anything new?", { source: "test" }),
			{ values: {}, data: {}, text: "" },
		);
		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "facts",
				entityId,
				authorEntityIds: [entityId],
			}),
		);
	});

	it("keeps room current facts with unreadable timestamps listed rather than lapsing them", async () => {
		const unknownStamp = memory(
			"room-unknown",
			"mentioned a conference in Oslo",
			{ kind: "current", category: "uncategorized" },
			Number.NaN,
			otherEntityId,
		);
		const runtime = makeRuntime({ roomFacts: [unknownStamp], entityFacts: [] });
		const result = await factsProvider.get(
			runtime,
			memory("msg-current", "anything new?", { source: "test" }),
			{ values: {}, data: {}, text: "" },
		);
		expect(result.text).toContain("mentioned a conference in Oslo");
		expect(result.text).not.toContain("Older observations");
	});
});
