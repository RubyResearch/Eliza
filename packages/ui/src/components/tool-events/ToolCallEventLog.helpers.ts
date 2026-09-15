/**
 * Pure derivations for `ToolCallEventLog`: maps a `NativeToolCallEvent` to its
 * running/success/preview/failure display state and resolves a human-readable tool name
 * from whichever of the event's name/id fields is populated. Kept
 * component-free so the mapping can be unit-tested without a DOM.
 */
import { normalizeEffectReceipts } from "@elizaos/core";
import type { NativeToolCallEvent } from "../../api/client-types-cloud";
import type { ToolCallEventDisplayState } from "./ToolCallEventLog";

function hasOnlyPreviewReceipts(value: unknown): boolean {
  try {
    const receipts = normalizeEffectReceipts(value);
    return (
      receipts.length > 0 &&
      receipts.every((receipt) => receipt.outcome === "preview")
    );
  } catch {
    // error-policy:J3 Invalid receipts are not accepted as evidence of a preview.
    return false;
  }
}

export function getToolCallEventDisplayState(
  event: NativeToolCallEvent,
): ToolCallEventDisplayState {
  const result = event.result ?? event.output;
  if (
    !event.error &&
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    !("error" in result && result.error) &&
    "effectReceipts" in result
  ) {
    if (hasOnlyPreviewReceipts(result.effectReceipts)) return "preview";
  }
  if (event.type === "tool_error" || event.status === "failed" || event.error) {
    return "failure";
  }
  if (
    event.type === "tool_result" ||
    event.status === "completed" ||
    event.success === true
  ) {
    return "success";
  }
  return "running";
}

export function getToolCallName(event: NativeToolCallEvent): string {
  return (
    event.actionName ||
    event.toolName ||
    event.name ||
    event.callId ||
    event.toolCallId ||
    "tool"
  );
}
