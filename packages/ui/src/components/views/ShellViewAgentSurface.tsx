/**
 * ShellViewAgentSurface — makes a shell-rendered builtin view (settings,
 * character, …) agent-controllable, the same way DynamicViewLoader does for
 * dynamically-loaded plugin bundles.
 *
 * Builtin views are rendered directly by the app shell rather than through the
 * bundle loader, so they don't get the loader's AgentSurfaceProvider + interact
 * bridge for free. Wrapping a page in this component gives it a registry, the
 * indicator overlay, and a WS interact handler — so the agent can list-elements
 * / agent-click / agent-fill it by id exactly like a plugin view. The page's
 * controls opt in with `useAgentElement`.
 */

import { type ReactNode, useEffect, useRef } from "react";
import {
  AgentElementOverlay,
  AgentSurfaceElementReporter,
  AgentSurfaceProvider,
  type AgentViewType,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
} from "../../agent-surface";
import type { RegisteredAgentSurfaceKind } from "../../app-shell-registry";
import { registerViewInteractHandler } from "./view-interact-registry";

function idParam(params: Record<string, unknown> | undefined): string | null {
  const id = params?.agentId ?? params?.id;
  return typeof id === "string" ? id : null;
}

export interface ShellViewAgentSurfaceProps {
  /** Stable builtin view id (matches the entry in builtin-views.ts). */
  viewId: string;
  viewType?: AgentViewType;
  /** Registry family that generated this bridge owner, when applicable. */
  surfaceKind?: RegisteredAgentSurfaceKind | "builtin";
  /** Reads an isolated child page rather than the shell's own DOM text. */
  readPage?: (selector?: string) => Promise<unknown>;
  children: ReactNode;
}

export function ShellViewAgentSurface({
  viewId,
  viewType = "gui",
  surfaceKind = "builtin",
  readPage,
  children,
}: ShellViewAgentSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pageReader = useRef(readPage);
  pageReader.current = readPage;

  useEffect(() => {
    return registerViewInteractHandler(
      viewId,
      viewType,
      async (capability, params) => {
        const registry = getViewRegistry(viewId, viewType);
        if (isAgentSurfaceCapability(capability)) {
          if (!registry) {
            throw new Error(
              `Shell view "${viewId}" has no agent surface registered yet`,
            );
          }
          return handleAgentSurfaceCapability(registry, capability, params);
        }
        switch (capability) {
          case "get-text":
            if (pageReader.current) {
              if (
                params?.selector !== undefined &&
                typeof params.selector !== "string"
              ) {
                throw new Error("Page text selector must be a string.");
              }
              return pageReader.current(params?.selector as string | undefined);
            }
            if (params?.nativeOnly === true) {
              throw new Error(
                "The requesting view has no mounted native page reader.",
              );
            }
            return containerRef.current?.innerText ?? "";
          case "get-state":
            return registry && registry.size() > 0 ? registry.snapshot() : {};
          case "focus-element": {
            const id = idParam(params);
            if (id && registry) {
              const r = registry.focus(id);
              return { focused: r.ok, id, reason: r.reason };
            }
            return { focused: false, reason: "agentId required" };
          }
          case "click-element": {
            const id = idParam(params);
            if (id && registry) {
              const r = registry.click(id);
              return { clicked: r.ok, id, reason: r.reason };
            }
            return { clicked: false, reason: "agentId required" };
          }
          case "fill-input": {
            const id = idParam(params);
            const value =
              typeof params?.value === "string" ? params.value : null;
            if (value === null) {
              return { filled: false, reason: "value must be a string" };
            }
            if (id && registry) {
              const r = registry.fill(id, value);
              return { filled: r.ok, id, reason: r.reason, value };
            }
            return { filled: false, reason: "agentId required" };
          }
          default:
            throw new Error(
              `Shell view "${viewId}" does not support capability "${capability}"`,
            );
        }
      },
    );
  }, [viewId, viewType]);

  return (
    <AgentSurfaceProvider viewId={viewId} viewType={viewType}>
      <div
        ref={containerRef}
        className="contents"
        data-agent-surface-kind={surfaceKind}
        data-agent-surface-view-id={viewId}
      >
        {children}
      </div>
      <AgentElementOverlay />
      <AgentSurfaceElementReporter />
    </AgentSurfaceProvider>
  );
}
