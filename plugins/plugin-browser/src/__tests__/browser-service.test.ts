/**
 * BrowserService tests for target registration, resolution, and dispatch behavior.
 *
 * Capability-aware dispatch (issue #18258): these tests prove that
 *   - a capable target is selected before dispatch (capability-aware selection),
 *   - pre-dispatch fallback is permitted for UNSUPPORTED/UNAVAILABLE failures,
 *   - a command is NEVER replayed against another target after dispatch,
 *   - side-effecting commands that fail opaquely surface UNCERTAIN_OUTCOME.
 */

import { ElizaError, logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserService, type BrowserTarget } from "../browser-service.js";
import {
  BrowserDispatchFailure,
  isBrowserDispatchFailure,
  isIdempotentBrowserSubaction,
} from "../dispatch-types.js";

const originalEnv = { ...process.env };

function createTarget(args: {
  id: string;
  priority: number;
  available?: boolean;
  availableError?: Error;
  fail?: boolean;
  score?: BrowserTarget["score"];
  supports?: BrowserTarget["supports"];
  executeMock?: BrowserTarget["execute"];
}): BrowserTarget {
  return {
    id: args.id,
    name: args.id,
    description: args.id,
    priority: args.priority,
    ...(args.score ? { score: args.score } : {}),
    ...(args.supports ? { supports: args.supports } : {}),
    available: vi.fn(async () => {
      if (args.availableError) throw args.availableError;
      return args.available ?? true;
    }),
    execute:
      args.executeMock ??
      (vi.fn(async (command) => {
        if (args.fail) throw new Error(`${args.id} failed`);
        return {
          mode: "web",
          subaction: command.subaction,
          value: args.id,
        };
      }) as BrowserTarget["execute"]),
  };
}

