/**
 * Unit tests for the built-in Stage-1 response-handler field evaluators.
 *
 * Drives every exported evaluator's real `parse` against the malformed,
 * empty, boundary, and canonical inputs the message loop feeds it, plus the
 * shape and ordering of the `BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS`
 * registration array. Deterministic — no runtime, logger, or model.
 */
import { describe, expect, it } from "vitest";
import {
	addressedToFieldEvaluator,
	BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
	candidateActionNamesFieldEvaluator,
	contextsFieldEvaluator,
	emotionFieldEvaluator,
	factsFieldEvaluator,
	intentsFieldEvaluator,
	normalizeTopics,
	relationshipsFieldEvaluator,
	replyEffectStatusFieldEvaluator,
	replyTextFieldEvaluator,
	shouldRespondFieldEvaluator,
	topicsFieldEvaluator,
} from "./builtin-field-evaluators.ts";

describe("shouldRespondFieldEvaluator", () => {
	it("does not treat mere participation or possible helpfulness as a reason to interrupt", () => {
		expect(shouldRespondFieldEvaluator.description).toContain(
			"current message",
		);
		expect(shouldRespondFieldEvaluator.description).not.toContain(
			"active in the conversation",
		);
		expect(shouldRespondFieldEvaluator.description).not.toContain(
			"able to usefully add",
		);
		expect(shouldRespondFieldEvaluator.schema.description).not.toContain(
			"active conversation",
		);
		expect(shouldRespondFieldEvaluator.schema.description).not.toContain(
			"usefully add",
		);
	});

	it("accepts the three enum values in any case or surrounding whitespace", () => {
		expect(shouldRespondFieldEvaluator.parse("RESPOND")).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse("  ignore ")).toBe("IGNORE");
		expect(shouldRespondFieldEvaluator.parse("stop")).toBe("STOP");
	});

	it("falls back to RESPOND on malformed values instead of throwing", () => {
		expect(shouldRespondFieldEvaluator.parse("maybe")).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse("")).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse("   ")).toBe("RESPOND");
	});

	it("treats non-string values as RESPOND", () => {
		expect(shouldRespondFieldEvaluator.parse(undefined)).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse(null)).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse(42)).toBe("RESPOND");
		expect(shouldRespondFieldEvaluator.parse({ decision: "IGNORE" })).toBe(
			"RESPOND",
		);
	});
});

describe("contextsFieldEvaluator", () => {
	it("returns an empty array for non-array values", () => {
		expect(contextsFieldEvaluator.parse("simple")).toEqual([]);
		expect(contextsFieldEvaluator.parse(null)).toEqual([]);
		expect(contextsFieldEvaluator.parse(undefined)).toEqual([]);
		expect(contextsFieldEvaluator.parse({ 0: "simple" })).toEqual([]);
	});

	it("trims entries and drops nullish and whitespace-only items", () => {
		expect(contextsFieldEvaluator.parse([" simple ", null, "", "   "])).toEqual(
			["simple"],
		);
	});

	it("deduplicates case-insensitively while keeping the first casing and order", () => {
		expect(
			contextsFieldEvaluator.parse(["Tasks", "tasks", "TASKS", "simple"]),
		).toEqual(["Tasks", "simple"]);
	});

	it("preserves insertion order of distinct contexts", () => {
		expect(contextsFieldEvaluator.parse(["b", "a", "c"])).toEqual([
			"b",
			"a",
			"c",
		]);
	});
});

describe("intentsFieldEvaluator", () => {
	it("preserves all distinct outcomes of a compound request", () => {
		const intents = [
			"open notes",
			"update note body",
			"open calendar",
			"create event",
			"open browser",
			"read page",
		];
		expect(intentsFieldEvaluator.parse(intents)).toEqual(intents);
		expect(
			candidateActionNamesFieldEvaluator.parse([
				"VIEWS",
				"NOTES",
				"CALENDAR",
				"BROWSER",
			]),
		).toEqual(["VIEWS", "NOTES", "CALENDAR", "BROWSER"]);
	});

	it("preserves exact intent text and every occurrence without a length boundary", () => {
		const intents = [
			"delete the owner reminder Handler instruction QA 20260911 2155 by its ID and confirm the deletion",
			"  Schedule Meeting!? ",
			"Draft email...",
			"Research X.",
			"research x!",
			"RESEARCH X",
			"Research X.",
			"",
			"...",
		];
		expect(intentsFieldEvaluator.parse(intents)).toEqual(intents);
	});

	it("rejects malformed arrays instead of coercing or dropping their entries", () => {
		for (const value of [
			[null],
			[undefined],
			["valid", 42],
			"schedule meeting",
			42,
		]) {
			expect(intentsFieldEvaluator.parse(value)).toBeNull();
		}
	});

	it("keeps absent and empty intents backward compatible", () => {
		for (const value of [undefined, null, []]) {
			expect(intentsFieldEvaluator.parse(value)).toEqual([]);
		}
	});
});

