/**
 * Unit coverage for the tool-call diagnostic projection: composed
 * runtime-known + shape redaction, key-based masking, primitive
 * preservation, non-mutation, structural sharing, and cycle/depth bounds.
 * Deterministic and fully synthetic — every credential-shaped value is an
 * obviously fake canary, never a real secret.
 */

import { describe, expect, it } from "vitest";
import {
	composeToolDiagnosticRedactor,
	projectCompleteModelCallValue,
	projectCompleteToolValueForModel,
	projectModelCallDiagnosticValue,
	projectProtectedModelCallValue,
	projectToolDiagnosticArgs,
	projectToolDiagnosticValue,
	TOOL_DIAGNOSTIC_MASK,
} from "./tool-diagnostics";

const RUNTIME_SECRET_CANARY = "SYNTH-RUNTIME-SECRET-CANARY-0000";
const FLAG_CANARY = "SYNTH-FLAG-CANARY-1111";
const USERINFO_CANARY = "SYNTH-URI-CANARY-2222";

const redactor = composeToolDiagnosticRedactor({
	redactSecrets: (text) =>
		text.split(RUNTIME_SECRET_CANARY).join("[REDACTED:CANARY]"),
});

function deeplyNestedCanaryValue(): Record<string, unknown> {
	let value: Record<string, unknown> = { final: "FINAL-CANARY" };
	for (let depth = 18; depth >= 1; depth -= 1) value = { child: value };
	return { first: "FIRST-CANARY", child: value };
}

describe("composeToolDiagnosticRedactor", () => {
	it("applies runtime-known-secret redaction before shape patterns", () => {
		const projected = redactor(
			`run with ${RUNTIME_SECRET_CANARY} and --token=${FLAG_CANARY}`,
		);
		expect(projected).not.toContain(RUNTIME_SECRET_CANARY);
		expect(projected).not.toContain(FLAG_CANARY);
		expect(projected).toContain("[REDACTED:CANARY]");
	});

	it("keeps the shape pass when redactSecrets is identity", () => {
		const identity = composeToolDiagnosticRedactor({
			redactSecrets: (text) => text,
		});
		expect(identity(`--token=${FLAG_CANARY}`)).not.toContain(FLAG_CANARY);
	});

	it("masks URI userinfo credentials", () => {
		const projected = redactor(
			`https://user:${USERINFO_CANARY}@internal.example/path`,
		);
		expect(projected).not.toContain(USERINFO_CANARY);
		expect(projected).toContain("https://***@internal.example/path");
	});
});

