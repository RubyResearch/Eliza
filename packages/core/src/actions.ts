/**
 * Formats the agent's registered actions into prompt text and parses the action
 * calls the model returns back into validated parameters. On the render side it
 * composes deterministic (seeded-RNG) complete action examples,
 * name/description/parameter listings, and canonical JSON call examples, so a
 * given action set always yields the same prompt. On the parse side it turns the
 * model's `{ actions, params }` payload into a per-action
 * `Map<string, ActionParameters>`, coercing loose scalars/arrays and validating
 * each value against the action's parameter schema (type, enum, pattern,
 * min/max).
 *
 * Sits between the action catalog and the message loop's model call, and also
 * acts as the barrel re-exporting the action sub-modules (extractor pipeline,
 * JSON model output, subaction promotion/dispatch, recent-context,
 * resolve-action-args). Nested model `params` graphs are bounded in
 * `action-parameter-value.ts`.
 */
import {
	parseActionParams,
	toActionParameterValue,
} from "./action-parameter-value.ts";
import { testSchemaPattern } from "./actions/validate-tool-args.ts";
import { allActionDocs } from "./generated/action-docs.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionParameterSchema,
	ActionParameters,
	ActionParameterValue,
	JsonValue,
} from "./types";
import {
	buildDeterministicSeed,
	createDeterministicRandom,
	deterministicShuffle,
	getDeterministicNames,
} from "./utils/deterministic";
import {
	deepToWellFormedUnicode,
	toWellFormedUnicode,
} from "./utils/well-formed.ts";

export {
	type ExtractorPipelineResult,
	type RunExtractorPipelineArgs,
	runExtractorPipeline,
} from "./actions/extractor-pipeline";
export {
	parseJsonModelArray,
	parseJsonModelOutput,
	parseJsonModelRecord,
} from "./actions/json-model-output";
export {
	isPromotedSubactionVirtual,
	listSubactionsFromParameters,
	type PromoteSubactionsOptions,
	promoteSubactionsToActions,
	type SubactionPromotionOverrides,
} from "./actions/promote-subactions";
export {
	recentConversationTexts,
	recentConversationTextsFromState,
} from "./actions/recent-context";
export {
	type ResolveActionArgsInput,
	type ResolveActionArgsResult,
	resolveActionArgs,
	type SubactionSpec,
	type SubactionsMap,
} from "./actions/resolve-action-args";
export {
	CANONICAL_SUBACTION_KEY,
	DEFAULT_SUBACTION_KEYS,
	dispatchSubaction,
	normalizeSubaction,
	readSubaction,
	type SubactionHandler,
	type SubactionHandlerMap,
	type SubactionParameters,
} from "./actions/subaction-dispatch";
export {
	testSchemaPattern,
	type ValidateToolArgsResult,
	validateSchema,
	validateToolArgs,
} from "./actions/validate-tool-args";

type ActionDocByName = Record<string, (typeof allActionDocs)[number]>;

const actionDocByName: ActionDocByName = allActionDocs.reduce<ActionDocByName>(
	(acc, doc) => {
		acc[doc.name] = doc;
		return acc;
	},
	{},
);

export const composeActionExamples = (
	actionsData: Action[],
	count: number,
	seed = "actions",
): string => {
	if (!actionsData.length || count <= 0) {
		return "";
	}

	const actionsWithExamples = actionsData.filter(
		(action) =>
			action.examples &&
			Array.isArray(action.examples) &&
			action.examples.length > 0,
	);

	if (!actionsWithExamples.length) {
		return "";
	}

	const examplesCopy: ActionExample[][][] = actionsWithExamples.map(
		(action) => [...(action.examples || [])],
	);

	const selectedExamples: ActionExample[][] = [];
	const random = createDeterministicRandom(
		buildDeterministicSeed(seed, "examples"),
	);

	const availableActionIndices = examplesCopy
		.map((examples, index) => (examples.length > 0 ? index : -1))
		.filter((index) => index !== -1);

	while (selectedExamples.length < count && availableActionIndices.length > 0) {
		const randomIndex = Math.floor(random() * availableActionIndices.length);
		const actionIndex = availableActionIndices[randomIndex];
		const examples = examplesCopy[actionIndex];

		const exampleIndex = Math.floor(random() * examples.length);
		selectedExamples.push(examples.splice(exampleIndex, 1)[0]);

		if (examples.length === 0) {
			availableActionIndices.splice(randomIndex, 1);
		}
	}

	return formatSelectedExamples(
		selectedExamples,
		buildDeterministicSeed(seed, "names"),
	);
};

