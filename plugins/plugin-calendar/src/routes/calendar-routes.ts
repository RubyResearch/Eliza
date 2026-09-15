/**
 * Calendar HTTP route logic for `/api/lifeops/calendar/*`.
 *
 * The path → CalendarService mapping lives here so the calendar surface is
 * owned by the calendar plugin. The generic HTTP plumbing it needs — service
 * resolution + telemetry + schema bootstrap (`runRoute`), rate limiting, body
 * parsing, JSON writing — is host infrastructure and is injected via
 * {@link CalendarRouteDeps} so this module never depends on the host plugin
 * (dependency direction stays `host -> plugin-calendar`). Paths are unchanged
 * contract surface the client + task-coordinator depend on.
 */

import type {
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsIcsCalendarSourceRequest,
  CreateLifeOpsLinkedCalendarLinkRequest,
  DisconnectLifeOpsLinkedCalendarRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  ListLifeOpsCalendarsRequest,
  PurgeLifeOpsCalendarImportedDataRequest,
  RebindLifeOpsLinkedCalendarRequest,
  ResolveLifeOpsLinkedCalendarConflictRequest,
  RunLifeOpsLinkedCalendarReconciliationRequest,
  SeedLifeOpsCalendarRequest,
  SetLifeOpsCalendarIncludedRequest,
  UpdateLifeOpsIcsCalendarSourceRequest,
} from "@elizaos/shared";
import type { CalendarOwnerMutationGateway } from "./mutation-gateway.js";

export type CalendarRouteRateLimitKey =
  | "google_api_read"
  | "google_api_write"
  | "calendar_create"
  | "calendar_update"
  | "calendar_delete"
  | "calendar_source_read"
  | "calendar_source_write"
  | "calendar_source_sync"
  | "calendar_imported_data_purge"
  | "calendar_link_read"
  | "calendar_link_write";

/** The calendar method surface the route handlers invoke. */
export interface CalendarRouteService {
  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
  ): Promise<unknown>;
  listCalendars(
    requestUrl: URL,
    request?: ListLifeOpsCalendarsRequest,
  ): Promise<unknown>;
  setCalendarIncluded(
    requestUrl: URL,
    request: SetLifeOpsCalendarIncludedRequest,
  ): Promise<unknown>;
  getNextCalendarEventContext(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
  ): Promise<unknown>;
  createCalendarEvent(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
  ): Promise<unknown>;
  updateCalendarEvent(
    requestUrl: URL,
    request: Record<string, unknown> & { eventId: string },
  ): Promise<unknown>;
  deleteCalendarEvent(
    requestUrl: URL,
    request: { eventId: string } & Record<string, unknown>,
  ): Promise<void>;
  respondToCalendarEvent(
    requestUrl: URL,
    request: Record<string, unknown> & {
      eventId: string;
      responseStatus: "declined";
      expectedProviderVersion: string;
    },
  ): Promise<unknown>;
  getMeetingAutoJoin(): Promise<unknown>;
  setMeetingAutoJoin(policy: unknown): Promise<unknown>;
  listIcsCalendarSources(): Promise<unknown>;
  createIcsCalendarSource(
    request: CreateLifeOpsIcsCalendarSourceRequest,
  ): Promise<unknown>;
  updateIcsCalendarSource(
    sourceId: string,
    request: UpdateLifeOpsIcsCalendarSourceRequest,
  ): Promise<unknown>;
  deleteIcsCalendarSource(sourceId: string): Promise<void>;
  syncIcsCalendarSource(sourceId: string): Promise<unknown>;
  purgeImportedCalendarData(
    request: PurgeLifeOpsCalendarImportedDataRequest,
  ): Promise<unknown>;
  seedImportedCalendarData(
    requestUrl: URL,
    request: SeedLifeOpsCalendarRequest,
  ): Promise<unknown>;
  listLinkedCalendarEvents(): Promise<unknown>;
  listLinkedCalendarEventViews(): Promise<
    import("@elizaos/shared").LifeOpsLinkedCalendarEventView[]
  >;
  getLinkedCalendarControl(): Promise<
    import("@elizaos/shared").LifeOpsLinkedCalendarControl
  >;
  getLinkedCalendarEvent(linkId: string): Promise<unknown>;
}

