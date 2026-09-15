/**
 * Exercises real catalog/navigation HTTP with trusted turn policy and cancellation.
 * The test server records transport effects; this is not mounted-renderer evidence.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { runWithStreamingContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setNavigationConstraint } from "./navigation-execution.js";
import {
	createShowViewAction,
	createViewsAction,
	createViewsAliasAction,
} from "./views.js";
import { createViewsClient, type ViewSummary } from "./views-client.js";
import { runViewsList } from "./views-list.js";
import { runViewsShow } from "./views-show.js";

let server: Server;
let controller: AbortController;
let posts: Record<string, unknown>[];
let cancelCatalog: boolean;
let view: ViewSummary;
let reply: "delivered" | "false" | "missing" | "malformed" | "mismatch";
let previousPort: string | undefined;
const message = {
	id: "turn-1",
	roomId: "room-1",
	entityId: "actor-1",
	content: { text: "Add dentist Thursday 2pm, but do not change views." },
} as unknown as Memory;
const clientMessage = {
	...message,
	content: { ...message.content, metadata: { viewClientId: "client-a" } },
} as Memory;
const options = {
	view: "calendar",
	navigationIntent: "planner-step",
	navigationStepId: "step-1",
};

beforeEach(async () => {
	controller = new AbortController();
	posts = [];
	cancelCatalog = false;
	reply = "delivered";
	view = {
		id: "calendar",
		label: "Calendar",
		pluginName: "calendar",
		available: true,
	};
	previousPort = process.env.ELIZA_API_PORT;
	server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method === "GET") {
			if (cancelCatalog) controller.abort("superseded while reading catalog");
			res.end(JSON.stringify({ views: [view] }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body: Record<string, unknown> = JSON.parse(
			Buffer.concat(chunks).toString(),
		);
		posts.push(body);
		res.end(
			reply === "malformed"
				? "not JSON"
				: JSON.stringify(
						reply === "missing"
							? {}
							: {
									completedActionDelivered: reply !== "false",
									completedActionHandoffId:
										reply === "mismatch"
											? "other-step"
											: body.completedActionHandoffId,
								},
					),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ELIZA_API_PORT = String((server.address() as AddressInfo).port);
});
afterEach(async () => {
	if (previousPort === undefined) delete process.env.ELIZA_API_PORT;
	else process.env.ELIZA_API_PORT = previousPort;
	await new Promise<void>((resolve) => server.close(() => resolve()));
});
function show(extra: Partial<Parameters<typeof runViewsShow>[0]> = {}) {
	return runViewsShow({
		client: createViewsClient(),
		message,
		options,
		originatingClientId: "client-a",
		...extra,
	});
}
function turn<T>(run: () => T, disposition: "allow" | "deny" = "allow"): T {
	return runWithStreamingContext(
		{ messageId: message.id, abortSignal: controller.signal },
		() => {
			setNavigationConstraint(message, disposition, "trusted classification");
			return run();
		},
	);
}

describe("navigation execution policy", () => {
	it("opens through the narrow action and preserves its delivery receipt", async () => {
		const action = createShowViewAction();
		const result = await turn(() =>
			action.handler(actionRuntime, clientMessage, undefined, {
				parameters: { view: "calendar", navigationStepId: "step-1" },
			}),
		);
		expect(posts).toHaveLength(1);
		expect(result).toMatchObject({
			success: true,
			turnComplete: false,
			data: {
				navigation: {
					viewId: "calendar",
					stepId: "step-1",
					status: "delivered",
				},
			},
		});
	});

	it.each(["view", "navigationStepId"] as const)(
		"requires %s on the narrow action without falling back to user-text routing",
		async (name) => {
			const action = createShowViewAction();
			expect(
				action.parameters?.find((parameter) => parameter.name === name)
					?.required,
			).toBe(true);
			const result = await turn(() =>
				action.handler(actionRuntime, clientMessage, undefined, {
					...options,
					[name]: undefined,
				}),
			);
			expect(posts).toEqual([]);
			expect(result).toMatchObject({
				success: false,
				data: { parameterErrors: [{ name }] },
			});
		},
	);

	it("keeps navigation denial authoritative on the narrow action", async () => {
		const result = await turn(
			() =>
				createShowViewAction().handler(
					actionRuntime,
					message,
					undefined,
					options,
				),
			"deny",
		);
		expect(posts).toEqual([]);
		expect(result).toMatchObject({
			success: false,
			data: { navigation: { status: "forbidden" } },
		});
	});

	it("rejects the narrow action on a viewless connector", async () => {
		const viewless = {
			...message,
			content: { text: "Open Calendar", source: "discord" },
		} as Memory;
		expect(
			await createShowViewAction().validate(
				actionRuntime,
				viewless,
				undefined,
				options,
			),
		).toBe(false);
		expect(posts).toEqual([]);
	});

	it("does not turn a missing delivery acknowledgment into narrow-action success", async () => {
		reply = "missing";
		const result = await turn(() =>
			createShowViewAction().handler(
				actionRuntime,
				clientMessage,
				undefined,
				options,
			),
		);
		expect(posts).toHaveLength(1);
		expect(result).toMatchObject({
			success: false,
			data: { navigation: { status: "not-delivered" } },
		});
	});

	it.each(["view", "navigationStepId"] as const)(
		"reports missing %s as a parameter failure without dispatching",
		async (name) => {
			const invalid = { ...options, [name]: "" };
			const result = await turn(() => show({ options: invalid }));
			expect(result.success).toBe(false);
			expect(posts).toEqual([]);
			expect(result.data).toMatchObject({
				parameterErrors: [{ name, message: expect.any(String) }],
				navigation: { status: "invalid", reason: "VIEW_STEP_INVALID" },
			});
		},
	);

	it("finishes a corrected navigation without reviving its missing-step failure", async () => {
		const { runPlannerLoop, actionResultToPlannerToolResult } = await import(
			"../../../../packages/core/src/runtime/planner-loop"
		);
		let modelCalls = 0;
		let evaluations = 0;
		const result = await turn(() =>
			runPlannerLoop({
				runtime: {
					useModel: async () => {
						modelCalls++;
						if (modelCalls > 2)
							throw new Error("Unexpected synthesis after recovery");
						return {
							text: "",
							toolCalls: [
								{
									id: `navigate-${modelCalls}`,
									name: "VIEWS",
									arguments: {
										action: "show",
										view: "calendar",
										navigationIntent: "planner-step",
										...(modelCalls === 2 ? { navigationStepId: "step-1" } : {}),
									},
								},
							],
						};
					},
				},
				context: { id: "corrected-navigation" },
				tools: [
					{ name: "VIEWS", description: "Navigate to the selected view." },
				],
				executeToolCall: async (call) =>
					actionResultToPlannerToolResult(await show({ options: call.params })),
				evaluate: async () => {
					const completed = ++evaluations === 2;
					return {
						success: completed,
						decision: completed ? "FINISH" : "CONTINUE",
						thought: completed
							? "The navigation receipt confirms delivery."
							: "Supply the missing step identity.",
						...(completed ? { messageToUser: "Calendar is open." } : {}),
					};
				},
			}),
		);
		expect(posts).toHaveLength(1);
		expect(evaluations).toBe(2);
		expect(modelCalls).toBe(2);
		expect(result.finalMessage).toBe("Calendar is open.");
		expect(
			result.trajectory.steps.filter((step) => step.result?.success === false),
		).toHaveLength(1);
	});

	it("keeps caller-filtered catalog absence distinct from a global existence or role claim", async () => {
		const listed = await runViewsList({ client: createViewsClient() });
		const missing = await turn(() =>
			show({ options: { ...options, view: "restricted-archive" } }),
		);
		expect(listed.success).toBe(true);
		expect(listed.data?.views).toMatchObject([{ id: "calendar" }]);
		expect(missing.success).toBe(false);
		expect(missing.data?.navigation).toMatchObject({ status: "not-found" });
		// This wire metadata reaches model continuation alongside the authorized
		// rows. A missing target cannot acquire a global or authorization cause.
		for (const result of [listed, missing]) {
			expect(result.data?.catalogScope).toEqual({
				visibility: "caller-authorized",
				missingView: "unavailable-to-caller",
				missingViewCause: "unknown",
			});
			expect(result.text).toContain(JSON.stringify(result.data?.catalogScope));
		}
		expect(posts).toEqual([]);
	});
	it("rejects planner arguments that attempt to override a forbidden turn", async () => {
		const result = await turn(() => show(), "deny");
		expect(posts).toEqual([]);
		expect(result.success).toBe(false);
		expect(result.data).toMatchObject({
			navigation: { status: "forbidden", stepId: "step-1" },
		});
	});
	it("keeps a denial when a nested model scope detaches streaming and omits the planner marker", async () => {
		const result = await turn(
			() =>
				runWithStreamingContext(undefined, () =>
					show({ options: { view: "calendar" } }),
				),
			"deny",
		);
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "forbidden" } });
	});
	it("rejects a planner step without trusted turn policy", async () => {
		const result = await show();
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "invalid" } });
	});
	it("does not dispatch after cancellation during the real catalog request", async () => {
		cancelCatalog = true;
		const result = await turn(() => show());
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({
			navigation: { status: "cancelled", stepId: "step-1" },
		});
	});
	it("rechecks cancellation after role resolution", async () => {
		view.roleGate = { minRole: "OWNER" };
		const result = await turn(() =>
			show({
				resolveCallerRoles: async () => {
					await Promise.resolve();
					controller.abort("superseded during authorization");
					return ["OWNER"];
				},
			}),
		);
		expect(posts).toEqual([]);
		expect(result.data).toMatchObject({ navigation: { status: "cancelled" } });
	});
	for (const mode of ["false", "missing", "mismatch", "malformed"] as const) {
		it(`keeps ${mode} client receipt distinct from delivery`, async () => {
			reply = mode;
			const result = await turn(() => show());
			expect(result.success).toBe(false);
			expect(result.modelReplyRequired).toBeUndefined();
			expect(result.turnComplete).toBe(false);
			expect(result.data).toMatchObject({
				navigation: {
					status: mode === "malformed" ? "malformed" : "not-delivered",
					stepId: "step-1",
				},
			});
			expect(JSON.parse(result.text ?? "{}").status).toBe(
				mode === "malformed" ? "malformed" : "not-delivered",
			);
			expect(result.values?.completedActionDelivered).toBeUndefined();
		});
	}
	it("reuses originating-client handoff identity when the same turn/step is replayed", async () => {
		const first = await turn(() => show());
		const second = await turn(() => show());
		expect(posts).toHaveLength(2);
		expect(posts[0].clientId).toBe("client-a");
		expect(posts[1].clientId).toBe("client-a");
		expect(posts[0].completedActionHandoffId).toBe(
			posts[1].completedActionHandoffId,
		);
		expect(first.data).toEqual(second.data);
		expect(first.data).toMatchObject({
			navigation: { status: "delivered", stepId: "step-1" },
		});
	});
});

const shellModes = [
	"manager",
	"window",
	"pin",
	"close",
	"split",
	"tile",
] as const;
const actionRuntime = { agentId: "agent-1" } as unknown as IAgentRuntime;
function shellAction(mode: string) {
	return createViewsAction().handler(actionRuntime, message, undefined, {
		...options,
		action: mode,
		views: ["calendar", "notes"],
		viewType: "gui",
	});
}
describe("dispatcher-wide navigation effect constraints", () => {
	for (const mode of shellModes) {
		it(`blocks ${mode} under trusted denial without a transport effect`, async () => {
			const result = await turn(() => shellAction(mode), "deny");
			expect(posts).toEqual([]);
			expect(result).toMatchObject({
				success: false,
				data: { navigation: { status: "forbidden", stepId: "step-1" } },
			});
		});
		it(`blocks ${mode} after canonical cancellation`, async () => {
			const result = await turn(() => {
				controller.abort("superseded");
				return shellAction(mode);
			});
			expect(posts).toEqual([]);
			expect(result).toMatchObject({
				success: false,
				data: { navigation: { status: "cancelled", stepId: "step-1" } },
			});
		});
	}
	for (const mode of ["window", "pin", "close", "split", "tile"]) {
		it(`cannot dispatch ${mode} when cancellation arrives during catalog resolution`, async () => {
			cancelCatalog = true;
			const result = await turn(() => shellAction(mode));
			expect(posts).toEqual([]);
			expect(result).toMatchObject({
				success: false,
				data: { navigation: { status: "cancelled" } },
			});
		});
	}
	it("keeps catalog reads available when navigation is forbidden", async () => {
		const result = await turn(() => shellAction("list"), "deny");
		expect(result).toMatchObject({ success: true });
		expect(posts).toEqual([]);
	});
});

for (const alias of ["CLOSE_VIEW", "CLOSE_ALL_VIEWS"] as const) {
	it(`cannot bypass navigation denial through ${alias}`, async () => {
		const result = await turn(
			() =>
				createViewsAliasAction(alias).handler(
					actionRuntime,
					message,
					undefined,
					options,
				),
			"deny",
		);
		expect(posts).toEqual([]);
		expect(result).toMatchObject({
			success: false,
			data: { navigation: { status: "forbidden" } },
		});
	});
}

it("keeps an undelivered HTTP navigation in the planner's failure path", async () => {
	const { runPlannerLoop, TURN_SCOPE_ARG, TURN_SCOPE_FINAL } = await import(
		"../../../../packages/core/src/runtime/planner-loop"
	);
	reply = "false";
	let evaluations = 0;
	let modelCalls = 0;
	const result = await turn(() =>
		runPlannerLoop({
			runtime: {
				useModel: async () => {
					modelCalls++;
					return modelCalls === 1
						? {
								text: "",
								toolCalls: [
									{
										id: "navigate",
										name: "VIEWS",
										arguments: {
											...options,
											action: "show",
											[TURN_SCOPE_ARG]: TURN_SCOPE_FINAL,
										},
									},
								],
							}
						: { text: "Calendar is open.", toolCalls: [] };
				},
			},
			context: { id: "undelivered-navigation" },
			tools: [
				{ name: "VIEWS", description: "Navigate to the requested surface." },
			],
			executeToolCall: async () => show(),
			evaluate: async () => {
				evaluations++;
				return {
					success: false,
					decision: "FINISH",
					thought: "The originating client did not receive the navigation.",
					messageToUser:
						"I could not open Calendar because the originating client did not receive the navigation.",
				};
			},
		}),
	);
	expect(posts).toHaveLength(1);
	expect(evaluations).toBe(1);
	expect(result.finalMessage).not.toBe("Calendar is open.");
	expect(result.finalMessage).toContain("could not open Calendar");
});
