/**
 * Drives executePlannedToolCall end to end: exact action-name matching, strict
 * argument validation and planner-wrapper canonicalization, role/context/
 * connector/private gating (including the ACTION_ROLE_POLICY override),
 * ACTION_STARTED/ACTION_COMPLETED emission with sensitive-result suppression, and
 * trajectory-step wiring; also unit-tests dropEmptyOptionalArgs. Deterministic —
 * stub runtime with vi.fn handlers and in-memory connector storage, no live model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getConnectorAccountManager,
	InMemoryConnectorAccountStorage,
} from "../../connectors/account-manager";
import type { ElizaError } from "../../errors";
import {
	attestDeliveryAudienceFromCanonicalRoom,
	PRIVACY_DENIED_TEXT,
} from "../../security/trusted-delivery-audience";
import { runWithStreamingContext } from "../../streaming-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
	runWithTrajectoryPurpose,
} from "../../trajectory-context";
import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	Room,
	UUID,
} from "../../types";
import { ChannelType, EventType } from "../../types";
import type { EffectReceipt } from "../../types/effects";
import { ModelType } from "../../types/model";
import {
	_resetActionRolePolicyCacheForTests,
	dropEmptyOptionalArgs,
	executePlannedToolCall,
} from "../execute-planned-tool-call";

type ExecuteToolCallTestRuntime = Pick<IAgentRuntime, "actions" | "agentId"> &
	Partial<
		Pick<
			IAgentRuntime,
			| "emitEvent"
			| "getCurrentRunId"
			| "getParticipantsForRoom"
			| "getRoom"
			| "getService"
			| "getServicesByType"
			| "getSetting"
			| "reportError"
			| "useModel"
		>
	> & {
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

function makeRuntime(
	actions: Action[],
	overrides: Partial<ExecuteToolCallTestRuntime> = {},
): IAgentRuntime {
	const runtime: ExecuteToolCallTestRuntime = {
		actions,
		agentId: "agent-id" as UUID,
		getRoom: vi.fn(async () => null),
		getService: vi.fn(() => undefined),
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		...overrides,
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

function appliedEffectReceipt(): EffectReceipt {
	return {
		receiptId: "receipt-create-task-1",
		operation: "task.create",
		resource: { kind: "task", id: "task-1" },
		artifacts: [],
		idempotency: { key: "request-create-task-1", replayed: false },
		observedAt: "2026-07-27T18:00:00.000Z",
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "transaction-create-task-1",
			committedAt: "2026-07-27T18:00:00.000Z",
		},
	};
}

describe("executePlannedToolCall", () => {
	it("starts the handler without waiting for ACTION_STARTED subscribers and keeps the lifecycle order", async () => {
		// Live 2026-09-05: 30-145 ms of ACTION_STARTED subscriber work ran in
		// front of every tool handler.
		let releaseStarted!: () => void;
		const startedGate = new Promise<void>((resolve) => {
			releaseStarted = resolve;
		});
		const events: string[] = [];
		const emitEvent = vi.fn(async (eventType: string) => {
			if (eventType === EventType.ACTION_STARTED) {
				await startedGate;
			}
			events.push(eventType);
		});
		let handlerStarted!: () => void;
		const handlerRan = new Promise<void>((resolve) => {
			handlerStarted = resolve;
		});
		const handler = vi.fn(async () => {
			handlerStarted();
			return { success: true, text: "done" };
		});
		const runtime = makeRuntime(
			[makeAction({ name: "TEST_ACTION", handler })],
			{
				emitEvent,
			},
		);

		const pending = executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "TEST_ACTION", params: {} },
		);
		// The handler runs while the ACTION_STARTED dispatch is still blocked.
		await Promise.race([
			handlerRan,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("handler waited for ACTION_STARTED")),
					250,
				),
			),
		]);
		expect(events).not.toContain(EventType.ACTION_COMPLETED);

		releaseStarted();
		const result = await pending;
		expect(result.success).toBe(true);
		expect(events).toEqual([
			EventType.ACTION_STARTED,
			EventType.ACTION_COMPLETED,
		]);
	});

	it("matches action names exactly only", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const runtime = makeRuntime([makeAction({ name: "DOCUMENT", handler })]);

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "search_documents", params: {} },
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Action not found: search_documents");
		expect(result.failureProvenance).toEqual({
			kind: "missing_capability",
			boundary: "capability",
			code: "ACTION_NOT_FOUND",
			retryable: false,
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("carries handler and persistence provenance from their boundaries", async () => {
		const thrown = await executePlannedToolCall(
			makeRuntime([
				makeAction({
					name: "THROWING_ACTION",
					handler: async () => {
						throw new Error("handler exploded");
					},
				}),
			]),
			{ message: makeMessage() },
			{ name: "THROWING_ACTION", params: {} },
		);
		expect(thrown.failureProvenance).toEqual({
			kind: "handler_error",
			boundary: "handler",
			code: "ACTION_HANDLER_FAILED",
			retryable: true,
		});

		const persistence = await executePlannedToolCall(
			makeRuntime([
				makeAction({
					name: "PERSIST_ACTION",
					handler: async () => ({
						success: false,
						error: "database rejected the write",
						failureProvenance: {
							kind: "persistence_error" as const,
							boundary: "persistence" as const,
							code: "TEST_WRITE_FAILED",
							retryable: true,
						},
					}),
				}),
			]),
			{ message: makeMessage() },
			{ name: "PERSIST_ACTION", params: {} },
		);
		expect(persistence.failureProvenance).toEqual({
			kind: "persistence_error",
			boundary: "persistence",
			code: "TEST_WRITE_FAILED",
			retryable: true,
		});
	});

	it("rejects invalid native tool arguments before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "CREATE_TASK", params: { title: 42 } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain(
			"Argument 'title' expected string, got number",
		);
		expect(result.data).toMatchObject({
			parameterErrors: ["Argument 'title' expected string, got number"],
			invalidParameterNames: ["title"],
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not start an action or publish a settlement when cancellation wins during validation", async () => {
		const abortController = new AbortController();
		const abortReason = new Error("transport disconnected before commit");
		const handler = vi.fn(async () => ({ success: true }));
		const onSettledResult = vi.fn();
		const action = makeAction({
			name: "CREATE_TASK",
			validate: async () => {
				abortController.abort(abortReason);
				return true;
			},
			handler,
		});

		await expect(
			executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: action.name, params: {} },
				{
					abortSignal: abortController.signal,
					onSettledResult,
				},
			),
		).rejects.toBe(abortReason);
		expect(handler).not.toHaveBeenCalled();
		expect(onSettledResult).not.toHaveBeenCalled();
	});

	it("drops undeclared planner wrapper args without weakening strict validation", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "op",
					description: "Task operation",
					required: true,
					schema: {
						type: "string",
						enum: ["provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					op: "provision_workspace",
					subaction: "provision_workspace",
					thought: "set up workspace",
				},
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { op: "provision_workspace" },
			}),
			undefined,
			undefined,
		);
	});

	it("flattens a schema-safe parameters envelope inside native tool args", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "WORKFLOW",
			parameters: [
				{
					name: "action",
					description: "Workflow operation",
					required: true,
					schema: { type: "string", enum: ["create"] },
				},
				{
					name: "name",
					description: "Workflow name",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "seedPrompt",
					description: "Workflow description",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "active",
					description: "Initial active state",
					required: false,
					schema: { type: "boolean" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "WORKFLOW",
				params: {
					action: "create",
					parameters: {
						name: "Smithers acceptance",
						seedPrompt: "Manual Trigger followed by Set Message",
						active: false,
					},
				},
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: {
					action: "create",
					name: "Smithers acceptance",
					seedPrompt: "Manual Trigger followed by Set Message",
					active: false,
				},
			}),
			undefined,
			undefined,
		);
	});

	it("does not flatten a parameters envelope containing an unknown key", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "WORKFLOW",
			parameters: [
				{
					name: "action",
					description: "Workflow operation",
					required: true,
					schema: { type: "string", enum: ["create"] },
				},
				{
					name: "name",
					description: "Workflow name",
					required: false,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "WORKFLOW",
				params: {
					action: "create",
					parameters: { name: "Smithers acceptance", reciepient: "alice" },
				},
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'parameters'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not flatten conflicting top-level and nested parameter values", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "WORKFLOW",
			parameters: [
				{
					name: "action",
					description: "Workflow operation",
					required: true,
					schema: { type: "string", enum: ["create"] },
				},
				{
					name: "name",
					description: "Workflow name",
					required: false,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "WORKFLOW",
				params: {
					action: "create",
					name: "Top-level name",
					parameters: { name: "Conflicting nested name" },
				},
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'parameters'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("preserves a parameters object when the action declares that field", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "DECLARED_PARAMETERS",
			parameters: [
				{
					name: "parameters",
					description: "Action-owned nested parameters",
					required: true,
					schema: { type: "object", additionalProperties: true },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "DECLARED_PARAMETERS",
				params: { parameters: { name: "Nested name" } },
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { parameters: { name: "Nested name" } },
			}),
			undefined,
			undefined,
		);
	});

	it("canonicalizes undeclared subaction into the declared discriminator", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "action",
					description: "Task operation",
					required: false,
					schema: {
						type: "string",
						enum: ["create", "provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					subaction: "provision_workspace",
					thought: "set up workspace",
				},
			},
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { action: "provision_workspace" },
			}),
			undefined,
			undefined,
		);
	});

	it("rejects conflicting planner subaction aliases", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "action",
					description: "Task operation",
					required: false,
					schema: {
						type: "string",
						enum: ["create", "provision_workspace"],
					},
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "TASKS",
				params: {
					action: "create",
					subaction: "provision_workspace",
				},
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'subaction'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("still rejects unknown non-wrapper args", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{
				name: "CREATE_TASK",
				params: { title: "Ship it", reciepient: "alice" },
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("Unexpected argument 'reciepient'");
		expect(handler).not.toHaveBeenCalled();
	});

	it("passes validated parameters and an action-attributing HandlerCallback through to the action handler", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		let handlerCallback: HandlerCallback | undefined;
		const handler = vi.fn(async () => ({ success: true, text: "ok" }));
		const action = makeAction({
			name: "CREATE_TASK",
			parameters: [
				{
					name: "title",
					description: "Task title",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "priority",
					description: "Task priority",
					required: false,
					schema: { type: "string", default: "normal" },
				},
			],
			handler: async (...args) => {
				handlerCallback = args[4];
				return handler(...args);
			},
		});

		await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: { title: "Ship it" } },
		);

		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { title: "Ship it", priority: "normal" },
			}),
			expect.any(Function),
			undefined,
		);
		await handlerCallback?.({ text: "created Ship it" });
		expect(callback).toHaveBeenCalledWith(
			{ text: "created Ship it" },
			"CREATE_TASK",
		);
	});

	it("records and delivers only the opt-in normalized tool parameters", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "normalized-action-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const action = makeAction({
			name: "MEMORY",
			parameters: [
				{
					name: "text",
					description: "Memory text",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "memoryId",
					description: "Optional memory UUID",
					modelOmissionSentinels: ["null"],
					schema: { type: "string", pattern: "^[0-9a-f-]{36}$" },
				},
				{
					name: "note",
					description: "Optional byte-exact note",
					schema: { type: "string" },
				},
			],
			handler,
		});
		const runtime = makeRuntime([action], {
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
		});

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "normalization-trajectory",
				trajectoryStepId: "planner-step",
				purpose: "planner",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{
						name: "MEMORY",
						params: { text: "remember this", memoryId: "null", note: "" },
					},
				),
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { text: "remember this", note: "" },
			}),
			undefined,
			undefined,
		);
		expect(trajectoryLogger.completeStep).toHaveBeenCalledWith(
			"normalization-trajectory",
			"normalized-action-step",
			expect.objectContaining({
				parameters: { text: "remember this", note: "" },
			}),
		);
	});

	it("preserves byte-exact canonical callback text through later voice gates", async () => {
		const canonicalText =
			"“Send demo video” is scheduled for Tuesday, August 4, 2026 at 9:00 AM.";
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = makeAction({
			name: "READ_CALENDAR",
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: canonicalText });
				return {
					success: true,
					text: canonicalText,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
				};
			},
		});

		await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "READ_CALENDAR", params: {} },
		);

		expect(callback).toHaveBeenCalledWith(
			{ text: canonicalText, agentVoiced: true },
			"READ_CALENDAR",
		);
	});

	it("suppresses mutation callbacks until their result carries receipt proof", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = makeAction({
			name: "CREATE_TASK",
			tags: ["capability:write", "effect:receipt-required"],
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "created Ship it" });
				return { success: true, text: "created Ship it" };
			},
		});

		await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(callback).not.toHaveBeenCalled();
	});

	it("keeps unmigrated mutation callbacks visible and reports the missing contract", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const warn = vi.fn();
		const action = makeAction({
			name: "LEGACY_CREATE_TASK",
			tags: ["capability:write"],
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "created Ship it" });
				return { success: true, text: "created Ship it" };
			},
		});
		const runtime = makeRuntime([action], {
			logger: { debug: vi.fn(), warn, error: vi.fn() },
		});

		await executePlannedToolCall(
			runtime,
			{ message: makeMessage(), callback },
			{ name: "LEGACY_CREATE_TASK", params: {} },
		);

		expect(callback).toHaveBeenCalledWith(
			{ text: "created Ship it" },
			"LEGACY_CREATE_TASK",
		);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ action: "LEGACY_CREATE_TASK" }),
			expect.stringContaining("effect receipt contract"),
		);
	});

	it("delivers only the exact callback bound to a validated applied receipt", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const receipt = appliedEffectReceipt();
		const canonicalText = "Done — the task is created.";
		const action = makeAction({
			name: "CREATE_TASK",
			tags: ["capability:write"],
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({
					text: canonicalText,
					effectReceiptIds: ["forged-callback-id"],
				});
				return {
					success: true,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(true);
		expect(callback).toHaveBeenCalledOnce();
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: canonicalText,
				effectReceiptIds: [receipt.receiptId],
			}),
			"CREATE_TASK",
		);
		expect(JSON.stringify(callback.mock.calls[0]?.[0])).not.toContain(
			"forged-callback-id",
		);
	});

	it("suppresses buffered callbacks when receipt validation fails", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = makeAction({
			name: "CREATE_TASK",
			tags: ["capability:write"],
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "Done — the task is created." });
				return {
					success: true,
					userFacingText: "Done — the task is created.",
					verifiedUserFacing: true,
					effectReceipts: [
						{
							...appliedEffectReceipt(),
							commit: undefined,
						},
					],
					userFacingEffectReceiptIds: ["receipt-create-task-1"],
				};
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/invalid result|reconciled/iu);
		expect(result.data).toMatchObject({
			outcomeUnknown: true,
			retryable: false,
			reconciliationRequired: true,
		});
		expect(callback).not.toHaveBeenCalled();
	});

	it("preserves an applied receipt when downstream callback delivery fails", async () => {
		const receipt = appliedEffectReceipt();
		const canonicalText = "Done — the task is created.";
		const callback: HandlerCallback = vi.fn(async () => {
			throw new Error("connector delivery unavailable");
		});
		const emitEvent = vi.fn(async () => undefined);
		const reportError = vi.fn();
		const action = makeAction({
			name: "CREATE_TASK",
			tags: ["capability:write"],
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: canonicalText });
				return {
					success: true,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action], { emitEvent, reportError }),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(true);
		expect(result.effectReceipts).toEqual([receipt]);
		expect(result.data?.callbackDeliveryFailures).toEqual([
			"connector delivery unavailable",
		]);
		expect(reportError).toHaveBeenCalledWith(
			"ActionCallbackDelivery",
			expect.any(Error),
			expect.objectContaining({
				actionName: "CREATE_TASK",
				effectReceiptIds: [receipt.receiptId],
			}),
		);
		expect(emitEvent).toHaveBeenCalledWith(
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({ actionStatus: "completed" }),
			}),
		);
	});

	it("does not retry an ambiguously failed delivery of identical settled text", async () => {
		const receipt = appliedEffectReceipt();
		const canonicalText = "Done — the task is created.";
		const callback: HandlerCallback = vi
			.fn()
			.mockRejectedValueOnce(new Error("temporary transport failure"))
			.mockResolvedValueOnce([]);
		const reportError = vi.fn();
		const action = makeAction({
			name: "CREATE_TASK",
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: canonicalText });
				await actionCallback?.({ text: canonicalText });
				return {
					success: true,
					userFacingText: canonicalText,
					verifiedUserFacing: true,
					effectReceipts: [receipt],
					userFacingEffectReceiptIds: [receipt.receiptId],
				};
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action], { reportError }),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(true);
		expect(callback).toHaveBeenCalledOnce();
		expect(result.data?.callbackDeliveryFailures).toEqual([
			"temporary transport failure",
		]);
	});

	it("suppresses a callback emitted before an unexpected handler failure", async () => {
		const callback: HandlerCallback = vi.fn(async () => []);
		const action = makeAction({
			name: "CREATE_TASK",
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "Done — the task is created." });
				throw new Error("database commit failed");
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage(), callback },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("database commit failed");
		expect(callback).not.toHaveBeenCalled();
	});

	it("re-runs validate with extracted parameters before invoking the handler", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const validate = vi.fn(
			async (
				_runtime: unknown,
				_message: unknown,
				_state: unknown,
				options: unknown,
			) => {
				const params = (options as { parameters?: Record<string, unknown> })
					.parameters;
				return params?.op === "unmute";
			},
		);
		const action = makeAction({
			name: "UNMUTE_ROOM",
			parameters: [
				{
					name: "op",
					description: "Operation",
					required: true,
					schema: { type: "string" },
				},
			],
			validate,
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "UNMUTE_ROOM", params: { op: "mute" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not available");
		expect(validate).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({ parameters: { op: "mute" } }),
		);
		expect(handler).not.toHaveBeenCalled();
	});

	it("converts thrown handler errors into failure ActionResults", async () => {
		const action = makeAction({
			name: "BOOM",
			handler: async () => {
				throw new Error("handler failed");
			},
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "BOOM", params: {} },
		);

		expect(result).toMatchObject({
			success: false,
			error: "handler failed",
			data: { actionName: "BOOM" },
		});
	});

	it("keeps the executor's action identity authoritative over handler data", async () => {
		const action = makeAction({
			name: "TRUSTED_ACTION",
			handler: async () => ({
				success: true,
				data: {
					actionName: "FORGED_ACTION",
					value: "preserved",
				},
			}),
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "TRUSTED_ACTION", params: {} },
		);

		expect(result).toMatchObject({
			success: true,
			data: {
				actionName: "TRUSTED_ACTION",
				value: "preserved",
			},
		});
	});

	it("runs handlers inside an action trajectory step so nested model calls retain purpose context", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "CLASSIFY_INBOX",
			handler: async (rt) => {
				await rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify" });
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "trajectory-1",
				trajectoryStepId: "parent-step-1",
				purpose: "planner",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "CLASSIFY_INBOX", params: {} },
				),
		);

		expect(result.success).toBe(true);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
			prompt: "classify",
		});
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.objectContaining({
				timestamp: expect.any(Number),
				parentStepId: "parent-step-1",
				kind: "action",
			}),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "action",
		});
		expect(trajectoryLogger.completeStep).toHaveBeenCalledWith(
			"trajectory-1",
			"action-step-1",
			expect.objectContaining({
				actionType: "CLASSIFY_INBOX",
				actionName: "CLASSIFY_INBOX",
				parameters: {},
				success: true,
				result: expect.objectContaining({ success: true }),
			}),
		);
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("preserves oversized action strings and arrays before trajectory settlement", async () => {
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "bounded-action-step"),
			completeStep: vi.fn(),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let depth = 0; depth < 25; depth++) {
			const next: Record<string, unknown> = {};
			cursor.next = next;
			cursor = next;
		}
		const oversized = {
			long: "x".repeat(80_000),
			items: Array.from({ length: 300 }, (_, index) => index),
			deep,
		};
		const action = makeAction({
			name: "BOUNDED_ACTION",
			parameters: [
				{
					name: "payload",
					description: "Oversized persistence fixture",
					required: true,
					schema: { type: "object", additionalProperties: true },
				},
			],
			handler: async () => ({ success: true, data: oversized }),
		});
		const runtime = makeRuntime([action], {
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
		});

		const result = await runWithTrajectoryContext(
			{
				trajectoryId: "bounded-trajectory",
				trajectoryStepId: "bounded-parent",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "BOUNDED_ACTION", params: { payload: oversized } },
				),
		);
		expect(result.success).toBe(true);

		const settlement = trajectoryLogger.completeStep.mock.calls[0]?.[2] as {
			parameters: { payload: typeof oversized };
			result: { data: typeof oversized };
			success: boolean;
		};
		for (const bounded of [
			settlement.parameters.payload,
			settlement.result.data,
		]) {
			expect(bounded.long).toBe(oversized.long);
			expect(bounded.items).toEqual(oversized.items);
		}
		// Parameters and result cross the diagnostic projection before the JSON
		// sanitizer, so over-deep subtrees collapse to the projection's mask at
		// its (shallower) depth bound rather than the sanitizer's [MaxDepth].
		expect(JSON.stringify(settlement.parameters.payload.deep)).toContain(
			"[REDACTED]",
		);
		expect(JSON.stringify(settlement.result.data.deep)).toContain("[REDACTED]");
		expect(settlement.success).toBe(true);
	});

	it("rebuilds action trajectory context from message metadata when planner execution lost ALS", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "INBOX_TRIAGE",
			handler: async (rt) => {
				await runWithTrajectoryPurpose("inbox_triage", () =>
					rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify inbox" }),
				);
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getCurrentRunId: vi.fn(() => "run-1"),
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});
		const message = makeMessage();
		message.metadata = {
			trajectoryId: "trajectory-1",
			trajectoryStepId: "parent-step-1",
		};

		const result = await executePlannedToolCall(
			runtime,
			{ message },
			{ name: "INBOX_TRIAGE", params: {} },
		);

		expect(result.success).toBe(true);
		expect(useModel).toHaveBeenCalledWith(ModelType.TEXT_SMALL, {
			prompt: "classify inbox",
		});
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.objectContaining({
				timestamp: expect.any(Number),
				parentStepId: "parent-step-1",
				kind: "action",
			}),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "inbox_triage",
			runId: "run-1",
			roomId: "room-id",
			messageId: "message-id",
		});
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("fills a missing trajectory id from message metadata when ALS kept only the parent step", async () => {
		const observedContexts: ReturnType<typeof getTrajectoryContext>[] = [];
		const trajectoryLogger = {
			isEnabled: vi.fn(() => true),
			startStep: vi.fn(() => "action-step-1"),
			flushWriteQueue: vi.fn(async () => {}),
			annotateStep: vi.fn(async () => {}),
		};
		const useModel = vi.fn(async () => {
			observedContexts.push(getTrajectoryContext());
			return "classified";
		});
		const action = makeAction({
			name: "INBOX_TRIAGE",
			handler: async (rt) => {
				await runWithTrajectoryPurpose("inbox_triage", () =>
					rt.useModel(ModelType.TEXT_SMALL, { prompt: "classify inbox" }),
				);
				return { success: true };
			},
		});
		const runtime = makeRuntime([action], {
			getCurrentRunId: vi.fn(() => "run-1"),
			getService: vi.fn((serviceType: string) =>
				serviceType === "trajectories" ? trajectoryLogger : undefined,
			),
			getServicesByType: vi.fn(() => []),
			useModel,
		});
		const message = makeMessage();
		message.metadata = {
			trajectoryId: "trajectory-1",
			trajectoryStepId: "parent-step-1",
		};

		const result = await runWithTrajectoryContext(
			{
				trajectoryStepId: "parent-step-1",
				purpose: "planner",
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message },
					{ name: "INBOX_TRIAGE", params: {} },
				),
		);

		expect(result.success).toBe(true);
		expect(trajectoryLogger.startStep).toHaveBeenCalledWith(
			"trajectory-1",
			expect.any(Object),
		);
		expect(observedContexts[0]).toMatchObject({
			trajectoryId: "trajectory-1",
			trajectoryStepId: "action-step-1",
			parentStepId: "parent-step-1",
			purpose: "inbox_triage",
			runId: "run-1",
		});
		expect(trajectoryLogger.flushWriteQueue).toHaveBeenCalledWith(
			"trajectory-1",
		);
	});

	it("emits ACTION_STARTED and ACTION_COMPLETED events for successful planned tools", async () => {
		const emitEvent = vi.fn(async () => {});
		const action = makeAction({
			name: "CREATE_TASK",
			handler: async () => ({
				success: true,
				text: "created",
				data: { id: "task-1" },
			}),
		});
		const getRoom = vi.fn(
			async () =>
				({
					id: "room-id" as UUID,
					agentId: "agent-id" as UUID,
					source: "test",
					type: ChannelType.DM,
					worldId: "world-id" as UUID,
				}) satisfies Room,
		);
		const runtime = makeRuntime([action], { emitEvent, getRoom });

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage(), userRoles: ["GUEST"] },
			{ name: "CREATE_TASK", params: {} },
		);

		expect(result.success).toBe(true);
		expect(emitEvent).toHaveBeenNthCalledWith(
			1,
			EventType.ACTION_STARTED,
			expect.objectContaining({
				messageId: "message-id",
				roomId: "room-id",
				world: "world-id",
				content: expect.objectContaining({
					text: "Executing action: CREATE_TASK",
					actions: ["CREATE_TASK"],
					actionStatus: "executing",
				}),
			}),
		);
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				messageId: "message-id",
				roomId: "room-id",
				world: "world-id",
				content: expect.objectContaining({
					text: "created",
					actions: ["CREATE_TASK"],
					actionStatus: "completed",
					actionResult: expect.objectContaining({
						success: true,
						text: "created",
						data: expect.objectContaining({ id: "task-1" }),
					}),
				}),
			}),
		);
	});

	it("bounds cyclic and deep handler results before completion diagnostics", async () => {
		const cyclic: Record<string, unknown> = { label: "loop" };
		cyclic.self = cyclic;
		const cyclicDate = new Date("2026-08-20T00:00:00.000Z") as Date & {
			apiKey?: string;
			self?: unknown;
		};
		Object.defineProperties(cyclicDate, {
			apiKey: { enumerable: true, value: "short-secret" },
			self: { enumerable: true, value: cyclicDate },
		});
		const fallbackCanary = "sk-0123456789abcdefghij";
		const fallbackValue = Symbol(fallbackCanary);
		let deep: Record<string, unknown> = { leaf: "must-be-bounded" };
		for (let depth = 0; depth < 12; depth += 1) {
			deep = { child: deep };
		}
		const emitted: Array<{ type: EventType; payload: unknown }> = [];
		const streamed: unknown[] = [];
		let settledResult: unknown;
		const action = makeAction({
			name: "RETURN_DATA",
			handler: async () => ({
				success: true,
				data: {
					actionName: "RETURN_DATA",
					cyclic,
					cyclicDate,
					deep,
					fallbackValue,
				},
			}),
		});
		const runtime = makeRuntime([action], {
			emitEvent: async (type, payload) => {
				emitted.push({ type, payload });
			},
		});

		const result = await runWithStreamingContext(
			{
				onStreamChunk: () => {},
				onToolResult: (payload) => {
					streamed.push(payload);
				},
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "RETURN_DATA", params: {} },
					{
						onSettledResult: (settled) => {
							settledResult = settled;
						},
					},
				),
		);

		expect(result.success).toBe(true);
		const rawCyclic = result.data?.cyclic;
		expect(rawCyclic).toBe(cyclic);
		expect((rawCyclic as Record<string, unknown>).self).toBe(cyclic);
		expect(result.data?.cyclicDate).toBe(cyclicDate);
		expect(cyclicDate.self).toBe(cyclicDate);
		expect(result.data?.deep).toBe(deep);
		expect(result.data?.fallbackValue).toBe(fallbackValue);
		expect(settledResult).toBe(result);
		const completedEvents = emitted.filter(
			(entry) => entry.type === EventType.ACTION_COMPLETED,
		);
		expect(completedEvents).toHaveLength(1);
		expect(streamed).toHaveLength(1);
		const eventPayload = completedEvents[0]?.payload as
			| { content?: { actionResult?: unknown } }
			| undefined;
		const eventActionResult = eventPayload?.content?.actionResult;
		const streamedActionResult = (streamed[0] as { result?: unknown }).result;
		for (const diagnosticSurface of [eventActionResult, streamedActionResult]) {
			const diagnosticData = (
				diagnosticSurface as { data?: Record<string, unknown> } | undefined
			)?.data;
			expect(diagnosticData?.cyclicDate).toEqual({
				apiKey: "[REDACTED]",
				self: "[REDACTED]",
			});
			const serialized = JSON.stringify(diagnosticSurface);
			expect(serialized).toContain('"self":"[REDACTED]"');
			expect(serialized).toContain('"deep":');
			expect(serialized).toContain('"fallbackValue":');
			expect(serialized).not.toContain("must-be-bounded");
			expect(serialized).not.toContain(fallbackCanary);
		}
	});

	it("masks callable diagnostics without changing or rejecting the settled result", async () => {
		let settledResult: unknown;
		let callableTraps = 0;
		const callable = new Proxy(() => undefined, {
			get() {
				callableTraps += 1;
				throw new Error("callable diagnostic trap escaped");
			},
		});
		const action = makeAction({
			name: "RETURN_HOSTILE_DATA",
			handler: async () => ({
				success: true,
				data: { payload: callable },
			}),
		});
		const emitted: unknown[] = [];
		const streamed: unknown[] = [];
		const runtime = makeRuntime([action], {
			emitEvent: async (_type, payload) => emitted.push(payload),
		});

		const result = await runWithStreamingContext(
			{
				onStreamChunk: () => {},
				onToolResult: (payload) => streamed.push(payload),
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "RETURN_HOSTILE_DATA", params: {} },
					{
						onSettledResult: (result) => {
							settledResult = result;
						},
					},
				),
		);
		expect(result).toBe(settledResult);
		expect(result.data?.payload).toBe(callable);
		expect(callableTraps).toBe(0);
		expect(JSON.stringify(emitted)).toContain('"payload":"[REDACTED]"');
		expect(JSON.stringify(streamed)).toContain('"payload":"[REDACTED]"');
	});

	it("does not invoke accessors and bounds shallow diagnostic outputs", async () => {
		let accessorCalls = 0;
		const payload: Record<string, unknown> = {};
		Object.defineProperty(payload, "value", {
			enumerable: true,
			get() {
				accessorCalls += 1;
				return "safe";
			},
		});
		const wide = Array.from({ length: 10_000 }, () => "😀".repeat(100));
		const emitted: unknown[] = [];
		const streamed: unknown[] = [];
		const action = makeAction({
			name: "RETURN_WIDE_DATA",
			handler: async () => ({ success: true, data: { payload, wide } }),
		});
		const runtime = makeRuntime([action], {
			emitEvent: async (_type, eventPayload) => {
				emitted.push(eventPayload);
			},
		});

		const result = await runWithStreamingContext(
			{
				onStreamChunk: () => {},
				onToolResult: (value) => streamed.push(value),
			},
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "RETURN_WIDE_DATA", params: {} },
				),
		);
		expect(result.data?.payload).toBe(payload);
		expect(result.data?.wide).toBe(wide);
		expect(accessorCalls).toBe(0);
		for (const diagnostic of [emitted, streamed]) {
			const serialized = JSON.stringify(diagnostic);
			expect(serialized).toContain('"value":"[REDACTED]"');
			expect(serialized).toContain('"wide":"[REDACTED]"');
			expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(
				64 * 1_024,
			);
		}
	});

	it("masks revoked proxies after settlement without rejecting execution", async () => {
		let settled = false;
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		const action = makeAction({
			name: "RETURN_REVOKED_DATA",
			handler: async () => ({ success: true, data: { proxy } }),
		});
		const runtime = makeRuntime([action], { emitEvent: async () => {} });

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "RETURN_REVOKED_DATA", params: {} },
			{ onSettledResult: () => (settled = true) },
		);
		expect(result.data?.proxy).toBe(proxy);
		expect(settled).toBe(true);
	});

	it("preserves UTF-8 strings while masking hostile sparse arrays", async () => {
		let coercionCalls = 0;
		const coercible = {
			[Symbol.toPrimitive]() {
				coercionCalls += 1;
				return "must-not-coerce";
			},
			toString() {
				coercionCalls += 1;
				return "must-not-stringify";
			},
		};
		const protoPayload: Record<string, unknown> = {};
		Object.defineProperty(protoPayload, "__proto__", {
			enumerable: true,
			value: { polluted: "diagnostic-only" },
		});
		const sparse: unknown[] = [];
		sparse.length = 10_000_000;
		sparse[9_999_999] = "tail";
		const emitted: unknown[] = [];
		const action = makeAction({
			name: "RETURN_BOUNDED_DATA",
			handler: async () => ({
				success: true,
				data: {
					coercible,
					huge: "😀".repeat(100_000),
					multibyte: "😀".repeat(3_000),
					protoPayload,
					sparse,
				},
			}),
		});
		const runtime = makeRuntime([action], {
			emitEvent: async (_type, payload) => emitted.push(payload),
		});

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "RETURN_BOUNDED_DATA", params: {} },
		);
		expect(result.data?.coercible).toBe(coercible);
		expect(result.data?.sparse).toBe(sparse);
		expect(coercionCalls).toBe(0);

		const completed = emitted.find(
			(value) =>
				(value as { content?: { actionResult?: unknown } }).content
					?.actionResult !== undefined,
		) as {
			content?: {
				actionResult?: {
					data?: Record<string, unknown>;
				};
			};
		};
		const diagnosticData = completed.content?.actionResult?.data;
		expect(diagnosticData?.sparse).toBe("[REDACTED]");
		expect(diagnosticData?.coercible).toEqual({
			toString: "[REDACTED]",
		});
		const projectedPrototype = diagnosticData?.protoPayload as Record<
			string,
			unknown
		>;
		expect(Object.getPrototypeOf(projectedPrototype)).toBe(Object.prototype);
		expect(Object.hasOwn(projectedPrototype, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(projectedPrototype, "__proto__")?.value,
		).toEqual({
			polluted: "diagnostic-only",
		});
		expect(
			(Object.prototype as { polluted?: unknown }).polluted,
		).toBeUndefined();
		const projectedHuge = diagnosticData?.huge;
		expect(projectedHuge).toBe("😀".repeat(100_000));
		const projectedMultibyte = diagnosticData?.multibyte as string;
		expect(projectedMultibyte).toBe("😀".repeat(3_000));
		expect(projectedMultibyte).not.toContain("�");
	});

	it("suppresses sensitive action result data in ACTION_COMPLETED events", async () => {
		const emitEvent = vi.fn(async () => {});
		const onToolResult = vi.fn();
		const onSettledResult = vi.fn();
		const action = makeAction({
			name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
			suppressActionResultClipboard: true,
			handler: async () => ({
				success: true,
				text: "declared",
				data: {
					actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
					credentialScopeId: "cred_scope_test",
					scopedToken: "secret-token",
				},
			}),
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await runWithStreamingContext(
			{ onStreamChunk: vi.fn(), onToolResult },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE", params: {} },
					{ onSettledResult },
				),
		);

		expect(result).toMatchObject({
			success: true,
			data: expect.objectContaining({ scopedToken: "secret-token" }),
		});
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({
					actionResult: expect.objectContaining({
						success: true,
						text: "declared",
						data: {
							actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
							suppressed: true,
							reason: "sensitive_action_result",
						},
					}),
				}),
			}),
		);
		expect(JSON.stringify(emitEvent.mock.calls)).not.toContain("secret-token");
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({
					data: {
						actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
						suppressed: true,
						reason: "sensitive_action_result",
					},
				}),
				toolCall: expect.objectContaining({
					result: expect.objectContaining({
						data: {
							actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE",
							suppressed: true,
							reason: "sensitive_action_result",
						},
					}),
				}),
			}),
		);
		expect(JSON.stringify(onToolResult.mock.calls)).not.toContain(
			"secret-token",
		);
		expect(onSettledResult).toHaveBeenCalledWith({
			success: true,
			text: "declared",
			data: { actionName: "DECLARE_SUB_AGENT_CREDENTIAL_SCOPE" },
		});
		expect(JSON.stringify(onSettledResult.mock.calls)).not.toContain(
			"secret-token",
		);
	});

	it("honors per-result suppression in action events and streaming tool results", async () => {
		const emitEvent = vi.fn(async () => {});
		const onToolResult = vi.fn();
		const action = makeAction({
			name: "VIEWS",
			handler: async () => ({
				success: false,
				text: "View edit did not start.",
				values: { workdir: "/private/must-not-leak" },
				data: {
					actionName: "VIEWS",
					task: { sessionId: "must-not-leak" },
					suppressActionResultClipboard: true,
				},
			}),
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await runWithStreamingContext(
			{ onStreamChunk: vi.fn(), onToolResult },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: makeMessage() },
					{ name: "VIEWS", params: {} },
				),
		);

		expect(result).toMatchObject({
			success: false,
			text: "View edit did not start.",
			data: expect.objectContaining({
				suppressActionResultClipboard: true,
			}),
		});
		const emittedSurfaces = JSON.stringify({
			events: emitEvent.mock.calls,
			streaming: onToolResult.mock.calls,
		});
		expect(emittedSurfaces).not.toContain("must-not-leak");
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({
					actionStatus: "failed",
					actionResult: expect.objectContaining({
						success: false,
						text: "View edit did not start.",
						data: {
							actionName: "VIEWS",
							suppressed: true,
							reason: "sensitive_action_result",
						},
					}),
				}),
			}),
		);
		expect(onToolResult).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				result: expect.objectContaining({
					success: false,
					text: "View edit did not start.",
					data: {
						actionName: "VIEWS",
						suppressed: true,
						reason: "sensitive_action_result",
					},
				}),
			}),
		);
	});

	it("revalidates owner-private callbacks, events, and streamed tool results after the handler", async () => {
		const owner = "11111111-1111-1111-1111-111111111111";
		const agent = "22222222-2222-2222-2222-222222222222";
		const room = "33333333-3333-3333-3333-333333333333";
		const guest = "44444444-4444-4444-4444-444444444444";
		let participants = [owner, agent];
		const emitEvent = vi.fn(async () => {});
		const onToolResult = vi.fn();
		const onSettledResult = vi.fn();
		const callback = vi.fn(async () => []);
		const action = makeAction({
			name: "OWNER_PRIVATE",
			disclosureGate: { require: "owner_exclusive" },
			handler: async (_runtime, _message, _state, _options, actionCallback) => {
				await actionCallback?.({ text: "OWNER_PRIVATE_CANARY" });
				participants = [owner, agent, guest];
				return {
					success: true,
					text: "OWNER_PRIVATE_CANARY",
					data: { privateValue: "OWNER_PRIVATE_CANARY" },
				};
			},
		});
		const runtime = makeRuntime([action], {
			emitEvent,
			getParticipantsForRoom: vi.fn(async () => [...participants]),
			getRoom: vi.fn(async () => ({
				id: room,
				agentId: agent,
				source: "discord",
				type: ChannelType.DM,
			})),
			getSetting: vi.fn((key: string) =>
				key === "ELIZA_ADMIN_ENTITY_ID" ? owner : undefined,
			),
			reportError: vi.fn(),
		});
		(runtime as { agentId: string }).agentId = agent;
		const turn = {
			...makeMessage(),
			entityId: owner,
			agentId: agent,
			roomId: room,
		} as Memory;
		await attestDeliveryAudienceFromCanonicalRoom(runtime, turn);

		const result = await runWithStreamingContext(
			{ onStreamChunk: vi.fn(), onToolResult },
			() =>
				executePlannedToolCall(
					runtime,
					{ message: turn, callback, userRoles: ["OWNER"] },
					{ name: action.name, params: {} },
					{ onSettledResult },
				),
		);

		expect(result).toMatchObject({
			success: false,
			text: PRIVACY_DENIED_TEXT,
			data: {
				actionName: "OWNER_PRIVATE",
				privacyDenied: true,
				privacyReason: "audience_changed",
			},
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: PRIVACY_DENIED_TEXT }),
			"PRIVACY_DENIED",
		);
		const observable = JSON.stringify({
			callback: callback.mock.calls,
			events: emitEvent.mock.calls,
			settlement: onSettledResult.mock.calls,
			streaming: onToolResult.mock.calls,
			result,
		});
		expect(observable).not.toContain("OWNER_PRIVATE_CANARY");
		expect(onSettledResult).toHaveBeenCalledWith({
			success: true,
			data: { actionName: "OWNER_PRIVATE" },
		});
	});

	it("emits failed ACTION_COMPLETED events with string errors for thrown handlers", async () => {
		const emitEvent = vi.fn(async () => {});
		const action = makeAction({
			name: "BOOM",
			handler: async () => {
				throw new Error("handler failed");
			},
		});
		const runtime = makeRuntime([action], { emitEvent });

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "BOOM", params: {} },
		);

		expect(result.success).toBe(false);
		expect(emitEvent).toHaveBeenNthCalledWith(
			2,
			EventType.ACTION_COMPLETED,
			expect.objectContaining({
				content: expect.objectContaining({
					actions: ["BOOM"],
					actionStatus: "failed",
					actionResult: expect.objectContaining({
						success: false,
						error: "handler failed",
					}),
					error: "handler failed",
				}),
			}),
		);
	});

	it("denies actions that fail role or context gates", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "OWNER_ONLY",
			contextGate: { anyOf: ["admin"] },
			roleGate: { minRole: "OWNER" },
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{
				message: makeMessage(),
				activeContexts: ["general"],
				userRoles: ["MEMBER"],
			},
			{ name: "OWNER_ONLY", params: {} },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	it("runs an action admitted under its own contexts whose validate() reads the routing state", async () => {
		const { hasActionContext } = await import("../../utils/action-validation");
		const handler = vi.fn(async () => ({ success: true, text: "3 messages" }));
		const action = makeAction({
			name: "MESSAGE",
			contexts: ["messaging"],
			validate: async (_runtime, message, state) =>
				hasActionContext(message, state, { contexts: ["messaging"] }),
			handler,
		});
		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{
				message: makeMessage(),
				state: {
					text: "",
					data: {},
					values: { __contextRouting: { primaryContext: "general" } },
				},
				activeContexts: ["general", "messaging"],
				userRoles: ["ADMIN"],
			},
			{ name: "MESSAGE", params: {} },
		);
		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("fails closed when canonical role lookup throws instead of fabricating USER", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "USER_OR_HIGHER",
			roleGate: { minRole: "USER" },
			handler,
		});
		const roleStoreFailure = new Error("role database unavailable");
		const runtime = makeRuntime([action], {
			getRoom: vi.fn(async () => {
				throw roleStoreFailure;
			}),
		});

		await expect(
			executePlannedToolCall(
				runtime,
				{ message: makeMessage() },
				{ name: "USER_OR_HIGHER", params: {} },
			),
		).rejects.toMatchObject<Partial<ElizaError>>({
			code: "ACTION_CALLER_ROLE_LOOKUP_FAILED",
			cause: roleStoreFailure,
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("uses the GUEST floor when canonical room or world evidence is absent", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "USER_OR_HIGHER",
			roleGate: { minRole: "USER" },
			handler,
		});
		const runtime = makeRuntime([action], {
			getRoom: vi.fn(async () => null),
		});

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{ name: "USER_OR_HIGHER", params: {} },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	describe("ACTION_ROLE_POLICY override", () => {
		const ORIGINAL = process.env.ACTION_ROLE_POLICY;
		afterEach(() => {
			if (ORIGINAL === undefined) {
				delete process.env.ACTION_ROLE_POLICY;
			} else {
				process.env.ACTION_ROLE_POLICY = ORIGINAL;
			}
			_resetActionRolePolicyCacheForTests();
		});

		it("allows a context-gated action when policy lists it and caller meets the role", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "GUEST" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("rejects a policy-listed action when caller is below the policy role", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "ADMIN" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["admin"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("falls through to the normal contextGate when the action is absent from the policy", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ OTHER: "GUEST" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "GATED", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("rejects malformed ACTION_ROLE_POLICY", async () => {
			process.env.ACTION_ROLE_POLICY = "not-json";
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "PLAIN_ACTION",
				handler,
			});

			await expect(
				executePlannedToolCall(
					makeRuntime([action]),
					{ message: makeMessage() },
					{ name: "PLAIN_ACTION", params: {} },
				),
			).rejects.toMatchObject({ code: "INVALID_ACTION_ROLE_POLICY" });
			expect(handler).not.toHaveBeenCalled();
		});

		it("does not match a policy entry against the action's similes", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "NONE" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "SHELL",
				similes: ["BASH", "EXEC", "RUN_COMMAND"],
				contextGate: { anyOf: ["code", "terminal", "automation"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "SHELL", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain("not allowed");
			expect(handler).not.toHaveBeenCalled();
		});

		it("does not let a simile policy entry tighten an unrelated action", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ BASH: "OWNER" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "SHELL",
				similes: ["BASH", "EXEC", "RUN_COMMAND"],
				contextGate: { anyOf: ["general"] },
				roleGate: { minRole: "NONE" },
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{
					message: makeMessage(),
					activeContexts: ["general"],
					userRoles: ["GUEST"],
				},
				{ name: "SHELL", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("rejects policy entries with unrecognized roles", async () => {
			process.env.ACTION_ROLE_POLICY = JSON.stringify({ GATED: "MODERATOR" });
			_resetActionRolePolicyCacheForTests();
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "GATED",
				contextGate: { anyOf: ["admin"] },
				roleGate: { minRole: "OWNER" },
				handler,
			});

			await expect(
				executePlannedToolCall(
					makeRuntime([action]),
					{
						message: makeMessage(),
						activeContexts: ["general"],
						userRoles: ["GUEST"],
					},
					{ name: "GATED", params: {} },
				),
			).rejects.toMatchObject({ code: "INVALID_ACTION_ROLE_POLICY" });
			expect(handler).not.toHaveBeenCalled();
		});
	});

	it("denies execution when connector account policy is not satisfied", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "SEND_CONNECTOR_MESSAGE",
			connectorAccountPolicy: {
				provider: "gmail",
				roles: ["owner"],
				purposes: ["messaging"],
				accessGates: ["open"],
				accountIdParam: "accountId",
			},
			parameters: [
				{
					name: "accountId",
					description: "Connector account id",
					required: true,
					schema: { type: "string" },
				},
			],
			handler,
		});
		const runtime = makeRuntime([action]);
		const storage = new InMemoryConnectorAccountStorage();
		const manager = getConnectorAccountManager(runtime, storage);
		await manager.upsertAccount("gmail", {
			id: "member-account",
			role: "member",
			purpose: "messaging",
			accessGate: "open",
			status: "connected",
		});

		const result = await executePlannedToolCall(
			runtime,
			{ message: makeMessage() },
			{
				name: "SEND_CONNECTOR_MESSAGE",
				params: { accountId: "member-account" },
			},
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("role TEAM is not allowed");
		expect(handler).not.toHaveBeenCalled();
	});

	it("does not trust content.metadata.accountId for connector account selection", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "SEND_CONNECTOR_MESSAGE",
			connectorAccountPolicy: {
				provider: "gmail",
				roles: ["owner"],
				purposes: ["messaging"],
				accessGates: ["open"],
				accountIdParam: "accountId",
			},
			handler,
		});
		const runtime = makeRuntime([action]);
		const storage = new InMemoryConnectorAccountStorage();
		const manager = getConnectorAccountManager(runtime, storage);
		await manager.upsertAccount("gmail", {
			id: "owner-account",
			role: "owner",
			purpose: "messaging",
			accessGate: "open",
			status: "connected",
		});
		const message = {
			...makeMessage(),
			content: {
				text: "send this",
				metadata: { accountId: "owner-account" },
			},
		} as Memory;

		const result = await executePlannedToolCall(
			runtime,
			{ message },
			{ name: "SEND_CONNECTOR_MESSAGE", params: {} },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain(
			"Missing connector account parameter",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	describe("private actions", () => {
		function makeAutonomousMessage(): Memory {
			return {
				...makeMessage(),
				content: {
					text: "autonomous tick",
					metadata: { isAutonomous: true },
				},
			} as Memory;
		}

		it("rejects a private action on a user-driven turn", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "MINT_COIN",
				private: true,
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: "MINT_COIN", params: {} },
			);

			expect(result.success).toBe(false);
			expect(String(result.error)).toContain(
				"is private and can only run in the agent's autonomous loop",
			);
			expect(handler).not.toHaveBeenCalled();
		});

		it("allows a private action on an autonomous turn", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({
				name: "MINT_COIN",
				private: true,
				handler,
			});

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeAutonomousMessage() },
				{ name: "MINT_COIN", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});

		it("leaves non-private actions runnable on user turns", async () => {
			const handler = vi.fn(async () => ({ success: true }));
			const action = makeAction({ name: "REPLY", handler });

			const result = await executePlannedToolCall(
				makeRuntime([action]),
				{ message: makeMessage() },
				{ name: "REPLY", params: {} },
			);

			expect(result.success).toBe(true);
			expect(handler).toHaveBeenCalledOnce();
		});
	});
});

describe("dropEmptyOptionalArgs", () => {
	function backgroundLikeAction(
		handler: Action["handler"] = async () => ({ success: true }),
	): Action {
		// Mirrors the #10694 live-trajectory shape: an all-optional action where
		// strict tool schemas force the model to emit every key, so `""` is its
		// only way to leave `preset` unset on a color-only turn.
		return makeAction({
			name: "BACKGROUND",
			parameters: [
				{
					name: "op",
					description: "Operation",
					required: false,
					schema: { type: "string", enum: ["set", "undo", "redo", "reset"] },
				},
				{
					name: "color",
					description: "Color",
					required: false,
					schema: { type: "string" },
				},
				{
					name: "preset",
					description: "Shader preset",
					required: false,
					modelOmissionSentinels: [""],
					schema: { type: "string", enum: ["aurora", "lava"] },
				},
			],
			handler,
		});
	}

	it("treats an empty string on an optional enum parameter as omitted (#10694)", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = backgroundLikeAction(handler);

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "BACKGROUND", params: { op: "set", color: "teal", preset: "" } },
		);

		expect(result.success).toBe(true);
		expect(handler).toHaveBeenCalledWith(
			expect.any(Object),
			expect.any(Object),
			undefined,
			expect.objectContaining({
				parameters: { op: "set", color: "teal" },
			}),
			undefined,
			undefined,
		);
	});

	it("keeps an empty string on a REQUIRED enum parameter failing loudly", async () => {
		const handler = vi.fn(async () => ({ success: true }));
		const action = makeAction({
			name: "TASKS",
			parameters: [
				{
					name: "op",
					description: "Task operation",
					required: true,
					schema: { type: "string", enum: ["create", "provision_workspace"] },
				},
			],
			handler,
		});

		const result = await executePlannedToolCall(
			makeRuntime([action]),
			{ message: makeMessage() },
			{ name: "TASKS", params: { op: "" } },
		);

		expect(result.success).toBe(false);
		expect(String(result.error)).toContain("is not one of");
		expect(handler).not.toHaveBeenCalled();
	});

	it("drops only opted-in empty-string sentinels and preserves ordinary empty strings", () => {
		const action = backgroundLikeAction();

		const untouched = { op: "set", color: "teal" };
		expect(dropEmptyOptionalArgs(action, untouched)).toBe(untouched);

		expect(
			dropEmptyOptionalArgs(action, { op: "set", color: "", preset: "" }),
		).toEqual({ op: "set", color: "" });

		// Undeclared keys and non-string empties pass through untouched — strict
		// validation still owns rejecting them.
		expect(
			dropEmptyOptionalArgs(action, { op: "set", stray: "", count: 0 }),
		).toEqual({ op: "set", stray: "", count: 0 });
	});
});

import { normalizeParamAliases } from "../execute-planned-tool-call";

describe("normalizeParamAliases", () => {
	const action = {
		name: "TRIGGER",
		description: "",
		parameters: [
			{
				name: "instructions",
				required: false,
				aliases: ["description", "message", "prompt"],
				schema: { type: "string" },
			},
			{
				name: "scheduledAtIso",
				required: false,
				aliases: ["scheduledFor", "when", "at"],
				schema: { type: "string" },
			},
			{
				name: "target",
				required: false,
				aliases: ["to", "recipient"],
				schema: { type: "string" },
			},
			{
				name: "shared",
				required: false,
				aliases: ["dup"],
				schema: { type: "string" },
			},
			{
				name: "shared2",
				required: false,
				aliases: ["dup"],
				schema: { type: "string" },
			},
		],
		validate: async () => true,
		handler: async () => ({}),
	} as unknown as import("@elizaos/core").Action;

	it("renames an alias key to its canonical param", () => {
		expect(
			normalizeParamAliases(action, {
				description: "drink water",
				scheduledFor: "2026-01-01T00:00:00Z",
			}),
		).toEqual({
			instructions: "drink water",
			scheduledAtIso: "2026-01-01T00:00:00Z",
		});
	});

	it("leaves a declared canonical key untouched", () => {
		expect(normalizeParamAliases(action, { instructions: "x" })).toEqual({
			instructions: "x",
		});
	});

	it("never clobbers an explicitly-provided canonical value", () => {
		expect(
			normalizeParamAliases(action, {
				instructions: "canon",
				description: "alias",
			}),
		).toEqual({ instructions: "canon", description: "alias" });
	});

	it("leaves an unknown key to reject (not claimed by any alias)", () => {
		expect(normalizeParamAliases(action, { totally_unknown: "x" })).toEqual({
			totally_unknown: "x",
		});
	});

	it("leaves an ambiguous alias (two params claim it) to reject", () => {
		expect(normalizeParamAliases(action, { dup: "x" })).toEqual({ dup: "x" });
	});

	it("is a no-op when the action declares no aliases", () => {
		const noAlias = {
			...action,
			parameters: [{ name: "x", required: false, schema: { type: "string" } }],
		} as unknown as import("@elizaos/core").Action;
		expect(normalizeParamAliases(noAlias, { y: "1" })).toEqual({ y: "1" });
	});
});