/** Host-provided HTTP plumbing. */
export interface CalendarRouteDeps {
  method: string;
  pathname: string;
  url: URL;
  /** Resolve the calendar service (with telemetry + schema bootstrap) and run `fn`. Returns `true` once handled. */
  runRoute: (
    fn: (service: CalendarRouteService) => Promise<void>,
  ) => Promise<boolean>;
  /** Returns `true` when the request is rate-limited (caller should stop). */
  rateLimit: (key: CalendarRouteRateLimitKey) => boolean;
  json: (data: unknown, status?: number) => void;
  readJsonBody: <T extends object>() => Promise<T | null>;
  /** Decode a matched path component, writing a 400 + returning null on failure. */
  decodePathComponent: (raw: string, label: string) => string | null;
  parseConnectorMode: (
    value: string | null,
  ) => LifeOpsConnectorMode | undefined;
  parseConnectorSide: (
    value: string | null,
  ) => LifeOpsConnectorSide | undefined;
  parseBoolean: (value: string | null, field: string) => boolean | undefined;
  /** Build a host service error carrying an HTTP status (e.g. LifeOpsServiceError). */
  serviceError: (status: number, message: string) => Error;
  mutationGateway: CalendarOwnerMutationGateway;
}

/**
 * Handle a calendar route. Resolves to `true` when the request matched a
 * calendar path (and was served/short-circuited), or `false` when no calendar
 * route matched and the host should continue its own dispatch.
 */
