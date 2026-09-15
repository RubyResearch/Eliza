/**
 * Exercises the evaluator stage: parseEvaluatorOutput's JSON/prose recovery and
 * runEvaluator's FINISH/CONTINUE decisions, messageToUser sanitization, and the
 * injected clipboard/message effects. Deterministic — runtime.useModel returns
 * canned strings, no live model or DB.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaError } from "../../errors";
import { evaluatorSchema, evaluatorTemplate } from "../../prompts/evaluator";
import {
	type ChatMessage,
	ModelType,
	type PromptSegment,
} from "../../types/model";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";
import type { RecordedStage, TrajectoryRecorder } from "../trajectory-recorder";

describe("v5 evaluator skeleton", () => {
	it("keeps receipt selection compatible with provider structured-output schemas", () => {
		// Cerebras rejected uniqueItems in the live post-tool evaluator request.
		// The parser below, not provider-specific grammar, validates these IDs.
		const receiptSchema = evaluatorSchema.properties?.effectReceiptIds;
		expect(receiptSchema).toMatchObject({
			type: "array",
			items: { type: "string" },
		});
		expect(receiptSchema).not.toHaveProperty("uniqueItems");
		expect(receiptSchema).not.toHaveProperty("items.minLength");
	});

	it.each([
		"note-proof",
		[42],
		[""],
		["  "],
		["note-proof", "note-proof"],
		null,
	])("rejects malformed effect receipt selection: %j", (effectReceiptIds) => {
		const output = parseEvaluatorOutput(
			JSON.stringify({
				thought: "The note write succeeded.",
				success: true,
				decision: "FINISH",
				messageToUser: "I've created the picnic note.",
				effectReceiptIds,
			}),
		);
		expect(output.protocolFailure).toBe(true);
		expect(output.decision).toBe("CONTINUE");
		expect(output.effectReceiptIds).toBeUndefined();
	});

	it("keeps synthesized replies human-readable unless raw output was requested", () => {
		expect(evaluatorTemplate).toContain(
			"natural conversation, not a database or debug log",
		);
		expect(evaluatorTemplate).toContain(
			"Translate machine dates, 24-hour times, and Unix/epoch timestamps into familiar dates and times",
		);
		expect(evaluatorTemplate).toContain(
			"unless the user explicitly asks for raw or technical output",
		);
	});

	it("keeps grounded multi-call plans eligible without treating pending effects as success", () => {
		expect(evaluatorTemplate).not.toContain("exactly one queued grounded tool");
		expect(evaluatorTemplate).toContain(
			"even when multiple queued tools remain",
		);
		expect(evaluatorTemplate).toContain(
			"preserve the planned order and prerequisites",
		);
		expect(evaluatorTemplate).toContain("remaining plan is missing, stale");
		expect(evaluatorTemplate).toContain(
			"do not imagine the result or declare success before it executes",
		);
	});

	it("allows structured chat markers while still banning arbitrary JSON/tool attempts", () => {
		expect(evaluatorTemplate).toContain("arbitrary JSON/tool attempts");
		expect(evaluatorTemplate).toContain(
			"Structured chat markers are allowed in messageToUser",
		);
		expect(evaluatorTemplate).toContain("[FORM]\\n{json}\\n[/FORM]");
		expect(evaluatorTemplate).toContain("The JSON inside [FORM] is form data");
	});

	it("teaches the model to omit post-tool process-status bubbles and keep outcomes task-grounded", () => {
		// Contract for dual-bubble / canned-ack bugs: after verifiedUserFacing
		// tool text, the evaluator must not invent a second process-status
		// message; when messageToUser is set it must be grounded in THIS
		// request's outcome, not a fixed phrase list enforced by runtime regex.
		expect(evaluatorTemplate).toContain("verifiedUserFacing=true");
		expect(evaluatorTemplate).toContain(
			"omit messageToUser entirely unless you add NEW task-grounded substance",
		);
		expect(evaluatorTemplate).toContain("ground it in THIS request's outcome");
		expect(evaluatorTemplate).toContain(
			"Do not rely on a fixed canned phrase list",
		);
	});

	it("normalizes evaluator routes and next tool recommendations", () => {
		const output = parseEvaluatorOutput(`{
  "success": true,
  "thought": "Need one more lookup.",
  "decision": "NEXT_RECOMMENDED",
  "nextTool": {
    "name": "LOOKUP",
    "args": { "id": 123 }
  }
}`);

		expect(output.decision).toBe("NEXT_RECOMMENDED");
		expect(output.nextTool).toEqual({
			name: "LOOKUP",
			params: { id: 123 },
		});
	});

	it("rejects evaluator text that contains multiple JSON objects", () => {
		const output = parseEvaluatorOutput(`{
  "action": "OPEN_URL",
  "url": "https://example.test"
}{
  "success": false,
  "decision": "CONTINUE",
  "thought": "Need one more grounded tool result."
}`);

		expect(output.success).toBe(false);
		expect(output.decision).toBe("CONTINUE");
		expect(output.parseError).toBe("response is not a single JSON object");
		expect(output.thought).toContain("Invalid evaluator output");
	});

	it("preserves a form interaction marker with a JSON body in messageToUser", () => {
		const form =
			'[FORM]\n{"title":"Connect Discord","fields":[{"name":"token","type":"secret"}]}\n[/FORM]';
		const output = parseEvaluatorOutput(
			JSON.stringify({
				success: false,
				decision: "FINISH",
				thought: "Need user input.",
				messageToUser: form,
			}),
		);

		expect(output.messageToUser).toBe(form);
		expect(output.decision).toBe("FINISH");
	});

	it("does not salvage claimed success from malformed evaluator text", () => {
		const output = parseEvaluatorOutput(`{
  "content": "pretend document body"
}{
  "success": true,
  "decision": "FINISH",
  "thought": "Saved the document."
}`);

		expect(output.success).toBe(false);
		expect(output.decision).toBe("CONTINUE");
		expect(output.parseError).toBe("response is not a single JSON object");
	});

	it("parses evaluator-labeled text without recording a schema failure", () => {
		const output = parseEvaluatorOutput(`Success: true
Decision: FINISH
Thought: The tool result satisfies the request.

\`\`\`bash
df -h / /home
\`\`\`

**Result**
- / has 165G available.`);

		expect(output.success).toBe(true);
		expect(output.decision).toBe("FINISH");
		expect(output.parseError).toBeUndefined();
		expect(output.thought).toBe("Recovered evaluator-labeled final answer.");
		expect(output.messageToUser).toContain("df -h / /home");
		expect(output.messageToUser).toContain("165G available");
	});

	it("applies message and clipboard effects through injected callbacks", async () => {
		const copyToClipboard = vi.fn();
		const messageToUser = vi.fn();
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "thought": "Complete.",
  "decision": "FINISH",
  "messageToUser": "Sent.",
  "copyToClipboard": {
    "title": "Artifact",
    "content": "artifact",
    "tags": ["test"]
  }
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [
					{
						id: "provider:RECENT_MESSAGES",
						type: "provider",
						name: "RECENT_MESSAGES",
						text: "Recent: user asked for status.",
					},
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: { text: "Check status." },
						},
					},
				],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
			effects: { copyToClipboard, messageToUser },
		});

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.RESPONSE_HANDLER,
			expect.objectContaining({ messages: expect.any(Array) }),
			undefined,
		);
		const evaluatorParams = runtime.useModel.mock.calls[0][1];
		// Wire-shape contract: evaluator emits ONLY `messages`.
		expect(evaluatorParams.prompt).toBeUndefined();
		expect(evaluatorParams.maxTokens).toBeUndefined();
		expect(evaluatorParams.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(evaluatorParams.messages[0].content).toContain("evaluator_stage:");
		expect(evaluatorParams.messages[0].content).toContain("agent_name: Eliza");
		// Provider events render as `provider:NAME:\n<text>` (label + content);
		// the label must not also be duplicated into the body.
		expect(evaluatorParams.messages[1].content).toContain(
			"provider:RECENT_MESSAGES:",
		);
		expect(evaluatorParams.messages[1].content).toContain("Check status.");
		expect(evaluatorParams.messages[1].content).not.toMatch(
			/provider:RECENT_MESSAGES:\nprovider: RECENT_MESSAGES/,
		);
		// Trajectory steps are conveyed as assistant/tool message pairs, NOT as a
		// JSON dump in the user message.
		expect(evaluatorParams.messages[1].content).not.toMatch(/^trajectory:\n\[/);
		expect(
			evaluatorParams.providerOptions.eliza.modelInputBudget,
		).toMatchObject({
			reserveTokens: 10_000,
			shouldReject: false,
		});
		expect(evaluatorParams.providerOptions.eliza.thinking).toBe("off");
		expect(result.decision).toBe("FINISH");
		expect(copyToClipboard).toHaveBeenCalledWith({
			title: "Artifact",
			content: "artifact",
			tags: ["test"],
		});
		expect(messageToUser).toHaveBeenCalledWith("Sent.");
	});

	it("rejects a missing success field even when FINISH follows a successful tool result", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "route": "FINISH",
  "thought": "The tool result satisfies the request.",
  "messageToUser": "Done."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: {
							id: "tool-1",
							name: "LOOKUP",
							params: { q: "eliza" },
						},
						result: {
							success: true,
							text: "Found results.",
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.decision).toBe("CONTINUE");
		expect(result.success).toBe(false);
		expect(result.protocolFailure).toBe(true);
		expect(result.messageToUser).toBeUndefined();
	});

	it("promotes safe final thoughts to messageToUser with requested command echo", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "The root filesystem is 58% used with 165G available."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: {
						content: "agent_name: Eliza",
						stable: true,
					},
				},
				events: [
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: {
								text: "Run the disk check and include the exact command you ran.",
							},
						},
					},
				],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: {
							id: "tool-1",
							name: "SHELL",
							params: { command: "df -h / /home" },
						},
						result: {
							success: true,
							text: "Filesystem 58%",
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("Command run: `df -h / /home`");
		expect(result.messageToUser).toContain("165G available");
	});

	it("does not finish a successful tool turn with internal evaluator narration", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Fetched current Bitcoin price (USD) from CoinGecko API and provided it to the user."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [
					{
						id: "msg",
						type: "message",
						message: {
							role: "user",
							content: { text: "what is btc at rn?" },
						},
					},
				],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: {
							id: "tool-1",
							name: "SHELL",
							params: {
								command:
									"curl -s 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'",
							},
						},
						result: {
							success: true,
							text: '{"bitcoin":{"usd":80565}}',
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(false);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
		expect(result.thought).toContain("without a user-facing message");
	});

	it("recovers evaluator tool-attempt text as CONTINUE without parse failure", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					`{"action":"run","command":"df -h /","description":"Check disk","timeout":120000}\nNeed one more shell command before answering.`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "Filesystem 50%" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(false);
		expect(result.decision).toBe("CONTINUE");
		expect(result.parseError).toBeUndefined();
		expect(result.thought).toContain("tool/action syntax");
	});

	it("recovers clean evaluator prose as FINISH after a successful tool result", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					"Root is 58% used with 165 GB free. No deletions were performed.",
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "Filesystem 58%" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.parseError).toBeUndefined();
		expect(result.messageToUser).toBe(
			"Root is 58% used with 165 GB free. No deletions were performed.",
		);
	});

	it("verified tool text overrides recovered prose — committed state is authoritative (F30)", async () => {
		// Live fabrication (tj-e9bdfb8015bc11): OWNER_REMINDERS_REVIEW returned
		// verified "water the ficus at 10am. then again at 5pm." and the
		// unparseable evaluator prose invented conversation-history items
		// ("your 20 pushups and the sandpaper run"). The verified
		// do-not-paraphrase text must ship, not the prose.
		const runtime = {
			useModel: vi.fn(
				async () =>
					"your 20 pushups and the sandpaper run. you've got the dentist in two days.",
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: {
							id: "tool-1",
							name: "OWNER_REMINDERS_REVIEW",
							params: {},
						},
						result: {
							success: true,
							text: "water the ficus at 10am. then again at 5pm.",
							userFacingText: "water the ficus at 10am. then again at 5pm.",
							verifiedUserFacing: true,
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe(
			"water the ficus at 10am. then again at 5pm.",
		);
		expect(result.messageToUser).not.toContain("pushups");
	});

	it("keeps prose recovery for tools without a verified-text claim", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => "The search found three articles about ficus care.",
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "WEB_SEARCH", params: {} },
						result: { success: true, text: "3 results" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe(
			"The search found three articles about ficus care.",
		);
	});

	it("strips a trailing evaluator JSON envelope from recovered prose", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					'Root is 58% used with 165 GB free.\n{"success":true,"decision":"FINISH","thought":"Done with {quoted} braces."}',
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "Filesystem 58%" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe("Root is 58% used with 165 GB free.");
	});

	it("preserves user-facing trailing JSON that is not an evaluator envelope", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => 'Here is the JSON you asked for:\n{"success":true}',
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "JSON requested" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe(
			'Here is the JSON you asked for:\n{"success":true}',
		);
	});

	it("recovers search-result prose that is already user-facing", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					"Search results: Bitcoin is trading at $105,000 USD from the market-data API.",
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: '{"bitcoin":{"usd":105000}}' },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("Bitcoin is trading");
	});

	it("does not recover evaluator work-planning notes as a user message", async () => {
		const runtime = {
			useModel: vi.fn(
				async () =>
					'We need to locate OpenCode vendored endpoint detection change. Search for "OpenCode" and maybe "endpoint detection".Let\'s grep for "OpenCode" again but focusing on directory where detection could be. Search for "endpoint detection".Use grep.Search for "opencode" case-insensitive.\n- **Standard parsing** - Using `new URL(...).hostname` relies on the built-in URL parser.\n- **Avoids regex pitfalls** - Hand-rolled regular expressions often miss valid forms.',
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: {
							success: true,
							text: "plugins/plugin-agent-orchestrator/vendor/opencode/packages/opencode/src/provider/provider.ts",
						},
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(false);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
		expect(result.thought).toContain("Invalid evaluator output");
	});

	it("recovers clean evaluator prose with command fences after a successful tool result", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `The command executed was:

\`\`\`
df -h / /home
\`\`\`

Result: / and /home are on /dev/sda1, 387G total, 223G used, 165G free, 58% used.`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "Filesystem 58%" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.decision).toBe("FINISH");
		expect(result.parseError).toBeUndefined();
		expect(result.messageToUser).toContain("df -h / /home");
		expect(result.messageToUser).toContain("165G free");
	});

	it.each(["", " (session: pty-1778500471501-4cf0e3a6)"])(
		"preserves literal reply whitespace while removing only an internal annotation: %s",
		async (annotation) => {
			// The mixed preview/count live result kept both spaces on the wire,
			// but evaluator cleanup collapsed them before client delivery.
			const literal =
				'Row 1: {"mode":"read-only"}.\nRow 2: keep  two spaces; don\'t normalize—OK!\n\tindented  text  \n : literal punctuation\n';
			const expected = `Preview only:\n\n${literal}\nEnd of preview.`;
			const result = await runEvaluator({
				runtime: {
					useModel: vi.fn(async () =>
						JSON.stringify({
							thought: "Only the supplied literal preview is requested.",
							success: true,
							decision: "FINISH",
							messageToUser: `Preview only:\n\n${literal}\nEnd of preview${annotation}.`,
						}),
					),
				},
				context: { id: "literal-preview", events: [] },
				trajectory: {
					context: { id: "literal-preview" },
					steps: [],
					archivedSteps: [],
					plannedQueue: [],
					evaluatorOutputs: [],
				},
			});
			expect(result.decision).toBe("FINISH");
			expect(result.messageToUser).toBe(expected);
		},
	);

	it("strips internal task-agent session-ids and auto-generated labels from messageToUser", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Both agents spawned.",
  "messageToUser": "Both agents spawned in parallel (count-py-files-projects-1 and count-ts-files-iqlabs-1). I'll reply with both numbers when they finish."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).not.toContain("count-py-files-projects-1");
		expect(result.messageToUser).not.toContain("count-ts-files-iqlabs-1");
		expect(result.messageToUser).toContain("Both agents spawned in parallel.");
		expect(result.messageToUser).toContain("when they finish");
	});

	it("strips bare PTY session ids and (session: pty-...) parentheticals", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Spawned.",
  "messageToUser": "on it — task agent is running (session: pty-1778500471501-4cf0e3a6). it'll write /tmp/x.py and verify."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).not.toMatch(/pty-\d+-[A-Za-z0-9]+/);
		expect(result.messageToUser).not.toMatch(/\(session/);
		expect(result.messageToUser).toContain("/tmp/x.py");
	});

	it("leaves messageToUser unchanged when no mechanics are mentioned", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "success": true,
  "decision": "FINISH",
  "thought": "Got it.",
  "messageToUser": "190G free on / (387G total, 198G used, 52% used)."
}`,
			),
		};

		const result = await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});

		expect(result.messageToUser).toBe(
			"190G free on / (387G total, 198G used, 52% used).",
		);
	});
});

describe("envelope-then-prose repair (leading fenced verdict + answer)", () => {
	it("takes the fenced envelope as the verdict and the prose as messageToUser", () => {
		const raw = [
			"```json",
			"{",
			'  "success": true,',
			'  "decision": "FINISH",',
			'  "thought": "Retrieved the commit info."',
			"}",
			"```",
			"",
			"Last commit:",
			"SHA: 2e240df0a1ecab779ccca5e17eecd4bc532f1d25",
		].join("\n");
		const parsed = parseEvaluatorOutput(raw);
		expect(parsed.decision).toBe("FINISH");
		expect(parsed.success).toBe(true);
		expect(parsed.messageToUser).toContain("Last commit:");
		// The raw envelope must never reach the user-facing message.
		expect(parsed.messageToUser).not.toContain("```json");
		expect(parsed.messageToUser).not.toContain('"decision"');
	});

	it("keeps an explicit messageToUser from the envelope over trailing prose", () => {
		const raw = [
			"```json",
			'{ "success": true, "decision": "FINISH", "thought": "Done.", "messageToUser": "The answer is 42." }',
			"```",
			"stray trailing text",
		].join("\n");
		const parsed = parseEvaluatorOutput(raw);
		expect(parsed.messageToUser).toBe("The answer is 42.");
	});

	it("reports invalid when the trailing prose is XML tool syntax", () => {
		const raw = [
			"```json",
			'{ "success": true, "decision": "FINISH", "thought": "done" }',
			"```",
			"<tool_call>",
			"<arg_key>location</arg_key>",
			"<arg_value>Tokyo</arg_value>",
			"</tool_call>",
		].join("\n");
		const parsed = parseEvaluatorOutput(raw);
		// The model was trying to act, not answer: the response is invalid and
		// the loop replans — the tool syntax never becomes the user message and
		// the turn never ends on a silent no-message FINISH.
		expect(parsed.parseError).toBeDefined();
		expect(parsed.decision).toBe("CONTINUE");
		expect(parsed.messageToUser).toBeUndefined();
	});

	it("reports invalid when the trailing prose is a bare action name + JSON args", () => {
		const raw = [
			"```json",
			'{ "success": true, "decision": "FINISH", "thought": "done" }',
			"```",
			"GET_WEATHER",
			'{ "location": "Tokyo" }',
		].join("\n");
		const parsed = parseEvaluatorOutput(raw);
		expect(parsed.parseError).toBeDefined();
		expect(parsed.decision).toBe("CONTINUE");
		expect(parsed.messageToUser).toBeUndefined();
	});
});

describe("structured evaluator output shape gate", () => {
	it("rejects a structured object with no verdict fields as a parse error", () => {
		const parsed = parseEvaluatorOutput({
			object: { command: "curl https://example.com" },
		});
		expect(parsed.parseError).toContain("not evaluator-shaped");
		expect(parsed.decision).toBe("CONTINUE");
		expect(parsed.success).toBe(false);
	});

	it("accepts a structured object that carries a verdict field", () => {
		const parsed = parseEvaluatorOutput({
			object: {
				success: true,
				decision: "FINISH",
				thought: "Done.",
				messageToUser: "Done.",
			},
		});
		expect(parsed.parseError).toBeUndefined();
		expect(parsed.decision).toBe("FINISH");
		expect(parsed.messageToUser).toBe("Done.");
	});
});

describe("native tool dialects never recover as the user-facing answer", () => {
	async function runWithModelText(text: string) {
		const runtime = { useModel: vi.fn(async () => text) };
		return await runEvaluator({
			runtime,
			context: {
				id: "ctx",
				staticPrefix: {
					characterPrompt: { content: "agent_name: Eliza", stable: true },
				},
				events: [],
			},
			trajectory: {
				context: { id: "ctx" },
				steps: [
					{
						toolCall: { id: "tool-1", name: "SHELL", params: {} },
						result: { success: true, text: "tool ran" },
					},
				],
				archivedSteps: [],
				plannedQueue: [],
				evaluatorOutputs: [],
			},
		});
	}

	it("does not deliver standalone XML tool syntax", async () => {
		const result = await runWithModelText(
			"<tool_call>\n<arg_key>location</arg_key>\n<arg_value>Tokyo</arg_value>\n</tool_call>",
		);
		expect(result.messageToUser ?? "").not.toContain("tool_call");
		expect(result.messageToUser ?? "").not.toContain("arg_key");
	});

	it("does not launder pseudo-tag tool markup into a fabricated effect claim (matrix F38, tj-9129a432454364)", async () => {
		// Live stage-7 shape: prose claiming the effect beside an UNEXECUTED
		// `<NOTES_CREATE>{…}</NOTES_CREATE>` invocation. Recovering the prose
		// would ship "saving note." while no note exists — the strip-and-send
		// launder. The turn must stay on the replanning path instead.
		const result = await runWithModelText(
			'temp is 35°C. saving note.\n\n<NOTES_CREATE>\n{"title": "b50 paris wx", "content": "Paris temperature: 35°C"}\n</NOTES_CREATE>',
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser ?? "").toBe("");
	});

	it("still recovers prose that merely quotes a short acronym tag", async () => {
		const result = await runWithModelText(
			"the <AI> tag in that template is just a label, not markup you need to escape.",
		);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser ?? "").toContain("<AI>");
	});

	it("does not deliver a standalone bare action name + JSON args block", async () => {
		const result = await runWithModelText(
			'GET_WEATHER\n{ "location": "Tokyo" }',
		);
		expect(result.messageToUser ?? "").not.toContain("GET_WEATHER");
		expect(result.messageToUser ?? "").not.toContain("location");
	});

	it("does not deliver a call:NAME{...} invocation with non-JSON args (live 2026-07-16 leak)", async () => {
		// gemma emitted this exact dialect as its whole reply — unquoted keys, so
		// the JSON-object screen can never see it. It shipped to Discord verbatim,
		// four turns in a row.
		const result = await runWithModelText(
			"call:WEB_SEARCH{numResults:6,query:best restaurants near 25 Nassau Ave Brooklyn NY 11222}",
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser ?? "").toBe("");
	});

	it("does not deliver a namespaced workflow invocation as the chat reply", async () => {
		// Action results and evaluator prose are persisted independently, so the
		// evaluator must not place machine invocation text beside a valid result.
		const result = await runWithModelText(
			'call:automation:GET_WORKFLOW{workflowId: "8914e389-8cda-401e-aac0-a501286a8130"}',
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser ?? "").toBe("");
	});

	it("rejects the same workflow invocation inside a structured evaluator verdict", async () => {
		const result = await runWithModelText(
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "The workflow action completed.",
				messageToUser:
					'call:automation:GET_WORKFLOW{workflowId: "8914e389-8cda-401e-aac0-a501286a8130"}',
			}),
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
	});

	it("does not deliver a mid-text invocation of a tool the trajectory carries", async () => {
		const result = await runWithModelText(
			"Let me check that again. SHELL{cmd: df -h}",
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser ?? "").toBe("");
	});

	it("still recovers genuine prose after a successful tool result", async () => {
		const result = await runWithModelText(
			"You have 165G available on / and plenty of headroom on /home.",
		);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("165G available");
	});

	it("still recovers prose that merely MENTIONS a trajectory tool without invoking it", async () => {
		const result = await runWithModelText(
			"I used SHELL to check the disk — you have 165G free, so no cleanup needed.",
		);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("165G free");
	});
});

describe("malformed envelope recovery (#18240 class — the 2026-08-10 leak)", () => {
	const harness = (raw: string) => ({
		runtime: { useModel: vi.fn(async () => raw) },
		context: {
			id: "ctx",
			staticPrefix: {
				characterPrompt: { content: "agent_name: Eliza", stable: true },
			},
			events: [],
		},
		trajectory: {
			context: { id: "ctx" },
			steps: [
				{
					kind: "tool",
					tool: { name: "WEB_SEARCH" },
					result: { success: true, text: "search results" },
				},
			],
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
		},
	});

	// The live incident shape: gemma double-escaped the quotes inside
	// messageToUser (\\" instead of \"), so the literal backslash terminates
	// the JSON string early and strict parsing rejects the whole envelope.
	const overEscaped = [
		"```json",
		"{",
		' "success": true,',
		' "decision": "FINISH",',
		' "thought": "Verified the protocol claims against the search results.",',
		' "messageToUser": "here is the reality check:\\\\n\\\\nit isn\'t a legal firm—it doesn\'t \\\\"support\\\\" a filing because that is a structure you establish independently."',
		"}",
		"```",
	].join("\n");

	it("salvages an over-escaped envelope and delivers the trapped answer", async () => {
		const result = await runEvaluator(harness(overEscaped));
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("reality check");
		expect(result.messageToUser).toContain('"support"');
		// No machinery may ship.
		expect(result.messageToUser).not.toContain("```");
		expect(result.messageToUser).not.toContain('"decision"');
		expect(result.messageToUser).not.toContain("\\n");
	});

	it("replans instead of shipping an envelope that stays unparseable after salvage", async () => {
		// Truncated mid-string: no escape repair can make this parse.
		const mangled = [
			"```json",
			'{ "success": true, "decision": "FINISH", "thought": "done", "messageToUser": "the answer is',
		].join("\n");
		const result = await runEvaluator(harness(mangled));
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
	});

	it("still recovers plain prose after a successful tool (existing path untouched)", async () => {
		const result = await runEvaluator(
			harness("the repo has 42 open issues, mostly about connectors."),
		);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("42 open issues");
	});

	it("prefers a terminal envelope answer over debris wrapped around it", async () => {
		const raw = `None${JSON.stringify({
			success: false,
			decision: "FINISH",
			thought: "The search window did not reach the requested day.",
			messageToUser:
				"I couldn't reach yesterday's messages in the available search window.",
		})}`;
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("available search window");
		expect(result.messageToUser).not.toBe("None");
	});

	it("does not promote a debris-wrapped CONTINUE envelope to FINISH", async () => {
		const raw = `None${JSON.stringify({
			success: false,
			decision: "CONTINUE",
			thought: "Another search is required.",
			messageToUser: "I need to search again.",
		})}`;
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("CONTINUE");
		expect(result.success).toBe(false);
		expect(result.messageToUser).toBeUndefined();
	});

	it("preserves a CONTINUE decision after a natural-language preamble instead of finishing on the preamble", async () => {
		const raw = `The first operation completed, but another requested action remains.\n\n${JSON.stringify(
			{
				thought:
					"The note changed, but the requested navigation is still pending.",
				success: false,
				decision: "CONTINUE",
			},
		)}`;
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("CONTINUE");
		expect(result.success).toBe(false);
		expect(result.thought).toContain("navigation is still pending");
		expect(result.messageToUser).toBeUndefined();
	});

	it("does not equate structured outcome count with required tool-call count", async () => {
		const params = harness(
			JSON.stringify({
				thought:
					"The body was updated and its title preserved by the same operation.",
				success: true,
				decision: "FINISH",
				messageToUser: "Your note is updated.",
			}),
		);
		const result = await runEvaluator({
			...params,
			context: {
				...params.context,
				events: [
					{
						id: "routing",
						type: "message_handler",
						metadata: {
							plan: { intents: ["update note body", "preserve title"] },
						},
					},
				],
			},
			trajectory: {
				...params.trajectory,
				steps: [
					{
						iteration: 0,
						toolCall: { name: "NOTES", params: { action: "update" } },
						result: { success: true, text: "Note updated." },
					},
				],
			},
		});
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe("Your note is updated.");
	});

	it("replans (not a protocol failure) on prose plus a trailing fenced non-terminal envelope with unlicensed fields", async () => {
		// Live 2026-09-05 (tj-103a1bfb93f2e1): after a successful calendar lookup
		// the model wrote prose, then a fenced NEXT_RECOMMENDED envelope carrying
		// invented `nextTool`/`nextParams`; the protocol failure relayed the
		// lookup text as the final answer and the requested delete never ran.
		const raw = [
			"There are two Gym session entries on Tuesday. I will delete the 7 AM event.",
			"```json",
			JSON.stringify({
				thought: "Delete the confirmed 7 AM event next.",
				success: true,
				decision: "NEXT_RECOMMENDED",
				nextTool: "CALENDAR_DELETE_EVENT",
				nextParams: { event_id: "event-96120c00" },
			}),
			"```",
		].join("\n");
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("CONTINUE");
		expect(result.success).toBe(false);
		expect(result.protocolFailure).toBeUndefined();
		expect(result.messageToUser).toBeUndefined();
		expect(
			(result.raw as { recoverySource?: string } | undefined)?.recoverySource,
		).toBe("unlicensed_envelope_nonterminal");
	});

	it("recovers a valid FINISH verdict from a trailing fenced envelope after prose", async () => {
		const raw = [
			"Checked the search results.",
			"```json",
			JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "The answer is grounded in the search results.",
				messageToUser: "The repo has 42 open issues, mostly about connectors.",
			}),
			"```",
		].join("\n");
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe(
			"The repo has 42 open issues, mostly about connectors.",
		);
		expect(
			(result.raw as { recoverySource?: string } | undefined)?.recoverySource,
		).toBe("trailing_evaluator_envelope");
	});

	it("replans instead of shipping debris when a terminal envelope has no answer", async () => {
		const raw = `None${JSON.stringify({
			success: false,
			decision: "FINISH",
			thought: "No answer was produced.",
			messageToUser: "",
		})}`;
		const result = await runEvaluator(harness(raw));
		expect(result.decision).toBe("CONTINUE");
		expect(result.success).toBe(false);
		expect(result.messageToUser).toBeUndefined();
	});

	it("does not classify a user-asked-for JSON payload as a malformed envelope", async () => {
		// A JSON payload without the envelope discriminator keys must not be
		// captured by the malformed-envelope branch; it keeps the pre-existing
		// parse-failure replan behavior (and still never ships as machinery).
		const result = await runEvaluator(
			harness('```json\n{ "name": "color-pop", "hue": 210 }\n```'),
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
		expect(
			(result.raw as { recoverySource?: string } | undefined)?.recoverySource,
		).not.toBe("malformed_envelope_text");
	});
});

describe("FINISH with a progress-promise message coerces to CONTINUE", () => {
	const makeParams = (evaluatorJson: string) => ({
		runtime: { useModel: vi.fn(async () => evaluatorJson) },
		context: {
			id: "ctx",
			staticPrefix: {
				characterPrompt: { content: "agent_name: Eliza", stable: true },
			},
			events: [
				{
					id: "msg",
					type: "message" as const,
					message: {
						role: "user" as const,
						content: { text: "find the best keyboard" },
					},
				},
			],
		},
		trajectory: {
			context: { id: "ctx" },
			steps: [
				{
					toolCall: { name: "WEB_SEARCH", args: { query: "best keyboard" } },
					result: { success: true, text: '{"results":[{"url":"x"}]}' },
				},
			],
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
		},
		effects: { copyToClipboard: vi.fn(), messageToUser: vi.fn() },
	});

	it("bare final ack after a successful tool continues the loop (live: 'checking.')", async () => {
		const result = await runEvaluator(
			makeParams(
				'{"success": true, "decision": "FINISH", "thought": "found a list.", "messageToUser": "checking."}',
			),
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
	});

	it("promise-tailed message continues the loop (live: link + 'checking this list for the top pick')", async () => {
		const result = await runEvaluator(
			makeParams(
				'{"success": true, "decision": "FINISH", "thought": "found it.", "messageToUser": "<https://example.com/best-keyboards>\\n\\nchecking this list for the top pick under $150."}',
			),
		);
		expect(result.decision).toBe("CONTINUE");
		expect(result.messageToUser).toBeUndefined();
	});

	it("substantive answer that merely opens with a gerund stays FINISH", async () => {
		const answer =
			"Checking accounts are bank accounts designed for everyday spending; for your $150 budget the Keychron V5 is the pick.";
		const result = await runEvaluator(
			makeParams(
				`{"success": true, "decision": "FINISH", "thought": "answered.", "messageToUser": ${JSON.stringify(answer)}}`,
			),
		);
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toContain("Keychron V5");
	});

	it("real deliverable ending in a plain sentence stays FINISH", async () => {
		const answer =
			"top pick: Keychron V5 ($95) — hot-swappable, gasket mount, well under your $150 budget.";
		const result = await runEvaluator(
			makeParams(
				`{"success": true, "decision": "FINISH", "thought": "done.", "messageToUser": ${JSON.stringify(answer)}}`,
			),
		);
		expect(result.decision).toBe("FINISH");
	});
});

describe("fabricated marker invocations are rejected, real widgets pass", () => {
	const finishWith = (messageToUser: string) =>
		`{"success": true, "decision": "FINISH", "thought": "done.", "messageToUser": ${JSON.stringify(messageToUser)}}`;
	const paramsWithTool = (json: string) => ({
		runtime: { useModel: vi.fn(async () => json) },
		context: {
			id: "ctx",
			staticPrefix: {
				characterPrompt: { content: "agent_name: Eliza", stable: true },
			},
			events: [
				{
					id: "msg",
					type: "message" as const,
					message: {
						role: "user" as const,
						content: { text: "what documents do i have" },
					},
				},
			],
		},
		trajectory: {
			context: { id: "ctx" },
			steps: [
				{
					toolCall: { name: "DOCUMENTS", args: {} },
					result: { success: true, text: "{}" },
				},
			],
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
		},
		effects: { copyToClipboard: vi.fn(), messageToUser: vi.fn() },
	});

	it.each(["[CALL:tool-1-0]", "Searching now. [CALL:tool-1-0]"])(
		"replans instead of delivering a call reference: %s",
		async (marker) => {
			for (const output of [marker, finishWith(marker)]) {
				const result = await runEvaluator(paramsWithTool(output));
				expect(result.decision).toBe("CONTINUE");
				expect(result.messageToUser ?? "").toBe("");
			}
		},
	);

	it.each([
		"The internal reference is `[CALL:tool-1-0]`.",
		"Example:\n```text\n[CALL:tool-1-0]\n```",
	])("preserves quoted call-reference documentation: %s", async (answer) => {
		const result = await runEvaluator(paramsWithTool(finishWith(answer)));
		expect(result.decision).toBe("FINISH");
		expect(result.messageToUser).toBe(answer);
	});

	it("a fabricated [DOCUMENT_SEARCH] marker coerces to CONTINUE and does not ship (live leak)", async () => {
		for (const answer of [
			'checking documents context. [DOCUMENT_SEARCH] {"limit":20} [/DOCUMENT_SEARCH]',
			'checking documents context. [ DOCUMENT_SEARCH ] {"limit":20,} [ / DOCUMENT_SEARCH ]',
		]) {
			const result = await runEvaluator(paramsWithTool(finishWith(answer)));
			expect(result.decision).toBe("CONTINUE");
			expect(result.messageToUser ?? "").not.toContain("DOCUMENT_SEARCH");
		}
	});

	it("a real [CHECKLIST] widget block is NOT treated as an invocation", async () => {
		const result = await runEvaluator(
			paramsWithTool(
				finishWith(
					'here is your list:\n[CHECKLIST]\n{"title":"x","items":[{"content":"a","status":"pending"}]}\n[/CHECKLIST]',
				),
			),
		);
		expect(result.decision).toBe("FINISH");
	});

	it("literal bracket-tag documentation stays FINISH", async () => {
		for (const answer of [
			"Wrap the value in [SECTION]content[/SECTION].",
			'Example:\n```text\n[DOCUMENT_SEARCH] {"limit":20} [/DOCUMENT_SEARCH]\n```',
		]) {
			const result = await runEvaluator(paramsWithTool(finishWith(answer)));
			expect(result.decision).toBe("FINISH");
			expect(result.messageToUser).toBe(answer);
		}
	});
});

describe("provider-owned evaluator output boundaries", () => {
	// Core never chooses a completion ceiling. If a provider still reports that
	// its own hard length boundary was reached, reject the partial envelope as a
	// typed failure instead of parsing or silently retrying it.
	const truncatedEnvelope = {
		// A JSON envelope cut mid-string — unparseable by construction.
		text: '{"success": true, "decision": "FINISH", "thought": "long reasoning that got cut o',
		finishReason: "length",
		usage: { promptTokens: 100, completionTokens: 2048 },
	};
	const completeEnvelope = {
		text: '{"success": true, "decision": "FINISH", "thought": "Recovered on the retry."}',
		finishReason: "stop",
		usage: { promptTokens: 100, completionTokens: 40 },
	};
	const baseParams = (useModel: ReturnType<typeof vi.fn>) => ({
		runtime: { useModel },
		context: {
			id: "ctx",
			staticPrefix: {
				characterPrompt: { content: "agent_name: Eliza", stable: true },
			},
			events: [
				{
					id: "msg",
					type: "message" as const,
					message: {
						role: "user" as const,
						content: { text: "Check status." },
					},
				},
			],
		},
		trajectory: {
			context: { id: "ctx" },
			steps: [],
			archivedSteps: [],
			plannedQueue: [],
			evaluatorOutputs: [],
		},
	});
	const captureRecorder = (stages: RecordedStage[]): TrajectoryRecorder => ({
		startTrajectory: () => "trajectory-evaluator-retry",
		recordStage: async (_trajectoryId, stage) => {
			stages.push(stage);
		},
		endTrajectory: async () => undefined,
		load: async () => null,
		list: async () => [],
	});

	it("detects truncation via finishReason and via usage-at-cap", async () => {
		const { evaluatorHitCompletionLimit } = await import("../evaluator");
		expect(
			evaluatorHitCompletionLimit(
				{ finishReason: "length", usage: { completionTokens: 10 } },
				2048,
			),
		).toBe(true);
		for (const finishReason of ["max_completion_tokens", "stop_length"]) {
			expect(
				evaluatorHitCompletionLimit(
					{ finishReason, usage: { completionTokens: 10 } },
					2048,
				),
			).toBe(true);
		}
		expect(
			evaluatorHitCompletionLimit(
				{ finishReason: "stop", usage: { completionTokens: 2048 } },
				2048,
			),
		).toBe(true);
		expect(
			evaluatorHitCompletionLimit(
				{ finishReason: "stop", usage: { completionTokens: 40 } },
				2048,
			),
		).toBe(false);
		// String results carry no metadata and are never treated as truncated.
		expect(evaluatorHitCompletionLimit("plain text", 2048)).toBe(false);
	});

	it("rejects an incomplete envelope once without imposing or doubling a cap", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(truncatedEnvelope)
			.mockResolvedValueOnce(completeEnvelope);

		await expect(runEvaluator(baseParams(useModel))).rejects.toMatchObject({
			code: "EVALUATOR_OUTPUT_INCOMPLETE",
		});
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0][1].maxTokens).toBeUndefined();
	});

	it("reports usage for the rejected provider response", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(truncatedEnvelope)
			.mockResolvedValueOnce(completeEnvelope);
		const onUsage = vi.fn();

		await expect(
			runEvaluator({ ...baseParams(useModel), onUsage }),
		).rejects.toMatchObject({ code: "EVALUATOR_OUTPUT_INCOMPLETE" });

		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith({
			promptTokens: 100,
			completionTokens: 2048,
		});
	});

	it("records the typed incomplete-output failure", async () => {
		const stages: RecordedStage[] = [];
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(truncatedEnvelope)
			.mockResolvedValueOnce(completeEnvelope);

		await expect(
			runEvaluator({
				...baseParams(useModel),
				recorder: captureRecorder(stages),
				trajectoryId: "trajectory-evaluator-incomplete",
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_OUTPUT_INCOMPLETE" });

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(stages).toHaveLength(1);
		expect(stages[0]?.model?.response).toContain(
			"Evaluator provider returned an incomplete output",
		);
	});

	it("keeps selected-provider provenance for an incomplete output", async () => {
		const stages: RecordedStage[] = [];
		const providerError = Object.assign(new Error("retry rate limited"), {
			status: 429,
		});
		let callIndex = 0;
		const useModel = vi.fn(
			async (
				_modelType: string,
				request: {
					messages: ChatMessage[];
					promptSegments?: PromptSegment[];
					providerOptions?: Record<string, unknown>;
					prepareModelAttempt?: (
						attempt: { modelType: string; provider: string },
						params: {
							messages: ChatMessage[];
							promptSegments?: PromptSegment[];
							providerOptions?: Record<string, unknown>;
						},
					) => Promise<void> | void;
				},
			) => {
				const provider =
					callIndex === 0 ? "initial-provider" : "retry-provider";
				await request.prepareModelAttempt?.(
					{ modelType: ModelType.RESPONSE_HANDLER, provider },
					request,
				);
				callIndex++;
				if (callIndex === 1) return truncatedEnvelope;
				throw providerError;
			},
		);

		await expect(
			runEvaluator({
				...baseParams(useModel),
				runtime: {
					useModel,
					supportsModelAttemptPreparation: true,
					reportError: vi.fn(),
				},
				recorder: captureRecorder(stages),
				trajectoryId: "trajectory-evaluator-incomplete",
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_OUTPUT_INCOMPLETE" });

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(stages).toHaveLength(1);
		expect(stages[0]?.model?.provider).toBe("initial-provider");
		expect(stages[0]?.model?.response).toContain("incomplete output");
	});

	it("does not make a second model call after an incomplete output", async () => {
		const providerError = Object.assign(new Error("retry rate limited"), {
			status: 429,
		});
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(truncatedEnvelope)
			.mockRejectedValueOnce(providerError);
		const warn = vi.fn();
		const reportError = vi.fn();
		const onUsage = vi.fn();

		await expect(
			runEvaluator({
				...baseParams(useModel),
				runtime: { useModel, logger: { warn }, reportError },
				onUsage,
			}),
		).rejects.toMatchObject({ code: "EVALUATOR_OUTPUT_INCOMPLETE" });

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
		expect(reportError).not.toHaveBeenCalled();
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith({
			promptTokens: 100,
			completionTokens: 2048,
		});
	});

	it("rejects a complete input that cannot fit the selected provider", async () => {
		vi.stubEnv("MODEL_CONTEXT_WINDOWS_JSON", '{"tiny-evaluator":8000}');
		try {
			const stages: RecordedStage[] = [];
			const useModel = vi.fn(
				async (
					_modelType: string,
					request: {
						messages: ChatMessage[];
						promptSegments?: PromptSegment[];
						providerOptions?: Record<string, unknown>;
						prepareModelAttempt?: (
							attempt: {
								modelType: string;
								provider: string;
								metadata: { displayModel: string };
							},
							params: {
								messages: ChatMessage[];
								promptSegments?: PromptSegment[];
								providerOptions?: Record<string, unknown>;
							},
						) => Promise<void> | void;
					},
				) => {
					await request.prepareModelAttempt?.(
						{
							modelType: ModelType.RESPONSE_HANDLER,
							provider: "tiny",
							metadata: { displayModel: "tiny-evaluator" },
						},
						request,
					);
					throw new ElizaError("final request exceeds context", {
						code: "MODEL_INPUT_OVER_BUDGET",
					});
				},
			);
			const reportError = vi.fn();

			await expect(
				runEvaluator({
					...baseParams(useModel),
					runtime: {
						useModel,
						supportsModelAttemptPreparation: true,
						getModelRegistrations: () => [
							{
								modelType: ModelType.RESPONSE_HANDLER,
								provider: "tiny",
								metadata: { displayModel: "tiny-evaluator" },
							},
						],
						reportError,
					},
					context: {
						...baseParams(useModel).context,
						staticPrefix: {
							characterPrompt: {
								content: `agent_name: Eliza\n${"x".repeat(40_000)}`,
								stable: true,
							},
						},
					},
					recorder: captureRecorder(stages),
					trajectoryId: "trajectory-evaluator-input-budget",
				}),
			).rejects.toMatchObject({ code: "MODEL_INPUT_OVER_BUDGET" });

			expect(useModel).toHaveBeenCalledTimes(1);
			expect(stages).toHaveLength(1);
			expect(stages[0]?.model?.response).toContain("MODEL_INPUT_OVER_BUDGET");
			expect(reportError).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not invoke a second-call adapter after incomplete output", async () => {
		const programmerError = new TypeError("retry result adapter is broken");
		const useModel = vi
			.fn()
			.mockResolvedValueOnce(truncatedEnvelope)
			.mockRejectedValueOnce(programmerError);
		const onUsage = vi.fn();

		await expect(
			runEvaluator({ ...baseParams(useModel), onUsage }),
		).rejects.toMatchObject({ code: "EVALUATOR_OUTPUT_INCOMPLETE" });
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledTimes(1);
		expect(onUsage).toHaveBeenCalledWith({
			promptTokens: 100,
			completionTokens: 2048,
		});
	});

	it("does not infer a cap from usage when none was requested", async () => {
		const parseableAtCap = {
			text: '{"success": true, "decision": "FINISH", "thought": "Fits exactly."}',
			finishReason: "stop",
			usage: { promptTokens: 100, completionTokens: 2048 },
		};
		const useModel = vi.fn().mockResolvedValue(parseableAtCap);

		const result = await runEvaluator(baseParams(useModel));

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.decision).toBe("FINISH");
	});

	it("never parses or retries an incomplete provider response", async () => {
		const useModel = vi.fn().mockResolvedValue(truncatedEnvelope);

		await expect(runEvaluator(baseParams(useModel))).rejects.toMatchObject({
			code: "EVALUATOR_OUTPUT_INCOMPLETE",
		});
		expect(useModel).toHaveBeenCalledTimes(1);
	});
});
