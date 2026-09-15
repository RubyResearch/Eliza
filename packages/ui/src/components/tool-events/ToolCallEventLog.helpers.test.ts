/**
 * Unit tests for ToolCallEventLog helpers: validates event state derivation and naming.
 */
import { describe, expect, it } from "vitest";
import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import {
  getToolCallEventDisplayState,
  getToolCallName,
} from "./ToolCallEventLog.helpers.ts";

describe("ToolCallEventLog.helpers", () => {
  it("derives failure state for errors or failed status", () => {
    const ev1: NativeToolCallEvent = {
      error: "failed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev1)).toBe("failure");

    const ev2: NativeToolCallEvent = {
      status: "failed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev2)).toBe("failure");
  });

  it("derives success state for completed status or success flag", () => {
    const ev1: NativeToolCallEvent = {
      status: "completed",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev1)).toBe("success");

    const ev2: NativeToolCallEvent = {
      success: true,
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev2)).toBe("success");
  });

  it("defaults to running state for in-flight events", () => {
    const ev: NativeToolCallEvent = {
      status: "started",
    } as unknown as NativeToolCallEvent;
    expect(getToolCallEventDisplayState(ev)).toBe("running");
  });

  it("distinguishes valid preview-only receipts without hiding real errors or invalid receipts", () => {
    const receipt = {
      receiptId: "preview-1",
      operation: "routine.preview",
      resource: { kind: "draft", id: "draft-1" },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: "2026-09-10T20:23:13.166Z",
      outcome: "preview",
    };
    const event: NativeToolCallEvent = {
      id: "event",
      type: "tool_error",
      status: "failed",
      success: false,
      result: { success: false, effectReceipts: [receipt] },
    };
    expect(getToolCallEventDisplayState(event)).toBe("preview");
    expect(
      getToolCallEventDisplayState({ ...event, error: "receipt rejected" }),
    ).toBe("failure");
    expect(
      getToolCallEventDisplayState({
        ...event,
        result: { effectReceipts: [{ outcome: "preview" }] },
      }),
    ).toBe("failure");
    expect(
      getToolCallEventDisplayState({
        ...event,
        result: {
          error: "backend rejected preview",
          effectReceipts: [receipt],
        },
      }),
    ).toBe("failure");
    expect(
      getToolCallEventDisplayState({
        ...event,
        result: {
          effectReceipts: [
            receipt,
            {
              ...receipt,
              receiptId: "applied-2",
              outcome: "applied",
              commit: {
                kind: "durable",
                id: "commit-2",
                committedAt: receipt.observedAt,
              },
            },
          ],
        },
      }),
    ).toBe("failure");
    expect(
      getToolCallEventDisplayState({
        ...event,
        result: { effectReceipts: [] },
      }),
    ).toBe("failure");
  });

  it("resolves tool call name from available event fields", () => {
    expect(
      getToolCallName({
        actionName: "git_commit",
      } as unknown as NativeToolCallEvent),
    ).toBe("git_commit");
    expect(
      getToolCallName({ toolName: "bash" } as unknown as NativeToolCallEvent),
    ).toBe("bash");
    expect(
      getToolCallName({ name: "edit" } as unknown as NativeToolCallEvent),
    ).toBe("edit");
    expect(getToolCallName({} as unknown as NativeToolCallEvent)).toBe("tool");
  });
});