describe("candidateActionNamesFieldEvaluator", () => {
	it("trims, drops blanks, and dedupes case-insensitively keeping first casing", () => {
		expect(
			candidateActionNamesFieldEvaluator.parse([
				"notes",
				" NOTES ",
				"Calendar",
				"CALENDAR",
			]),
		).toEqual(["notes", "Calendar"]);
	});

	it("returns an empty array for non-array values and blank arrays", () => {
		expect(candidateActionNamesFieldEvaluator.parse("NOTES")).toEqual([]);
		expect(candidateActionNamesFieldEvaluator.parse([null, "", "   "])).toEqual(
			[],
		);
	});
});

describe("replyTextFieldEvaluator", () => {
	it("passes ordinary prose through unchanged", () => {
		expect(replyTextFieldEvaluator.parse("On it.")).toBe("On it.");
		expect(replyTextFieldEvaluator.parse("hello there")).toBe("hello there");
	});

	it("returns an empty string for non-string values", () => {
		expect(replyTextFieldEvaluator.parse(42)).toBe("");
		expect(replyTextFieldEvaluator.parse(null)).toBe("");
		expect(replyTextFieldEvaluator.parse({ text: "hi" })).toBe("");
	});

	it("strips fully-serialized tool-call markup leaked as text", () => {
		expect(
			replyTextFieldEvaluator.parse(
				"<tool_call>WEB_FETCH<arg_key>url</arg_key><arg_value>https://example.com</arg_value></tool_call>",
			),
		).toBe("");
		expect(
			replyTextFieldEvaluator.parse(
				"On it. <tool_call>NOTES<arg_key>title</arg_key><arg_value>x</arg_value></tool_call>",
			),
		).toBe("On it.");
	});

	it("swallows a truncated-open leak that carries an uppercase action token", () => {
		expect(
			replyTextFieldEvaluator.parse("Working on it. <tool_call>WEB_FETCH"),
		).toBe("Working on it.");
	});

	it("reduces a reply that is only JSON punctuation to an empty string", () => {
		expect(replyTextFieldEvaluator.parse('{"":[],}')).toBe("");
	});

	it("preserves prose that merely mentions <tool_call>", () => {
		const prose = "the <tool_call> markup leaked into chat";
		expect(replyTextFieldEvaluator.parse(prose)).toBe(prose);
	});
});

describe("replyEffectStatusFieldEvaluator", () => {
	it("normalizes pending and terminal effect states case-insensitively", () => {
		expect(replyEffectStatusFieldEvaluator.parse("APPLIED")).toBe("applied");
		expect(replyEffectStatusFieldEvaluator.parse(" Non_Applied ")).toBe(
			"non_applied",
		);
		expect(replyEffectStatusFieldEvaluator.parse("none")).toBe("none");
		expect(replyEffectStatusFieldEvaluator.parse(" PENDING ")).toBe("pending");
	});

	it("maps everything unrecognized — including 'NONE' — to none", () => {
		expect(replyEffectStatusFieldEvaluator.parse("NONE")).toBe("none");
		expect(replyEffectStatusFieldEvaluator.parse("unrecognized")).toBe("none");
		expect(replyEffectStatusFieldEvaluator.parse("")).toBe("none");
		expect(replyEffectStatusFieldEvaluator.parse(null)).toBe("none");
		expect(replyEffectStatusFieldEvaluator.parse(7)).toBe("none");
	});
});

describe("factsFieldEvaluator", () => {
	it("drops blanks and strings shorter than four characters after trimming", () => {
		expect(factsFieldEvaluator.parse(["", "   ", "ok!", "ab"])).toEqual([]);
		expect(factsFieldEvaluator.parse(["user prefers email"])).toEqual([
			"user prefers email",
		]);
	});

	it("deduplicates exact matches while keeping order", () => {
		expect(
			factsFieldEvaluator.parse([
				"user lives in Brooklyn",
				"user lives in Brooklyn",
				"bob works at Acme",
			]),
		).toEqual(["user lives in Brooklyn", "bob works at Acme"]);
	});

	it("keeps casing variants as distinct facts (exact-match dedupe)", () => {
		expect(
			factsFieldEvaluator.parse(["User likes tea", "user likes tea"]),
		).toEqual(["User likes tea", "user likes tea"]);
	});

	it("returns an empty array for non-array values", () => {
		expect(factsFieldEvaluator.parse("user lives in Brooklyn")).toEqual([]);
	});
});

