/**
 * Deterministic transport gate for same-turn view planning: a turn that arrived
 * over a programmatic API transport (REST message API, OpenAI/Anthropic-compat)
 * gets neither a catalog listing nor a model call, while a renderer-authored
 * dashboard turn keeps the full evaluator path. Runs through the real
 * response-handler patch runner and a TCP catalog boundary, like the
 * neighbouring view-context-planning tests.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type Memory,
	type ResponseHandlerEvaluatorContext,
	runResponseHandlerEvaluators,
	runWithStreamingContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	messageArrivedOverProgrammaticTransport,
	viewContextPlanningEvaluator,
} from "./view-context-planning.js";

let server: Server;
let requestedPaths: string[];
let originalPort: string | undefined;
let prompts: string[];
const views = [
	{
		id: "calendar",
		label: "Calendar",
		description: "Plan the week",
		pluginName: "calendar",
		available: true,
	},
];

beforeEach(async () => {
	requestedPaths = [];
	prompts = [];
	originalPort = process.env.ELIZA_API_PORT;
	server = createServer((req, res) => {
		requestedPaths.push(req.url ?? "");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ views }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.ELIZA_API_PORT = String((server.address() as AddressInfo).port);
});
afterEach(async () => {
	if (originalPort === undefined) delete process.env.ELIZA_API_PORT;
	else process.env.ELIZA_API_PORT = originalPort;
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
});

function context(
	content: Record<string, unknown>,
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			actions: [{ name: "VIEWS" }],
			reportError: () => undefined,
			useModel: async (_type: string, request: { prompt: string }) => {
				prompts.push(request.prompt);
				return JSON.stringify({
					disposition: "requested",
					viewId: "calendar",
					reason: "explicit",
				});
			},
			logger: { error() {}, warn() {} },
		},
		message: {
			id: "turn-1",
			roomId: "room-1",
			entityId: "actor-1",
			content,
		},
		state: { values: {}, data: {}, text: "" },
		messageHandler: {
			processMessage: "RESPOND",
			plan: {
				contexts: ["general"],
				candidateActions: ["CALENDAR"],
				parentActionHints: ["CALENDAR"],
				reply: "premature response",
			},
		},
		availableContexts: [],
		userRoles: ["USER"],
	} as unknown as ResponseHandlerEvaluatorContext;
}
async function run(ctx: ResponseHandlerEvaluatorContext) {
	return runWithStreamingContext({ messageId: ctx.message.id }, () =>
		runResponseHandlerEvaluators({
			...ctx,
			evaluators: [viewContextPlanningEvaluator],
		}),
	);
}

describe("view planning transport gate", () => {
	for (const source of [
		"agent_message_api",
		"compat_openai",
		"compat_anthropic",
	]) {
		it(`skips the catalog listing and the model call for ${source}`, async () => {
			// Live 2026-09-13: 149 REST-API turns each paid a catalog listing plus a
			// TEXT_SMALL call for a navigation the curl caller could never see.
			const ctx = context({
				text: "open my calendar",
				source,
				channelType: "API",
			});
			const result = await run(ctx);
			expect(prompts).toEqual([]);
			expect(requestedPaths).toEqual([]);
			expect(result.errors).toEqual([]);
			expect(result.appliedPatches).toEqual([]);
			expect(ctx.messageHandler.plan.candidateActions).toEqual(["CALENDAR"]);
			expect(ctx.messageHandler.plan.reply).toBe("premature response");
		});
	}

	it("keeps the full path for a renderer-authored dashboard turn", async () => {
		const ctx = context({
			text: "open my calendar",
			source: "client_chat",
			metadata: { uiView: "chat", uiViewPath: "/" },
		});
		const result = await run(ctx);
		expect(prompts).toHaveLength(1);
		expect(requestedPaths).toEqual(["/api/views"]);
		expect(result.errors).toEqual([]);
		expect(ctx.messageHandler.plan.candidateActions).toEqual([
			"CALENDAR",
			"VIEWS",
		]);
		expect(ctx.messageHandler.plan.reply).toBeUndefined();
	});

	it("keeps the full path for a turn with no source at all", async () => {
		const ctx = context({ text: "open my calendar" });
		const result = await run(ctx);
		expect(prompts).toHaveLength(1);
		expect(result.errors).toEqual([]);
	});

	it("fails open for unknown sources and matches known ones case-insensitively", () => {
		const message = (content: Record<string, unknown>): Memory =>
			({ content }) as unknown as Memory;
		expect(messageArrivedOverProgrammaticTransport(message({}))).toBe(false);
		expect(
			messageArrivedOverProgrammaticTransport(
				message({ source: "custom_platform" }),
			),
		).toBe(false);
		expect(
			messageArrivedOverProgrammaticTransport(
				message({ source: "Agent_Message_API" }),
			),
		).toBe(true);
	});
});
