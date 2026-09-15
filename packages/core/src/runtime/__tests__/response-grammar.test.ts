/**
 * Unit coverage for guided-decode grammar assembly: the Stage-1 response
 * envelope grammar/skeleton, the Stage-2 per-action grammars (loose and strict
 * single-call union), per-action parameter skeletons, bounded-number rules, the
 * per-span argmax sampler plan, and the guided-decode provider-option merge.
 * Pure grammar construction over synthetic actions and field evaluators — no
 * model, no runtime.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeActionJsonSchema } from "../../actions/action-schema";
import type { Action } from "../../types";
import type { ResponseSkeleton } from "../../types/model";
import {
	buildPlannerActionGrammar,
	buildPlannerActionGrammarStrict,
	buildPlannerParamsSkeleton,
	buildResponseGrammar,
	buildSpanSamplerPlan,
	clearResponseGrammarCache,
	MAX_SIMPLE_REGEX_REPEAT,
	withGuidedDecodeProviderOptions,
} from "../response-grammar";
import type { ResponseHandlerFieldEvaluator } from "../response-handler-field-evaluator";

function makeAction(name: string, overrides: Partial<Action> = {}): Action {
	return {
		name,
		description: `Run ${name}`,
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

const field = (
	overrides: Partial<ResponseHandlerFieldEvaluator>,
): ResponseHandlerFieldEvaluator => ({
	name: "field",
	description: "a field",
	schema: { type: "array", items: { type: "string" } },
	...overrides,
});

const RESPONSE_GRAMMAR_ENV_KEYS = ["ELIZA_LOCAL_GUIDED_DECODE"] as const;
const responseGrammarEnvSnapshot: Record<string, string | undefined> = {};
for (const key of RESPONSE_GRAMMAR_ENV_KEYS) {
	responseGrammarEnvSnapshot[key] = process.env[key];
}

function restoreResponseGrammarTestState(): void {
	clearResponseGrammarCache();
	for (const key of RESPONSE_GRAMMAR_ENV_KEYS) {
		if (responseGrammarEnvSnapshot[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = responseGrammarEnvSnapshot[key];
		}
	}
}

beforeEach(() => {
	restoreResponseGrammarTestState();
});

afterEach(() => {
	restoreResponseGrammarTestState();
});

describe("buildResponseGrammar — Stage-1 envelope", () => {
	it("defaults to the canonical response-handler field envelope", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["tasks", "calendar"] },
		);
		// The skeleton's literal-key glue spans, in order, recover the envelope.
		const keyOrder = responseSkeleton.spans
			.filter((s) => s.key !== undefined && s.kind !== "literal")
			.map((s) => s.key);
		expect(keyOrder).toEqual([
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
		// First span opens the JSON object with the first key.
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"shouldRespond":',
		});
		// Last span closes it.
		expect(responseSkeleton.spans.at(-1)).toEqual({
			kind: "literal",
			value: "}",
		});
		// shouldRespond is a 3-value enum span.
		const sr = responseSkeleton.spans.find((s) => s.key === "shouldRespond");
		expect(sr?.kind).toBe("enum");
		expect(sr?.enumValues).toEqual(["RESPOND", "IGNORE", "STOP"]);
		// The grammar pins shouldRespond and the contexts element enum.
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
		expect(grammar).toContain('"\\"tasks\\""');
		expect(grammar).toContain('"\\"calendar\\""');
		expect(grammar).toContain("contextsarray ::=");
	});

	it("keeps every registered field on direct channels", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "DM" },
		);
		expect(responseSkeleton.spans.some((s) => s.key === "shouldRespond")).toBe(
			true,
		);
		expect(responseSkeleton.spans.some((s) => s.key === "facts")).toBe(true);
		expect(responseSkeleton.spans.some((s) => s.key === "relationships")).toBe(
			true,
		);
		expect(responseSkeleton.spans.some((s) => s.key === "topics")).toBe(true);
		expect(responseSkeleton.spans.some((s) => s.key === "addressedTo")).toBe(
			true,
		);
		expect(responseSkeleton.spans.some((s) => s.key === "emotion")).toBe(true);
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"shouldRespond":',
		});
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
	});

	it("keeps every registered field on one-to-one voice", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "VOICE_DM" },
		);
		expect(responseSkeleton.spans.some((s) => s.key === "shouldRespond")).toBe(
			true,
		);
		expect(responseSkeleton.spans.some((s) => s.key === "facts")).toBe(true);
		expect(responseSkeleton.spans.some((s) => s.key === "relationships")).toBe(
			true,
		);
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
	});

	it("keeps shouldRespond on multi-party voice channels", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "VOICE_GROUP" },
		);
		expect(responseSkeleton.spans.some((s) => s.key === "shouldRespond")).toBe(
			true,
		);
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
	});

	it("always merges `simple` and `general` into the contexts element enum", () => {
		clearResponseGrammarCache();
		const { grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["onlythis"] },
		);
		expect(grammar).toContain('"\\"onlythis\\""');
		expect(grammar).toContain('"\\"simple\\""');
		expect(grammar).toContain('"\\"general\\""');
	});

	it("collapses a single-value field-evaluator enum to a literal span (zero tokens)", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({ name: "mode", schema: { type: "string", enum: ["ONLY"] } }),
				],
			},
			{ contexts: ["general"] },
		);
		const modeSpan = responseSkeleton.spans.find((s) => s.key === "mode");
		expect(modeSpan).toEqual({ kind: "literal", key: "mode", value: '"ONLY"' });
		// The literal is in the grammar root, not as a sampled enum rule.
		expect(grammar).not.toContain("fieldenum-");
		expect(grammar).toContain('"\\"ONLY\\""');
	});

	it("preserves multi-value string field enums as enum spans for prefix shortcuts", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({
						name: "shouldRespond",
						priority: 5,
						schema: { type: "string", enum: ["RESPOND", "IGNORE", "STOP"] },
					}),
					field({
						name: "replyText",
						priority: 20,
						schema: { type: "string" },
					}),
				],
			},
			{ contexts: ["general"] },
		);
		const shouldRespondSpan = responseSkeleton.spans.find(
			(span) => span.key === "shouldRespond",
		);
		expect(shouldRespondSpan).toMatchObject({
			kind: "enum",
			enumValues: ["RESPOND", "IGNORE", "STOP"],
		});
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
	});

	it("uses the field-registry envelope when registered fields are present", () => {
		clearResponseGrammarCache();
		const { responseSkeleton } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({ name: "late", priority: 90, schema: { type: "object" } }),
					field({ name: "early", priority: 20, schema: { type: "object" } }),
				],
			},
			{ contexts: ["general"] },
		);
		const keys = responseSkeleton.spans
			.filter((s) => s.key !== undefined && s.kind !== "literal")
			.map((s) => s.key);
		expect(keys).toEqual(["early", "late"]);
		expect(keys).not.toContain("extract");
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"early":',
		});
	});

	it("is byte-stable / cached across calls for the same registry snapshot", () => {
		clearResponseGrammarCache();
		const a = buildResponseGrammar({ actions: [] }, { contexts: ["x", "y"] });
		const b = buildResponseGrammar({ actions: [] }, { contexts: ["y", "x"] });
		expect(b).toBe(a); // same object reference from the cache (order-insensitive key)
		expect(b.grammar).toBe(a.grammar);
		// A different context set yields a different result.
		const c = buildResponseGrammar({ actions: [] }, { contexts: ["z"] });
		expect(c).not.toBe(a);
	});

	it("shares the complete envelope across direct channel profiles", () => {
		clearResponseGrammarCache();
		const direct = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "DM" },
		);
		const voice = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "VOICE_DM" },
		);
		expect(direct).toBe(voice);
		expect(direct.responseSkeleton.id).toBe(voice.responseSkeleton.id);
		expect(
			direct.responseSkeleton.spans.some((s) => s.key === "shouldRespond"),
		).toBe(true);
		expect(
			voice.responseSkeleton.spans.some((s) => s.key === "shouldRespond"),
		).toBe(true);
	});
});

describe("normalizeActionJsonSchema", () => {
	it("emits a core JSONSchema object with properties / required / additionalProperties:false", () => {
		const action = makeAction("DO_THING", {
			parameters: [
				{
					name: "target",
					description: "where",
					required: true,
					schema: { type: "string", enum: ["a", "b"] },
				},
				{
					name: "count",
					description: "how many",
					schema: { type: "integer", minimum: 1 },
				},
			],
		});
		const schema = normalizeActionJsonSchema(action);
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["target"]);
		expect((schema.properties as Record<string, unknown>).target).toMatchObject(
			{
				type: "string",
				enum: ["a", "b"],
			},
		);
		expect((schema.properties as Record<string, unknown>).count).toMatchObject({
			type: "integer",
			minimum: 1,
		});
	});

	it("honors allowAdditionalParameters", () => {
		const schema = normalizeActionJsonSchema(
			makeAction("OPEN", { allowAdditionalParameters: true, parameters: [] }),
		);
		expect(schema.additionalProperties).toBe(true);
	});

	it("recurses into nested object/array parameter schemas", () => {
		const schema = normalizeActionJsonSchema(
			makeAction("NESTED", {
				parameters: [
					{
						name: "config",
						description: "cfg",
						schema: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
					},
					{
						name: "tags",
						description: "tags",
						schema: { type: "array", items: { type: "string" } },
					},
				],
			}),
		);
		const props = schema.properties as Record<
			string,
			{ properties?: unknown; required?: unknown; items?: unknown }
		>;
		expect(props.config.properties).toBeDefined();
		expect(props.config.required).toEqual(["name"]);
		expect(props.tags.items).toMatchObject({ type: "string" });
	});
});

describe("buildPlannerActionGrammar — Stage-2 per-action grammar", () => {
	it("pins `action` to the enum of available action names", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
		]);
		if (r === null) throw new Error("expected planner grammar");
		const actionSpan = r.responseSkeleton.spans.find((s) => s.key === "action");
		expect(actionSpan?.kind).toBe("enum");
		expect(actionSpan?.enumValues).toEqual(["ALPHA", "BRAVO"]);
		expect(r.grammar).toContain('actionname ::= "\\"ALPHA\\"" | "\\"BRAVO\\""');
		// Args envelope key order: action, parameters, thought.
		const keys = r.responseSkeleton.spans
			.filter((s) => s.key !== undefined)
			.filter((s) => s.kind !== "literal")
			.map((s) => s.key);
		expect(keys).toEqual(["action", "parameters", "thought"]);
	});

	it("collapses to a literal when exactly one action is exposed", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([makeAction("ONLY")]);
		if (r === null) throw new Error("expected planner grammar");
		const actionSpan = r.responseSkeleton.spans.find((s) => s.key === "action");
		expect(actionSpan).toEqual({
			kind: "literal",
			key: "action",
			value: '"ONLY"',
		});
		expect(r.grammar).not.toContain("actionname ::=");
	});

	it("exposes each action's normalized parameter schema for the second pass", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([
			makeAction("WITH_PARAMS", {
				parameters: [
					{
						name: "url",
						description: "the url",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected planner grammar");
		expect(r.actionSchemas.WITH_PARAMS).toMatchObject({
			type: "object",
			required: ["url"],
		});
	});

	it("returns null when no actions are exposed", () => {
		clearResponseGrammarCache();
		expect(buildPlannerActionGrammar([])).toBeNull();
	});

	it("is cached across calls for the same action set", () => {
		clearResponseGrammarCache();
		const a = buildPlannerActionGrammar([makeAction("A"), makeAction("B")]);
		const b = buildPlannerActionGrammar([makeAction("B"), makeAction("A")]);
		expect(b).toBe(a);
	});
});

describe("buildPlannerParamsSkeleton — second-pass per-action parameters", () => {
	it("returns a `{}` literal span when the action has no parameters", () => {
		const sk = buildPlannerParamsSkeleton(makeAction("NO_PARAMS"));
		expect(sk.spans).toEqual([{ kind: "literal", value: "{}" }]);
	});

	it("emits a free-string span for a string param with no enum", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("FREE", {
				parameters: [
					{
						name: "text",
						description: "free text",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		const valueSpans = sk.spans.filter((s) => s.kind !== "literal");
		expect(valueSpans).toEqual([{ kind: "free-string", key: "text" }]);
	});

	it("collapses a single-value string enum to a literal", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("ONE", {
				parameters: [
					{
						name: "op",
						description: "only one op",
						required: true,
						schema: { type: "string", enum: ["send"] },
					},
				],
			}),
		);
		const opSpan = sk.spans.find((s) => s.key === "op");
		expect(opSpan).toEqual({ kind: "literal", key: "op", value: '"send"' });
	});

	it("pins a multi-value string enum as an enum span (the gap this closes)", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("MULTI", {
				parameters: [
					{
						name: "kind",
						description: "one of several kinds",
						required: true,
						schema: {
							type: "string",
							enum: ["user", "channel", "thread"],
						},
					},
				],
			}),
		);
		const kindSpan = sk.spans.find((s) => s.key === "kind");
		expect(kindSpan?.kind).toBe("enum");
		expect(kindSpan?.enumValues).toEqual(["user", "channel", "thread"]);
	});

	it("falls back to free-json for non-string parameter types", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("NESTED", {
				parameters: [
					{
						name: "context",
						description: "an object",
						required: true,
						schema: {
							type: "object",
							properties: { kind: { type: "string", enum: ["a", "b"] } },
						},
					},
				],
			}),
		);
		const ctxSpan = sk.spans.find((s) => s.key === "context");
		expect(ctxSpan).toEqual({ kind: "free-json", key: "context" });
	});

	it("differentiates the skeleton id when enum constraints differ", () => {
		// Same param names, different enum sets — id must differ so a downstream
		// grammar cache doesn't return a stale compilation.
		const noEnum = buildPlannerParamsSkeleton(
			makeAction("X", {
				parameters: [
					{
						name: "k",
						description: "",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		const withEnum = buildPlannerParamsSkeleton(
			makeAction("X", {
				parameters: [
					{
						name: "k",
						description: "",
						required: true,
						schema: { type: "string", enum: ["a", "b"] },
					},
				],
			}),
		);
		expect(noEnum.id).not.toBe(withEnum.id);
	});

	it("rejects non-string enum members (mixed-type enums fall through to free-string)", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("MIXED", {
				parameters: [
					{
						name: "n",
						description: "mixed",
						required: true,
						schema: { type: "string", enum: ["a", 1] as unknown as string[] },
					},
				],
			}),
		);
		const nSpan = sk.spans.find((s) => s.key === "n");
		expect(nSpan).toEqual({ kind: "free-string", key: "n" });
	});
});

describe("buildPlannerActionGrammarStrict — single-call per-action union grammar", () => {
	it("returns null when no actions are exposed", () => {
		expect(buildPlannerActionGrammarStrict([])).toBeNull();
	});

	it("emits one call branch per action at the grammar root", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
		]);
		if (r === null) throw new Error("expected grammar");
		// Branches are root-level alternatives — both call rules referenced
		// from the root.
		expect(r.grammar).toMatch(
			/^root ::= callofaction-ALPHA \| callofaction-BRAVO/m,
		);
		expect(r.grammar).toMatch(/^callofaction-ALPHA ::= /m);
		expect(r.grammar).toMatch(/^callofaction-BRAVO ::= /m);
		// Action name is pinned as a literal inside each call rule, NOT free.
		expect(r.grammar).toContain('"{\\"action\\":\\"ALPHA\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"BRAVO\\""');
	});

	it("emits an empty `{}` params rule for actions with no parameters", () => {
		const r = buildPlannerActionGrammarStrict([makeAction("EMPTY")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(/^paramsofaction-EMPTY ::= "\{\}"$/m);
	});

	it("does NOT factor SNAKE_CASE prefixes — each branch must pin the full action name", () => {
		// Regression: a prior version of this function grouped actions by common
		// prefix (e.g. emit "MESSAGE_" once with a shared suffix rule). That was
		// broken on two fronts: (1) the suffix alternation produced malformed
		// JSON like `{"action":"MESSAGE_"READ""…` because each suffix was
		// JSON-quoted on top of the already-opened action-value quote; (2) the
		// shared suffix rule decoupled the action name from its params rule, so
		// the model could legally pair `MESSAGE_READ` with
		// `paramsofaction-MESSAGE-SEND`. Each call branch must encode the full
		// action name as a single quoted literal.
		const r = buildPlannerActionGrammarStrict([
			makeAction("MESSAGE_SEND"),
			makeAction("MESSAGE_READ"),
			makeAction("MESSAGE_SEARCH"),
			makeAction("REPLY"),
		]);
		if (r === null) throw new Error("expected grammar");
		// Each branch contains the full action name as a single literal.
		expect(r.grammar).toContain('"{\\"action\\":\\"MESSAGE_SEND\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"MESSAGE_READ\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"MESSAGE_SEARCH\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"REPLY\\""');
		// The grammar must NOT contain a `suffix_MESSAGE_` shared rule.
		expect(r.grammar).not.toMatch(/^suffix_MESSAGE_ ::= /m);
	});

	it("pins a multi-value string enum as a GBNF alternation in the params rule", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("MSG", {
				parameters: [
					{
						name: "kind",
						description: "the kind",
						required: true,
						schema: {
							type: "string",
							enum: ["user", "channel", "thread"],
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// The property rule for `kind` should reference the three quoted enum values.
		expect(r.grammar).toContain('"\\"user\\""');
		expect(r.grammar).toContain('"\\"channel\\""');
		expect(r.grammar).toContain('"\\"thread\\""');
		// And NOT fall back to free jsonstring for this property's value.
		expect(r.grammar).toMatch(
			/paramsofaction-MSG-p-kind ::= "\\"kind\\":" \( "\\"user\\"" \| "\\"channel\\"" \| "\\"thread\\"" \)/,
		);
	});

	it("pins an array-of-string-enum element by element", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("CHAR", {
				parameters: [
					{
						name: "fields",
						description: "saveable fields",
						required: true,
						schema: {
							type: "array",
							items: {
								type: "string",
								enum: ["name", "system", "bio"],
							},
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toContain('"\\"name\\""');
		expect(r.grammar).toContain('"\\"system\\""');
		expect(r.grammar).toContain('"\\"bio\\""');
		// Array structure: opening bracket, optional elements, closing bracket.
		expect(r.grammar).toMatch(
			/paramsofaction-CHAR-p-fields ::= "\\"fields\\":" "\[" ws/,
		);
	});

	it("falls back to shared jsonstring for free-text string params", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("REPLY", {
				parameters: [
					{
						name: "text",
						description: "the text",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-REPLY-p-text ::= "\\"text\\":" jsonstring/,
		);
		expect(r.grammar).toMatch(/^jsonstring ::= /m);
	});

	it("compiles a simple anchored regex pattern into the parameter grammar", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("TASK", {
				parameters: [
					{
						name: "id",
						description: "task id",
						required: true,
						schema: { type: "string", pattern: "^task-[0-9]+$" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-TASK-p-id ::= "\\"id\\":" "task-" \[0-9\]\+/,
		);
		expect(r.grammar).not.toMatch(
			/paramsofaction-TASK-p-id ::= "\\"id\\":" jsonstring/,
		);
	});

	it("expands bounded repeat counts in anchored regex patterns", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("CODE", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: { type: "string", pattern: "^[A-Z]{2}[0-9]{4}$" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-CODE-p-code ::= "\\"code\\":" \[A-Z\] \[A-Z\] \[0-9\] \[0-9\] \[0-9\] \[0-9\]/,
		);
	});

	it("expands a last-fit exact repeat and refuses the first overflowing count", () => {
		clearResponseGrammarCache();
		const atoms = Array.from(
			{ length: MAX_SIMPLE_REGEX_REPEAT },
			() => "\\[A-Z\\]",
		).join(" ");
		const fit = buildPlannerActionGrammarStrict([
			makeAction("FIT", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: {
							type: "string",
							pattern: `^[A-Z]{${MAX_SIMPLE_REGEX_REPEAT}}$`,
						},
					},
				],
			}),
		]);
		if (fit === null) throw new Error("expected grammar");
		expect(fit.grammar).toMatch(
			new RegExp(`paramsofaction-FIT-p-code ::= "\\\\"code\\\\":" ${atoms}`),
		);

		const overflow = buildPlannerActionGrammarStrict([
			makeAction("OVERFLOW", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: {
							type: "string",
							pattern: `^[A-Z]{${MAX_SIMPLE_REGEX_REPEAT + 1}}$`,
						},
					},
				],
			}),
		]);
		if (overflow === null) throw new Error("expected grammar");
		expect(overflow.grammar).toMatch(
			/paramsofaction-OVERFLOW-p-code ::= "\\"code\\":" jsonstring/,
		);
	});

	it("refuses an unsafe exact-repeat count before allocating GBNF atoms", () => {
		clearResponseGrammarCache();
		const started = performance.now();
		const r = buildPlannerActionGrammarStrict([
			makeAction("BOMB", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: {
							type: "string",
							pattern: `^A{${"9".repeat(16)}}$`,
						},
					},
				],
			}),
		]);
		expect(performance.now() - started).toBeLessThan(100);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-BOMB-p-code ::= "\\"code\\":" jsonstring/,
		);
		expect(r.grammar ?? "").not.toContain("A A A A A");
	});

	it("refuses nested repeats whose compiled grammar exceeds the total budget", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("NESTED_BOMB", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: {
							type: "string",
							pattern: "^((A{32}){32}){32}$",
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-NESTED-BOMB-p-code ::= "\\"code\\":" jsonstring/,
		);
		expect(r.grammar.length).toBeLessThan(10_000);
	});

	it("falls back when a repeat range exceeds the per-term ceiling", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("RANGE_BOMB", {
				parameters: [
					{
						name: "code",
						description: "code",
						required: true,
						schema: { type: "string", pattern: "^A{32,64}$" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-RANGE-BOMB-p-code ::= "\\"code\\":" jsonstring/,
		);
	});

	it("falls back to validation-backed string grammar for unsupported regex features", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("WILDCARD", {
				parameters: [
					{
						name: "id",
						description: "task id",
						required: true,
						schema: { type: "string", pattern: "^task-.*$" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-WILDCARD-p-id ::= "\\"id\\":" jsonstring/,
		);
	});

	it("falls back when alternation is not explicitly grouped", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammarStrict([
			makeAction("ALT", {
				parameters: [
					{
						name: "id",
						description: "task id",
						required: true,
						schema: { type: "string", pattern: "^foo|bar$" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-ALT-p-id ::= "\\"id\\":" jsonstring/,
		);
	});

	it("recurses into object-typed properties with declared sub-properties", () => {
		// Mirrors paymentContext in real actions: object with enum-typed
		// sub-properties. The strict grammar should pin the sub-property
		// enums, not fall back to a loose jsonvalue.
		const r = buildPlannerActionGrammarStrict([
			makeAction("PAYMENT", {
				parameters: [
					{
						name: "paymentContext",
						description: "context",
						required: true,
						schema: {
							type: "object",
							properties: {
								kind: {
									type: "string",
									enum: ["any_payer", "verified_payer", "specific_payer"],
								},
								scope: {
									type: "string",
									enum: ["owner", "owner_or_linked_identity"],
								},
								payerIdentityId: { type: "string" },
							},
							required: ["kind"],
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Property rule references the nested object rule, not jsonvalue.
		expect(r.grammar).toMatch(
			/paramsofaction-PAYMENT-p-paymentContext ::= "\\"paymentContext\\":" paramsofaction-PAYMENT-paymentContext-obj/,
		);
		// Nested object rule exists and pins kind's enum members.
		expect(r.grammar).toMatch(/paramsofaction-PAYMENT-paymentContext-obj ::= /);
		expect(r.grammar).toContain('"\\"any_payer\\""');
		expect(r.grammar).toContain('"\\"verified_payer\\""');
		expect(r.grammar).toContain('"\\"specific_payer\\""');
		expect(r.grammar).toContain('"\\"owner\\""');
	});

	it("falls back to jsonvalue for objects without declared sub-properties", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("BAG", {
				parameters: [
					{
						name: "extras",
						description: "freeform bag",
						required: false,
						schema: { type: "object" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction-BAG-p-extras ::= "\\"extras\\":" jsonvalue/,
		);
	});

	it("recurses into array-of-object items with declared sub-properties", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("PAGES", {
				parameters: [
					{
						name: "entries",
						description: "list of typed records",
						required: true,
						schema: {
							type: "array",
							items: {
								type: "object",
								properties: {
									kind: { type: "string", enum: ["page", "comment"] },
									id: { type: "string" },
								},
								required: ["kind", "id"],
							},
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Property rule wraps the item rule in array brackets.
		expect(r.grammar).toMatch(
			/paramsofaction-PAGES-p-entries ::= "\\"entries\\":" "\[" ws \( paramsofaction-PAGES-entries-item /,
		);
		// Item rule exists and references the kind enum.
		expect(r.grammar).toMatch(/paramsofaction-PAGES-entries-item ::= /);
		expect(r.grammar).toContain('"\\"page\\""');
		expect(r.grammar).toContain('"\\"comment\\""');
	});

	it("caps object recursion at MAX_NESTED_OBJECT_DEPTH so cyclic schemas don't explode", () => {
		// Build a 6-deep nested schema. The strict grammar caps recursion at
		// depth 4; depth-5 and below should collapse to jsonvalue.
		const deep = (level: number): JSONSchema => {
			if (level === 0) return { type: "string" };
			return { type: "object", properties: { next: deep(level - 1) } };
		};
		const r = buildPlannerActionGrammarStrict([
			makeAction("DEEP", {
				parameters: [
					{
						name: "root",
						description: "",
						required: true,
						schema: deep(6) as {
							type: "object";
							properties: Record<string, unknown>;
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Depths 0..3 each emit their own nested -obj rule; depth 4 stops the
		// recursion and the deepest object falls back to jsonvalue.
		const objRules = (
			r.grammar.match(/paramsofaction-DEEP-(?:[A-Za-z0-9-]+-)*next-obj ::=/g) ??
			[]
		).length;
		expect(objRules).toBeLessThanOrEqual(4);
		expect(r.grammar).toContain("jsonvalue");
	});

	it("emits required-then-optional structure in the params rule", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("MIXED", {
				parameters: [
					{
						name: "a",
						description: "required",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "b",
						description: "optional",
						required: false,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Required `a` precedes the optional-group; optional `b` is wrapped in
		// `( "," ( ... ) )*` (zero-or-more, leading comma).
		expect(r.grammar).toMatch(
			/paramsofaction-MIXED ::= "\{" paramsofaction-MIXED-p-a \( "," \( paramsofaction-MIXED-p-b \) \)\* "\}"/,
		);
	});

	it("returns a minimal skeleton (the grammar carries the structure)", () => {
		const r = buildPlannerActionGrammarStrict([makeAction("ONE")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.responseSkeleton.spans).toEqual([
			{ kind: "free-json", key: "envelope" },
		]);
		expect(typeof r.responseSkeleton.id).toBe("string");
	});

	it("exposes the same normalized parameter schemas as the loose grammar", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("WITH_PARAMS", {
				parameters: [
					{
						name: "url",
						description: "",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.actionSchemas.WITH_PARAMS).toMatchObject({
			type: "object",
			required: ["url"],
			properties: { url: { type: "string" } },
		});
	});

	it("is cached across calls for the same action set", () => {
		const a = buildPlannerActionGrammarStrict([
			makeAction("A"),
			makeAction("B"),
		]);
		const b = buildPlannerActionGrammarStrict([
			makeAction("B"),
			makeAction("A"),
		]);
		expect(b).toBe(a);
	});

	it("does not collide with the loose grammar cache", () => {
		const loose = buildPlannerActionGrammar([makeAction("SAME")]);
		const strict = buildPlannerActionGrammarStrict([makeAction("SAME")]);
		expect(loose).not.toBe(strict);
		if (loose && strict) {
			expect(loose.grammar).not.toBe(strict.grammar);
		}
	});

	it("sanitizes action names that contain GBNF-unsafe characters", () => {
		// Plugin-supplied action names occasionally carry `:` or `.`.
		const r = buildPlannerActionGrammarStrict([makeAction("plugin:foo.bar")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toContain("callofaction-plugin-foo-bar");
		expect(r.grammar).not.toContain("callofaction-plugin:foo.bar");
	});
});

describe("buildPlannerActionGrammarStrict — realistic action set (P2-4 production shape)", () => {
	// Mirror the kind of schemas real actions declare. The test catches
	// regressions where the grammar generator silently drops a constraint
	// someone added downstream.
	const messageAction = makeAction("MESSAGE", {
		parameters: [
			{
				name: "op",
				description: "messaging operation",
				required: true,
				schema: {
					type: "string",
					enum: ["send", "read_channel", "search", "manage"],
				},
			},
			{
				name: "targetKind",
				description: "kind of target",
				required: false,
				schema: {
					type: "string",
					enum: ["user", "channel", "thread", "group"],
				},
			},
			{
				name: "manageOperation",
				description: "manage op",
				required: false,
				schema: {
					type: "string",
					enum: ["archive", "trash", "spam", "mark_read"],
				},
			},
			{
				name: "text",
				description: "body",
				required: false,
				schema: { type: "string" },
			},
		],
	});
	const paymentAction = makeAction("PAYMENT", {
		parameters: [
			{
				name: "action",
				description: "payment op",
				required: true,
				schema: {
					type: "string",
					enum: ["create_request", "cancel_request"],
				},
			},
			{
				name: "amountCents",
				description: "amount in cents",
				required: false,
				schema: { type: "integer", minimum: 1 },
			},
			{
				name: "paymentContext",
				description: "payer constraint",
				required: false,
				schema: {
					type: "object",
					properties: {
						kind: {
							type: "string",
							enum: ["any_payer", "verified_payer", "specific_payer"],
						},
						scope: {
							type: "string",
							enum: ["owner", "owner_or_linked_identity"],
						},
						payerIdentityId: { type: "string" },
					},
					required: ["kind"],
				},
			},
		],
	});
	const characterAction = makeAction("CHARACTER", {
		parameters: [
			{
				name: "op",
				description: "character op",
				required: true,
				schema: {
					type: "string",
					enum: ["save", "update_identity", "reset"],
				},
			},
			{
				name: "fieldsToSave",
				description: "fields to persist",
				required: false,
				schema: {
					type: "array",
					items: {
						type: "string",
						enum: ["name", "system", "bio", "topics"],
					},
				},
			},
		],
	});
	const ignoreAction = makeAction("IGNORE");

	it("emits one branch per action with action name pinned as a literal", () => {
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
			ignoreAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// Root union has one branch per action (alphabetical inside the grammar
		// since the strict builder sorts by name for cache stability).
		expect(r.grammar).toMatch(
			/^root ::= callofaction-CHARACTER \| callofaction-IGNORE \| callofaction-MESSAGE \| callofaction-PAYMENT/m,
		);
		// Each call rule pins the action name as a literal.
		expect(r.grammar).toContain('"{\\"action\\":\\"MESSAGE\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"PAYMENT\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"CHARACTER\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"IGNORE\\""');
	});

	it("pins every declared enum in the realistic action set", () => {
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// MESSAGE enums
		expect(r.grammar).toContain('"\\"send\\""');
		expect(r.grammar).toContain('"\\"read_channel\\""');
		expect(r.grammar).toContain('"\\"search\\""');
		expect(r.grammar).toContain('"\\"manage\\""');
		expect(r.grammar).toContain('"\\"user\\""');
		expect(r.grammar).toContain('"\\"thread\\""');
		expect(r.grammar).toContain('"\\"archive\\""');
		expect(r.grammar).toContain('"\\"trash\\""');
		// PAYMENT enums (including nested object enums)
		expect(r.grammar).toContain('"\\"create_request\\""');
		expect(r.grammar).toContain('"\\"cancel_request\\""');
		expect(r.grammar).toContain('"\\"any_payer\\""');
		expect(r.grammar).toContain('"\\"verified_payer\\""');
		expect(r.grammar).toContain('"\\"owner_or_linked_identity\\""');
		// CHARACTER enums (including array items)
		expect(r.grammar).toContain('"\\"save\\""');
		expect(r.grammar).toContain('"\\"name\\""');
		expect(r.grammar).toContain('"\\"system\\""');
	});

	it("co-determines action name and parameter shape (no cross-branch leak)", () => {
		// Verify that PAYMENT's params rule references PAYMENT-specific
		// sub-rules, not MESSAGE's or CHARACTER's. This is the property that
		// makes the strict grammar fundamentally different from the loose
		// (independent action/params) variant.
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// callofaction-PAYMENT references paramsofaction-PAYMENT (not _MESSAGE
		// / _CHARACTER) before the thought field.
		const paymentCallLine = r.grammar
			.split("\n")
			.find((l) => l.startsWith("callofaction-PAYMENT ::="));
		expect(paymentCallLine).toBeDefined();
		expect(paymentCallLine).toContain("paramsofaction-PAYMENT");
		expect(paymentCallLine).not.toContain("paramsofaction-MESSAGE");
		expect(paymentCallLine).not.toContain("paramsofaction-CHARACTER");

		const messageCallLine = r.grammar
			.split("\n")
			.find((l) => l.startsWith("callofaction-MESSAGE ::="));
		expect(messageCallLine).toBeDefined();
		expect(messageCallLine).toContain("paramsofaction-MESSAGE");
		expect(messageCallLine).not.toContain("paramsofaction-PAYMENT");
	});

	it("returns the same actionSchemas map as the loose grammar would", () => {
		const r = buildPlannerActionGrammarStrict([messageAction, paymentAction]);
		const loose = buildPlannerActionGrammar([messageAction, paymentAction]);
		if (r === null || loose === null) throw new Error("expected grammars");
		expect(Object.keys(r.actionSchemas).sort()).toEqual(
			Object.keys(loose.actionSchemas).sort(),
		);
		expect(r.actionSchemas.PAYMENT).toEqual(loose.actionSchemas.PAYMENT);
		expect(r.actionSchemas.MESSAGE).toEqual(loose.actionSchemas.MESSAGE);
	});
});

describe("withGuidedDecodeProviderOptions", () => {
	const ENV_KEYS = ["ELIZA_LOCAL_GUIDED_DECODE"] as const;
	const saved: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("sets eliza.guidedDecode = true by default and preserves siblings", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const opts = withGuidedDecodeProviderOptions({
			eliza: { plannerActionSchemas: { A: { type: "object" } } },
			other: 1,
		} as Record<string, unknown>);
		expect(opts).toMatchObject({
			other: 1,
			eliza: {
				guidedDecode: true,
				plannerActionSchemas: { A: { type: "object" } },
			},
		});
	});

	it("creates the eliza bag when absent", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const opts = withGuidedDecodeProviderOptions({} as Record<string, unknown>);
		expect((opts as { eliza?: { guidedDecode?: unknown } }).eliza).toEqual({
			guidedDecode: true,
		});
	});

	it("is a no-op when ELIZA_LOCAL_GUIDED_DECODE=false", () => {
		process.env.ELIZA_LOCAL_GUIDED_DECODE = "false";
		const opts = withGuidedDecodeProviderOptions({
			eliza: { plannerActionSchemas: {} },
		} as Record<string, unknown>);
		expect(
			(opts as { eliza?: { guidedDecode?: unknown } }).eliza?.guidedDecode,
		).toBeUndefined();
	});

	it("returns the same object reference (idempotent merge)", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const input = { eliza: { foo: 1 } } as Record<string, unknown>;
		expect(withGuidedDecodeProviderOptions(input)).toBe(input);
		// second pass keeps guidedDecode true, no duplication
		const again = withGuidedDecodeProviderOptions(input);
		expect((again as { eliza?: { guidedDecode?: unknown } }).eliza).toEqual({
			foo: 1,
			guidedDecode: true,
		});
	});
});

describe("buildSpanSamplerPlan — per-span argmax policy", () => {
	it("emits T=0 / topK=1 for every multi-value enum span", () => {
		const skeleton: ResponseSkeleton = {
			id: "test#multi-enum",
			spans: [
				{ kind: "literal", value: '{"shouldRespond":' },
				{
					kind: "enum",
					key: "shouldRespond",
					enumValues: ["RESPOND", "IGNORE", "STOP"],
				},
				{ kind: "literal", value: ',"replyText":' },
				{ kind: "free-string", key: "replyText" },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = buildSpanSamplerPlan(skeleton);
		expect(plan.overrides).toEqual([{ spanIndex: 1, temperature: 0, topK: 1 }]);
		// The override addresses skeleton.spans[1] — the enum span.
		expect(skeleton.spans[plan.overrides[0].spanIndex].kind).toBe("enum");
	});

	it("emits T=0 / topK=1 for number and boolean spans", () => {
		const skeleton: ResponseSkeleton = {
			id: "test#numeric",
			spans: [
				{ kind: "literal", value: '{"count":' },
				{ kind: "number", key: "count" },
				{ kind: "literal", value: ',"shouldStream":' },
				{ kind: "boolean", key: "shouldStream" },
				{ kind: "literal", value: ',"replyText":' },
				{ kind: "free-string", key: "replyText" },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = buildSpanSamplerPlan(skeleton);
		expect(plan.overrides).toEqual([
			{ spanIndex: 1, temperature: 0, topK: 1 },
			{ spanIndex: 3, temperature: 0, topK: 1 },
		]);
	});

	it("skips literal, free-string, and free-json spans", () => {
		const skeleton: ResponseSkeleton = {
			id: "test#all-free",
			spans: [
				{ kind: "literal", value: '{"replyText":' },
				{ kind: "free-string", key: "replyText" },
				{ kind: "literal", value: ',"facts":' },
				{ kind: "free-json", key: "facts" },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = buildSpanSamplerPlan(skeleton);
		expect(plan.overrides).toEqual([]);
	});

	it("skips single-value enums (defensive — they collapse to literals upstream)", () => {
		const skeleton: ResponseSkeleton = {
			id: "test#single-enum",
			spans: [
				{ kind: "literal", value: '{"mode":' },
				// A defensive single-value enum that didn't get collapsed.
				{ kind: "enum", key: "mode", enumValues: ["ONLY"] },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = buildSpanSamplerPlan(skeleton);
		expect(plan.overrides).toEqual([]);
	});

	it("covers the canonical Stage-1 envelope enum decisions", () => {
		clearResponseGrammarCache();
		const { responseSkeleton } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"] },
		);
		const plan = buildSpanSamplerPlan(responseSkeleton);
		// shouldRespond and emotion get overrides; replyText / contexts do not.
		const overriddenKinds = plan.overrides.map(
			(o) => responseSkeleton.spans[o.spanIndex].kind,
		);
		const overriddenKeys = plan.overrides.map(
			(o) => responseSkeleton.spans[o.spanIndex].key,
		);
		expect(overriddenKinds).toContain("enum");
		expect(overriddenKeys).toContain("shouldRespond");
		expect(overriddenKeys).toContain("emotion");
		// Every override carries T=0 and topK=1 — the user's explicit rule.
		for (const o of plan.overrides) {
			expect(o.temperature).toBe(0);
			expect(o.topK).toBe(1);
		}
		// Free-string / free-json spans are not overridden.
		expect(overriddenKeys).not.toContain("replyText");
		expect(overriddenKeys).not.toContain("contexts");
	});

	it("returns an empty plan (no overrides) for a skeleton with only free spans", () => {
		const skeleton: ResponseSkeleton = {
			id: "test#empty",
			spans: [
				{ kind: "literal", value: "{" },
				{ kind: "free-string", key: "any" },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = buildSpanSamplerPlan(skeleton);
		expect(plan.overrides).toEqual([]);
		expect(plan.strict).toBeUndefined();
	});
});

describe("buildPlannerParamsSkeleton — typed number/boolean span kinds", () => {
	it("emits a number span for an integer action parameter", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("SET_COUNT", {
				parameters: [
					{
						name: "count",
						description: "how many",
						required: true,
						schema: { type: "integer" },
					},
				],
			}),
		);
		const countSpan = sk.spans.find((s) => s.key === "count");
		expect(countSpan?.kind).toBe("number");
	});

	it("emits a number span for a `number`-typed action parameter", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("FRAC", {
				parameters: [
					{
						name: "ratio",
						description: "decimal ratio",
						required: true,
						schema: { type: "number" },
					},
				],
			}),
		);
		const ratioSpan = sk.spans.find((s) => s.key === "ratio");
		expect(ratioSpan?.kind).toBe("number");
	});

	it("emits a boolean span for a boolean action parameter", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("TOGGLE", {
				parameters: [
					{
						name: "enabled",
						description: "on/off",
						required: true,
						schema: { type: "boolean" },
					},
				],
			}),
		);
		const enabledSpan = sk.spans.find((s) => s.key === "enabled");
		expect(enabledSpan?.kind).toBe("boolean");
	});

	it("derives T=0 overrides via buildSpanSamplerPlan for a mixed-shape params skeleton", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("MIXED", {
				parameters: [
					{
						name: "count",
						description: "how many",
						required: true,
						schema: { type: "number" },
					},
					{
						name: "enabled",
						description: "on/off",
						required: true,
						schema: { type: "boolean" },
					},
					{
						name: "label",
						description: "free text",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		const plan = buildSpanSamplerPlan(sk);
		const overriddenKeys = plan.overrides.map((o) => sk.spans[o.spanIndex].key);
		// Order matches property emission order in the skeleton.
		expect(overriddenKeys.sort()).toEqual(["count", "enabled"].sort());
		// `label` (free-string) gets no override.
		expect(overriddenKeys).not.toContain("label");
	});
});

describe("buildBoundedNumberRule — integer and float range constraints", () => {
	it("emits a rule with alternation for closed integer range [0, 5]", () => {
		clearResponseGrammarCache();
		const action = makeAction("BOUNDED", {
			parameters: [
				{
					name: "count",
					description: "small count",
					required: true,
					schema: { type: "integer", minimum: 0, maximum: 5 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// The grammar should contain alternation with the bounded values.
		// Check that the bounded rule is present and references both 0 and 5.
		expect(result.grammar).toContain("-count-bounded");
		expect(result.grammar).toContain('"\\"0\\""');
		expect(result.grammar).toContain('"\\"5\\""');
	});

	it("emits a rule with alternation for closed integer range [0, 100]", () => {
		clearResponseGrammarCache();
		const action = makeAction("BOUNDED100", {
			parameters: [
				{
					name: "count",
					description: "count up to 100",
					required: true,
					schema: { type: "integer", minimum: 0, maximum: 100 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// For 0-100 (101 values), still under the 200 threshold, so expect direct alternation.
		expect(result.grammar).toContain("-count-bounded");
		// Should have the edge values in JSON-encoded GBNF format.
		expect(result.grammar).toContain('"\\"0\\""');
		expect(result.grammar).toContain('"\\"100\\""');
		// Spot-check a middle value exists.
		expect(result.grammar).toContain('"\\"50\\""');
	});

	it("handles negative and positive integers in [−10, 10]", () => {
		clearResponseGrammarCache();
		const action = makeAction("SIGNEDCOUNT", {
			parameters: [
				{
					name: "delta",
					description: "signed change",
					required: true,
					schema: { type: "integer", minimum: -10, maximum: 10 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// Should contain negative and positive edge values.
		expect(result.grammar).toContain('"\\"-10\\""');
		expect(result.grammar).toContain('"\\"10\\""');
		expect(result.grammar).toContain('"\\"0\\""');
		expect(result.grammar).toContain('"\\"-1\\""');
	});

	it("falls back to jsonnumber for unbounded number (no min/max)", () => {
		clearResponseGrammarCache();
		const action = makeAction("UNBOUNDED", {
			parameters: [
				{
					name: "value",
					description: "any number",
					required: true,
					schema: { type: "number" },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// Should reference the shared jsonnumber rule, not emit a bounded rule.
		expect(result.grammar).toContain("jsonnumber");
		// Should not emit a -bounded rule for this parameter.
		const lines = result.grammar.split("\n");
		const boundedLines = lines.filter((l) => l.includes("-value-bounded"));
		expect(boundedLines.length).toBe(0);
	});

	it("falls back to jsonnumber for float type with bounds", () => {
		clearResponseGrammarCache();
		const action = makeAction("FLOATRANGE", {
			parameters: [
				{
					name: "ratio",
					description: "decimal ratio",
					required: true,
					schema: { type: "number", minimum: 0, maximum: 1 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// Current implementation falls back to jsonnumber for floats.
		expect(result.grammar).toContain("jsonnumber");
	});

	it("falls back to jsonnumber for ranges > ~200 values", () => {
		clearResponseGrammarCache();
		const action = makeAction("LARGERANGE", {
			parameters: [
				{
					name: "bigcount",
					description: "large count",
					required: true,
					schema: { type: "integer", minimum: 0, maximum: 300 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// For 301 values (> 200), should fall back to jsonnumber.
		expect(result.grammar).toContain("jsonnumber");
	});
});

describe("buildBoundedNumberRule — boundary, single-value, and degenerate ranges", () => {
	it("emits a literal-alternation rule for a 200-difference integer range [1, 200] (at the threshold)", () => {
		clearResponseGrammarCache();
		const action = makeAction("BOUNDARY200", {
			parameters: [
				{
					name: "count",
					description: "exactly 200 values",
					required: true,
					schema: { type: "integer", minimum: 1, maximum: 200 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// max - min = 199 (just under the 200 threshold) → bounded rule emitted.
		const boundedRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-count-bounded ::="));
		expect(boundedRule).toBeDefined();
		// 200 alternatives separated by " | "
		const alternatives = (boundedRule ?? "").split(" | ");
		expect(alternatives.length).toBe(200);
		// First and last and a spot-check middle value all present.
		expect(result.grammar).toContain('"\\"1\\""');
		expect(result.grammar).toContain('"\\"100\\""');
		expect(result.grammar).toContain('"\\"200\\""');
		// The parameter rule references the bounded rule, not the unbounded jsonnumber.
		const paramRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-p-count ::="));
		expect(paramRule).toBeDefined();
		expect(paramRule).toContain("-count-bounded");
		expect(paramRule).not.toContain("jsonnumber");
	});

	it("falls back to bare jsonnumber for a very large integer range [0, 10000]", () => {
		clearResponseGrammarCache();
		const action = makeAction("HUGECOUNT", {
			parameters: [
				{
					name: "count",
					description: "huge count",
					required: true,
					schema: { type: "integer", minimum: 0, maximum: 10000 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// No bounded rule should be emitted at all — the parameter resolves
		// straight to the shared unbounded jsonnumber.
		expect(result.grammar).not.toContain("-count-bounded");
		const paramRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-p-count ::="));
		expect(paramRule).toBeDefined();
		// The parameter line is exactly `"\"count\":" jsonnumber` — i.e. the
		// value part is just the shared rule, with no extra references.
		expect(paramRule).toMatch(/::= "\\"count\\":" jsonnumber$/);
	});

	it("falls back to jsonnumber for a unit-interval float schema with no bounded rule emitted", () => {
		clearResponseGrammarCache();
		const action = makeAction("UNITRATIO", {
			parameters: [
				{
					name: "ratio",
					description: "unit ratio",
					required: true,
					schema: { type: "number", minimum: 0, maximum: 1 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// Float ranges never emit a bounded rule — the value part references
		// jsonnumber directly. Server-side validates the actual numeric bounds.
		expect(result.grammar).not.toContain("-ratio-bounded");
		expect(result.grammar).toContain("jsonnumber");
		const paramRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-p-ratio ::="));
		expect(paramRule).toBeDefined();
		expect(paramRule).toMatch(/::= "\\"ratio\\":" jsonnumber$/);
	});

	it("emits every signed alternative for a small negative-to-positive integer range [-5, 5]", () => {
		clearResponseGrammarCache();
		const action = makeAction("SIGNED5", {
			parameters: [
				{
					name: "delta",
					description: "signed delta",
					required: true,
					schema: { type: "integer", minimum: -5, maximum: 5 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		const boundedRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-delta-bounded ::="));
		expect(boundedRule).toBeDefined();
		const alternatives = (boundedRule ?? "").split(" | ");
		// 11 values: -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5
		expect(alternatives.length).toBe(11);
		for (const value of [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]) {
			expect(result.grammar).toContain(`"\\"${value}\\""`);
		}
	});

	it("collapses a single-value integer range [7, 7] to one literal alternative", () => {
		clearResponseGrammarCache();
		const action = makeAction("FIXED7", {
			parameters: [
				{
					name: "pin",
					description: "pinned value",
					required: true,
					schema: { type: "integer", minimum: 7, maximum: 7 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		const boundedRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-pin-bounded ::="));
		expect(boundedRule).toBeDefined();
		// Exactly one alternative, the literal `"7"` — no alternation pipe.
		expect(boundedRule).toBe('paramsofaction-FIXED7-pin-bounded ::= "\\"7\\""');
		expect(boundedRule).not.toContain(" | ");
	});

	it("falls back to jsonnumber for an inverted integer range [10, 5]", () => {
		clearResponseGrammarCache();
		const action = makeAction("INVERTED", {
			parameters: [
				{
					name: "bad",
					description: "min > max",
					required: true,
					schema: { type: "integer", minimum: 10, maximum: 5 },
				},
			],
		});
		const result = buildPlannerActionGrammarStrict([action]);
		expect(result).not.toBeNull();
		if (!result) return;
		// An inverted range (min > max) is unsatisfiable, so the impl
		// falls back to the shared `jsonnumber` rule (same shape as the large-
		// range and float cases) instead of emitting an empty rule body that
		// would produce malformed GBNF.
		expect(result.grammar).not.toContain("-bad-bounded");
		const paramRule = result.grammar
			.split("\n")
			.find((l) => l.includes("-p-bad ::="));
		expect(paramRule).toBeDefined();
		expect(paramRule).toMatch(/::= "\\"bad\\":" jsonnumber$/);
	});
});