function formatActionCallExample(example: {
	user: string;
	actions: readonly string[];
	params?: Record<string, Record<string, unknown>>;
}): string {
	const paramsByAction = example.params ?? {};
	const assistantPayload: Record<string, unknown> = {
		actions: [...example.actions],
	};

	if (Object.keys(paramsByAction).length > 0) {
		assistantPayload.params = paramsByAction;
	}

	return `User: ${example.user}\nAssistant:\n${JSON.stringify(assistantPayload, null, 2)}`;
}

/** Render canonical JSON action-call examples. */
export function composeActionCallExamples(
	actionsData: Action[],
	maxExamples: number,
): string {
	if (!actionsData.length || maxExamples <= 0) return "";

	const blocks: string[] = [];
	const sorted = [...actionsData].sort((a, b) => a.name.localeCompare(b.name));

	for (const action of sorted) {
		const doc = actionDocByName[action.name];
		if (!doc?.exampleCalls || doc.exampleCalls.length === 0) continue;
		for (const ex of doc.exampleCalls) {
			blocks.push(formatActionCallExample(ex));
			if (blocks.length >= maxExamples) return blocks.join("\n\n");
		}
	}

	return blocks.join("\n\n");
}

const formatSelectedExamples = (
	examples: ActionExample[][],
	seed = "actions",
): string => {
	const MAX_NAME_PLACEHOLDERS = 5;

	return examples
		.map((example, index) => {
			const randomNames = getDeterministicNames(
				MAX_NAME_PLACEHOLDERS,
				buildDeterministicSeed(seed, index),
			);

			const conversation = example
				.map((message) => {
					let messageText = `${message.name}: ${message.content.text}`;

					for (let i = 0; i < randomNames.length; i++) {
						messageText = messageText.replaceAll(
							`{{name${i + 1}}}`,
							randomNames[i],
						);
					}

					return messageText;
				})
				.join("\n");

			return `\n${conversation}`;
		})
		.join("\n");
};

function getExampleActionHints(example: ActionExample[]): string[] {
	const hints = new Set<string>();
	for (const message of example) {
		const content = message.content as {
			action?: unknown;
			actions?: unknown;
		};
		if (typeof content.action === "string" && content.action.trim()) {
			hints.add(content.action.trim());
		}
		if (Array.isArray(content.actions)) {
			for (const action of content.actions) {
				if (typeof action === "string" && action.trim()) {
					hints.add(action.trim());
				}
			}
		}
	}
	return [...hints];
}

function formatPromptScalar(value: unknown): string {
	if (value == null) return "null";
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => formatPromptScalar(item))
			.filter(Boolean)
			.join("|");
	}
	if (typeof value === "object") {
		return Object.entries(value as Record<string, unknown>)
			.map(([key, entry]) => `${key}:${formatPromptScalar(entry)}`)
			.join(",");
	}
	return String(value);
}

function formatActionExampleSummary(action: Action): string | null {
	const examples = action.examples ?? [];
	if (!Array.isArray(examples) || examples.length === 0) {
		return null;
	}

	const rendered: string[] = [];
	for (const example of examples) {
		if (!Array.isArray(example) || example.length === 0) {
			continue;
		}

		const userMessage = example[0]?.content?.text;
		const actionHints = getExampleActionHints(example);
		if (!userMessage) {
			continue;
		}
		rendered.push(
			actionHints.length === 0
				? `User: ${formatPromptScalar(userMessage)} -> actions: ${action.name}`
				: `User: ${formatPromptScalar(userMessage)} -> actions: ${actionHints.join(", ")}`,
		);
	}

	return rendered.length > 0 ? rendered.join("\n") : null;
}

