/**
 * Exercises cancellation through the installed Codex SDK and inference launcher.
 * A local protocol child records its lifetime; no model or account is contacted.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateTextParams, GenerateTextResult, IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { __setCodexSdkSessionFactoryForTests, buildModels, disposeSdkSessions } from "../index";
import { CodexSdkSession } from "../src/codex-sdk-session";

describe("Codex SDK cancellation at the subprocess boundary", () => {
  it.each(["external", "route", "dispose"] as const)(
    "terminates %s work and permits a clean next request",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "codex-cancel-contract-"));
      const started = join(directory, "started");
      const stopped = join(directory, "stopped");
      const probe = join(directory, "probe.mjs");
      const session = new CodexSdkSession({ model: "protocol-probe", codexBinPath: probe });
      try {
        await writeFile(
          probe,
          `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
let input = "";
for await (const chunk of process.stdin) input += chunk;
if (input === "recover") {
  for (const event of [
    {type:"thread.started",thread_id:"recovered"},
    {type:"item.completed",item:{id:"reply",type:"agent_message",text:"recovered"}},
    {type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}
  ]) process.stdout.write(JSON.stringify(event)+"\\n");
} else {
  process.on("SIGTERM", () => {writeFileSync(${JSON.stringify(stopped)}, String(process.pid));process.exit(0);});
  appendFileSync(${JSON.stringify(started)}, String(process.pid)+"\\n");
  setInterval(() => {}, 1000);
}
`
        );
        await chmod(probe, 0o700);
        const controller = new AbortController();
        const pending =
          mode === "route"
            ? session.route("wait", controller.signal)
            : session.generate("wait", undefined, controller.signal);
        const observed = pending.then(
          () => "unexpected success",
          () => "cancelled"
        );
        await expect
          .poll(
            async () => {
              try {
                return (await readFile(started, "utf8")).trim();
              } catch (error) {
                // error-policy:J4 the child has not announced startup yet.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
                throw error;
              }
            },
            { timeout: 10_000 }
          )
          .not.toBe("");
        const queued =
          mode === "dispose"
            ? session.generate("must not dispatch").then(
                () => "unexpected success",
                () => "cancelled"
              )
            : undefined;
        if (mode === "dispose") session.dispose();
        else controller.abort();
        expect(await observed).toBe("cancelled");
        if (queued) expect(await queued).toBe("cancelled");
        await expect
          .poll(
            async () => {
              try {
                return (await readFile(stopped, "utf8")).trim();
              } catch (error) {
                // error-policy:J4 wait for the subprocess termination receipt.
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
                throw error;
              }
            },
            { timeout: 5_000 }
          )
          .not.toBe("");
        expect((await readFile(started, "utf8")).trim().split("\n")).toHaveLength(1);
        expect(await session.generate("recover")).toBe("recovered");
      } finally {
        session.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
    20_000
  );

  it("rejects a pre-cancelled request before creating a thread", async () => {
    let starts = 0;
    const session = new CodexSdkSession({
      codexModule: {
        Codex: class {
          startThread() {
            starts++;
            return { run: async () => ({ finalResponse: "unexpected" }) };
          }
        },
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.generate("complete input", undefined, controller.signal)
    ).rejects.toThrow();
    expect(starts).toBe(0);
    session.dispose();
  });
});

describe("Codex model-handler cancellation", () => {
  it.each(["text", "route", "native-tools"] as const)(
    "forwards cancellation through the %s handler",
    async (mode) => {
      let announce: () => void = () => {
        throw new Error("startup observer unavailable");
      };
      const started = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const restore = __setCodexSdkSessionFactoryForTests(
        () =>
          new CodexSdkSession({
            codexModule: {
              Codex: class {
                startThread() {
                  return {
                    run: async (_input: string, options?: { signal?: AbortSignal }) => {
                      const signal = options?.signal;
                      if (!signal) throw new Error("cancellation signal missing");
                      announce();
                      return new Promise<never>((_resolve, reject) => {
                        signal.addEventListener("abort", () => reject(signal.reason), {
                          once: true,
                        });
                      });
                    },
                  };
                }
              },
            },
          })
      );
      try {
        const models = buildModels({
          ELIZA_CHAT_VIA_CLI: "codex-sdk",
          ELIZA_PLANNER_NATIVE_TOOLS: mode === "route" ? "0" : "1",
        });
        const handler = models?.[mode === "text" ? "TEXT_LARGE" : "ACTION_PLANNER"] as (
          runtime: IAgentRuntime,
          params: GenerateTextParams
        ) => Promise<string | GenerateTextResult>;
        const runtime = {
          getSetting: (key: string) =>
            key === "ELIZA_CHAT_VIA_CLI"
              ? "codex-sdk"
              : key === "ELIZA_CLI_INFERENCE_ACCOUNT_ROTATION"
                ? "0"
                : undefined,
        } as IAgentRuntime;
        const controller = new AbortController();
        const result = handler(runtime, {
          prompt: "Return a decision",
          signal: controller.signal,
          ...(mode === "native-tools"
            ? {
                tools: [
                  {
                    name: "OPEN_VIEW",
                    description: "Open a view",
                    parameters: { type: "object", properties: {} },
                  },
                ],
              }
            : {}),
        });
        const observed = result.then(
          () => "unexpected success",
          () => "cancelled"
        );
        await started;
        controller.abort();
        expect(await observed).toBe("cancelled");
      } finally {
        restore();
        await disposeSdkSessions();
      }
    }
  );
});
