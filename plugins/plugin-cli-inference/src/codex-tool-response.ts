/**
 * Bridge Codex structured output to Eliza's tool-result contract. The full
 * request and tool schemas remain model-visible; only Eliza executes actions.
 */
import { randomUUID } from "node:crypto";
import type { GenerateTextParams, GenerateTextResult } from "@elizaos/core";
import type { CodexSdkSession } from "./codex-sdk-session";
import { flattenPrompt } from "./prompt-flatten";

export async function generateCodexToolResponse(
  session: CodexSdkSession,
  params: GenerateTextParams
): Promise<GenerateTextResult> {
  const tools = params.tools ?? [];
  const choice = params.toolChoice ?? "auto";
  const forced =
    typeof choice === "object"
      ? "function" in choice
        ? choice.function.name
        : choice.name
      : undefined;
  const names = tools.map((tool) => tool.name);
  if (forced && !names.includes(forced)) throw new Error("Codex requested tool is not declared");
  const { system, body } = flattenPrompt(params);
  const outputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["text", "toolCalls"],
    properties: {
      text: { type: "string" },
      toolCalls: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "arguments"],
          properties: {
            name: { type: "string", enum: forced ? [forced] : names },
            arguments: {
              type: "string",
              description: "JSON object matching the selected tool's complete parameter schema",
            },
          },
        },
      },
    },
  };
  const raw = await session.generate(
    `${system}\n\n${body}\n\nEliza tool definitions (complete):\n${JSON.stringify(tools)}\nTool choice: ${JSON.stringify(choice)}\nReturn the structured response. Tool calls are decisions for Eliza to execute, not actions you have completed. Do not execute tools yourself. Required means at least one tool call; none means no tool calls.`,
    outputSchema,
    params.signal
  );
  const result: unknown = JSON.parse(raw);
  if (
    !result ||
    typeof result !== "object" ||
    !("text" in result) ||
    typeof result.text !== "string" ||
    !("toolCalls" in result) ||
    !Array.isArray(result.toolCalls)
  ) {
    throw new Error("Invalid Codex structured tool response");
  }
  const calls = result.toolCalls.map((call: unknown) => {
    if (
      !call ||
      typeof call !== "object" ||
      !("name" in call) ||
      typeof call.name !== "string" ||
      !names.includes(call.name) ||
      (forced && call.name !== forced) ||
      !("arguments" in call) ||
      typeof call.arguments !== "string"
    ) {
      throw new Error("Codex returned an undeclared or invalid tool call");
    }
    const args: unknown = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("Codex tool arguments must be a JSON object");
    }
    return { id: randomUUID(), name: call.name, arguments: call.arguments };
  });
  if ((choice === "required" || forced) && calls.length === 0)
    throw new Error("Codex omitted a required tool call");
  if (choice === "none" && calls.length !== 0)
    throw new Error("Codex called a tool when toolChoice is none");
  return {
    text: result.text,
    toolCalls: calls,
    finishReason: calls.length ? "tool_calls" : "stop",
  };
}
