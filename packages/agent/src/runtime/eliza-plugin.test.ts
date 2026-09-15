/**
 * Behavioral unit tests for {@link createElizaPlugin} — the agent plugin
 * factory that wires the workspace/session providers, lifecycle actions, the
 * runtime-owned schema, and the long-lived retention services.
 *
 * These are REAL tests: they import and CALL `createElizaPlugin`, then assert
 * the returned plugin's structure and behavior, and drive the `init`/`dispose`
 * lifecycle against a REAL {@link AgentRuntime} (constructed with `logLevel:
 * "fatal"`, no database) — not a cast-fabricated runtime. Agent Skills owns its
 * command lifecycle in plugin-agent-skills and has a separate real-runtime test.
 *
 * Companion to eliza-plugin-services.test.ts (which asserts the *source text*
 * of the services array as a fail-closed guard); this file proves the *runtime
 * behavior* and produces the coverage the text-only guard cannot.
 */

import { AgentRuntime, type Memory, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../core/src/actions/validate-tool-args.ts";
import { createElizaPlugin } from "./eliza-plugin.ts";
import { LogsRetentionService } from "./logs-retention-service.ts";
import { MemoryRetentionService } from "./memory-retention-service.ts";

/** Assert the plugin declares an `init` hook and return it (no non-null `!`). */
function initOf(
  plugin: ReturnType<typeof createElizaPlugin>,
): NonNullable<ReturnType<typeof createElizaPlugin>["init"]> {
  const { init } = plugin;
  if (!init) throw new Error("plugin.init is not defined");
  return init;
}

/** Assert the plugin declares a `dispose` hook and return it. */
function disposeOf(
  plugin: ReturnType<typeof createElizaPlugin>,
): NonNullable<ReturnType<typeof createElizaPlugin>["dispose"]> {
  const { dispose } = plugin;
  if (!dispose) throw new Error("plugin.dispose is not defined");
  return dispose;
}

/** Class names of the services array (each entry is a service constructor). */
function serviceNamesOf(
  plugin: ReturnType<typeof createElizaPlugin>,
): string[] {
  return (plugin.services ?? []).map((s) => {
    // Each entry is a service constructor; read its class name (constructors
    // carry a string `name`). Access via a narrow constructor shape.
    const ctor = s as { name: string };
    return ctor.name;
  });
}

describe("createElizaPlugin — structure & service wiring", () => {
  it("returns a plugin named 'eliza' with the expected surface arrays", () => {
    const plugin = createElizaPlugin({
      workspaceDir: "/tmp/ws",
      agentId: "unit",
      sessionStorePath: "/tmp/ws/sessions.json",
    });
    expect(plugin.name).toBe("eliza");
    expect(typeof plugin.description).toBe("string");
    expect(Array.isArray(plugin.services)).toBe(true);
    expect(Array.isArray(plugin.providers)).toBe(true);
    expect(Array.isArray(plugin.actions)).toBe(true);
    expect(Array.isArray(plugin.routes)).toBe(true);
    expect((plugin.services ?? []).length).toBeGreaterThan(0);
    expect((plugin.providers ?? []).length).toBeGreaterThan(0);
    expect((plugin.actions ?? []).length).toBeGreaterThan(0);
  });

  it("registers MemoryRetentionService (the append-only-store bound)", () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    expect(plugin.services).toContain(MemoryRetentionService);
    expect((plugin.services ?? []).map((s) => s.serviceType)).toContain(
      MemoryRetentionService.serviceType,
    );
  });

  it("registers LogsRetentionService (the append-only logs-table bound)", () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    expect(plugin.services).toContain(LogsRetentionService);
    expect((plugin.services ?? []).map((s) => s.serviceType)).toContain(
      LogsRetentionService.serviceType,
    );
    // Two distinct, independently-configured subsystems (memories vs logs),
    // not the same service double-counted.
    expect(MemoryRetentionService.serviceType).not.toBe(
      LogsRetentionService.serviceType,
    );
  });

  it("registers PairingService + OwnerBindingService for the DM pairing path", () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    const names = serviceNamesOf(plugin);
    // Guard the #14710 residual behaviorally, not just by source text.
    expect(names).toContain("PairingService");
    expect(names).toContain("OwnerBindingService");
  });

  it("merges the runtime-owned schema (knowledge-graph + pendant-session)", () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    expect(plugin.schema).toBeDefined();
    expect(Object.keys(plugin.schema as object).length).toBeGreaterThan(0);
  });

  it("exposes the media + files routes (iOS in-process dispatch surface)", () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    expect((plugin.routes ?? []).length).toBeGreaterThan(0);
  });
});

describe("createElizaPlugin — config resolution", () => {
  it("honors an explicit config (no filesystem probing needed)", () => {
    const plugin = createElizaPlugin({
      workspaceDir: "/explicit/workspace",
      agentId: "cfg-agent",
      sessionStorePath: "/explicit/sessions.json",
    });
    expect(plugin.name).toBe("eliza");
    // The workspace provider is constructed from the config; presence proves
    // the base-providers block executed with our values.
    expect((plugin.providers ?? []).length).toBeGreaterThan(0);
  });

  it("falls back to defaults when called with no config", () => {
    const plugin = createElizaPlugin();
    expect(plugin.name).toBe("eliza");
    expect((plugin.services ?? []).length).toBeGreaterThan(0);
  });

  it("falls back to defaults when called with an empty config object", () => {
    const plugin = createElizaPlugin({});
    expect(plugin.name).toBe("eliza");
    expect((plugin.providers ?? []).length).toBeGreaterThan(0);
  });
});

