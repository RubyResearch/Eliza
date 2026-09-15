/**
 * Canonical view-interact protocol contract shared by the agent server and the
 * UI. The agent's views route (`packages/agent/src/api/views-routes.ts`) and the
 * UI's DynamicViewLoader both dispatch against the same capability ids, so the
 * ids live here — in the shared workspace contract — rather than inside UI
 * internals, keeping the agent buildable without an `@elizaos/ui` dependency.
 *
 * The flow:
 *   1. Agent POSTs to /api/views/:id/interact with a ViewInteractRequest body.
 *   2. Server broadcasts a WS message {type:"view:interact", ...} to all clients.
 *   3. DynamicViewLoader receives the WS message, calls the view module's
 *      interact(capability, params) export (or a standard capability handler).
 *   4. Frontend sends {type:"view:interact:result", ...} back over WS.
 *   5. Server resolves the pending request and returns the result to the agent.
 */

export interface ViewInteractRequest {
  viewId: string;
  capability: string;
  params?: Record<string, unknown>;
  /** UUID generated server-side for correlating the async result. */
  requestId: string;
  /** Timeout in ms before the server gives up waiting. Default 5000. */
  timeoutMs?: number;
}

export interface ViewInteractResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

/** Renderer-owned delivery identity stamped on a runtime message, not model arguments. */
export function readViewInteractionClientId(message: {
  content: unknown;
}): string | undefined {
  if (
    !message.content ||
    typeof message.content !== "object" ||
    Array.isArray(message.content)
  )
    return undefined;
  const metadata = (message.content as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return undefined;
  const clientId = (metadata as Record<string, unknown>).viewClientId;
  return parseViewInteractionClientId(clientId);
}

/** Routing identifier only; never an authentication or permission credential. */
export function parseViewInteractionClientId(
  value: unknown,
): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value)
    ? value
    : undefined;
}

/** Standard capabilities that every view is expected to support. */
export const STANDARD_CAPABILITIES = {
  /** Returns the current view state as JSON. */
  GET_STATE: "get-state",
  /** Forces a data refresh / re-render. */
  REFRESH: "refresh",
  /** Focuses an input or button by CSS selector or name attribute. */
  FOCUS_ELEMENT: "focus-element",
  /** Returns the visible text content of the view container. */
  GET_TEXT: "get-text",
  /** Clicks an element by CSS selector or name attribute. Dispatched generically
   *  by DynamicViewLoader / ShellViewAgentSurface for every loaded view. */
  CLICK_ELEMENT: "click-element",
  /** Sets the value of an input by selector/name. Dispatched generically by
   *  DynamicViewLoader / ShellViewAgentSurface for every loaded view. */
  FILL_INPUT: "fill-input",
} as const;

export type StandardCapability =
  (typeof STANDARD_CAPABILITIES)[keyof typeof STANDARD_CAPABILITIES];

/**
 * Capability ids handled generically by the agent-surface registry (addressable
 * elements, focus, programmatic fill/click). DynamicViewLoader routes any of
 * these to the agent-surface capability handler before falling back to selector
 * handling.
 */
export const AGENT_SURFACE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "list-elements",
  "describe-element",
  "get-focus",
  "get-agent-state",
  "agent-click",
  "agent-fill",
  "agent-focus",
  "agent-scroll-to",
  "set-highlight",
]);