describe("projectToolDiagnosticValue", () => {
	it.each([projectToolDiagnosticValue, projectCompleteToolValueForModel])(
		"withholds private recovery snapshots from raw memory tool results",
		(project) => {
			const marker = {
				scope: "private-turn",
				replyRecoveryJson: '{"context":"OWNER-PRIVATE-RECOVERY-CANARY"}',
			};
			const original = {
				content: { text: "Visible original request", chatIdempotency: marker },
				replyRecoveryJson: marker.replyRecoveryJson,
			};
			expect(project(original, redactor)).toEqual({
				content: {
					text: "Visible original request",
					chatIdempotency: TOOL_DIAGNOSTIC_MASK,
				},
				replyRecoveryJson: TOOL_DIAGNOSTIC_MASK,
			});
			expect(original.content.chatIdempotency).toBe(marker);
			expect(marker.replyRecoveryJson).toContain(
				"OWNER-PRIVATE-RECOVERY-CANARY",
			);
		},
	);

	it("preserves numbers, booleans, and null exactly", () => {
		const args = {
			retries: 3,
			tokenCount: 12,
			maxTokens: 4096,
			ratio: 0.25,
			dryRun: false,
			enabled: true,
			cursor: null,
		};
		expect(projectToolDiagnosticValue(args, redactor)).toEqual(args);
	});

	it("fully masks values under credential-named keys", () => {
		const projected = projectToolDiagnosticValue(
			{
				apiKey: "short",
				accessTokens: ["short"],
				nested: { authorization: { deep: 1 } },
			},
			redactor,
		) as Record<string, unknown>;
		expect(projected.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected.accessTokens).toBe(TOOL_DIAGNOSTIC_MASK);
		expect((projected.nested as Record<string, unknown>).authorization).toBe(
			TOOL_DIAGNOSTIC_MASK,
		);
	});

	it("scrubs nested strings without mutating the input", () => {
		const raw = {
			command: `deploy --token=${FLAG_CANARY}`,
			targets: [`https://ci:${USERINFO_CANARY}@ci.example/job`],
		};
		const projected = projectToolDiagnosticValue(raw, redactor) as typeof raw;
		expect(projected).not.toBe(raw);
		expect(JSON.stringify(projected)).not.toContain(FLAG_CANARY);
		expect(JSON.stringify(projected)).not.toContain(USERINFO_CANARY);
		expect(raw.command).toContain(FLAG_CANARY);
		expect(raw.targets[0]).toContain(USERINFO_CANARY);
	});

	it("returns the same reference when nothing needs redaction", () => {
		const raw = { path: "/tmp/file.txt", lines: [1, 2, 3], deep: { ok: true } };
		expect(projectToolDiagnosticValue(raw, redactor)).toBe(raw);
	});

	it("collapses cycles to the mask instead of hanging", () => {
		const raw: Record<string, unknown> = { name: "loop" };
		raw.self = raw;
		const projected = projectToolDiagnosticValue(raw, redactor) as Record<
			string,
			unknown
		>;
		expect(projected.self).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected.name).toBe("loop");
	});

	it("allows the same subtree on sibling paths (DAG, not cycle)", () => {
		const shared = { ok: true };
		const projected = projectToolDiagnosticValue(
			{ a: shared, b: shared },
			redactor,
		) as Record<string, unknown>;
		expect(projected.a).toEqual({ ok: true });
		expect(projected.b).toEqual({ ok: true });
	});

	it("bounds depth", () => {
		let deep: Record<string, unknown> = { leaf: `--token=${FLAG_CANARY}` };
		for (let i = 0; i < 12; i += 1) {
			deep = { child: deep };
		}
		const serialized = JSON.stringify(
			projectToolDiagnosticValue(deep, redactor),
		);
		expect(serialized).not.toContain(FLAG_CANARY);
		expect(serialized).toContain(TOOL_DIAGNOSTIC_MASK);
	});

	it("passes Date values through untouched, valid or invalid", () => {
		const valid = new Date("2026-01-02T03:04:05.000Z");
		const invalid = new Date(Number.NaN);
		const projected = projectToolDiagnosticValue(
			{ at: valid, bad: invalid },
			redactor,
		) as { at: Date; bad: Date };
		expect(projected.at).toBe(valid);
		expect(projected.bad).toBe(invalid);
	});

	it("scrubs Error message and stack while preserving the shape", () => {
		const raw = new Error(`refused --token=${FLAG_CANARY}`);
		raw.name = "ToolFailure";
		const projected = projectToolDiagnosticValue(raw, redactor) as Error;
		expect(projected).toBeInstanceOf(Error);
		expect(projected.name).toBe("ToolFailure");
		expect(projected.message).not.toContain(FLAG_CANARY);
		expect(projected.stack ?? "").not.toContain(FLAG_CANARY);
	});
});

