/** Exercises the real action collector and inference timer with controlled asynchronous validators, preserving ordered fail-closed discovery and complete caller data. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	InferenceTurnTimer,
	runWithInferenceTiming,
} from "../inference-timing";
import { collectV5PlannerCandidateActions } from "../services/message/action-surface";
import type { Action } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("action discovery latency attribution", () => {
	it.each([true, false])(
		"preserves ordered authorization and exceptions with timing enabled=%s",
		async (enabled) => {
			vi.stubEnv("ELIZA_INFERENCE_TIMING", "1");
			let clock = 0;
			vi.spyOn(performance, "now").mockImplementation(() => clock);
			const order: string[] = [];
			const message: Memory = {
				entityId: "00000000-0000-0000-0000-000000000001",
				agentId: "00000000-0000-0000-0000-000000000002",
				roomId: "00000000-0000-0000-0000-000000000003",
				content: { text: "Complete request ".repeat(1000) },
			};
			const state: State = { text: "Complete state", values: {}, data: {} };
			const failure = new Error("validation service unavailable");
			const action = (
				name: string,
				outcome: boolean | Error,
				milliseconds: number,
			): Action => ({
				name,
				description: name,
				similes: [],
				examples: [],
				handler: async () => {
					throw new Error("Discovery must never execute actions");
				},
				validate: async (receivedRuntime, receivedMessage, receivedState) => {
					expect(receivedRuntime).toBe(runtime);
					expect(receivedMessage).toBe(message);
					expect(receivedState).toBe(state);
					order.push(name);
					await Promise.resolve();
					clock += milliseconds;
					if (outcome instanceof Error) throw outcome;
					return outcome;
				},
			});
			const allowed = action("AVAILABLE", true, 17);
			const denied = action("UNAVAILABLE", false, 23);
			const rejected = action("FAILED", failure, 31);
			const gated = {
				...action("OWNER_ONLY", true, 100),
				roleGate: { minRole: "OWNER" as const },
			};
			const runtime = {
				actions: [allowed, denied, rejected, gated],
				reportError: vi.fn(),
				logger: { warn: vi.fn() },
			} as unknown as IAgentRuntime;
			const timer = enabled
				? new InferenceTurnTimer({ turnId: "discovery", label: "test" })
				: undefined;
			const result = await runWithInferenceTiming(timer, () =>
				collectV5PlannerCandidateActions({
					runtime,
					message,
					state,
					discoverActions: true,
					userRoles: ["USER"],
				}),
			);
			expect(result).toEqual([allowed]);
			expect(order).toEqual(["AVAILABLE", "UNAVAILABLE", "FAILED"]);
			expect(runtime.reportError).toHaveBeenCalledExactlyOnceWith(
				"MessageService.plannerActionValidation",
				failure,
				{ action: "FAILED", parentAction: undefined },
			);
			expect(message.content.text).toBe("Complete request ".repeat(1000));
			if (timer) {
				const spans = timer.close().spans;
				const summary = spans.find((span) => span.name === "actions:discovery");
				const checks = JSON.parse(String(summary?.meta?.checks)) as Array<{
					action: string;
					gate: string;
					durationMs: number;
					outcome: string;
				}>;
				expect(checks.filter((check) => check.gate === "validate")).toEqual([
					{
						action: "AVAILABLE",
						gate: "validate",
						durationMs: 17,
						outcome: "returned",
					},
					{
						action: "UNAVAILABLE",
						gate: "validate",
						durationMs: 23,
						outcome: "returned",
					},
					{
						action: "FAILED",
						gate: "validate",
						durationMs: 31,
						outcome: "threw",
					},
				]);
				expect(
					checks
						.filter((check) => check.gate === "connector-policy")
						.map((check) => check.action),
				).toEqual(order);
				expect(JSON.stringify(spans)).not.toContain(message.content.text);
			}
		},
	);
	it.each([undefined, "0", "1"])(
		"keeps default diagnostics small and complete checks opt-in (%s)",
		async (flag) => {
			vi.stubEnv("ELIZA_INFERENCE_TIMING", flag);
			const actions: Action[] = Array.from({ length: 600 }, (_, index) => ({
				name: `CAPABILITY_${index}`,
				description: "Capability",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					throw new Error("No execution during discovery");
				},
			}));
			const runtime = {
				actions,
				reportError: vi.fn(),
				logger: { warn: vi.fn() },
			} as unknown as IAgentRuntime;
			const message: Memory = {
				entityId: "00000000-0000-0000-0000-000000000001",
				agentId: "00000000-0000-0000-0000-000000000002",
				roomId: "00000000-0000-0000-0000-000000000003",
				content: { text: "List available capabilities" },
			};
			const timer = new InferenceTurnTimer({
				turnId: "large-discovery",
				label: "test",
				maxSpans: 4,
			});
			const result = await runWithInferenceTiming(timer, () =>
				collectV5PlannerCandidateActions({
					runtime,
					message,
					state: { text: "", values: {}, data: {} },
					discoverActions: true,
					userRoles: ["USER"],
				}),
			);
			timer.recordSpan("model:RESPONSE_HANDLER", 50);
			const summary = timer.close();
			const metadata = summary.spans.find(
				(span) => span.name === "actions:discovery",
			)?.meta;
			expect(metadata).toBeDefined();
			const totals = JSON.parse(String(metadata?.summary));
			expect(totals.validate.count).toBe(600);
			expect(totals["connector-policy"].count).toBe(600);
			expect(totals.validate.throws).toBe(0);
			expect(result).toEqual(actions);
			if (flag === "1") {
				const checks = JSON.parse(String(metadata?.checks)) as Array<{
					action: string;
					gate: string;
				}>;
				expect(
					checks
						.filter((check) => check.gate === "validate")
						.map((check) => check.action),
				).toEqual(actions.map((action) => action.name));
			} else {
				expect(metadata?.checks).toBeUndefined();
				expect(
					new TextEncoder().encode(JSON.stringify(metadata)).length,
				).toBeLessThan(1024);
			}

			expect(summary.byName["model:RESPONSE_HANDLER"].totalMs).toBe(50);
			expect(summary.anomalies).not.toContain("span-cap");
		},
	);
});
