/**
 * Host-owned owner-editor mutation boundary for calendar HTTP routes. Calendar
 * owns provider CRUD, while the host must bind an authenticated Save/Delete
 * gesture to its approval queue and durable mutation ledger before invoking
 * those provider methods.
 */
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  CreateLifeOpsCalendarEventResponse,
  CreateLifeOpsLinkedCalendarLinkRequest,
  DisconnectLifeOpsLinkedCalendarRequest,
  LifeOpsCalendarAllDayRange,
  LifeOpsCalendarCancellationMode,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventCancellationResult,
  LifeOpsCalendarRecurrenceScope,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsLinkedCalendarControlMutationResult,
  LifeOpsLinkedCalendarMutationResponse,
  RebindLifeOpsLinkedCalendarRequest,
  RebindLifeOpsLinkedCalendarResponse,
  ResolveLifeOpsLinkedCalendarConflictRequest,
  RunLifeOpsLinkedCalendarReconciliationRequest,
  UpdateLifeOpsLinkedCalendarControlRequest,
} from "@elizaos/shared";

export const CALENDAR_OWNER_MUTATION_GATEWAY_SERVICE =
  "calendar_owner_mutation_gateway";

export interface CalendarOwnerMutationGateway {
  updateLinkedCalendarControl(
    requestUrl: URL,
    request: UpdateLifeOpsLinkedCalendarControlRequest,
  ): Promise<LifeOpsLinkedCalendarControlMutationResult>;
  create(
    requestUrl: URL,
    request: CreateLifeOpsCalendarEventRequest,
  ): Promise<CreateLifeOpsCalendarEventResponse>;
  update(
    requestUrl: URL,
    request: {
      mode?: LifeOpsConnectorMode | null;
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      title?: string;
      description?: string;
      location?: string;
      startAt?: string;
      endAt?: string;
      allDay?: LifeOpsCalendarAllDayRange;
      timeZone?: string;
      attendees?: CreateLifeOpsCalendarEventAttendee[] | null;
      recurrence?: string[] | null;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees?: boolean;
      expectedProviderVersion: string;
      idempotencyKey: string;
    },
  ): Promise<LifeOpsCalendarEvent>;
  cancel(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide | null;
      grantId?: string;
      calendarId?: string | null;
      eventId: string;
      recurrenceScope?: LifeOpsCalendarRecurrenceScope | null;
      notifyAttendees: boolean;
      expectedProviderVersion: string;
      cancellationMode: LifeOpsCalendarCancellationMode;
      idempotencyKey: string;
    },
  ): Promise<LifeOpsCalendarEventCancellationResult>;
  linkCalendar(
    requestUrl: URL,
    request: CreateLifeOpsLinkedCalendarLinkRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse>;
  reconcileLinkedCalendar(
    requestUrl: URL,
    linkId: string,
    request: RunLifeOpsLinkedCalendarReconciliationRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse>;
  resolveLinkedCalendarConflict(
    requestUrl: URL,
    linkId: string,
    request: ResolveLifeOpsLinkedCalendarConflictRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse>;
  rebindLinkedCalendar(
    requestUrl: URL,
    linkId: string,
    request: RebindLifeOpsLinkedCalendarRequest,
  ): Promise<RebindLifeOpsLinkedCalendarResponse>;
  disconnectLinkedCalendar(
    requestUrl: URL,
    linkId: string,
    request: DisconnectLifeOpsLinkedCalendarRequest,
  ): Promise<LifeOpsLinkedCalendarMutationResponse>;
  reconcileLinkedCalendarProviderChanges(
    requestUrl: URL,
    providerEventIds: readonly string[],
  ): Promise<void>;
}
