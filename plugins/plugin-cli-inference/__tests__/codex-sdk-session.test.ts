import { describe, expect, it } from "vitest";
import { type CodexModule, CodexSdkSession } from "../src/codex-sdk-session";

/**
 * Unit tests for the warm Codex SDK session, driven by a FAKE CodexModule via the
 * constructor's injectable `codexModule` seam (no real `@openai/codex-sdk`, no
 * real `codex` process). Each "turn script" describes the completed turn the fake
 * thread returns: its `finalResponse` (or item text), or an error to throw.
 */

interface TurnScript {
  finalResponse?: string;
  itemText?: string;
  throws?: string;
}

function makeFakeCodex(scripts: TurnScript[]): {
  codexModule: CodexModule;
  starts: () => number;
  codexOptions: () => Array<Record<string, unknown>>;
} {
  let startCount = 0;
  let turn = 0;
  const constructedOptions: Array<Record<string, unknown>> = [];
  const codexModule = {
    Codex: class {
      constructor(options?: Record<string, unknown>) {
        constructedOptions.push(options ?? {});
      }

      startThread() {
        startCount += 1;
        return {
          run: async (_input: string, _turnOptions?: { outputSchema?: unknown }) => {
            const s = scripts[turn++] ?? {};
            if (s.throws) throw new Error(s.throws);
            const items = s.itemText ? [{ type: "agent_message", text: s.itemText }] : [];
            return { items, finalResponse: s.finalResponse, usage: null };
          },
        };
      }
    },
  } as unknown as CodexModule;
  return { codexModule, starts: () => startCount, codexOptions: () => constructedOptions };
}

function makeSession(
  scripts: TurnScript[],
  opts: {
    router?: boolean;
    restartAfterTurns?: number;
    subprocessEnv?: Record<string, string | undefined>;
  } = {}
) {
  const fake = makeFakeCodex(scripts);
  const session = new CodexSdkSession({
    model: "gpt-test",
    router: opts.router ?? false,
    restartAfterTurns: opts.restartAfterTurns,
    subprocessEnv: opts.subprocessEnv,
    codexModule: fake.codexModule,
  });
  return { session, ...fake };
}

describe("CodexSdkSession — TEXT mode", () => {
  it("disables inherited tools and memories in the inference child", async () => {
    const { session, codexOptions } = makeSession([{ finalResponse: "hello" }]);
    await session.generate("hi");
    expect(codexOptions()[0].config).toEqual({
      features: {
        apps: false,
        plugins: false,
        shell_tool: false,
        unified_exec: false,
        multi_agent: false,
        hooks: false,
        memories: false,
        image_generation: false,
      },
    });
  });
  it("returns the turn finalResponse", async () => {
    const { session } = makeSession([{ finalResponse: "hello" }]);
    expect(await session.generate("hi")).toBe("hello");
    session.dispose();
  });

  it("passes rotated account env to the Codex SDK constructor only", async () => {
    const subprocessEnv = { PATH: "/bin", CODEX_HOME: "/selected/codex" };
    const { session, codexOptions } = makeSession([{ finalResponse: "hello" }], {
      subprocessEnv,
    });
    expect(await session.generate("hi")).toBe("hello");
    expect(codexOptions()[0].env).toEqual({
      ...subprocessEnv,
      ELIZA_CODEX_INFERENCE_BIN: "codex",
    });
    session.dispose();
  });

  it("falls back to the last agent_message item text", async () => {
    const { session } = makeSession([{ itemText: "from item" }]);
    expect(await session.generate("hi")).toBe("from item");
    session.dispose();
  });

  it("throws on an empty completion (fail over)", async () => {
    const { session } = makeSession([{ finalResponse: "" }]);
    await expect(session.generate("hi")).rejects.toThrow(/empty completion/);
    session.dispose();
  });

  it("rejects an empty prompt body", async () => {
    const { session } = makeSession([{ finalResponse: "x" }]);
    await expect(session.generate("   ")).rejects.toThrow(/empty prompt body/);
    session.dispose();
  });

  it("self-heals: a throwing turn disposes, the next call re-starts the thread", async () => {
    const { session, starts } = makeSession([{ throws: "boom" }, { finalResponse: "recovered" }]);
    await expect(session.generate("a")).rejects.toThrow(/boom/);
    expect(await session.generate("b")).toBe("recovered");
    expect(starts()).toBe(2);
    session.dispose();
  });

  it("restarts after restartAfterTurns to bound context", async () => {
    const { session, starts } = makeSession([{ finalResponse: "one" }, { finalResponse: "two" }], {
      restartAfterTurns: 1,
    });
    expect(await session.generate("1")).toBe("one");
    expect(await session.generate("2")).toBe("two");
    expect(starts()).toBeGreaterThanOrEqual(2);
    session.dispose();
  });
});

describe("CodexSdkSession — ROUTE mode (native outputSchema)", () => {
  it("parses a bare {action,params} JSON from the turn's finalResponse", async () => {
    const { session } = makeSession(
      [{ finalResponse: '{"action":"WEB_FETCH","params":"{\\"url\\":\\"u\\"}"}' }],
      { router: true }
    );
    const out = JSON.parse(await session.route("price?"));
    expect(out).toEqual({ action: "WEB_FETCH", params: { url: "u" } });
    session.dispose();
  });

  it("rejects structured JSON wrapped in prose instead of guessing a route", async () => {
    const { session } = makeSession(
      [
        {
          finalResponse:
            'Sure, here is the action: {"action":"REPLY","params":"{\\"text\\":\\"4\\"}"} — let me know if you need anything else.',
        },
      ],
      { router: true }
    );
    await expect(session.route("2+2?")).rejects.toThrow(/non-JSON output/);
    session.dispose();
  });

  it("rejects malformed parameters rather than replacing them with an empty object", async () => {
    const { session } = makeSession(
      [{ finalResponse: '{"action":"IGNORE","params":"not valid json"}' }],
      {
        router: true,
      }
    );
    await expect(session.route("hi")).rejects.toThrow();
    session.dispose();
  });

  it("throws when the structured output has no action", async () => {
    const { session } = makeSession([{ finalResponse: '{"params":{}}' }], {
      router: true,
    });
    await expect(session.route("hi")).rejects.toThrow(/missing action/);
    session.dispose();
  });

  it("throws on non-JSON route output", async () => {
    const { session } = makeSession([{ finalResponse: "not json at all" }], {
      router: true,
    });
    await expect(session.route("hi")).rejects.toThrow(/non-JSON output/);
    session.dispose();
  });
});

describe("CodexSdkSession — serialization", () => {
  it("serializes concurrent calls without interleaving", async () => {
    const { session } = makeSession(
      [
        { finalResponse: '{"action":"A","params":"{}"}' },
        { finalResponse: '{"action":"B","params":"{}"}' },
      ],
      { router: true }
    );
    const [r1, r2] = await Promise.all([session.route("one"), session.route("two")]);
    const actions = [JSON.parse(r1).action, JSON.parse(r2).action].sort();
    expect(actions).toEqual(["A", "B"]);
    session.dispose();
  });
});