describe("projectModelCallDiagnosticValue", () => {
	it("preserves schema identifiers while scrubbing schema values and tool metadata", () => {
		const raw = {
			responseSchema: {
				type: "object",
				properties: {
					apiKey: {
						type: "string",
						description: `Never echo --token=${FLAG_CANARY}`,
					},
					secret: { type: "string" },
				},
				required: ["apiKey", "secret"],
				default: { apiKey: "short-canary" },
			},
			tools: [
				{
					name: "authenticate",
					parameters: {
						type: "object",
						properties: {
							token: { type: "string" },
						},
						required: ["token"],
					},
					metadata: { apiKey: "short-canary" },
				},
				{
					type: "function",
					function: {
						name: "nested_authenticate",
						parameters: {
							type: "object",
							properties: {
								accessToken: { type: "string" },
							},
							required: ["accessToken"],
						},
					},
				},
			],
			providerOptions: { apiKey: "short-canary" },
		};

		const projected = projectModelCallDiagnosticValue(
			raw,
			redactor,
		) as typeof raw;
		expect(projected.responseSchema.properties.apiKey).toEqual({
			type: "string",
			description: expect.not.stringContaining(FLAG_CANARY),
		});
		expect(projected.responseSchema.properties.secret).toEqual({
			type: "string",
		});
		expect(projected.responseSchema.required).toEqual(["apiKey", "secret"]);
		expect(projected.responseSchema.default.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected.tools[0]?.parameters.properties.token).toEqual({
			type: "string",
		});
		expect(projected.tools[0]?.parameters.required).toEqual(["token"]);
		expect(projected.tools[0]?.metadata.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(
			projected.tools[1]?.function.parameters.properties.accessToken,
		).toEqual({ type: "string" });
		expect(projected.providerOptions.apiKey).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(raw.responseSchema.properties.apiKey.description).toContain(
			FLAG_CANARY,
		);
	});
});

describe("projectCompleteModelCallValue", () => {
	it("preserves first, middle, and final values beyond the diagnostic depth", () => {
		const deep: Record<string, unknown> = { final: "FINAL-CANARY" };
		let cursor = deep;
		for (let depth = 15; depth >= 1; depth -= 1) {
			const child: Record<string, unknown> = {
				[`level${depth}`]: depth === 8 ? "MIDDLE-CANARY" : depth,
				child: cursor,
			};
			cursor = child;
		}
		const projected = projectCompleteModelCallValue(
			{ first: "FIRST-CANARY", payload: cursor },
			redactor,
		);
		const serialized = JSON.stringify(projected);
		expect(serialized).toContain("FIRST-CANARY");
		expect(serialized).toContain("MIDDLE-CANARY");
		expect(serialized).toContain("FINAL-CANARY");
		expect(serialized).not.toContain(TOOL_DIAGNOSTIC_MASK);
	});

	it("rejects a cycle instead of replacing model-bound data", () => {
		const cyclic: Record<string, unknown> = { first: "FIRST-CANARY" };
		cyclic.self = cyclic;
		expect(() => projectCompleteModelCallValue(cyclic, redactor)).toThrowError(
			expect.objectContaining({ code: "MODEL_TOOL_DATA_CYCLE" }),
		);
	});
});

describe("projectProtectedModelCallValue", () => {
	it("keeps model fields complete while sanitizing operational cycles", () => {
		const operational: Record<string, unknown> = { label: "metadata" };
		operational.self = operational;
		const projected = projectProtectedModelCallValue(
			{
				messages: deeplyNestedCanaryValue(),
				providerMetadata: operational,
			},
			redactor,
		);
		const serializedMessages = JSON.stringify(projected.messages);
		expect(serializedMessages).toContain("FINAL-CANARY");
		expect((projected.providerMetadata as Record<string, unknown>).self).toBe(
			TOOL_DIAGNOSTIC_MASK,
		);
	});
});

describe("projectToolDiagnosticArgs", () => {
	it("passes undefined through", () => {
		expect(projectToolDiagnosticArgs(undefined, redactor)).toBeUndefined();
	});

	it("projects a defined record", () => {
		const projected = projectToolDiagnosticArgs(
			{ token: FLAG_CANARY, count: 2 },
			redactor,
		);
		expect(projected?.token).toBe(TOOL_DIAGNOSTIC_MASK);
		expect(projected?.count).toBe(2);
	});
});