describe("createElizaPlugin — init lifecycle", () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    // A real runtime, no database — enough for the plugin's init registration
    // helpers (trigger worker, media GC, attachment ingest, error escalation,
    // and custom actions).
    runtime = new AgentRuntime({ logLevel: "fatal" });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs init without throwing and registers the trigger task worker", async () => {
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    const spy = vi.spyOn(runtime, "registerTaskWorker");
    await expect(initOf(plugin)({}, runtime)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });
});

describe("createElizaPlugin — dispose lifecycle", () => {
  it("stops the disposable services it owns, tolerating absent ones", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const stopped: string[] = [];
    // Each getService<T>(type) returns a stub whose stop() records the type,
    // so dispose()'s teardown fan-out is observable.
    vi.spyOn(runtime, "getService").mockImplementation(((type: string) => ({
      stop: vi.fn(async () => {
        stopped.push(type);
      }),
    })) as typeof runtime.getService);

    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    await expect(disposeOf(plugin)(runtime)).resolves.toBeUndefined();
    // Four services are torn down in dispose(); each stop() ran once.
    expect(stopped.length).toBe(4);
    vi.restoreAllMocks();
  });

  it("dispose is safe when the owned services are not registered", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    vi.spyOn(runtime, "getService").mockImplementation(
      (() => null) as typeof runtime.getService,
    );
    const plugin = createElizaPlugin({ workspaceDir: "/tmp/ws", agentId: "u" });
    await expect(disposeOf(plugin)(runtime)).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe("promoted MEMORY tool contracts", () => {
  const memoryId = "8f57e93e-b652-4ae0-8653-d86baa67a16b" as UUID;
  function actionNamed(name: string) {
    const action = createElizaPlugin().actions?.find(
      (entry) => entry.name === name,
    );
    if (!action) throw new Error(`Missing ${name}`);
    return action;
  }

  it("rejects the observed missing-text update and accepts either target form", () => {
    const update = actionNamed("MEMORY_UPDATE");
    expect(
      validateToolArgs(update, { memoryId, confirm: true }).errors,
    ).toContain("Missing required argument 'text'");
    for (const target of [{ memoryId }, { query: "Silver Heron" }]) {
      expect(
        validateToolArgs(update, {
          ...target,
          text: "Silver Heron review day is Friday.",
          confirm: true,
        }).valid,
      ).toBe(true);
    }
    expect(validateToolArgs(update, { memoryId, text: "Friday" }).valid).toBe(
      false,
    );
    expect(validateToolArgs(actionNamed("MEMORY_CREATE"), {}).valid).toBe(
      false,
    );
    expect(
      validateToolArgs(actionNamed("MEMORY_DELETE"), { memoryId }).valid,
    ).toBe(false);
    expect(
      validateToolArgs(actionNamed("MEMORY_SEARCH"), {
        query: "Silver Heron",
        author: "any",
      }).valid,
    ).toBe(true);
    expect(
      actionNamed("MEMORY").parameters?.find((p) => p.name === "text")
        ?.required,
    ).toBe(false);
  });

  it("requires explicit authorship on the registered search tool", () => {
    const search = actionNamed("MEMORY_SEARCH");
    // An omitted scope must not execute a broad search when the user asked
    // for their original statements rather than assistant restatements.
    expect(
      validateToolArgs(search, { query: "Mira", limit: 10 }).errors,
    ).toContain("Missing required argument 'author'");
    for (const author of ["requester", "assistant", "any"]) {
      expect(validateToolArgs(search, { author, query: "Mira" }).valid).toBe(
        true,
      );
    }
    expect(
      validateToolArgs(actionNamed("MEMORY"), {
        action: "search",
        query: "Mira",
      }).valid,
    ).toBe(true);
    expect(
      validateToolArgs(search, { author: "everyone", query: "Mira" }).valid,
    ).toBe(false);
    expect(
      validateToolArgs(search, {
        author: "requester",
        query: "Mira",
        queryMode: "literal",
      }).valid,
    ).toBe(true);
    expect(
      validateToolArgs(search, {
        author: "requester",
        query: "Mira",
        queryMode: "regex",
      }).valid,
    ).toBe(false);
    expect(
      actionNamed("MEMORY_DELETE").parameters?.some((p) => p.name === "author"),
    ).toBe(false);
    expect(
      actionNamed("MEMORY_DELETE").parameters?.some(
        (p) => p.name === "queryMode",
      ),
    ).toBe(false);
  });

  it("dispatches a valid promoted update without losing replacement text", async () => {
    const runtime = new AgentRuntime({ character: { name: "Eliza" } });
    let stored: Memory = {
      id: memoryId,
      agentId: runtime.agentId,
      entityId: "1f6f565c-00c4-0952-bfa6-a8af23e74913" as UUID,
      roomId: "b1e84986-c1e5-0109-ad54-092e36867860" as UUID,
      content: { text: "Silver Heron review day is Tuesday." },
    };
    vi.spyOn(runtime, "getMemoryById").mockImplementation(async () => stored);
    const write = vi
      .spyOn(runtime, "updateMemory")
      .mockImplementation(async (change) => {
        stored = { ...stored, ...change };
        return true;
      });
    const action = actionNamed("MEMORY_UPDATE");
    const parameters = {
      memoryId,
      text: "Silver Heron review day is Friday.",
      confirm: true,
    };
    const checked = validateToolArgs(action, parameters);
    expect(checked.valid).toBe(true);
    const result = await action.handler(runtime, stored, undefined, {
      parameters,
    });
    expect(result?.success).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(stored.content.text).toBe("Silver Heron review day is Friday.");
  });
});
