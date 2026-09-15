/**
 * Stops a supervised Telegraf launch and waits for its polling loop to settle.
 * Telegraf exposes its polling object only after asynchronous startup; stopping
 * during that interval must retain ownership until the actual loop has ended.
 */
import { ElizaError } from "@elizaos/core";
import type { Context, Telegraf } from "telegraf";

export function stopTelegramPolling(
  bot: Telegraf<Context>,
  completion: Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stoppedPolling: object | undefined;
    const finish = (ok: boolean, error?: unknown): void => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      if (!ok) reject(error);
      else resolve();
    };
    completion.then(
      () => finish(true),
      (error) => finish(false, error),
    );
    const inspect = (): void => {
      if (finished) return;
      const polling = (bot as unknown as { polling?: { stop?: unknown } })
        .polling;
      if (typeof polling?.stop === "function" && polling !== stoppedPolling) {
        try {
          bot.stop("service-stop");
          stoppedPolling = polling;
        } catch (cause) {
          // error-policy:J2 A failed stop cannot establish a drained poller.
          finish(
            false,
            new ElizaError(
              "Telegram polling could not be stopped. Retry shutdown.",
              {
                code: "TELEGRAM_POLLER_STOP_FAILED",
                cause,
              },
            ),
          );
          return;
        }
      }
      timer = setTimeout(inspect, 10);
      timer.unref?.();
    };
    // A completed launch must settle before inspecting its old polling object.
    queueMicrotask(inspect);
  });
}