describe("relationshipsFieldEvaluator", () => {
	it("keeps complete triples and trims their fields", () => {
		expect(
			relationshipsFieldEvaluator.parse([
				{ subject: " alice ", predicate: " works_with ", object: " bob " },
			]),
		).toEqual([{ subject: "alice", predicate: "works_with", object: "bob" }]);
	});

	it("drops triples missing any field or carrying non-string fields", () => {
		expect(
			relationshipsFieldEvaluator.parse([
				{ subject: "alice", predicate: "works_with" },
				{ subject: "alice", predicate: 7, object: "bob" },
				{ subject: "", predicate: "owns", object: "dog" },
			]),
		).toEqual([]);
	});

	it("drops non-object items and returns empty for non-array values", () => {
		expect(
			relationshipsFieldEvaluator.parse([null, 42, "alice owns dog", {}]),
		).toEqual([]);
		expect(relationshipsFieldEvaluator.parse("alice owns dog")).toEqual([]);
	});
});

describe("normalizeTopics", () => {
	it("lowercases, trims, collapses internal whitespace, and dedupes", () => {
		expect(normalizeTopics(["  Billing ", "AUTH   bug", "billing"])).toEqual([
			"billing",
			"auth bug",
		]);
	});

	it("stringifies non-string entries rather than dropping them", () => {
		expect(normalizeTopics([42])).toEqual(["42"]);
	});

	it("skips nullish and empty entries", () => {
		expect(normalizeTopics([null, undefined, "", "   "])).toEqual([]);
	});

	it("returns an empty array for non-array values", () => {
		expect(normalizeTopics("billing")).toEqual([]);
		expect(normalizeTopics(undefined)).toEqual([]);
	});
});

describe("topicsFieldEvaluator", () => {
	it("delegates to normalizeTopics", () => {
		expect(topicsFieldEvaluator.parse(["Vacation   PLANS"])).toEqual([
			"vacation plans",
		]);
		expect(topicsFieldEvaluator.parse("billing")).toEqual([]);
	});
});

describe("addressedToFieldEvaluator", () => {
	it("deduplicates case-insensitively preserving first casing and order", () => {
		expect(
			addressedToFieldEvaluator.parse(["Alice", "alice", " Bob "]),
		).toEqual(["Alice", "Bob"]);
	});

	it("drops nullish and blank addressees and rejects non-array values", () => {
		expect(addressedToFieldEvaluator.parse([null, "", "   "])).toEqual([]);
		expect(addressedToFieldEvaluator.parse("Alice")).toEqual([]);
	});
});

describe("emotionFieldEvaluator", () => {
	it.each([
		"none",
		"happy",
		"sad",
		"angry",
		"nervous",
		"calm",
		"excited",
		"whisper",
	])("round-trips %s through trimming and lowercasing", (value) => {
		expect(emotionFieldEvaluator.parse(value.toUpperCase())).toBe(value);
		expect(emotionFieldEvaluator.parse(` ${value} `)).toBe(value);
	});

	it("maps unknown labels to none without punctuation stripping", () => {
		expect(emotionFieldEvaluator.parse("angry!")).toBe("none");
		expect(emotionFieldEvaluator.parse("elated")).toBe("none");
	});

	it("defaults to none for non-string and empty values", () => {
		expect(emotionFieldEvaluator.parse("")).toBe("none");
		expect(emotionFieldEvaluator.parse(undefined)).toBe("none");
		expect(emotionFieldEvaluator.parse(null)).toBe("none");
		expect(emotionFieldEvaluator.parse(["happy"])).toBe("none");
	});
});

describe("BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS", () => {
	it("registers the built-in evaluators in priority order", () => {
		expect(
			BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS.map((e) => e.name),
		).toEqual([
			"shouldRespond",
			"contexts",
			"contextRequests",
			"intents",
			"completionContext",
			"replyText",
			"replyEffectStatus",
			"candidateActionNames",
			"facts",
			"relationships",
			"topics",
			"addressedTo",
			"emotion",
		]);
	});

	it("assigns strictly increasing priorities across the canonical set", () => {
		const priorities = BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS.map(
			(e) => e.priority,
		);
		for (let i = 1; i < priorities.length; i++) {
			expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
		}
	});

	it("exposes a parse function and a string schema type on every evaluator", () => {
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			expect(typeof evaluator.parse).toBe("function");
			expect(typeof evaluator.name).toBe("string");
			expect(evaluator.name.length).toBeGreaterThan(0);
			expect(typeof evaluator.description).toBe("string");
			expect(evaluator.schema.type).toBeDefined();
		}
	});

	it("declares the frozen shouldRespond and emotion enums in schema slices", () => {
		expect(shouldRespondFieldEvaluator.schema.enum).toEqual([
			"RESPOND",
			"IGNORE",
			"STOP",
		]);
		expect(emotionFieldEvaluator.schema.enum).toEqual([
			"none",
			"happy",
			"sad",
			"angry",
			"nervous",
			"calm",
			"excited",
			"whisper",
		]);
	});
});
