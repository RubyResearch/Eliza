/**
 * EXPERIENCE action unit tests: confirm gating, id/score/field validation,
 * update and delete against a map-backed fake EXPERIENCE service, and the
 * delete-by-query strong-match/ambiguity contract. Deterministic — no model,
 * no database; the fake service records exactly the calls the handler makes.
 */
import { describe, expect, it } from "vitest";
import type {
	ActionResult,
	HandlerCallback,
	HandlerOptions,
} from "../../../../types/components.ts";
import type { Memory } from "../../../../types/memory.ts";
import type { UUID } from "../../../../types/primitives.ts";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { type Experience, ExperienceType, OutcomeType } from "../types.ts";
import { manageExperienceAction } from "./manage-experience.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000a1" as UUID;
const EXPERIENCE_ID_1 = "00000000-0000-0000-0000-0000000000e1" as UUID;
const EXPERIENCE_ID_2 = "00000000-0000-0000-0000-0000000000e2" as UUID;
const MISSING_ID = "00000000-0000-0000-0000-0000000000ff" as UUID;

function experience(seed: Partial<Experience> & { id: UUID }): Experience {
	return {
		agentId: AGENT_ID,
		type: ExperienceType.LEARNING,
		outcome: OutcomeType.NEUTRAL,
		context: "",
		action: "",
		result: "",
		learning: "",
		tags: [],
		domain: "general",
		keywords: [],
		associatedEntityIds: [],
		confidence: 0.5,
		importance: 0.5,
		createdAt: 1,
		updatedAt: 1,
		accessCount: 0,
		...seed,
	};
}

function makeRuntime(seedExperiences: Experience[] = []) {
	const store = new Map<string, Experience>(
		seedExperiences.map((e) => [e.id, e]),
	);
	const updateCalls: Array<{ id: UUID; updates: Partial<Experience> }> = [];
	const deleteCalls: UUID[] = [];
	const service = {
		updateExperience: async (id: UUID, updates: Partial<Experience>) => {
			updateCalls.push({ id, updates });
			const existing = store.get(id);
			if (!existing) return null;
			const next = { ...existing, ...updates, updatedAt: 2 };
			store.set(id, next);
			return next;
		},
		deleteExperience: async (id: UUID) => {
			deleteCalls.push(id);
			return store.delete(id);
		},
		queryExperiences: async () => Array.from(store.values()),
	};
	const runtime = {
		agentId: AGENT_ID,
		getService: (name: string) => (name === "EXPERIENCE" ? service : null),
	} as unknown as IAgentRuntime;
	return { runtime, store, updateCalls, deleteCalls };
}

function message(text = ""): Memory {
	return {
		entityId: AGENT_ID,
		roomId: AGENT_ID,
		content: { text, source: "test" },
	} as Memory;
}

async function invoke(
	runtime: IAgentRuntime,
	parameters: Record<string, unknown>,
	callback?: HandlerCallback,
): Promise<ActionResult> {
	const result = await manageExperienceAction.handler(
		runtime,
		message(),
		undefined,
		{ parameters } as HandlerOptions,
		callback,
	);
	if (!result) throw new Error("handler returned no result");
	return result;
}

describe("EXPERIENCE action shape", () => {
	it("is OWNER-gated with an action discriminator and confirm parameter", () => {
		expect(manageExperienceAction.name).toBe("EXPERIENCE");
		expect(manageExperienceAction.roleGate).toEqual({ minRole: "OWNER" });
		const names = (manageExperienceAction.parameters ?? []).map((p) => p.name);
		expect(names).toContain("action");
		expect(names).toContain("experienceId");
		expect(names).toContain("confirm");
	});
});