function shuffleActions<T>(items: T[], seed = "actions"): T[] {
	return deterministicShuffle(items, seed);
}

function collectActionSimiles(action: Action): string[] {
	return [
		...new Set(
			(action.similes ?? [])
				.filter((simile): simile is string => typeof simile === "string")
				.map((simile) => simile.trim()),
		),
	].filter((simile) => simile.length > 0);
}

function collectActionTags(action: Action): string[] {
	return [
		...new Set(
			(action.tags ?? [])
				.filter((tag): tag is string => typeof tag === "string")
				.map((tag) => tag.trim()),
		),
	].filter((tag) => tag.length > 0 && tag !== "always-include");
}

function renderCompleteDescription(item: {
	description?: string;
	descriptionCompressed?: string;
	compressedDescription?: string;
}): string {
	return item.description ?? "";
}

export function formatActionNames(actions: Action[], seed = "actions"): string {
	if (!actions.length) return "";

	return shuffleActions(actions, buildDeterministicSeed(seed, "names"))
		.map((action) => action.name)
		.join(", ");
}

export function formatActions(actions: Action[], seed = "actions"): string {
	if (!actions.length) return "";

	const actionRows = shuffleActions(
		actions,
		buildDeterministicSeed(seed, "descriptions"),
	).map((action) => ({
		name: action.name,
		description:
			renderCompleteDescription(action) || "No description available",
		params:
			action.parameters && action.parameters.length > 0
				? formatActionParameters(action.parameters)
				: "",
		aliases: collectActionSimiles(action),
		tags: collectActionTags(action),
		example: formatActionExampleSummary(action) ?? "",
	}));

	return JSON.stringify({ actions: actionRows }, null, 2);
}

export function formatActionParameters(parameters: ActionParameter[]): string {
	if (!parameters.length) return "";

	return parameters
		.map((param) => {
			const typeStr = formatParameterType(param.schema);
			const modifiers: string[] = [];

			if (param.schema.enum?.length) {
				modifiers.push(`values=${param.schema.enum.join("|")}`);
			}

			if (param.schema.default !== undefined) {
				modifiers.push(`default=${formatPromptScalar(param.schema.default)}`);
			}

			if (param.examples && param.examples.length > 0) {
				modifiers.push(
					`examples=${param.examples.map((v) => formatPromptScalar(v)).join("|")}`,
				);
			}

			const suffix = modifiers.length > 0 ? ` [${modifiers.join("; ")}]` : "";
			return `${param.name}${param.required ? "" : "?"}:${typeStr}${suffix} - ${renderCompleteDescription(param)}`;
		})
		.join("; ");
}

function formatParameterType(schema: ActionParameterSchema): string {
	if (schema.anyOf?.length) {
		return `(${schema.anyOf.map(formatParameterType).join(" | ")})`;
	}
	if (schema.oneOf?.length) {
		return schema.oneOf.map(formatParameterType).join(" | ");
	}

	const primitiveType = schema.type;
	switch (primitiveType) {
		case "string":
			return "string";
		case "number":
			return schema.minimum !== undefined || schema.maximum !== undefined
				? `number [${schema.minimum ?? "∞"}-${schema.maximum ?? "∞"}]`
				: "number";
		case "boolean":
			return "boolean";
		case "array":
			return schema.items
				? `array of ${formatParameterType(schema.items)}`
				: "array";
		case "object":
			return "object";
		case undefined:
			return "unknown";
		default:
			return primitiveType;
	}
}

export { parseActionParams };

