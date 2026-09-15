/**
 * Stage-1 unusable-decision repair trigger: a parseable decision that ends an
 * addressed turn without an answer (STOP/IGNORE with no stop language, or a
 * simple route with an empty reply and no pending work) gets one correction
 * prompt; real disengage requests, answers, routed work and refusal stubs get
 * none. Pure function, no runtime.
 */
import { describe, expect, it } from "vitest";
import { getStage1UnusableDecisionRepair } from "./stage1-generation";

const QUESTION = "one line: what's the capital of chile?";

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		shouldRespond: "RESPOND",
		contexts: ["simple"],
		replyText: "",
		replyEffectStatus: "none",
		requiresTool: false,
		candidateActionNames: [],
		intents: [],
		contextRequests: [],
		...overrides,
	};
}

describe("getStage1UnusableDecisionRepair", () => {
	it("repairs a STOP with an empty plan on a plain question (live 2026-09-15: shipped the canned deferral)", () => {
		const repair = getStage1UnusableDecisionRepair(
			decision({ shouldRespond: "STOP", contexts: [] }),
			QUESTION,
		);
		expect(repair).toContain("response_contract_repair:");
		expect(repair).toContain("without answering");
		expect(repair).toContain('"shouldRespond":"STOP"');
	});

	it("repairs an IGNORE and an empty simple reply on an addressed request", () => {
		expect(
			getStage1UnusableDecisionRepair(
				decision({ shouldRespond: "IGNORE", contexts: [] }),
				QUESTION,
			),
		).toContain("response_contract_repair:");
		expect(
			getStage1UnusableDecisionRepair(decision({ replyText: "   " }), QUESTION),
		).toContain("response_contract_repair:");
	});

	it("leaves real disengage requests, answers, routed work and refusal stubs alone", () => {
		expect(
			getStage1UnusableDecisionRepair(
				decision({ shouldRespond: "STOP", contexts: [] }),
				"ok stop, never mind",
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ replyText: "Santiago." }),
				QUESTION,
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ contexts: ["calendar"], intents: ["create the event"] }),
				QUESTION,
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ requiresTool: true, contexts: ["general"] }),
				QUESTION,
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ contextRequests: ["CONTEXT_CATALOG"] }),
				QUESTION,
			),
		).toBeUndefined();
		expect(
			getStage1UnusableDecisionRepair(
				decision({ replyText: "I don't know." }),
				QUESTION,
			),
		).toBeUndefined();
		expect(getStage1UnusableDecisionRepair(null, QUESTION)).toBeUndefined();
	});
});