describe("EXPERIENCE validate", () => {
	it("is unavailable without the EXPERIENCE service", async () => {
		const runtime = {
			getService: () => null,
		} as unknown as IAgentRuntime;
		expect(
			await manageExperienceAction.validate(
				runtime,
				message("delete that experience"),
			),
		).toBe(false);
	});

	it("validates on structured params or mutation intent text", async () => {
		const { runtime } = makeRuntime();
		expect(
			await manageExperienceAction.validate(runtime, message(), undefined, {
				parameters: { action: "delete" },
			} as HandlerOptions),
		).toBe(true);
		expect(
			await manageExperienceAction.validate(
				runtime,
				message("forget that experience about docker builds"),
			),
		).toBe(true);
		expect(
			await manageExperienceAction.validate(
				runtime,
				message("what's the weather like"),
			),
		).toBe(false);
	});
});

describe("EXPERIENCE confirm gating", () => {
	it("refuses update and delete without confirm:true and touches nothing", async () => {
		const { runtime, updateCalls, deleteCalls } = makeRuntime([
			experience({ id: EXPERIENCE_ID_1, learning: "keep me" }),
		]);
		for (const action of ["update", "delete"] as const) {
			const result = await invoke(runtime, {
				action,
				experienceId: EXPERIENCE_ID_1,
				learning: "changed",
			});
			expect(result.success).toBe(false);
			expect(result.data?.error).toBe("EXPERIENCE_CONFIRMATION_REQUIRED");
		}
		// A stringly "true" must not pass the strict-boolean bar.
		const stringConfirm = await invoke(runtime, {
			action: "delete",
			experienceId: EXPERIENCE_ID_1,
			confirm: "true",
		});
		expect(stringConfirm.success).toBe(false);
		expect(updateCalls).toHaveLength(0);
		expect(deleteCalls).toHaveLength(0);
	});

	it("rejects a missing or unknown op", async () => {
		const { runtime } = makeRuntime();
		const result = await invoke(runtime, { confirm: true });
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("EXPERIENCE_INVALID_OP");
	});
});

