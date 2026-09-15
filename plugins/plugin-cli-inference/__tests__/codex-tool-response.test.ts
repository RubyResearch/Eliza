/** Tests the real structured-response bridge with a fake SDK transport. */

import type { GenerateTextParams, GenerateTextResult, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { __setCodexSdkSessionFactoryForTests, buildModels, disposeSdkSessions } from "../index";
import { CodexSdkSession } from "../src/codex-sdk-session";
import { generateCodexToolResponse } from "../src/codex-tool-response";

const tool = {
  name: "OPEN_VIEW",
  description: "Open a view",
  parameters: {
    type: "object",
    properties: { view: { type: "string" } },
    required: ["view"],
  },
};

function fixture(response: string) {
  const inputs: string[] = [];
  const schemas: unknown[] = [];
  let starts = 0;
  const session = new CodexSdkSession({
    codexModule: {
      Codex: class {
        startThread() {
          starts++;
          return {
            async run(input: string, options?: { outputSchema?: unknown }) {
              inputs.push(input);
              schemas.push(options?.outputSchema);
              return { finalResponse: response };
            },
          };
        }
      },
    },
  });
  return { session, inputs, schemas, starts: () => starts };
}

describe("Codex structured tools", () => {
  it("registers the native planner and isolates two runtime instances", async () => {
    let adapters = 0;
    const restore = __setCodexSdkSessionFactoryForTests(() => {
      adapters++;
      return fixture(
        '{"text":"","toolCalls":[{"name":"OPEN_VIEW","arguments":"{\\"view\\":\\"notes\\"}"}]}'
      ).session;
    });
    try {
      const models = buildModels({ ELIZA_CHAT_VIA_CLI: "codex-sdk" });
      const handler = models?.ACTION_PLANNER as (
        runtime: IAgentRuntime,
        params: GenerateTextParams
      ) => Promise<GenerateTextResult>;
      expect(handler).toBeTypeOf("function");
      const makeRuntime = () =>
        ({
          getSetting: (key: string) =>
            key === "ELIZA_CHAT_VIA_CLI"
              ? "codex-sdk"
              : key === "ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION"
                ? "0"
                : undefined,
        }) as IAgentRuntime;
      const a = makeRuntime();
      const b = makeRuntime();
      for (const runtime of [a, a, b]) {
        const result = await handler(runtime, {
          prompt: "Open notes",
          tools: [tool],
          toolChoice: "required",
        });
        expect(result.toolCalls?.[0].name).toBe("OPEN_VIEW");
      }
      expect(adapters).toBe(2);
    } finally {
      restore();
      await disposeSdkSessions();
    }
  });
  it("preserves context and schemas and returns an Eliza tool decision", async () => {
    const f = fixture(
      JSON.stringify({
        text: "",
        toolCalls: [{ name: "OPEN_VIEW", arguments: '{"view":"notes"}' }],
      })
    );
    const result = await generateCodexToolResponse(f.session, {
      system: "Keep this complete",
      prompt: "Open Notes",
      tools: [tool],
      toolChoice: "required",
    });
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "OPEN_VIEW",
      arguments: '{"view":"notes"}',
    });
    expect(f.inputs[0]).toContain("Keep this complete");
    expect(f.inputs[0]).toContain(JSON.stringify([tool]));
    expect(f.schemas[0]).toBeDefined();
    await generateCodexToolResponse(f.session, { prompt: "Different room", tools: [tool] });
    expect(f.starts()).toBe(2);
    expect(f.inputs[1]).not.toContain("Keep this complete");
  });

  it.each([
    ['{"text":"done","toolCalls":[]}', "required"],
    ['{"text":"","toolCalls":[{"name":"DELETE_ALL","arguments":"{}"}]}', "auto"],
    ['{"text":"","toolCalls":[{"name":"OPEN_VIEW","arguments":"broken"}]}', "auto"],
    ['{"text":"","toolCalls":[{"name":"OPEN_VIEW","arguments":"[]"}]}', "auto"],
    ['{"text":"","toolCalls":[{"name":"OPEN_VIEW","arguments":"{}"}]}', "none"],
  ] as const)("rejects invalid or disallowed output %s", async (response, toolChoice) => {
    const f = fixture(response);
    await expect(
      generateCodexToolResponse(f.session, { prompt: "test", tools: [tool], toolChoice })
    ).rejects.toThrow();
  });
});
