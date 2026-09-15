/**
 * Exercises the sub-planner helpers (`actionHasSubActions`,
 * `detectSubActionCycles`, `resolveSubActions`, `runSubPlanner`): child-action
 * resolution and simile matching, native-tool exposure, context propagation,
 * and role/context gating. Mocked runtime with stubbed useModel/execute/evaluate;
 * deterministic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { promoteSubactionsToActions } from "../../actions/promote-subactions";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { _resetActionRolePolicyCacheForTests } from "../action-role-policy";
import {
	actionHasSubActions,
	detectSubActionCycles,
	resolveSubActions,
	runSubPlanner,
	subPlannerCallDigest,
} from "../sub-planner";

type SubPlannerTestRuntime = Pick<IAgentRuntime, "actions" | "useModel"> & {
	logger: Pick<IAgentRuntime["logger"], "debug" | "warn" | "error">;
};

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		validate: async () => true,
		handler: async () => ({ success: true }),
		...overrides,
	};
}

function makeRuntime(actions: Action[], useModel = vi.fn()): IAgentRuntime {
	const runtime: SubPlannerTestRuntime = {
		actions,
		useModel: useModel as IAgentRuntime["useModel"],
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
	return runtime as IAgentRuntime;
}

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "hello" },
	} as Memory;
}

describe("sub-planner helpers", () => {
	const ORIGINAL_ACTION_ROLE_POLICY = process.env.ACTION_ROLE_POLICY;

	afterEach(() => {
		if (ORIGINAL_ACTION_ROLE_POLICY === undefined) {
			delete process.env.ACTION_ROLE_POLICY;
		} else {
			process.env.ACTION_ROLE_POLICY = ORIGINAL_ACTION_ROLE_POLICY;
		}
		_resetActionRolePolicyCacheForTests();
	});

	function ledgerFamily(): { parent: Action; virtuals: Action[] } {
		const parent = makeAction({
			name: "LEDGER",
			description: "Create and remove ledger entries.",
			parameters: [
				{
					name: "action",
					description: "Operation",
					required: true,
					schema: { type: "string", enum: ["create", "delete"] },
				},
				{
					name: "id",
					description: "Entry identity",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "text",
					description: `Complete ledger entry text. ${"A per-child tool repeats this property in full. ".repeat(12)}`,
					required: false,
					schema: { type: "string" },
				},
			],
		});
		const promoted = promoteSubactionsToActions(parent).map((action) => ({
			...action,
		}));
		const promotedParent = promoted.find((action) => action.name === "LEDGER");
		if (!promotedParent) throw new Error("promotion dropped the parent");
		return {
			parent: promotedParent,
			virtuals: promoted.filter((action) => action.name !== "LEDGER"),
		};
	}

	it("collapses a promoted family onto the umbrella tool with the discriminator required (live: CALENDAR without action, 40K-token round)", async () => {
		const { parent, virtuals } = ledgerFamily();
		expect(virtuals.map((action) => action.name)).toEqual([
			"LEDGER_CREATE",
			"LEDGER_DELETE",
		]);
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "LEDGER",
					arguments: { action: "delete", id: "entry-7" },
				},
			],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "removed",
			data: { actionName: "LEDGER_DELETE" },
		}));
		const result = await runSubPlanner({
			runtime: makeRuntime([parent, ...virtuals], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});
		const modelParams = useModel.mock.calls[0]?.[1] as {
			tools?: Array<{
				name: string;
				description?: string;
				parameters?: {
					required?: string[];
					properties?: Record<string, { enum?: string[] }>;
				};
			}>;
		};
		const tools = modelParams.tools ?? [];
		expect(tools.map((tool) => tool.name)).toEqual([
			"LEDGER",
			"REPLY",
			"IGNORE",
			"STOP",
		]);
		const umbrella = tools[0];
		expect(umbrella?.parameters?.required).toContain("action");
		expect(umbrella?.parameters?.properties?.action?.enum).toEqual([
			"create",
			"delete",
		]);
		expect(umbrella?.description).toContain(
			"`action` is required; choose one of:",
		);
		expect(umbrella?.description).toContain("delete");
		// The umbrella schema renders once instead of once per child.
		const repeated = "A per-child tool repeats this property in full.";
		expect(JSON.stringify(tools).split(repeated).length - 1).toBe(12);
		expect(execute).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({
				name: "LEDGER_DELETE",
				params: expect.objectContaining({ action: "delete", id: "entry-7" }),
			}),
			expect.any(Object),
		);
		expect(result.status).toBe("finished");
	});

	it("rejects an umbrella call that still omits the discriminator without executing anything", async () => {
		const { parent, virtuals } = ledgerFamily();
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-1", name: "LEDGER", arguments: { id: "entry-7" } },
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-2", name: "REPLY", arguments: { message: "Which one?" } },
				],
			});
		const execute = vi.fn(async () => ({ success: true, text: "never" }));
		const result = await runSubPlanner({
			runtime: makeRuntime([parent, ...virtuals], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "NEXT_RECOMMENDED",
				thought: "Missing action.",
			}),
		});
		expect(execute).not.toHaveBeenCalled();
		const first = result.trajectory.steps[0]?.result;
		expect(first?.success).toBe(false);
		expect(String(first?.error)).toContain(
			"requires `action`, one of: create, delete",
		);
	});

	it("detects declared sub-actions and resolves them by exact name", () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});

		expect(actionHasSubActions(parent)).toBe(true);
		expect(resolveSubActions(makeRuntime([parent, child]), parent)).toEqual([
			child,
		]);
	});

	it("detects sub-action cycles", () => {
		const a = makeAction({ name: "A", subActions: ["B"] });
		const b = makeAction({ name: "B", subActions: ["C"] });
		const c = makeAction({ name: "C", subActions: ["A"] });

		expect(detectSubActionCycles([a, b, c])).toEqual([["A", "B", "C", "A"]]);
	});

	it("runs the planner with only child actions available to execution", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "child done",
			data: { actionName: "CHILD" },
		}));

		const result = await runSubPlanner({
			runtime: makeRuntime([parent, child], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		expect(execute).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({ name: "CHILD" }),
			expect.objectContaining({ actions: [child] }),
		);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	it("does not replay an exact prior non-retryable nested operation", async () => {
		const child = makeAction({ name: "CHILD" });
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const call = { name: "CHILD", params: { target: "same" } };
		const execute = vi.fn(async () => ({ success: true }));
		const result = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-replay", name: "CHILD", arguments: call.params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: {
				message: makeMessage(),
				previousResults: [
					{
						success: false,
						data: {
							subSteps: [
								{
									action: "CHILD",
									success: false,
									callDigest: subPlannerCallDigest(call),
									retryable: false,
								},
							],
						},
					},
				],
			},
			execute,
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "That exact operation cannot be retried this turn.",
			}),
		});

		expect(execute).not.toHaveBeenCalled();
		expect(result.trajectory.steps[0]?.result?.data).toMatchObject({
			retryable: false,
			replaySuppressed: true,
			code: "PRIOR_NON_RETRYABLE_SUBSTEP",
		});
	});

	it.each([false, true])(
		"resolves child similes with inherited outer scope: %s",
		async (inherited) => {
			const child = makeAction({
				name: "GOOGLE_CALENDAR",
				similes: ["CALENDAR_READ"],
			});
			const parent = makeAction({
				name: "CALENDAR",
				subActions: ["GOOGLE_CALENDAR"],
				subPlanner: true,
			});
			const useModel = vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "CALENDAR_READ", arguments: {} }],
			}));
			const execute = vi.fn(async () => ({
				success: true,
				text: "calendar done",
				data: { actionName: "GOOGLE_CALENDAR" },
			}));

			await runSubPlanner({
				runtime: makeRuntime([parent, child], useModel),
				action: parent,
				context: {
					id: "ctx",
					events: inherited
						? [
								{
									id: "outer-tool",
									type: "tool",
									source: "sub-planner",
									tool: {
										name: child.name,
										description: child.description,
										action: makeAction({
											name: child.name,
											similes: ["OUTER_ONLY"],
										}),
										metadata: { parentAction: "OUTER_PARENT" },
									},
								},
							]
						: [],
				},
				ctx: { message: makeMessage() },
				execute,
				evaluate: async () => ({
					success: true,
					decision: "FINISH",
					thought: "Done.",
					messageToUser: "Done.",
				}),
			});

			const call = useModel.mock.calls[0] as unknown[] | undefined;
			const params = call?.[1] as { tools: Array<{ name: string }> };
			expect(params.tools.map((tool) => tool.name)).toContain(
				"GOOGLE_CALENDAR",
			);
			expect(params.tools.map((tool) => tool.name)).not.toContain(
				"CALENDAR_READ",
			);

			expect(execute).toHaveBeenCalledWith(
				expect.any(Object),
				expect.any(Object),
				expect.objectContaining({ name: "GOOGLE_CALENDAR" }),
				expect.objectContaining({ actions: [child] }),
			);
		},
	);

	it("rejects a restricted child's alias even when another child is exposed", async () => {
		const allowed = makeAction({ name: "PUBLIC_READ" });
		const restricted = makeAction({
			name: "PRIVATE_READ",
			similes: ["SECRET_ALIAS"],
			roleGate: { minRole: "OWNER" },
		});
		const parent = makeAction({
			name: "PARENT",
			subActions: [allowed, restricted],
		});
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [{ name: "SECRET_ALIAS", arguments: {} }],
			})
			.mockResolvedValue({
				text: "No private read was performed.",
				toolCalls: [
					{
						name: "REPLY",
						arguments: { text: "No private read was performed." },
					},
				],
			});
		const execute = vi.fn();
		await runSubPlanner({
			runtime: makeRuntime([parent, allowed, restricted], useModel),
			action: parent,
			context: {
				id: "ctx",
				events: [
					{
						id: "outer-tool",
						type: "tool",
						source: "sub-planner",
						tool: {
							name: allowed.name,
							description: allowed.description,
							action: makeAction({
								name: allowed.name,
								similes: ["SECRET_ALIAS"],
							}),
							metadata: { parentAction: "OUTER_PARENT" },
						},
					},
				],
			},
			ctx: { message: makeMessage(), userRoles: ["USER"] },
			execute,
		});
		expect(execute).not.toHaveBeenCalled();
		expect(useModel).toHaveBeenCalledTimes(2);
	});

	it("keeps canonical identity when another child's simile collides", async () => {
		const canonical = makeAction({ name: "READ", similes: ["LEGACY_READ"] });
		const other = makeAction({ name: "OTHER_READ", similes: ["READ"] });
		const parent = makeAction({
			name: "PARENT",
			subActions: [canonical, other],
		});
		const execute = vi.fn(async () => ({ success: true, text: "read done" }));
		await runSubPlanner({
			runtime: makeRuntime(
				[parent, canonical, other],
				vi.fn(async () => ({
					text: "",
					toolCalls: [{ name: "LEGACY_READ", arguments: {} }],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Done.",
			}),
		});
		expect(execute).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({ name: "READ" }),
			expect.objectContaining({ actions: [canonical, other] }),
		);
	});

	it("records a simile call under the canonical child identity", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			similes: ["CALENDAR_READ"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const result = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{
							id: "call-canonical",
							name: "CALENDAR_READ",
							arguments: { calendar: "primary" },
						},
					],
				})),
			),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({ success: true, text: "done" })),
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Done.",
			}),
		});

		const recordedCall = result.trajectory.steps[0]?.toolCall;
		if (!recordedCall) throw new Error("Expected a recorded child call");
		expect(recordedCall).toMatchObject({
			name: "GOOGLE_CALENDAR",
			params: { calendar: "primary" },
		});
		expect(subPlannerCallDigest(recordedCall)).toBe(
			subPlannerCallDigest({
				name: "GOOGLE_CALENDAR",
				params: { calendar: "primary" },
			}),
		);
	});

	it("suppresses a second-pass replay when the model changes child aliases", async () => {
		const child = makeAction({
			name: "GOOGLE_CALENDAR",
			similes: ["CALENDAR_READ", "READ_CALENDAR"],
		});
		const parent = makeAction({
			name: "CALENDAR",
			subActions: ["GOOGLE_CALENDAR"],
			subPlanner: true,
		});
		const params = { calendar: "primary" };
		const first = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-first", name: "CALENDAR_READ", arguments: params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx-first", events: [] },
			ctx: { message: makeMessage() },
			execute: vi.fn(async () => ({
				success: false,
				text: "calendar access is permanently unavailable",
				data: { retryable: false },
			})),
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "Calendar access is unavailable.",
			}),
		});
		const firstCall = first.trajectory.steps[0]?.toolCall;
		if (!firstCall)
			throw new Error("Expected the first child call to be recorded");
		expect(firstCall?.name).toBe("GOOGLE_CALENDAR");

		const secondExecute = vi.fn(async () => ({ success: true }));
		const second = await runSubPlanner({
			runtime: makeRuntime(
				[parent, child],
				vi.fn(async () => ({
					text: "",
					toolCalls: [
						{ id: "call-second", name: "READ_CALENDAR", arguments: params },
					],
				})),
			),
			action: parent,
			context: { id: "ctx-second", events: [] },
			ctx: {
				message: makeMessage(),
				previousResults: [
					{
						success: false,
						data: {
							subSteps: [
								{
									action: firstCall.name,
									success: false,
									callDigest: subPlannerCallDigest(firstCall),
									retryable: false,
								},
							],
						},
					},
				],
			},
			execute: secondExecute,
			evaluate: async () => ({
				success: false,
				decision: "FINISH",
				messageToUser: "That operation is already known to be unavailable.",
			}),
		});

		expect(secondExecute).not.toHaveBeenCalled();
		expect(second.trajectory.steps[0]?.result?.data).toMatchObject({
			retryable: false,
			replaySuppressed: true,
			code: "PRIOR_NON_RETRYABLE_SUBSTEP",
		});
	});

	it("keeps replay correlation stable without embedding raw parameters", () => {
		const canary = "SYNTH-SUBPLANNER-TOKEN-CANARY-3333";
		const first = subPlannerCallDigest({
			name: "GOOGLE_CALENDAR",
			params: { nested: { count: 2, token: canary }, calendar: "primary" },
		});
		const reordered = subPlannerCallDigest({
			name: "GOOGLE_CALENDAR",
			params: { calendar: "primary", nested: { token: canary, count: 2 } },
		});

		expect(first).toBe(reordered);
		expect(first).not.toContain(canary);
		expect(first).toMatch(/^GOOGLECALENDAR\|[a-f0-9]{64}$/);
	});

	it("passes child actions to the model as native tool definitions", async () => {
		const childA = makeAction({
			name: "CHILD_A",
			description: "Do thing A",
		});
		const childB = makeAction({
			name: "CHILD_B",
			description: "Do thing B",
		});
		const parent = makeAction({
			name: "PARENT",
			subActions: ["CHILD_A", "CHILD_B"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD_A", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "done",
			data: { actionName: "CHILD_A" },
		}));

		await runSubPlanner({
			runtime: makeRuntime([parent, childA, childB], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: { message: makeMessage() },
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		// Sub-planner exposes each child action as its own native tool, plus
		// the universal terminal sentinels (REPLY/IGNORE/STOP). Stage 1
		// routing already happened at the top level, so the parent action
		// itself is NOT exposed inside its own sub-planner pass.
		const modelCall = useModel.mock.calls[0];
		expect(modelCall).toBeDefined();
		const modelParams = modelCall?.[1] as {
			messages?: Array<{ role: string; content: string }>;
			tools?: Array<{ name: string; type?: string }>;
			toolChoice?: string;
			responseSchema?: unknown;
		};
		const toolNames = (modelParams.tools ?? []).map((t) => t.name);
		expect(toolNames).toContain("CHILD_A");
		expect(toolNames).toContain("CHILD_B");
		expect(toolNames).toContain("REPLY");
		expect(toolNames).toContain("IGNORE");
		expect(toolNames).toContain("STOP");
		expect(toolNames).not.toContain("PARENT");
		// Tools array carries the per-action contracts, so the JSON-schema
		// fallback path must NOT be active.
		expect(modelParams.responseSchema).toBeUndefined();
	});

	it("uses selected plus parent contexts for sub-action execution gates", async () => {
		const child = makeAction({
			name: "CHILD",
			contexts: ["web"],
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["research_workflow", "web"],
			subActions: ["CHILD"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "CHILD", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "ok",
			data: { actionName: "CHILD" },
		}));

		await runSubPlanner({
			runtime: makeRuntime([parent, child], useModel),
			action: parent,
			context: { id: "ctx", events: [] },
			ctx: {
				message: makeMessage(),
				activeContexts: ["research_workflow"],
			},
			execute,
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			}),
		});

		// The execute callback receives selected contexts plus the parent's declared
		// contexts. Child-only contexts are no longer added as an authorization
		// shortcut; parents must declare every child context they intend to expose.
		const [, executedCtx] = execute.mock.calls[0] ?? [];
		expect(executedCtx).toBeDefined();
		const activeContexts = (executedCtx as { activeContexts?: string[] })
			?.activeContexts;
		expect(activeContexts).toEqual(
			expect.arrayContaining(["research_workflow", "web"]),
		);
	});

	it("does not expose child actions whose role gate is not satisfied", async () => {
		const child = makeAction({
			name: "OWNER_CHILD",
			contexts: ["admin"],
			roleGate: { minRole: "OWNER" },
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["admin"],
			subActions: ["OWNER_CHILD"],
			subPlanner: true,
		});

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent, child]),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: {
					message: makeMessage(),
					activeContexts: ["admin"],
					userRoles: ["USER"],
				},
			}),
		).rejects.toThrow(/no sub-actions available/i);
	});

	it("does not expose a child action when ACTION_ROLE_POLICY matches only a child simile", async () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "NONE" });
		_resetActionRolePolicyCacheForTests();
		const child = makeAction({
			name: "SHELL",
			similes: ["BASH", "EXEC", "RUN_COMMAND"],
			contexts: ["terminal"],
			contextGate: { anyOf: ["terminal"], roleGate: { minRole: "OWNER" } },
		});
		const parent = makeAction({
			name: "PARENT",
			contexts: ["general"],
			subActions: ["SHELL"],
			subPlanner: true,
		});
		const useModel = vi.fn(async () => ({
			text: "",
			toolCalls: [{ id: "call-1", name: "SHELL", arguments: {} }],
		}));
		const execute = vi.fn(async () => ({
			success: true,
			text: "shell done",
			data: { actionName: "SHELL" },
		}));

		await expect(
			runSubPlanner({
				runtime: makeRuntime([parent, child], useModel),
				action: parent,
				context: { id: "ctx", events: [] },
				ctx: {
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				execute,
				evaluate: async () => ({
					success: true,
					decision: "FINISH",
					thought: "Done.",
					messageToUser: "Done.",
				}),
			}),
		).rejects.toThrow(/no sub-actions available/i);

		expect(useModel).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});
});