describe("EXPERIENCE update", () => {
	it("updates only the provided fields through the service", async () => {
		const { runtime, updateCalls } = makeRuntime([
			experience({
				id: EXPERIENCE_ID_1,
				learning: "old learning",
				tags: ["old"],
			}),
		]);
		const result = await invoke(runtime, {
			action: "update",
			experienceId: EXPERIENCE_ID_1,
			learning: "new learning",
			confidence: 0.9,
			confirm: true,
		});
		expect(result.success).toBe(true);
		expect(updateCalls).toEqual([
			{
				id: EXPERIENCE_ID_1,
				updates: { learning: "new learning", confidence: 0.9 },
			},
		]);
		expect(result.values?.experienceId).toBe(EXPERIENCE_ID_1);
	});

	it("normalizes comma-separated tags like the view's edit form", async () => {
		const { runtime, updateCalls } = makeRuntime([
			experience({ id: EXPERIENCE_ID_1, learning: "x" }),
		]);
		const result = await invoke(runtime, {
			action: "update",
			experienceId: EXPERIENCE_ID_1,
			tags: "alpha, beta , ,gamma",
			confirm: true,
		});
		expect(result.success).toBe(true);
		expect(updateCalls[0]?.updates).toEqual({
			tags: ["alpha", "beta", "gamma"],
		});
	});

	it("rejects invalid ids, out-of-range scores, and empty updates", async () => {
		const { runtime, updateCalls } = makeRuntime([
			experience({ id: EXPERIENCE_ID_1, learning: "x" }),
		]);
		const badId = await invoke(runtime, {
			action: "update",
			experienceId: "not-a-uuid",
			learning: "y",
			confirm: true,
		});
		expect(badId.data?.error).toBe("EXPERIENCE_INVALID_ID");

		const badScore = await invoke(runtime, {
			action: "update",
			experienceId: EXPERIENCE_ID_1,
			importance: 1.5,
			confirm: true,
		});
		expect(badScore.data?.error).toBe("EXPERIENCE_INVALID_SCORE");

		const empty = await invoke(runtime, {
			action: "update",
			experienceId: EXPERIENCE_ID_1,
			confirm: true,
		});
		expect(empty.data?.error).toBe("EXPERIENCE_NO_FIELDS");
		expect(updateCalls).toHaveLength(0);
	});

	it("surfaces a not-found update as a failure", async () => {
		const { runtime } = makeRuntime();
		const result = await invoke(runtime, {
			action: "update",
			experienceId: MISSING_ID,
			learning: "y",
			confirm: true,
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("EXPERIENCE_NOT_FOUND");
	});
});

describe("EXPERIENCE delete", () => {
	it("deletes by id and retains the receipt for the planner without a public callback", async () => {
		const { runtime, store, deleteCalls } = makeRuntime([
			experience({ id: EXPERIENCE_ID_1, learning: "obsolete" }),
		]);
		const callbackTexts: string[] = [];
		const callback: HandlerCallback = async (content) => {
			callbackTexts.push(content.text ?? "");
			return [];
		};
		const result = await invoke(
			runtime,
			{ action: "delete", experienceId: EXPERIENCE_ID_1, confirm: true },
			callback,
		);
		expect(result.success).toBe(true);
		expect(deleteCalls).toEqual([EXPERIENCE_ID_1]);
		expect(store.has(EXPERIENCE_ID_1)).toBe(false);
		expect(callbackTexts).toEqual([]);
		expect(result.text).toContain(EXPERIENCE_ID_1);
		expect(result.transcriptVisibility).toBe("internal");
	});

	it("requires an id or query and surfaces not-found deletes", async () => {
		const { runtime } = makeRuntime();
		const missing = await invoke(runtime, { action: "delete", confirm: true });
		expect(missing.data?.error).toBe("EXPERIENCE_MISSING_ID");

		const callbackTexts: string[] = [];
		const notFound = await invoke(
			runtime,
			{
				action: "delete",
				experienceId: MISSING_ID,
				confirm: true,
			},
			async (content) => {
				callbackTexts.push(content.text ?? "");
				return [];
			},
		);
		expect(notFound.data?.error).toBe("EXPERIENCE_NOT_FOUND");
		expect(notFound.text).toContain(MISSING_ID);
		expect(notFound.transcriptVisibility).toBe("internal");
		expect(callbackTexts).toEqual([]);
	});

	it("deletes the single strong query match", async () => {
		const { runtime, store } = makeRuntime([
			experience({
				id: EXPERIENCE_ID_1,
				learning: "docker builds need buildkit enabled",
				tags: ["docker"],
			}),
			experience({
				id: EXPERIENCE_ID_2,
				learning: "users prefer short answers",
			}),
		]);
		const result = await invoke(runtime, {
			action: "delete",
			query: "docker builds",
			confirm: true,
		});
		expect(result.success).toBe(true);
		expect(store.has(EXPERIENCE_ID_1)).toBe(false);
		expect(store.has(EXPERIENCE_ID_2)).toBe(true);
	});

	it("refuses an ambiguous query and lists candidate ids without deleting", async () => {
		const { runtime, store, deleteCalls } = makeRuntime([
			experience({
				id: EXPERIENCE_ID_1,
				learning: "docker builds need buildkit",
			}),
			experience({
				id: EXPERIENCE_ID_2,
				learning: "docker builds are slow on arm",
			}),
		]);
		const result = await invoke(runtime, {
			action: "delete",
			query: "docker builds",
			confirm: true,
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("EXPERIENCE_AMBIGUOUS_QUERY");
		expect(result.text).toContain(EXPERIENCE_ID_1);
		expect(result.text).toContain(EXPERIENCE_ID_2);
		expect(deleteCalls).toHaveLength(0);
		expect(store.size).toBe(2);
	});

	it("reports no match when the query only weakly matches", async () => {
		const { runtime, store } = makeRuntime([
			experience({
				id: EXPERIENCE_ID_1,
				learning: "docker builds need buildkit",
			}),
		]);
		const result = await invoke(runtime, {
			action: "delete",
			query: "docker kubernetes helm",
			confirm: true,
		});
		expect(result.success).toBe(false);
		expect(result.data?.error).toBe("EXPERIENCE_NOT_FOUND");
		expect(store.size).toBe(1);
	});
});
