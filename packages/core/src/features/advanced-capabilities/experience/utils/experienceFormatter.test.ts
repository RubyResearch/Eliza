/**
 * Unit tests for the experience formatter/aggregation helpers (deterministic, no
 * runtime or model). Stats drive what the agent believes about its own track
 * record (success rate, averages), so the counting and averaging must be exact;
 * keyword extraction feeds retrieval recall.
 */
import { describe, expect, it } from "vitest";
import type { Experience } from "../types";
import { ExperienceType, OutcomeType } from "../types";
import {
	extractKeywords,
	formatExperienceForPrompt,
	formatExperienceForRAG,
	getExperienceStats,
	groupExperiencesByDomain,
} from "./experienceFormatter.ts";

const exp = (o: Partial<Experience>): Experience =>
	({
		type: ExperienceType.SUCCESS,
		outcome: OutcomeType.POSITIVE,
		domain: "general",
		action: "do_thing",
		context: "ctx",
		result: "res",
		learning: "learned something useful",
		confidence: 0.8,
		importance: 0.5,
		tags: [],
		keywords: [],
		createdAt: 0,
		...o,
	}) as unknown as Experience;

describe("groupExperiencesByDomain", () => {
	it("buckets by domain", () => {
		const groups = groupExperiencesByDomain([
			exp({ domain: "a" }),
			exp({ domain: "b" }),
			exp({ domain: "a" }),
		]);
		expect(groups.size).toBe(2);
		expect(groups.get("a")).toHaveLength(2);
		expect(groups.get("b")).toHaveLength(1);
	});
});

describe("getExperienceStats", () => {
	it("returns zeroed stats for an empty set", () => {
		const stats = getExperienceStats([]);
		expect(stats.total).toBe(0);
		expect(stats.averageConfidence).toBe(0);
		expect(stats.successRate).toBe(0);
	});

	it("counts, averages, and computes success rate", () => {
		const stats = getExperienceStats([
			exp({ outcome: OutcomeType.POSITIVE, domain: "a", confidence: 1 }),
			exp({ outcome: OutcomeType.POSITIVE, domain: "a", confidence: 0.5 }),
			exp({
				type: ExperienceType.FAILURE,
				outcome: OutcomeType.NEGATIVE,
				domain: "b",
				confidence: 0,
			}),
		]);
		expect(stats.total).toBe(3);
		expect(stats.averageConfidence).toBeCloseTo(0.5);
		expect(stats.byDomain).toEqual({ a: 2, b: 1 });
		expect(stats.byType[ExperienceType.SUCCESS]).toBe(2);
		expect(stats.byType[ExperienceType.FAILURE]).toBe(1);
		// 2 positive / (2 positive + 1 negative)
		expect(stats.successRate).toBeCloseTo(2 / 3);
	});
});

describe("extractKeywords", () => {
	it("returns explicit keywords verbatim when present", () => {
		expect(extractKeywords(exp({ keywords: ["pre", "set"] }))).toEqual([
			"pre",
			"set",
		]);
	});

	it("derives keywords from tags/learning/action/type/outcome/domain", () => {
		const kw = extractKeywords(
			exp({
				keywords: [],
				tags: ["Foo"],
				learning: "learned something useful",
				action: "do_thing",
				domain: "web",
			}),
		);
		expect(kw).toContain("foo"); // tag lowercased
		expect(kw).toContain("useful"); // learning word > 3 chars
		expect(kw).toContain("thing"); // action part > 2 chars
		expect(kw).toContain("web"); // domain
		expect(kw).not.toContain("do"); // too short
	});
});

describe("formatExperienceForRAG", () => {
	it("renders labeled fields including joined tags", () => {
		const text = formatExperienceForRAG(exp({ tags: ["a", "b"] }));
		expect(text).toMatch(/Experience Type: success/);
		expect(text).toMatch(/Tags: a, b/);
	});
});

describe("formatExperienceForPrompt", () => {
	it("renders a WHY that adds to DO", () => {
		const text = formatExperienceForPrompt(
			exp({ id: "e1" as Experience["id"], result: "the retry succeeded" }),
		);
		expect(text).toContain("DO: learned something useful");
		expect(text).toContain("WHY: the retry succeeded");
		expect(text).toContain("META: id=e1");
	});

	it("replaces a WHY that only repeats DO with the extraction rationale or a local reference (live store: result == learning)", () => {
		const duplicate = formatExperienceForPrompt(
			exp({
				id: "e2" as Experience["id"],
				result: "learned something useful",
				extractionReason: "the user corrected the first attempt",
			}),
		);
		expect(duplicate).toContain("WHY: the user corrected the first attempt");
		expect(duplicate).not.toContain("WHY: learned something useful");
		const bare = formatExperienceForPrompt(
			exp({
				id: "e3" as Experience["id"],
				result: " learned  something useful ",
			}),
		);
		expect(bare).not.toContain("WHY: learned");
		expect(bare).toMatch(
			/WHEN: ctx\nWHY: Same text as DO above\.\nMETA: id=e3/,
		);
	});
});
