/**
 * Unit tests for `TelegramService.launchPollerSupervised` — the supervised
 * launch that replaces `await bot.launch()`. Telegraf v4's `bot.launch()`
 * resolves only when polling stops, so awaiting it for completion strands every
 * post-launch step (dedup registration, `setMyCommands`, shutdown handlers).
 * These tests drive a controllable fake Telegraf bot (its `launch(config,
 * onLaunch)` deferred is resolved/rejected by the test) to prove: initial
 * startup waits for a stoppable polling object; readiness timers are bounded
 * and cancelled on launch failure; a post-connect poll failure self-heals with
 * backed-off relaunches; and token takeover cancels the loser's relaunch.
 * Runtime, timers, and `@elizaos/core` (logger/Service) are mocked.
 */
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTelegramPollerClaim } from "./poller-lock";
import { TelegramService } from "./service";

const CONFLICT = "409: Conflict: terminated by other getUpdates request";

type SupervisedLaunch = (
  bot: unknown,
  botToken: string | null | undefined,
  accountId: string,
) => Promise<void>;

function callLaunch(
  service: TelegramService,
  bot: unknown,
  botToken: string | null,
  accountId: string,
): Promise<void> {
  return (
    service as unknown as { launchPollerSupervised: SupervisedLaunch }
  ).launchPollerSupervised(bot, botToken, accountId);
}

interface LaunchCall {
  config: { dropPendingUpdates?: boolean; allowedUpdates?: string[] };
  onLaunch: () => void;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function makeBot() {
  const calls: LaunchCall[] = [];
  const bot = {
    launch: vi.fn(
      (config: LaunchCall["config"], onLaunch: () => void): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          calls.push({ config, onLaunch, resolve, reject });
        }),
    ),
    stop: vi.fn(),
  };
  return { bot, calls };
}

function makeService() {
  const runtime = { agentId: "agent-test", reportError: vi.fn() };
  const service = Object.assign(
    Object.create(TelegramService.prototype) as TelegramService,
    { runtime, pollerCompletions: new Map(), pollerRetryTimers: new Set() },
  );
  return { service, runtime };
}

async function exposeStoppablePoller(bot: unknown): Promise<void> {
  (bot as { polling?: { stop: ReturnType<typeof vi.fn> } }).polling = {
    stop: vi.fn(),
  };
  await vi.advanceTimersByTimeAsync(10);
}

