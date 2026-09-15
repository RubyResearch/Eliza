/**
 * Owner linked-calendar route tests exercise the real route dispatcher with
 * deterministic host plumbing and prove consequential writes cross the shared
 * mutation gateway instead of calling CalendarService directly.
 */

import type { LifeOpsLinkedCalendarLink } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type CalendarRouteDeps,
  handleCalendarRoutes,
} from "./calendar-routes.js";

function route(
  method: string,
  pathname: string,
  body: Record<string, unknown> | null,
) {
  const json = vi.fn();
  const service = {
    listLinkedCalendarEvents: vi.fn(async () => []),
    listLinkedCalendarEventViews: vi.fn(async () => [
      { id: "link-1", event: null },
    ]),
    getLinkedCalendarEvent: vi.fn(async () => ({ id: "link-1" })),
  };
  const replacementLink: LifeOpsLinkedCalendarLink = {
    id: "link-1",
    localEventId: "local-1",
    connectorAccountId: "replacement",
    providerCalendarId: "family",
    providerEventId: null,
    providerEtag: null,
    localRevision: 1,
    state: "dirty",
    pendingOperation: "create",
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: "2026-09-10T12:00:00Z",
    updatedAt: "2026-09-10T12:00:00Z",
  };
  const mutationGateway = {
    updateLinkedCalendarControl: vi.fn(async () => ({
      revision: 4,
      paused: true,
      destination: null,
      pendingDispatch: null,
    })),
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    linkCalendar: vi.fn(async () => ({ outcome: "pushed" })),
    reconcileLinkedCalendar: vi.fn(async () => ({ outcome: "clean" })),
    resolveLinkedCalendarConflict: vi.fn(async () => ({ outcome: "pulled" })),
    rebindLinkedCalendar: vi.fn(async () => ({
      providerMutation: "none" as const,
      previous: replacementLink,
      link: replacementLink,
      controlRevision: 2,
      receipt: { operationKey: "rebind-test", replayed: false },
    })),
    disconnectLinkedCalendar: vi.fn(async () => ({ outcome: "paused" })),
    reconcileLinkedCalendarProviderChanges: vi.fn(),
  };
  const deps: CalendarRouteDeps = {
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    async runRoute(fn) {
      await fn(service as never);
      return true;
    },
    rateLimit: vi.fn(() => false),
    json,
    readJsonBody: vi.fn(async () => body),
    decodePathComponent: (raw) => decodeURIComponent(raw),
    parseConnectorMode: () => undefined,
    parseConnectorSide: () => undefined,
    parseBoolean: () => undefined,
    serviceError: (_status, message) => new Error(message),
    mutationGateway,
  };
  return { deps, json, mutationGateway, service };
}

describe("linked calendar owner routes", () => {
  it("returns event review data only when explicitly requested", async () => {
    const test = route("GET", "/api/lifeops/calendar/links", null);
    test.deps.url.searchParams.set("view", "events");
    await handleCalendarRoutes(test.deps);
    expect(test.json).toHaveBeenCalledWith({
      links: [{ id: "link-1", event: null }],
    });
    expect(test.service.listLinkedCalendarEvents).not.toHaveBeenCalled();
    test.deps.url.searchParams.delete("view");
    await handleCalendarRoutes(test.deps);
    expect(test.json).toHaveBeenLastCalledWith({ links: [] });
  });

  it("routes a reviewed replacement through the owner gateway", async () => {
    const body = {
      expectedUpdatedAt: "2026-09-10T12:00:00Z",
      expectedLocalRevision: 1,
      expectedControlRevision: 3,
      connectorAccountId: "replacement",
      providerCalendarId: "family",
      idempotencyKey: "rebind-test",
      retainPreviousProviderEvent: true,
    };
    const test = route(
      "POST",
      "/api/lifeops/calendar/links/link-1/rebind",
      body,
    );
    expect(await handleCalendarRoutes(test.deps)).toBe(true);
    expect(
      test.mutationGateway.rebindLinkedCalendar,
    ).toHaveBeenCalledExactlyOnceWith(test.deps.url, "link-1", body);
    expect(
      test.mutationGateway.disconnectLinkedCalendar,
    ).not.toHaveBeenCalled();
    expect(test.json).toHaveBeenCalledWith(
      expect.objectContaining({ providerMutation: "none" }),
    );
    const missing = route(
      "POST",
      "/api/lifeops/calendar/links/link-1/rebind",
      null,
    );
    await handleCalendarRoutes(missing.deps);
    expect(missing.mutationGateway.rebindLinkedCalendar).not.toHaveBeenCalled();
  });

  it("routes link creation through the existing owner mutation gateway", async () => {
    const request = {
      localEventId: "local-1",
      connectorAccountId: "google-1",
      providerCalendarId: "primary",
      idempotencyKey: "request-1",
    };
    const test = route("POST", "/api/lifeops/calendar/links", request);

    await expect(handleCalendarRoutes(test.deps)).resolves.toBe(true);
    expect(test.mutationGateway.linkCalendar).toHaveBeenCalledWith(
      test.deps.url,
      request,
    );
    expect(test.service.listLinkedCalendarEvents).not.toHaveBeenCalled();
    expect(test.json).toHaveBeenCalledWith({ outcome: "pushed" }, 201);
  });

  it("preserves the explicit retention contract when disconnecting", async () => {
    const request = { retainEvents: true, idempotencyKey: "disconnect-1" };
    const test = route(
      "POST",
      "/api/lifeops/calendar/links/link-1/disconnect",
      request,
    );

    await expect(handleCalendarRoutes(test.deps)).resolves.toBe(true);
    expect(test.mutationGateway.disconnectLinkedCalendar).toHaveBeenCalledWith(
      test.deps.url,
      "link-1",
      request,
    );
    expect(test.json).toHaveBeenCalledWith({ outcome: "paused" });
  });

  it("routes a revision-bound pause through the owner mutation gateway", async () => {
    const request = {
      operation: "pause",
      expectedRevision: 3,
      idempotencyKey: "pause-review",
    };
    const test = route("POST", "/api/lifeops/calendar/sync-control", request);
    await expect(handleCalendarRoutes(test.deps)).resolves.toBe(true);
    expect(
      test.mutationGateway.updateLinkedCalendarControl,
    ).toHaveBeenCalledWith(test.deps.url, request);
    expect(test.json).toHaveBeenCalledWith({
      revision: 4,
      paused: true,
      destination: null,
      pendingDispatch: null,
    });
  });
});