export function validateActionParams(
	action: Action,
	extractedParams: ActionParameters | undefined,
): { valid: boolean; params: ActionParameters | undefined; errors: string[] } {
	const errors: string[] = [];
	const params: ActionParameters = {};

	if (!action.parameters || action.parameters.length === 0) {
		return { valid: true, params: undefined, errors: [] };
	}

	for (const paramDef of action.parameters) {
		const extractedValue = coerceActionParamValue(
			paramDef,
			extractedParams ? extractedParams[paramDef.name] : undefined,
		);

		if (extractedValue === undefined || extractedValue === null) {
			if (paramDef.required) {
				errors.push(
					`Required parameter '${paramDef.name}' was not provided for action ${action.name}`,
				);
			} else if (paramDef.schema.default !== undefined) {
				params[paramDef.name] = paramDef.schema.default;
			}
		} else {
			const typeError = validateParamType(paramDef, extractedValue);
			if (typeError) {
				if (paramDef.required) {
					errors.push(typeError);
				} else if (paramDef.schema.default !== undefined) {
					params[paramDef.name] = paramDef.schema.default;
				}
			} else {
				params[paramDef.name] = extractedValue;
			}
		}
	}

	return {
		valid: errors.length === 0,
		params: Object.keys(params).length > 0 ? params : undefined,
		errors,
	};
}

function coerceActionParamValue(
	paramDef: ActionParameter,
	value: ActionParameters[string] | undefined,
): ActionParameters[string] | undefined {
	if (
		paramDef.schema.type === "string" &&
		(typeof value === "number" || typeof value === "bigint")
	) {
		return String(value);
	}

	if (paramDef.schema.type !== "array" || Array.isArray(value)) {
		return value;
	}

	if (typeof value !== "string") {
		return value;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed) as unknown;
		} catch {
			// error-policy:J3 This field accepts either a JSON array or its documented
			// delimited-string form; malformed JSON remains untrusted string input.
		}
		if (Array.isArray(parsed)) {
			return toActionParameterValue(deepToWellFormedUnicode(parsed));
		}
	}

	if (paramDef.schema.items?.type !== "string") {
		return value;
	}

	const splitValues = toWellFormedUnicode(trimmed)
		.split(/\|\||,|\n/)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	if (splitValues.length === 0) {
		return [];
	}

	return splitValues;
}

type ValidatableParamValue =
	| ActionParameterValue
	| ActionParameters
	| ActionParameterValue[]
	| ActionParameters[]
	| JsonValue;

function validateParamType(
	paramDef: ActionParameter,
	value: ValidatableParamValue,
): string | undefined {
	const { schema, name } = paramDef;

	switch (schema.type) {
		case "string": {
			if (typeof value !== "string") {
				return `Parameter '${name}' expected string, got ${typeof value}`;
			}
			const enumValues = schema.enumValues ?? schema.enum;
			if (enumValues && !enumValues.includes(value)) {
				return `Parameter '${name}' value '${value}' not in allowed values: ${enumValues.join(", ")}`;
			}
			if (schema.pattern) {
				const result = testSchemaPattern(schema.pattern, value);
				if (!result.ok) {
					return `Parameter '${name}' value '${value}' ${result.reason}`;
				}
			}
			break;
		}

		case "number":
			if (typeof value !== "number") {
				return `Parameter '${name}' expected number, got ${typeof value}`;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				return `Parameter '${name}' value ${value} is below minimum ${schema.minimum}`;
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				return `Parameter '${name}' value ${value} is above maximum ${schema.maximum}`;
			}
			break;

		case "boolean":
			if (typeof value !== "boolean") {
				return `Parameter '${name}' expected boolean, got ${typeof value}`;
			}
			break;

		case "array":
			if (!Array.isArray(value)) {
				return `Parameter '${name}' expected array, got ${typeof value}`;
			}
			break;

		case "object":
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return `Parameter '${name}' expected object, got ${typeof value}`;
			}
			break;
	}

	return undefined;
}