export async function handleCalendarRoutes(
  deps: CalendarRouteDeps,
): Promise<boolean> {
  const { method, pathname, url } = deps;
  const q = url.searchParams;

  if (pathname === "/api/lifeops/calendar/sync-control") {
    if (method === "GET") {
      if (deps.rateLimit("calendar_link_read")) return true;
      return deps.runRoute(async (service) => {
        deps.json(await service.getLinkedCalendarControl());
      });
    }
    if (method === "POST") {
      if (deps.rateLimit("calendar_link_write")) return true;
      const body =
        await deps.readJsonBody<
          import("@elizaos/shared").UpdateLifeOpsLinkedCalendarControlRequest
        >();
      if (!body) return true;
      return deps.runRoute(async () => {
        deps.json(
          await deps.mutationGateway.updateLinkedCalendarControl(url, body),
        );
      });
    }
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/links") {
    if (deps.rateLimit("calendar_link_read")) return true;
    return deps.runRoute(async (service) => {
      deps.json({
        links:
          url.searchParams.get("view") === "events"
            ? await service.listLinkedCalendarEventViews()
            : await service.listLinkedCalendarEvents(),
      });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/links") {
    if (deps.rateLimit("calendar_link_write")) return true;
    const body =
      await deps.readJsonBody<CreateLifeOpsLinkedCalendarLinkRequest>();
    if (!body) return true;
    return deps.runRoute(async () => {
      deps.json(await deps.mutationGateway.linkCalendar(url, body), 201);
    });
  }

  const linkedActionMatch = pathname.match(
    /^\/api\/lifeops\/calendar\/links\/([^/]+)(?:\/(reconcile|resolve|disconnect|rebind))?$/,
  );
  if (linkedActionMatch) {
    const linkId = deps.decodePathComponent(linkedActionMatch[1], "link id");
    if (!linkId) return true;
    const action = linkedActionMatch[2];
    if (method === "GET" && action === undefined) {
      if (deps.rateLimit("calendar_link_read")) return true;
      return deps.runRoute(async (service) => {
        deps.json({ link: await service.getLinkedCalendarEvent(linkId) });
      });
    }
    if (method === "POST" && action) {
      if (deps.rateLimit("calendar_link_write")) return true;
      if (action === "reconcile") {
        const body =
          await deps.readJsonBody<RunLifeOpsLinkedCalendarReconciliationRequest>();
        if (!body) return true;
        return deps.runRoute(async () => {
          deps.json(
            await deps.mutationGateway.reconcileLinkedCalendar(
              url,
              linkId,
              body,
            ),
          );
        });
      }
      if (action === "resolve") {
        const body =
          await deps.readJsonBody<ResolveLifeOpsLinkedCalendarConflictRequest>();
        if (!body) return true;
        return deps.runRoute(async () => {
          deps.json(
            await deps.mutationGateway.resolveLinkedCalendarConflict(
              url,
              linkId,
              body,
            ),
          );
        });
      }
      if (action === "rebind") {
        const body =
          await deps.readJsonBody<RebindLifeOpsLinkedCalendarRequest>();
        if (!body) return true;
        return deps.runRoute(async () => {
          deps.json(
            await deps.mutationGateway.rebindLinkedCalendar(url, linkId, body),
          );
        });
      }
      const body =
        await deps.readJsonBody<DisconnectLifeOpsLinkedCalendarRequest>();
      if (!body) return true;
      return deps.runRoute(async () => {
        deps.json(
          await deps.mutationGateway.disconnectLinkedCalendar(
            url,
            linkId,
            body,
          ),
        );
      });
    }
  }

  if (
    method === "GET" &&
    pathname === "/api/lifeops/calendar/meeting-auto-join"
  ) {
    return deps.runRoute(async (service) => {
      deps.json(await service.getMeetingAutoJoin());
    });
  }

  if (
    method === "PUT" &&
    pathname === "/api/lifeops/calendar/meeting-auto-join"
  ) {
    const body = await deps.readJsonBody<{ policy?: unknown }>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      deps.json(await service.setMeetingAutoJoin(body.policy));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/feed") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        calendarId: q.get("calendarId") ?? undefined,
        includeHiddenCalendars: deps.parseBoolean(
          q.get("includeHiddenCalendars"),
          "includeHiddenCalendars",
        ),
        timeMin: q.get("timeMin") ?? undefined,
        timeMax: q.get("timeMax") ?? undefined,
        timeZone: q.get("timeZone") ?? undefined,
        forceSync: deps.parseBoolean(q.get("forceSync"), "forceSync"),
        grantId: q.get("grantId") ?? undefined,
      };
      deps.json(await service.getCalendarFeed(url, request));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/seed") {
    if (deps.rateLimit("calendar_source_sync")) return true;
    const body = await deps.readJsonBody<SeedLifeOpsCalendarRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      deps.json(await service.seedImportedCalendarData(url, body));
    });
  }

  if (
    method === "POST" &&
    pathname === "/api/lifeops/calendar/imported-data/purge"
  ) {
    if (deps.rateLimit("calendar_imported_data_purge")) return true;
    const body =
      await deps.readJsonBody<PurgeLifeOpsCalendarImportedDataRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      deps.json(await service.purgeImportedCalendarData(body));
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/sources") {
    if (deps.rateLimit("calendar_source_read")) return true;
    return deps.runRoute(async (service) => {
      deps.json({ sources: await service.listIcsCalendarSources() });
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/sources") {
    if (deps.rateLimit("calendar_source_write")) return true;
    const body =
      await deps.readJsonBody<CreateLifeOpsIcsCalendarSourceRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      deps.json({ source: await service.createIcsCalendarSource(body) }, 201);
    });
  }

  const sourceSyncMatch =
    method === "POST"
      ? pathname.match(/^\/api\/lifeops\/calendar\/sources\/([^/]+)\/sync$/)
      : null;
  if (sourceSyncMatch) {
    if (deps.rateLimit("calendar_source_sync")) return true;
    const sourceId = deps.decodePathComponent(
      sourceSyncMatch[1],
      "calendar source id",
    );
    if (!sourceId) return true;
    return deps.runRoute(async (service) => {
      deps.json(await service.syncIcsCalendarSource(sourceId));
    });
  }

  const sourceMatch = pathname.match(
    /^\/api\/lifeops\/calendar\/sources\/([^/]+)$/,
  );
  if (sourceMatch) {
    const sourceId = deps.decodePathComponent(
      sourceMatch[1],
      "calendar source id",
    );
    if (!sourceId) return true;
    if (method === "PATCH") {
      if (deps.rateLimit("calendar_source_write")) return true;
      const body =
        await deps.readJsonBody<UpdateLifeOpsIcsCalendarSourceRequest>();
      if (!body) return true;
      return deps.runRoute(async (service) => {
        deps.json({
          source: await service.updateIcsCalendarSource(sourceId, body),
        });
      });
    }
    if (method === "DELETE") {
      if (deps.rateLimit("calendar_source_write")) return true;
      return deps.runRoute(async (service) => {
        await service.deleteIcsCalendarSource(sourceId);
        deps.json({ deleted: true });
      });
    }
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/calendars") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: ListLifeOpsCalendarsRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        grantId: q.get("grantId") ?? undefined,
      };
      const calendars = await service.listCalendars(url, request);
      deps.json({ calendars });
    });
  }

  const setIncludedMatch =
    method === "PUT"
      ? pathname.match(
          /^\/api\/lifeops\/calendar\/calendars\/([^/]+)\/include$/,
        )
      : null;
  if (setIncludedMatch) {
    if (deps.rateLimit("google_api_write")) return true;
    const calendarId = deps.decodePathComponent(
      setIncludedMatch[1],
      "calendarId",
    );
    if (!calendarId) return true;
    const body = await deps.readJsonBody<SetLifeOpsCalendarIncludedRequest>();
    if (!body) return true;
    return deps.runRoute(async (service) => {
      if (body.calendarId && body.calendarId !== calendarId) {
        throw deps.serviceError(
          400,
          "calendarId must match between path and request body",
        );
      }
      if (
        body.provider === undefined ||
        body.side === undefined ||
        body.grantId === undefined ||
        body.connectorAccountId === undefined ||
        body.expectedVersion === undefined
      ) {
        throw deps.serviceError(
          400,
          "provider, side, grantId, connectorAccountId, and expectedVersion are required",
        );
      }
      deps.json(
        await service.setCalendarIncluded(url, {
          ...body,
          calendarId,
        }),
      );
    });
  }

  if (method === "GET" && pathname === "/api/lifeops/calendar/next-context") {
    if (deps.rateLimit("google_api_read")) return true;
    return deps.runRoute(async (service) => {
      const request: GetLifeOpsCalendarFeedRequest = {
        mode: deps.parseConnectorMode(q.get("mode")),
        side: deps.parseConnectorSide(q.get("side")),
        calendarId: q.get("calendarId") ?? undefined,
        timeMin: q.get("timeMin") ?? undefined,
        timeMax: q.get("timeMax") ?? undefined,
        timeZone: q.get("timeZone") ?? undefined,
      };
      deps.json(await service.getNextCalendarEventContext(url, request));
    });
  }

  if (method === "POST" && pathname === "/api/lifeops/calendar/events") {
    if (deps.rateLimit("calendar_create")) return true;
    const body = await deps.readJsonBody<CreateLifeOpsCalendarEventRequest>();
    if (!body) return true;
    return deps.runRoute(async () => {
      if (!body.idempotencyKey?.trim()) {
        throw deps.serviceError(
          428,
          "Calendar event creation requires a stable idempotencyKey.",
        );
      }
      deps.json(await deps.mutationGateway.create(url, body), 201);
    });
  }

  const eventMatch = pathname.match(
    /^\/api\/lifeops\/calendar\/events\/([^/]+)$/,
  );
  if (eventMatch) {
    const eventId = deps.decodePathComponent(eventMatch[1], "event id");
    if (!eventId) return true;
    if (method === "PATCH") {
      if (deps.rateLimit("calendar_update")) return true;
      const body = await deps.readJsonBody<LifeOpsCalendarEventUpdate>();
      if (!body) return true;
      return deps.runRoute(async () => {
        if (!body.expectedProviderVersion?.trim()) {
          throw deps.serviceError(
            428,
            "Calendar event update requires expectedProviderVersion.",
          );
        }
        if (!body.idempotencyKey?.trim()) {
          throw deps.serviceError(
            428,
            "Calendar event update requires a stable idempotencyKey.",
          );
        }
        const event = await deps.mutationGateway.update(url, {
          eventId,
          mode: body.mode ?? deps.parseConnectorMode(q.get("mode")),
          side: body.side ?? deps.parseConnectorSide(q.get("side")),
          grantId: body.grantId ?? q.get("grantId") ?? undefined,
          calendarId: body.calendarId ?? q.get("calendarId") ?? undefined,
          title: body.title,
          description: body.notes,
          startAt: body.startAt,
          endAt: body.endAt,
          allDay: body.allDay,
          timeZone: body.timeZone,
          location: body.location,
          attendees: body.attendees,
          recurrence: body.recurrence,
          recurrenceScope: body.recurrenceScope,
          notifyAttendees: body.notifyAttendees === true,
          expectedProviderVersion: body.expectedProviderVersion,
          idempotencyKey: body.idempotencyKey,
        });
        deps.json({ event });
      });
    }
    if (method === "DELETE") {
      if (deps.rateLimit("calendar_delete")) return true;
      return deps.runRoute(async () => {
        const expectedProviderVersion = q.get("expectedProviderVersion");
        if (!expectedProviderVersion?.trim()) {
          throw deps.serviceError(
            428,
            "Calendar event deletion requires expectedProviderVersion.",
          );
        }
        const idempotencyKey = q.get("idempotencyKey");
        if (!idempotencyKey?.trim()) {
          throw deps.serviceError(
            428,
            "Calendar event deletion requires a stable idempotencyKey.",
          );
        }
        const cancellationMode = q.get("cancellationMode");
        if (
          cancellationMode !== "organizer_cancel" &&
          cancellationMode !== "decline_invitation" &&
          cancellationMode !== "remove_private_copy"
        ) {
          throw deps.serviceError(
            428,
            "Calendar event deletion requires an explicit cancellationMode.",
          );
        }
        const mutationRequest = {
          side: deps.parseConnectorSide(q.get("side")),
          grantId: q.get("grantId") ?? undefined,
          calendarId: q.get("calendarId") ?? undefined,
          // Validated in the service; invalid values 400 instead of silently
          // degrading a series delete to a single-occurrence delete.
          recurrenceScope: (q.get("recurrenceScope") ?? undefined) as
            | LifeOpsCalendarRecurrenceScope
            | undefined,
          notifyAttendees:
            deps.parseBoolean(q.get("notifyAttendees"), "notifyAttendees") ===
            true,
          expectedProviderVersion,
        };
        const result = await deps.mutationGateway.cancel(url, {
          ...mutationRequest,
          eventId,
          cancellationMode,
          idempotencyKey,
        });
        deps.json(result);
      });
    }
  }

  return false;
}