describe("BrowserService target routing", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reads the originating native page and never the Mac workspace", async () => {
    const service = new BrowserService();
    const mac = createTarget({ id: "workspace", priority: 100 });
    service.registerTarget(mac);
    const reader = vi.fn(async () => ({
      url: "https://phone.example/",
      title: "Phone",
      text: "Second native page",
      truncated: false,
    }));
    service.setNativeClientTransport({ readPage: reader, navigate: vi.fn() });
    const result = await service.execute(
      { subaction: "snapshot" },
      "workspace",
      "seeker-client",
    );
    expect(reader).toHaveBeenCalledWith("seeker-client", undefined);
    expect(result).toMatchObject({
      targetId: "native-client",
      value: { bodyText: "Second native page", url: "https://phone.example/" },
    });
    expect(mac.execute).not.toHaveBeenCalled();
    await expect(
      service.execute(
        { subaction: "get", id: "tab-main", selector: "h1" },
        undefined,
        "seeker-client",
      ),
    ).rejects.toThrow("Omit id");
    await expect(
      service.execute(
        { subaction: "get", selector: "h1" },
        undefined,
        "seeker-client",
      ),
    ).resolves.toMatchObject({ value: "Second native page" });
    expect(reader).toHaveBeenLastCalledWith("seeker-client", "h1");
    reader.mockRejectedValueOnce(new Error("Phone disconnected"));
    await expect(
      service.execute({ subaction: "snapshot" }, undefined, "seeker-client"),
    ).rejects.toThrow("Phone disconnected");
    expect(mac.execute).not.toHaveBeenCalled();
  });

  it("fails closed for unavailable native reads and unsupported native DOM commands", async () => {
    const service = new BrowserService();
    const mac = createTarget({ id: "workspace", priority: 100 });
    service.registerTarget(mac);
    await expect(
      service.execute({ subaction: "snapshot" }, undefined, "seeker-client"),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    await expect(
      service.execute(
        { subaction: "click", selector: "button" },
        undefined,
        "seeker-client",
      ),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(mac.execute).not.toHaveBeenCalled();
    const navigate = vi.fn(async () => {});
    service.setNativeClientTransport({ readPage: vi.fn(), navigate });
    await service.execute(
      { subaction: "navigate", url: "https://example.com/" },
      "native-client",
      "seeker-client",
    );
    expect(navigate).toHaveBeenCalledWith(
      "seeker-client",
      "https://example.com/",
    );
    expect(mac.execute).not.toHaveBeenCalled();
  });

  it("never presents truncated native get-text as a complete string", async () => {
    const service = new BrowserService();
    service.setNativeClientTransport({
      navigate: vi.fn(),
      readPage: async () => ({
        url: "https://phone.example/",
        title: "Phone",
        text: "partial",
        truncated: true,
      }),
    });
    await expect(
      service.execute(
        { subaction: "get", selector: "body" },
        undefined,
        "phone",
      ),
    ).rejects.toThrow("exceeds the read limit");
    expect(
      await service.execute({ subaction: "snapshot" }, undefined, "phone"),
    ).toMatchObject({ value: { bodyText: "partial", truncated: true } });
  });

  it("uses target priority instead of registration order for automatic routing", async () => {
    const service = new BrowserService();
    service.registerTarget(createTarget({ id: "stagehand", priority: 10 }));
    service.registerTarget(createTarget({ id: "workspace", priority: 100 }));

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("workspace");
  });

  it("passes desktop context so companion targets can win when available", async () => {
    const service = new BrowserService();
    const workspaceScore = vi.fn(() => 100);
    const bridgeScore = vi.fn(({ mobile }) => (mobile ? null : 160));
    service.registerTarget(
      createTarget({ id: "workspace", priority: 100, score: workspaceScore }),
    );
    service.registerTarget(
      createTarget({ id: "bridge", priority: 80, score: bridgeScore }),
    );

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("bridge");
    expect(workspaceScore.mock.calls[0]?.[0].mobile).toBe(false);
    expect(bridgeScore.mock.calls[0]?.[0].mobile).toBe(false);
  });

  it("passes mobile context so internal workspace wins and companion targets opt out", async () => {
    process.env.ELIZA_MOBILE_PLATFORM = "ios";
    const service = new BrowserService();
    const workspace = createTarget({
      id: "workspace",
      priority: 100,
      score: ({ mobile }) => (mobile ? 120 : 100),
    });
    const bridge = createTarget({
      id: "bridge",
      priority: 80,
      score: ({ mobile }) => (mobile ? null : 160),
    });
    service.registerTarget(bridge);
    service.registerTarget(workspace);

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("workspace");
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(workspace.execute).toHaveBeenCalledTimes(1);
  });

  it("excludes an unpinned target whose availability check throws, still resolves a healthy one, and logs the exclusion", async () => {
    const logSpy = vi
      .spyOn(logger, "debug")
      .mockImplementation(() => logger as never);
    const service = new BrowserService();
    const broken = createTarget({
      id: "broken",
      priority: 200,
      availableError: new Error("probe boom"),
    });
    const workspace = createTarget({ id: "workspace", priority: 100 });
    service.registerTarget(broken);
    service.registerTarget(workspace);

    // Automatic (unpinned) resolution must not throw: the broken candidate is
    // skipped and the next healthy target is selected (designed failover).
    const result = await service.execute({ subaction: "state" });
    expect(result.value).toBe("workspace");
    expect(broken.execute).not.toHaveBeenCalled();
    // The exclusion is observable, not silently swallowed by an empty catch.
    expect(
      logSpy.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].includes('"broken"') &&
          call[0].includes("probe boom"),
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Capability-aware dispatch (issue #18258)
// ---------------------------------------------------------------------------

describe("BrowserService capability-aware dispatch (#18258)", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("selects a capable target before dispatch and skips an incapable one pre-dispatch", async () => {
    const service = new BrowserService();
    // bridge only supports read-only subactions
    const bridge = createTarget({
      id: "bridge",
      priority: 200,
      supports: (cmd) => cmd.subaction === "state" || cmd.subaction === "list",
    });
    // workspace supports everything
    const workspace = createTarget({ id: "workspace", priority: 100 });

    service.registerTarget(bridge);
    service.registerTarget(workspace);

    // A `click` is side-effecting and the bridge doesn't support it — workspace
    // must be selected (the bridge.execute is never called).
    const result = await service.execute({
      subaction: "click",
      selector: "#btn",
    });

    expect(result.value).toBe("workspace");
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(workspace.execute).toHaveBeenCalledTimes(1);
  });

  it("prefers the higher-scoring capable target when it supports the command", async () => {
    const service = new BrowserService();
    const bridge = createTarget({
      id: "bridge",
      priority: 200,
      supports: (cmd) => cmd.subaction === "state",
    });
    const workspace = createTarget({ id: "workspace", priority: 100 });

    service.registerTarget(bridge);
    service.registerTarget(workspace);

    const result = await service.execute({ subaction: "state" });

    expect(result.value).toBe("bridge");
  });

  it("returns a typed UNSUPPORTED failure when no available target supports the command", async () => {
    const service = new BrowserService();
    const readonlyOnly = createTarget({
      id: "readonly",
      priority: 100,
      supports: (cmd) => cmd.subaction === "state",
    });
    service.registerTarget(readonlyOnly);

    try {
      await service.execute({ subaction: "click", selector: "#btn" });
      throw new Error("expected UNSUPPORTED failure");
    } catch (error) {
      expect(isBrowserDispatchFailure(error)).toBe(true);
      const failure = error as BrowserDispatchFailure;
      expect(failure.kind).toBe("UNSUPPORTED");
      expect(failure.fallbackSafe).toBe(true);
      expect(readonlyOnly.execute).not.toHaveBeenCalled();
    }
  });

  it("returns a typed UNAVAILABLE failure when no target is available", async () => {
    const service = new BrowserService();
    service.registerTarget(
      createTarget({ id: "workspace", priority: 100, available: false }),
    );

    try {
      await service.execute({ subaction: "state" });
      throw new Error("expected UNAVAILABLE failure");
    } catch (error) {
      expect(isBrowserDispatchFailure(error)).toBe(true);
      expect((error as BrowserDispatchFailure).kind).toBe("UNAVAILABLE");
      expect((error as BrowserDispatchFailure).fallbackSafe).toBe(true);
    }
  });

  it("does not fall back when the caller pins a target", async () => {
    const service = new BrowserService();
    const workspace = createTarget({
      id: "workspace",
      priority: 100,
      fail: true,
    });
    const bridge = createTarget({ id: "bridge", priority: 80 });
    service.registerTarget(workspace);
    service.registerTarget(bridge);

    await expect(
      service.execute({ subaction: "state" }, "workspace"),
    ).rejects.toThrow("workspace failed");
    // bridge.execute must never have been called — pinned, no fallback.
    expect(bridge.execute).not.toHaveBeenCalled();
  });

  it("returns a typed UNSUPPORTED failure when a pinned target does not support the command", async () => {
    const service = new BrowserService();
    const bridge = createTarget({
      id: "bridge",
      priority: 80,
      supports: (cmd) => cmd.subaction === "state",
    });
    const workspace = createTarget({ id: "workspace", priority: 100 });
    service.registerTarget(bridge);
    service.registerTarget(workspace);

    try {
      await service.execute({ subaction: "click", selector: "#x" }, "bridge");
      throw new Error("expected UNSUPPORTED");
    } catch (error) {
      expect(isBrowserDispatchFailure(error)).toBe(true);
      expect((error as BrowserDispatchFailure).kind).toBe("UNSUPPORTED");
      // workspace is not tried because the pin is honored.
      expect(workspace.execute).not.toHaveBeenCalled();
    }
  });

  it("NEVER replays a non-idempotent (side-effecting) command after dispatch, even on failure", async () => {
    const service = new BrowserService();
    const primary = createTarget({
      id: "primary",
      priority: 200,
      fail: true, // throws after dispatch
    });
    const fallback = createTarget({ id: "fallback", priority: 100 });
    service.registerTarget(primary);
    service.registerTarget(fallback);

    // `click` is side-effecting. Once primary.execute throws, the command must
    // NOT be retried on fallback — it may have already clicked.
    await expect(
      service.execute({ subaction: "click", selector: "#submit" }),
    ).rejects.toThrow();

    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it("classifies an opaque failure of a side-effecting command as UNCERTAIN_OUTCOME", async () => {
    const service = new BrowserService();
    const primary = createTarget({
      id: "primary",
      priority: 200,
      fail: true,
    });
    service.registerTarget(primary);

    try {
      await service.execute({ subaction: "navigate", url: "https://x.test" });
      throw new Error("expected failure");
    } catch (error) {
      expect(isBrowserDispatchFailure(error)).toBe(true);
      const failure = error as BrowserDispatchFailure;
      expect(failure.kind).toBe("UNCERTAIN_OUTCOME");
      expect(failure.fallbackSafe).toBe(false);
      expect(failure.targetId).toBe("primary");
    }
  });

  it("does not wrap an opaque failure of an idempotent (read-only) command as UNCERTAIN_OUTCOME", async () => {
    const service = new BrowserService();
    const primary = createTarget({
      id: "primary",
      priority: 200,
      fail: true,
    });
    service.registerTarget(primary);

    // `state` is idempotent — no side effect is possible, so the original error
    // is rethrown (not wrapped in BrowserDispatchFailure).
    await expect(service.execute({ subaction: "state" })).rejects.toThrow(
      "primary failed",
    );
  });

  it("preserves a typed BrowserDispatchFailure thrown by the target", async () => {
    const service = new BrowserService();
    const sessionGone = new BrowserDispatchFailure(
      "SESSION_GONE",
      "The Steel session has ended.",
      { targetId: "cloud" },
    );
    const cloud = createTarget({
      id: "cloud",
      priority: 200,
      executeMock: vi.fn(async () => {
        throw sessionGone;
      }),
    });
    service.registerTarget(cloud);

    try {
      await service.execute({ subaction: "navigate", url: "https://x.test" });
      throw new Error("expected failure");
    } catch (error) {
      // The exact failure thrown by the target is preserved (not re-wrapped).
      expect(error).toBe(sessionGone);
    }
  });

  it("pre-dispatch fallback across candidates is permitted for UNSUPPORTED before execution begins", async () => {
    const service = new BrowserService();
    // Higher-scoring target that does NOT support `click`.
    const readonly = createTarget({
      id: "readonly",
      priority: 200,
      supports: (cmd) => cmd.subaction === "state",
    });
    // Lower-scoring target that DOES support `click`.
    const workspace = createTarget({ id: "workspace", priority: 100 });
    service.registerTarget(readonly);
    service.registerTarget(workspace);

    const result = await service.execute({
      subaction: "click",
      selector: "#b",
    });

    expect(result.value).toBe("workspace");
    // readonly was skipped pre-dispatch (never executed).
    expect(readonly.execute).not.toHaveBeenCalled();
    expect(workspace.execute).toHaveBeenCalledTimes(1);
  });

  it("preserves pinned target availability failures as typed errors", async () => {
    const service = new BrowserService();
    const availabilityError = new Error("bridge health probe failed");
    service.registerTarget(
      createTarget({
        id: "bridge",
        priority: 80,
        availableError: availabilityError,
      }),
    );
    service.registerTarget(createTarget({ id: "workspace", priority: 100 }));

    try {
      await service.execute({ subaction: "state" }, "bridge");
      throw new Error("expected pinned target availability failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe("BROWSER_TARGET_UNAVAILABLE");
      expect((error as ElizaError).context).toEqual({
        targetId: "bridge",
        subaction: "state",
      });
      expect((error as ElizaError).severity).toBe("ephemeral");
      expect((error as Error).cause).toBe(availabilityError);
    }
  });
});

describe("BrowserService workspace snapshot seam (item #12091-14)", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exposes the live workspace snapshot so hosts read it via the runtime service, not a plugin import", async () => {
    const service = new BrowserService();
    const snapshot = await service.getWorkspaceSnapshot();
    expect(typeof snapshot.mode).toBe("string");
    expect(Array.isArray(snapshot.tabs)).toBe(true);
  });
});

describe("isIdempotentBrowserSubaction", () => {
  it("classifies read-only subactions as idempotent", () => {
    expect(isIdempotentBrowserSubaction("state")).toBe(true);
    expect(isIdempotentBrowserSubaction("list")).toBe(true);
    expect(isIdempotentBrowserSubaction("get")).toBe(true);
    expect(isIdempotentBrowserSubaction("snapshot")).toBe(true);
    expect(isIdempotentBrowserSubaction("screenshot")).toBe(true);
  });

  it("classifies side-effecting subactions as non-idempotent", () => {
    expect(isIdempotentBrowserSubaction("click")).toBe(false);
    expect(isIdempotentBrowserSubaction("type")).toBe(false);
    expect(isIdempotentBrowserSubaction("fill")).toBe(false);
    expect(isIdempotentBrowserSubaction("navigate")).toBe(false);
    expect(isIdempotentBrowserSubaction("open")).toBe(false);
    expect(isIdempotentBrowserSubaction("upload")).toBe(false);
    expect(isIdempotentBrowserSubaction("dblclick")).toBe(false);
    expect(isIdempotentBrowserSubaction("scroll")).toBe(false);
    expect(isIdempotentBrowserSubaction("press")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bridge capability manifest regression (issue #18258 review P1 #2)
//
// The bridge target advertises session-gated subactions (open/navigate/close/
// show/hide/back/forward/reload) in BRIDGE_SUPPORTED_SUBACTIONS. But the
// executor unconditionally rejects every one of them because a LifeOps session
// is required. An unpinned side-effecting command can therefore select the
// high-priority bridge as "capable", hit a known pre-execution rejection, and
// be mislabeled UNCERTAIN_OUTCOME instead of selecting a genuinely capable
// target. The fix: BRIDGE_SUPPORTED_SUBACTIONS must only include subactions
// the bridge can execute directly, not session-gated ones.
// ---------------------------------------------------------------------------

describe("Bridge capability manifest excludes session-gated subactions (#18258 review)", () => {
  it("BRIDGE_SUPPORTED_SUBACTIONS does not advertise session-gated operations", async () => {
    const { BRIDGE_SUPPORTED_SUBACTIONS } = await import(
      "../targets/bridge-target.js"
    );

    // Direct-executable subactions the bridge handles without a session.
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("list")).toBe(true);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("state")).toBe(true);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("get")).toBe(true);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("tab")).toBe(true);

    // Session-gated subactions — must NOT be in the manifest so the
    // pre-dispatch capability check skips the bridge for them.
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("open")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("navigate")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("close")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("show")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("hide")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("back")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("forward")).toBe(false);
    expect(BRIDGE_SUPPORTED_SUBACTIONS.has("reload")).toBe(false);
  });

  it("does not select the bridge for a session-gated side-effecting command", async () => {
    // Simulate the real bridge-vs-workspace race: bridge has higher priority
    // and advertises only direct subactions. A `navigate` (session-gated,
    // side-effecting) must skip the bridge and select workspace.
    const service = new BrowserService();

    // Mirror the real bridge target's capability manifest.
    const bridge = createTarget({
      id: "bridge",
      priority: 200,
      score: () => 160,
      supports: (cmd) => {
        // Only direct-executable subactions.
        return ["list", "state", "get", "tab"].includes(cmd.subaction);
      },
    });

    // Workspace supports everything.
    const workspace = createTarget({ id: "workspace", priority: 100 });

    service.registerTarget(bridge);
    service.registerTarget(workspace);

    // navigate is side-effecting and session-gated — bridge must be skipped.
    const result = await service.execute({
      subaction: "navigate",
      url: "https://example.test",
    });

    expect(result.value).toBe("workspace");
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(workspace.execute).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel a session-gated operation as UNCERTAIN_OUTCOME when the bridge skips it", async () => {
    // Regression: previously the bridge was selected as "capable" for
    // session-gated ops, then rejected at execute time, which for a
    // side-effecting command was classified as UNCERTAIN_OUTCOME.
    // Now the bridge is skipped pre-dispatch and a capable workspace is
    // selected instead — no UNCERTAIN_OUTCOME.
    const service = new BrowserService();

    const bridge = createTarget({
      id: "bridge",
      priority: 200,
      score: () => 160,
      supports: (cmd) =>
        ["list", "state", "get", "tab"].includes(cmd.subaction),
      fail: true, // even if selected, it would fail
    });
    const workspace = createTarget({ id: "workspace", priority: 100 });

    service.registerTarget(bridge);
    service.registerTarget(workspace);

    const result = await service.execute({
      subaction: "open",
      url: "https://example.test",
    });

    // Workspace handles it successfully — bridge was never called.
    expect(result.value).toBe("workspace");
    expect(bridge.execute).not.toHaveBeenCalled();
  });
});