// Flush the microtask that runs the launch promise's rejection handler before
// its backoff `setTimeout` is scheduled.
async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("TelegramService.launchPollerSupervised", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a stoppable poller after the connect signal", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();

    const launched = callLaunch(service, bot, "tok-connect", "acct");
    // The poll loop is still running (launch promise stays pending); the caller
    // must proceed off the connect callback, not off loop completion.
    expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(calls[0].config).toEqual({
      dropPendingUpdates: false,
      allowedUpdates: ["message", "message_reaction", "callback_query"],
    });

    calls[0].onLaunch();
    await exposeStoppablePoller(bot);
    await expect(launched).resolves.toBeUndefined();
  });

  it("cancels the readiness timer when launch fails before polling exists", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();
    const failure = new Error("deleteWebhook failed");

    const launched = callLaunch(service, bot, "tok-fail", "acct");
    const rejected = expect(launched).rejects.toBe(failure);
    calls[0].onLaunch();
    calls[0].reject(failure);
    await flushMicrotasks();

    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("warns but keeps the original launch fenced beyond 30 seconds", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();
    const loggerWarn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const launched = callLaunch(service, bot, "tok-timeout", "acct");
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const observed = launched.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    calls[0].onLaunch();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(outcome).toBe("pending");
    expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(getTelegramPollerClaim("tok-timeout")?.bot).toBe(bot);
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ pollerReadyWarningMs: 30_000 }),
      expect.stringContaining("waiting for a stoppable poller"),
    );

    await exposeStoppablePoller(bot);
    await observed;
    expect(outcome).toBe("resolved");
    expect(bot.launch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("self-heals a post-connect poll failure with a bounded, backed-off relaunch and then gives up", async () => {
    const { bot, calls } = makeBot();
    const { service, runtime } = makeService();
    const loggerError = vi.spyOn(logger, "error").mockImplementation(() => {});

    const launched = callLaunch(service, bot, "tok-heal", "acct");
    calls[0].onLaunch();
    await exposeStoppablePoller(bot);
    await launched;

    // Persistent conflict on every attempt: backoff doubles (2^n s) capped at
    // 30s, and each attempt reuses the same bot instance (no re-registration of
    // handlers). Five relaunches → six launches total.
    const backoffsMs = [2000, 4000, 8000, 16000, 30000];
    for (let i = 0; i < backoffsMs.length; i++) {
      calls[i].reject(new Error(CONFLICT));
      await flushMicrotasks();
      expect(runtime.reportError).toHaveBeenCalledWith(
        "telegram:poll",
        expect.any(Error),
        expect.objectContaining({ accountId: "acct" }),
      );
      await vi.advanceTimersByTimeAsync(backoffsMs[i]);
      expect(bot.launch).toHaveBeenCalledTimes(i + 2);
    }

    // Sixth failure exceeds the relaunch budget: give up, do not relaunch.
    calls[5].reject(new Error(CONFLICT));
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bot.launch).toHaveBeenCalledTimes(6);
    expect(runtime.reportError).toHaveBeenCalledTimes(6);
    expect(loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ maxPollRelaunches: 5 }),
      expect.stringContaining("gave up"),
    );
  });

  it.each(["before failure", "during backoff"])(
    "does not restart a stopped service %s",
    async (stopTiming) => {
      const { bot, calls } = makeBot();
      const { service } = makeService();
      const token = `tok-stopped-${stopTiming}`;
      Object.assign(service, { bot, botToken: token });
      const launched = callLaunch(service, bot, token, "acct");
      calls[0].onLaunch();
      await exposeStoppablePoller(bot);
      await launched;

      const stopped = stopTiming === "before failure" ? service.stop() : null;
      calls[0].reject(new Error(CONFLICT));
      await flushMicrotasks();
      if (stopped) await stopped;
      else await service.stop();
      expect(getTelegramPollerClaim(token)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(bot.launch).toHaveBeenCalledTimes(1);
      expect(getTelegramPollerClaim(token)).toBeUndefined();
      const replacement = makeBot();
      const { service: replacementService } = makeService();
      const replacementStarted = callLaunch(
        replacementService,
        replacement.bot,
        token,
        "replacement",
      );
      replacement.calls[0].onLaunch();
      await exposeStoppablePoller(replacement.bot);
      await replacementStarted;
      expect(getTelegramPollerClaim(token)?.bot).toBe(replacement.bot);
      replacement.calls[0].resolve();
      await flushMicrotasks();
    },
  );

  it("retains ownership until the stopped polling loop has drained", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();
    const token = "tok-draining";
    Object.assign(service, { bot, botToken: token });
    const launched = callLaunch(service, bot, token, "acct");
    calls[0].onLaunch();
    await exposeStoppablePoller(bot);
    await launched;
    let stopped = false;
    const shutdown = service.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    expect(getTelegramPollerClaim(token)?.bot).toBe(bot);
    const replacement = makeBot();
    await expect(
      callLaunch(makeService().service, replacement.bot, token, "next"),
    ).rejects.toThrow(/already has an active/i);
    calls[0].resolve();
    await shutdown;
    expect(getTelegramPollerClaim(token)).toBeUndefined();
  });

  it("stops a launch that becomes stoppable after shutdown was requested", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();
    const token = "tok-stop-startup";
    Object.assign(service, { bot, botToken: token });
    const launched = callLaunch(service, bot, token, "acct");
    const startupResult = expect(launched).rejects.toThrow(/stopp/i);
    let stopped = false;
    const shutdown = service.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);
    expect(getTelegramPollerClaim(token)?.bot).toBe(bot);
    calls[0].onLaunch();
    await exposeStoppablePoller(bot);
    expect(bot.stop).toHaveBeenCalledWith("service-stop");
    calls[0].resolve();
    await shutdown;
    await startupResult;
    expect(getTelegramPollerClaim(token)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ownership when stopping fails and permits shutdown to be retried", async () => {
    const { bot, calls } = makeBot();
    const { service } = makeService();
    const token = "tok-stop-failure";
    Object.assign(service, { bot, botToken: token });
    const launched = callLaunch(service, bot, token, "acct");
    calls[0].onLaunch();
    await exposeStoppablePoller(bot);
    await launched;
    bot.stop.mockImplementation(() => {
      throw new Error("stop rejected");
    });
    await expect(service.stop()).rejects.toMatchObject({
      code: "TELEGRAM_SHUTDOWN_INCOMPLETE",
    });
    expect(getTelegramPollerClaim(token)?.bot).toBe(bot);
    expect(vi.getTimerCount()).toBe(0);
    bot.stop.mockReset();
    const shutdown = service.stop();
    await flushMicrotasks();
    calls[0].resolve();
    await shutdown;
    expect(getTelegramPollerClaim(token)).toBeUndefined();
  });

  it("fails loudly instead of replacing a poller that already owns the token", async () => {
    const first = makeBot();
    const second = makeBot();
    const { service } = makeService();

    const firstLaunched = callLaunch(
      service,
      first.bot,
      "tok-takeover",
      "acct",
    );
    first.calls[0].onLaunch();
    await exposeStoppablePoller(first.bot);
    await firstLaunched;

    await expect(
      callLaunch(service, second.bot, "tok-takeover", "acct"),
    ).rejects.toThrow(/already has an active/i);

    expect(first.bot.stop).not.toHaveBeenCalled();
    expect(second.bot.launch).not.toHaveBeenCalled();
  });
});
