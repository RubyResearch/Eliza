/**
 * Unit coverage for the chat generation-deadline path in `chat-routes.ts`:
 * how a timeout error is recognised, how it classifies (`generation_timeout`
 * rather than the generic `provider_issue`), and that the deadline actually
 * cancels the in-flight generation instead of merely abandoning it.
 *
 * Deterministic — no runtime, provider, or model call is involved; the
 * generation is a stub that observes the injected `AbortSignal`.
 */
import { describe, expect, it } from "vitest";
import {
  classifyChatFailure,
  getChatFailureReply,
  isChatGenerationTimeoutError,
  markSyntheticChatFailureContent,
  runWithGenerationTimeout,
} from "../chat-routes";

describe("chat failure classification", () => {
  it("reports failed reply grounding without blaming the provider or inviting action replay", () => {
    const err = Object.assign(new Error("Reply did not pass grounding"), {
      code: "REPLY_GROUNDING_FAILED",
    });
    const text = getChatFailureReply(err, []);
    expect(classifyChatFailure(err, [])).toBe("handler_error");
    expect(text).toContain("couldn't verify my reply");
    expect(text).not.toMatch(/provider|retry|try again/i);
    expect(markSyntheticChatFailureContent({ text })).toMatchObject({
      metadata: {
        elizaSyntheticFailure: true,
        chatFailureKind: "handler_error",
      },
    });
  });

  it("detects chat generation timeout errors", () => {
    expect(
      isChatGenerationTimeoutError(
        new Error("Chat generation timed out after 180000ms"),
      ),
    ).toBe(true);
    expect(isChatGenerationTimeoutError(new Error("network error"))).toBe(
      false,
    );
  });

  it("maps generation timeout to generation_timeout (not provider_issue)", () => {
    const err = new Error("Chat generation timed out after 180000ms");
    expect(classifyChatFailure(err, [])).toBe("generation_timeout");
    expect(getChatFailureReply(err, [])).toMatch(/taking too long/i);
    expect(getChatFailureReply(err, [])).not.toMatch(/provider issue/i);
  });
});

describe("runWithGenerationTimeout", () => {
  const timeoutError = () => new Error("Chat generation timed out after 10ms");

  it("returns the result and clears the deadline when generation wins", async () => {
    const result = await runWithGenerationTimeout(
      10_000,
      timeoutError,
      undefined,
      async () => "done",
    );
    expect(result).toBe("done");
  });

  it("aborts the in-flight generation when the deadline expires", async () => {
    let observed: AbortSignal | undefined;
    const settled = { aborted: false };

    await expect(
      runWithGenerationTimeout(10, timeoutError, undefined, (opts) => {
        observed = opts?.abortSignal;
        return new Promise((_resolve, reject) => {
          observed?.addEventListener("abort", () => {
            settled.aborted = true;
            reject(new Error("aborted by signal"));
          });
        });
      }),
    ).rejects.toThrow(/timed out/i);

    expect(settled.aborted).toBe(true);
    expect(observed?.aborted).toBe(true);
  });

  it("re-keys a cancellation-induced failure to the typed timeout error", async () => {
    const err = await runWithGenerationTimeout(
      10,
      timeoutError,
      undefined,
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("provider socket closed")), 30),
        ),
    ).catch((e: unknown) => e);

    expect(isChatGenerationTimeoutError(err)).toBe(true);
  });

  it("propagates a caller abort without mislabelling it as a timeout", async () => {
    const caller = new AbortController();
    const promise = runWithGenerationTimeout(
      10_000,
      timeoutError,
      { abortSignal: caller.signal },
      (opts) =>
        new Promise((_resolve, reject) => {
          opts?.abortSignal?.addEventListener("abort", () =>
            reject(new Error("caller cancelled")),
          );
        }),
    );
    caller.abort();

    const err = await promise.catch((e: unknown) => e);
    expect(isChatGenerationTimeoutError(err)).toBe(false);
    expect((err as Error).message).toMatch(/caller cancelled/i);
  });

  it("honours a caller signal that is already aborted", async () => {
    const err = await runWithGenerationTimeout(
      10_000,
      timeoutError,
      { abortSignal: AbortSignal.abort(new Error("already gone")) },
      (opts) =>
        opts?.abortSignal?.aborted
          ? Promise.reject(new Error("aborted before start"))
          : Promise.resolve("should not run"),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toMatch(/aborted before start/i);
  });
});
