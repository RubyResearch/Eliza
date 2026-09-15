/**
 * Covers Stage-1 response parsing: the replyText field evaluator (structural-
 * punctuation and leaked tool-call-markup stripping), parseMessageHandlerOutput's
 * complete candidate-action and intent arrays, and alignment of HANDLE_RESPONSE_SCHEMA
 * with the composed field-registry schema. Deterministic — parses fixed JSON
 * envelopes, no model.
 */
import { describe, expect, it } from "vitest";
import { HANDLE_RESPONSE_SCHEMA } from "../../actions/to-tool";
import {
	BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
	replyEffectStatusFieldEvaluator,
	replyTextFieldEvaluator,
} from "../builtin-field-evaluators";
import {
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
} from "../message-handler";
import { ResponseHandlerFieldRegistry } from "../response-handler-field-registry";

describe("message handler retrieval hint output", () => {
	it("normalizes structural JSON punctuation out of replyText", () => {
		expect(replyTextFieldEvaluator.parse("}")).toBe("");
		expect(replyTextFieldEvaluator.parse(' " , ')).toBe("");
		expect(replyTextFieldEvaluator.parse("Hello there.")).toBe("Hello there.");
	});

	it("normalizes semantic effect status and defaults malformed values to none", () => {
		expect(replyEffectStatusFieldEvaluator.parse(" APPLIED ")).toBe("applied");
		expect(replyEffectStatusFieldEvaluator.parse("non_applied")).toBe(
			"non_applied",
		);
		expect(replyEffectStatusFieldEvaluator.parse("maybe")).toBe("none");
	});

	it.each(["pending", "applied", "non_applied", "none"])(
		"preserves %s reply status through JSON and transcript parsing",
		(replyEffectStatus) => {
			const replyText = "The requested work has this model-declared status.";
			const json = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					contexts: ["simple"],
					replyText,
					replyEffectStatus,
				}),
			);
			const transcript = parseMessageHandlerOutput(
				[
					"shouldRespond: RESPOND",
					"contexts: simple",
					`replyText: ${replyText}`,
					`replyEffectStatus: ${replyEffectStatus}`,
				].join("\n"),
			);
			for (const parsed of [json, transcript]) {
				expect(parsed?.plan.replyEffectStatus).toBe(replyEffectStatus);
				expect(parsed?.plan.reply).toBe(replyText);
			}
		},
	);

	it.each([undefined, null, {}, "unknown", ""])(
		"does not treat invalid effect status %j as an explicit no-effect decision",
		(replyEffectStatus) => {
			const parsed = parseMessageHandlerOutput(
				JSON.stringify({
					shouldRespond: "RESPOND",
					contexts: ["simple"],
					replyText: "The requested time is Friday at 1 PM.",
					replyEffectStatus,
				}),
			);
			expect(parsed).not.toBeNull();
			expect(parsed?.plan.replyEffectStatus).toBeUndefined();
		},
	);

	it("strips leaked model tool-call markup out of replyText", () => {
		// Weak models emit their native tool-call serialization as plain text;
		// it must never reach the user. Cover closed, truncated-open, and
		// markup-only forms.
		expect(
			replyTextFieldEvaluator.parse(
				"Bitcoin is at <tool_call>WEB_FETCH<arg_key>url</arg_key><arg_value>x</arg_value></tool_call>",
			),
		).toBe("Bitcoin is at");
		expect(
			replyTextFieldEvaluator.parse("answer: 4 <tool_call>TASKS_SPAWN_AGENT"),
		).toBe("answer: 4");
		expect(replyTextFieldEvaluator.parse("<tool_call>X</tool_call>")).toBe("");
	});

	it("preserves prose that merely mentions tool-call markup", () => {
		// The truncated-open branch must not eat a documentation/explanation reply
		// to end-of-string just because it contains the literal `<tool_call>`.
		expect(
			replyTextFieldEvaluator.parse(
				"To call a tool, the model emits <tool_call> followed by the name.",
			),
		).toBe("To call a tool, the model emits <tool_call> followed by the name.");
	});

	it("preserves every canonical action hint and intent exactly in order", () => {
		const actionHints = [
			" send_email ",
			"SEND_EMAIL",
			...Array.from({ length: 13 }, (_, index) => `action_${index}`),
		];
		const intents = [
			" plan_trip ",
			"PLAN_TRIP",
			...Array.from({ length: 9 }, (_, index) => `intent_${index}`),
		];
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["tasks"],
				candidateActionNames: actionHints,
				intents,
			}),
		);

		expect(parsed?.plan.candidateActions).toEqual(actionHints);
		expect(parsed?.plan.intents).toEqual(intents);
	});

	it("keeps missing hint arrays backward-compatible", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["calendar"],
			}),
		);

		expect(parsed?.plan).toEqual({ contexts: ["calendar"], reply: "" });
	});

	it("rejects malformed canonical retrieval hint values", () => {
		const parsed = parseMessageHandlerOutput(
			JSON.stringify({
				shouldRespond: "RESPOND",
				replyText: "",
				contexts: ["email"],
				candidateActionNames: { action: "send_email" },
			}),
		);

		expect(parsed).toBeNull();
	});

	it("exposes the canonical field-registry fields in the default schema", () => {
		expect(Object.keys(HANDLE_RESPONSE_SCHEMA.properties ?? {})).toEqual([
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
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
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

	it("keeps the default schema aligned with the production field-registry schema", () => {
		const registry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			registry.register(evaluator);
		}

		const composedSchema = registry.composeSchema();

		expect(Object.keys(composedSchema.properties ?? {})).toEqual([
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
		expect(composedSchema.properties).toMatchObject({
			shouldRespond: { type: "string", enum: ["RESPOND", "IGNORE", "STOP"] },
			contexts: { type: "array" },
			contextRequests: { type: "array", items: { type: "string" } },
			intents: { type: "array" },
			replyText: { type: "string" },
			replyEffectStatus: {
				type: "string",
				enum: ["none", "applied", "non_applied", "pending"],
			},
			candidateActionNames: { type: "array" },
			facts: { type: "array" },
			relationships: { type: "array" },
			topics: { type: "array" },
			addressedTo: { type: "array" },
			emotion: { type: "string" },
		});
		expect(composedSchema.properties?.thought).toBeUndefined();
		expect(composedSchema.properties?.contextSlices).toBeUndefined();
		expect(composedSchema.properties?.candidateActions).toBeUndefined();
		expect(composedSchema.properties?.parentActionHints).toBeUndefined();
		expect(composedSchema.properties?.requiresTool).toBeUndefined();
		expect(composedSchema.properties?.extract).toBeUndefined();
		expect(Object.keys(composedSchema.properties ?? {})).toEqual(
			Object.keys(HANDLE_RESPONSE_SCHEMA.properties ?? {}),
		);
		expect(composedSchema.required).toEqual(HANDLE_RESPONSE_SCHEMA.required);
	});
});

describe("task-status claim on the simple path promotes to planning", () => {
	const makeOutput = (reply: string) =>
		({
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["simple"],
				reply,
				simple: true,
				requiresTool: false,
			},
		}) as never;

	it("parroted 'no task exists' denial for a status ask routes to tasks planning with TASKS seeded", () => {
		const output = makeOutput(
			'no task exists for "nubs website". the app idea got stopped before anything shipped. nothing running now.',
		);
		const route = routeMessageHandlerOutput(output, {
			messageText:
				"whats the real status of the nubs website build task right now",
		});
		expect(route.type).toBe("planning_needed");
		if (route.type === "planning_needed") {
			expect(route.contexts).toEqual(["tasks"]);
			expect(route.output.plan.candidateActions).toContain("TASKS");
		}
	});

	it("a genuine simple answer to a status ask stays final", () => {
		const output = makeOutput(
			"the site shipped this morning — it lives at https://example.org/apps/nubs/",
		);
		const route = routeMessageHandlerOutput(output, {
			messageText: "is the website build task done?",
		});
		expect(route.type).toBe("final_reply");
	});

	it("a task-state claim without a status ask stays final", () => {
		const output = makeOutput("nothing running now, all quiet.");
		const route = routeMessageHandlerOutput(output, {
			messageText: "hows your day going",
		});
		expect(route.type).toBe("final_reply");
	});
});
