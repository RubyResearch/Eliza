/**
 * Owner-facing drawer for creating and editing a calendar event: title, time
 * window, calendar/account selection, and attendees, submitting through the
 * augmented `@elizaos/ui` client to the calendar routes. Mounted by the
 * calendar views when the owner adds or edits an event.
 */
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventUpdate,
  LifeOpsCalendarSummary,
  LifeOpsConnectorSide,
} from "@elizaos/shared";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { client } from "@elizaos/ui/api";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TagEditor,
  Textarea,
} from "@elizaos/ui/components";
import { useAppSelector } from "@elizaos/ui/state";
import {
  Check,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";
import { basicEmailValid } from "../internal/email.js";

const calendarClient = client as typeof client & CalendarClientMethods;
let editorOperationSequence = 0;

type EditorMode = "edit" | "create";

const editorAccent: CSSProperties &
  Record<"--accent" | "--accent-hover" | "--accent-foreground", string> = {
  "--accent": "var(--brand-orange)",
  "--accent-hover": "#e65a10",
  "--accent-foreground": "#140c07",
};

function EventEditorInput({
  mode,
  field,
  label,
  description,
  inputType,
  value,
  placeholder,
  ariaLabel,
  disabled,
  onChange,
}: {
  mode: EditorMode;
  field: string;
  label: string;
  description: string;
  inputType?: string;
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLInputElement>({
    id: `event-${mode}-${field}`,
    role: inputType === "datetime-local" ? "text-input" : "text-input",
    label,
    group: "lifeops-event-editor",
    description,
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Input
      ref={ref}
      id={`event-editor-${field}`}
      type={inputType}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      {...agentProps}
    />
  );
}

function EventEditorNotes({
  mode,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  mode: EditorMode;
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLTextAreaElement>({
    id: `event-${mode}-notes`,
    role: "textarea",
    label: "Event notes",
    group: "lifeops-event-editor",
    description: "Notes for the calendar event",
    getValue: () => value,
    onFill: onChange,
  });
  return (
    <Textarea
      ref={ref}
      id="event-editor-notes"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      {...agentProps}
    />
  );
}

function EventEditorActionButton({
  agentId,
  label,
  description,
  children,
  ...buttonProps
}: {
  agentId: string;
  label: string;
  description: string;
  children: ReactNode;
} & ComponentProps<typeof Button>) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "lifeops-event-editor",
    description,
  });
  return (
    <Button ref={ref} {...buttonProps} {...agentProps}>
      {children}
    </Button>
  );
}

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function toLocalInputValue(isoString: string | null): string {
  if (!isoString) {
    return "";
  }
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) {
    return "";
  }
  // datetime-local input expects "YYYY-MM-DDTHH:mm"
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(localValue: string): string | null {
  if (!localValue) {
    return null;
  }
  const parsed = new Date(localValue);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function nextHalfHourIso(now = new Date()): string {
  const ms = 30 * 60 * 1000;
  const start = new Date(Math.ceil(now.getTime() / ms) * ms);
  return start.toISOString();
}

function isoPlusMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

export type EventEditorMode = "create" | "edit";

export interface EventEditorDefaults {
  /** ISO date used to seed the start time when opening in create mode. */
  date?: Date;
  side?: LifeOpsConnectorSide;
  calendarId?: string;
  grantId?: string;
}

export interface EventEditorDrawerProps {
  open: boolean;
  mode?: EventEditorMode;
  event: LifeOpsCalendarEvent | null;
  /** Used when `mode === "create"` to seed defaults. */
  createDefaults?: EventEditorDefaults;
  onClose: () => void;
  onSaved?: (event: LifeOpsCalendarEvent) => void;
  onCreated?: (event: LifeOpsCalendarEvent) => void;
  onDeleted?: (eventId: string) => void;
  onChat?: (event: LifeOpsCalendarEvent) => void;
}

interface FormState {
  title: string;
  isAllDay: boolean;
  startDate: string;
  lastDate: string;
  startAt: string;
  endAt: string;
  notes: string;
  location: string;
  attendees: string[];
  calendarId: string;
  grantId: string;
  side: LifeOpsConnectorSide;
}

function shiftCivilDate(value: string, days: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    !date.toISOString().startsWith(`${value}T`)
  )
    return null;
  date.setUTCDate(date.getUTCDate() + days);
  const shifted = date.toISOString().split("T")[0];
  return shifted && /^\d{4}-\d{2}-\d{2}$/.test(shifted) ? shifted : null;
}

function editorRange(
  form: FormState,
):
  | { allDay: { startDate: string; endDateExclusive: string } }
  | { startAt: string; endAt: string }
  | null {
  if (form.isAllDay) {
    const startDate = shiftCivilDate(form.startDate, 0);
    const endDateExclusive = shiftCivilDate(form.lastDate, 1);
    return startDate && endDateExclusive && endDateExclusive > startDate
      ? { allDay: { startDate, endDateExclusive } }
      : null;
  }
  const startAt = fromLocalInputValue(form.startAt);
  const endAt = fromLocalInputValue(form.endAt);
  return startAt && endAt && endAt > startAt ? { startAt, endAt } : null;
}

function blankFormState(defaults?: EventEditorDefaults): FormState {
  const seedDate = defaults?.date ?? new Date();
  const start = nextHalfHourIso(seedDate);
  return {
    title: "",
    isAllDay: false,
    startDate: toLocalInputValue(start).split("T")[0] ?? "",
    lastDate: toLocalInputValue(isoPlusMinutes(start, 30)).split("T")[0] ?? "",
    startAt: toLocalInputValue(start),
    endAt: toLocalInputValue(isoPlusMinutes(start, 30)),
    notes: "",
    location: "",
    attendees: [],
    calendarId: defaults?.calendarId ?? "",
    grantId: defaults?.grantId ?? "",
    side: defaults?.side ?? "owner",
  };
}

function formStateFromEvent(event: LifeOpsCalendarEvent): FormState {
  const attendees = event.attendees
    .map((attendee) => attendee.email?.trim() ?? "")
    .filter((email) => email.length > 0);
  return {
    title: event.title,
    isAllDay: event.isAllDay,
    // All-day feed bounds encode civil dates at UTC midnight, not instants in
    // the browser zone. Applying the timed conversion would shift western dates.
    startDate: event.isAllDay
      ? (event.startAt.split("T")[0] ?? "")
      : (toLocalInputValue(event.startAt).split("T")[0] ?? ""),
    lastDate: event.isAllDay
      ? (shiftCivilDate(event.endAt.split("T")[0] ?? "", -1) ?? "")
      : (toLocalInputValue(event.endAt).split("T")[0] ?? ""),
    startAt: event.isAllDay
      ? `${event.startAt.split("T")[0]}T09:00`
      : toLocalInputValue(event.startAt),
    endAt: event.isAllDay
      ? `${shiftCivilDate(event.endAt.split("T")[0] ?? "", -1)}T09:30`
      : toLocalInputValue(event.endAt),
    notes: event.description,
    location: event.location,
    attendees,
    calendarId: event.calendarId,
    grantId: event.grantId ?? "",
    side: event.side,
  };
}

function attendeesToContract(
  emails: string[],
): CreateLifeOpsCalendarEventAttendee[] {
  const valid = emails
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && basicEmailValid(value))
    .map((value) => value.toLowerCase());
  const deduped = [...new Set(valid)];
  return deduped.map((email) => ({ email }));
}

function normalizedEmailList(emails: string[]): string[] {
  return attendeesToContract(emails)
    .map((attendee) => attendee.email)
    .sort();
}

function calendarOptionValue(
  calendar: Pick<LifeOpsCalendarSummary, "side" | "grantId" | "calendarId">,
): string {
  return [calendar.side, calendar.grantId, calendar.calendarId]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function EventEditorCalendarSelect({
  mode,
  calendarOptions,
  value,
  placeholder,
  ariaLabel,
  disabled,
  onSelect,
}: {
  mode: EditorMode;
  calendarOptions: LifeOpsCalendarSummary[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `event-${mode}-calendar`,
    role: "select",
    label: "Calendar of record",
    group: "lifeops-event-editor",
    description: "Calendar that will own this event",
    options: calendarOptions.map((calendar) => calendarOptionValue(calendar)),
    getValue: () => value,
    onFill: onSelect,
  });
  return (
    <Select value={value} onValueChange={onSelect} disabled={disabled}>
      <SelectTrigger
        ref={ref}
        id="event-editor-calendar"
        aria-label={ariaLabel}
        disabled={disabled}
        {...agentProps}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {calendarOptions.map((calendar) => (
          <SelectItem
            key={`${calendar.side}:${calendar.grantId}:${calendar.calendarId}`}
            value={calendarOptionValue(calendar)}
          >
            <span>{calendar.summary}</span>
            {calendar.accountEmail ? (
              <>
                <span
                  className="mx-1.5 inline-block size-1 rounded-full bg-current opacity-55"
                  aria-hidden
                />
                <span>{calendar.accountEmail}</span>
              </>
            ) : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function sameCalendarIdentity(
  calendar: Pick<LifeOpsCalendarSummary, "side" | "grantId" | "calendarId">,
  state: Pick<FormState, "side" | "grantId" | "calendarId">,
): boolean {
  return (
    calendar.side === state.side &&
    calendar.grantId === state.grantId &&
    calendar.calendarId === state.calendarId
  );
}

function findSelectedCalendarOption(
  calendars: LifeOpsCalendarSummary[],
  state: Pick<FormState, "side" | "grantId" | "calendarId">,
): LifeOpsCalendarSummary | null {
  const exact = calendars.find((calendar) =>
    sameCalendarIdentity(calendar, state),
  );
  if (exact) return exact;
  if (state.grantId) return null;
  const matches = calendars.filter(
    (calendar) =>
      calendar.side === state.side && calendar.calendarId === state.calendarId,
  );
  return matches.length === 1 ? matches[0] : null;
}

function didAttendeesChange(
  formAttendees: string[],
  event: LifeOpsCalendarEvent,
): boolean {
  const previous = normalizedEmailList(
    event.attendees
      .map((attendee) => attendee.email?.trim() ?? "")
      .filter((email) => email.length > 0),
  );
  const next = normalizedEmailList(formAttendees);
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function createEditorOperationKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `event-editor:${globalThis.crypto.randomUUID()}`;
  }
  editorOperationSequence += 1;
  return `event-editor:${Date.now()}-${editorOperationSequence}`;
}

export type EventEditorReadOnlyReason =
  | "provider_version_missing"
  | "microsoft_read_only"
  | "ics_subscription"
  | "apple_read_only";

export type EventEditorMutability =
  | { readonly kind: "editable"; readonly providerVersion: string }
  | { readonly kind: "read_only"; readonly reason: EventEditorReadOnlyReason };

/**
 * Which edit affordances the owner-editor mutation pipeline can actually
 * honor for this event. The pipeline (client → route → owner-editor gateway →
 * trusted executor) performs etag-conditional writes and supports them only
 * for Google and built-in Eliza events; Microsoft mutations, ICS subscription
 * feeds, and the Apple native bridge are rejected server-side. Rendering a
 * Save/Delete button for those events would dead-end on every click, so the
 * drawer derives its affordances from this capability instead.
 */
export function eventEditorMutability(
  event: LifeOpsCalendarEvent,
): EventEditorMutability {
  switch (event.provider) {
    case "google":
    case "eliza": {
      const etag = event.metadata.etag;
      return typeof etag === "string" && etag.trim().length > 0
        ? { kind: "editable", providerVersion: etag.trim() }
        : { kind: "read_only", reason: "provider_version_missing" };
    }
    case "microsoft":
      return { kind: "read_only", reason: "microsoft_read_only" };
    case "ics":
      return { kind: "read_only", reason: "ics_subscription" };
    case "apple_calendar":
      return { kind: "read_only", reason: "apple_read_only" };
  }
}

/**
 * Mirrors the approval executor's organizer-disposition rules
 * (plugin-personal-assistant lifeops-port `eventOrganizerDisposition`): the
 * drawer must never offer a cancellation mode the executor would reject.
 * Organizer identity may also arrive only as the organizer email matching the
 * owning account email, so that comparison is part of the contract.
 * `remove_private_copy` is executor-gated to invitee disposition; the drawer's
 * single delete affordance maps invitees to `decline_invitation`.
 */
export function cancellationModeForEditorEvent(
  event: LifeOpsCalendarEvent,
): "organizer_cancel" | "decline_invitation" | null {
  if (event.organizer?.self === true) return "organizer_cancel";
  const selfAttendee = event.attendees.find((attendee) => attendee.self);
  if (selfAttendee) {
    return selfAttendee.organizer ? "organizer_cancel" : "decline_invitation";
  }
  const organizerEmail =
    typeof event.organizer?.email === "string"
      ? event.organizer.email.trim().toLowerCase()
      : null;
  const accountEmail = event.accountEmail?.trim().toLowerCase() || null;
  if (organizerEmail && accountEmail && organizerEmail === accountEmail) {
    return "organizer_cancel";
  }
  return null;
}

export function EventEditorDrawer({
  open,
  mode = "edit",
  event,
  createDefaults,
  onClose,
  onSaved,
  onCreated,
  onDeleted,
  onChat,
}: EventEditorDrawerProps) {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const [form, setForm] = useState<FormState>(() =>
    event ? formStateFromEvent(event) : blankFormState(createDefaults),
  );
  const [calendars, setCalendars] = useState<LifeOpsCalendarSummary[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createOperationKey = useRef<string | null>(null);
  const updateOperationKey = useRef<string | null>(null);
  const deleteOperationKey = useRef<string | null>(null);

  const isCreate = mode === "create";
  const calendarRequestSide = isCreate
    ? (createDefaults?.side ?? "owner")
    : (event?.side ?? "owner");
  const mutability = !isCreate && event ? eventEditorMutability(event) : null;
  const readOnly = mutability?.kind === "read_only";
  const cancellationMode = event ? cancellationModeForEditorEvent(event) : null;
  const declinesInvitation = cancellationMode === "decline_invitation";
  const deleteCapable =
    mutability?.kind === "editable" && cancellationMode !== null;
  const readOnlyReason =
    mutability?.kind === "read_only"
      ? {
          provider_version_missing: t("eventEditor.readOnlyVersionMissing", {
            defaultValue:
              "Editing is paused until this event's current provider version is available. Refresh the calendar to edit it.",
          }),
          microsoft_read_only: t("eventEditor.readOnlyMicrosoft", {
            defaultValue:
              "Microsoft Outlook events are view-only here. Edit this event in Outlook.",
          }),
          ics_subscription: t("eventEditor.readOnlyIcsSubscription", {
            defaultValue:
              "This event comes from a read-only calendar subscription. To stop seeing its events, remove the subscription in calendar sources.",
          }),
          apple_read_only: t("eventEditor.readOnlyApple", {
            defaultValue:
              "Apple Calendar events are view-only here. Edit this event in Apple Calendar.",
          }),
        }[mutability.reason]
      : null;
  const deleteUnavailableReason = readOnly
    ? readOnlyReason
    : !isCreate && event && cancellationMode === null
      ? t("eventEditor.deleteRoleUnknown", {
          defaultValue:
            "Deleting is unavailable because your organizer or invitee role on this event is unknown.",
        })
      : null;

  useEffect(() => {
    if (!open) return;
    if (isCreate) {
      setForm(blankFormState(createDefaults));
      createOperationKey.current = createEditorOperationKey();
    } else if (event) {
      setForm(formStateFromEvent(event));
      updateOperationKey.current = createEditorOperationKey();
      deleteOperationKey.current = createEditorOperationKey();
    }
    setError(null);
  }, [open, isCreate, event, createDefaults]);

  // An old drawer's source list must never remain selectable while a different
  // side or account is loading. A failed source read leaves the editor visibly
  // unavailable instead of fabricating a writable "Primary" calendar.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCalendars([]);
    setCalendarsLoading(true);
    setCalendarsError(null);
    void calendarClient
      .getLifeOpsCalendars({ side: calendarRequestSide })
      .then((response) => {
        if (cancelled) return;
        setCalendars(response.calendars);
        setForm((prev) => {
          if (prev.calendarId) {
            const selected = findSelectedCalendarOption(
              response.calendars,
              prev,
            );
            return selected && !prev.grantId
              ? {
                  ...prev,
                  grantId: selected.grantId,
                  side: selected.side,
                }
              : prev;
          }
          const primary =
            response.calendars.find((calendar) => calendar.primary) ??
            response.calendars[0];
          if (!primary) return prev;
          return {
            ...prev,
            calendarId: primary.calendarId,
            grantId: primary.grantId,
            side: primary.side,
          };
        });
      })
      .catch((cause) => {
        // error-policy:J4 Source discovery failure is rendered as unavailable
        // and disables every save path so no stale or fabricated target wins.
        if (cancelled) return;
        setCalendars([]);
        setCalendarsError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Could not load calendars.",
        );
      })
      .finally(() => {
        if (!cancelled) setCalendarsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, calendarRequestSide]);

  const calendarOptions = calendars;
  const calendarReady = calendarOptions.some((calendar) =>
    sameCalendarIdentity(calendar, form),
  );

  const updateForm = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      if (isCreate) {
        createOperationKey.current = createEditorOperationKey();
      } else {
        updateOperationKey.current = createEditorOperationKey();
      }
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [isCreate],
  );

  const handleSave = useCallback(
    async (options: { keepOpen?: boolean } = {}) => {
      setError(null);
      const titleTrimmed = form.title.trim();
      if (!titleTrimmed) return;
      if (!calendarReady) {
        setError(
          t("eventEditor.calendarUnavailable", {
            defaultValue:
              "Choose a currently available calendar before saving.",
          }),
        );
        return;
      }
      const range = editorRange(form);
      if (!range) {
        setError(
          t(
            form.isAllDay
              ? "eventEditor.invalidDates"
              : "eventEditor.invalidTimes",
            {
              defaultValue: form.isAllDay
                ? "Choose valid dates with the last day on or after the first day."
                : "Pick valid start and end times.",
            },
          ),
        );
        return;
      }

      setSaving(true);
      try {
        if (isCreate) {
          const attendees = attendeesToContract(form.attendees);
          const createIdempotencyKey =
            createOperationKey.current ?? createEditorOperationKey();
          createOperationKey.current = createIdempotencyKey;
          const request = {
            side: form.side,
            grantId: form.grantId || undefined,
            calendarId: form.calendarId || undefined,
            title: titleTrimmed,
            description: form.notes.trim() || undefined,
            location: form.location.trim() || undefined,
            ...range,
            timeZone: TIME_ZONE,
            attendees: attendees.length > 0 ? attendees : undefined,
            idempotencyKey: createIdempotencyKey,
            notifyAttendees: false,
          } satisfies CreateLifeOpsCalendarEventRequest;
          const result =
            await calendarClient.createLifeOpsCalendarEvent(request);
          if (result.outcome === "accepted_without_readback") {
            setActionNotice(
              t("eventEditor.createdWriteOnly", {
                defaultValue:
                  "Event added to Apple Calendar. Add-only access means availability and readback remain unknown.",
              }),
              "success",
              4200,
            );
            if (options.keepOpen) {
              createOperationKey.current = createEditorOperationKey();
              setForm(
                blankFormState({
                  ...createDefaults,
                  side: form.side,
                  grantId: form.grantId,
                  calendarId: form.calendarId,
                }),
              );
            } else {
              onClose();
            }
            return;
          }
          setActionNotice(
            t("eventEditor.created", {
              defaultValue: "Event created.",
            }),
            "success",
            2400,
          );
          onCreated?.(result.event);
          if (options.keepOpen) {
            createOperationKey.current = createEditorOperationKey();
            setForm(
              blankFormState({
                ...createDefaults,
                side: form.side,
                grantId: form.grantId,
                calendarId: form.calendarId,
              }),
            );
          } else {
            onClose();
          }
        } else {
          if (!event || mutability?.kind !== "editable") return;
          const updateIdempotencyKey =
            updateOperationKey.current ?? createEditorOperationKey();
          updateOperationKey.current = updateIdempotencyKey;
          const patch: LifeOpsCalendarEventUpdate & {
            expectedProviderVersion: string;
            idempotencyKey: string;
          } = {
            side: form.side,
            grantId: form.grantId || event.grantId,
            calendarId: form.calendarId || event.calendarId,
            timeZone: event.timezone ?? TIME_ZONE,
            expectedProviderVersion: mutability.providerVersion,
            idempotencyKey: updateIdempotencyKey,
            notifyAttendees: false,
          };
          if (titleTrimmed !== event.title) patch.title = titleTrimmed;
          if ("allDay" in range) {
            patch.allDay = range.allDay;
          } else {
            if (event.isAllDay || range.startAt !== event.startAt)
              patch.startAt = range.startAt;
            if (event.isAllDay || range.endAt !== event.endAt)
              patch.endAt = range.endAt;
          }
          if (form.notes.trim() !== event.description) {
            patch.notes = form.notes.trim();
          }
          if (form.location.trim() !== event.location) {
            patch.location = form.location.trim();
          }
          if (didAttendeesChange(form.attendees, event)) {
            patch.attendees = attendeesToContract(form.attendees);
          }
          const result = await calendarClient.updateLifeOpsCalendarEvent(
            event.externalId,
            patch,
          );
          setActionNotice(
            t("eventEditor.saved", { defaultValue: "Event saved." }),
            "success",
            2400,
          );
          onSaved?.(result.event);
          if (options.keepOpen) {
            updateOperationKey.current = createEditorOperationKey();
            setForm(formStateFromEvent(result.event));
          } else {
            onClose();
          }
        }
      } catch (cause) {
        // error-policy:J4 The exact draft remains visible while the provider
        // or approval error tells the owner whether a retry is appropriate.
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : t("eventEditor.saveFailed", {
                defaultValue: "Could not save the event.",
              }),
        );
      } finally {
        setSaving(false);
      }
    },
    [
      calendarReady,
      createDefaults,
      event,
      form,
      isCreate,
      mutability,
      onClose,
      onCreated,
      onSaved,
      setActionNotice,
      t,
    ],
  );

  const handleDelete = useCallback(async () => {
    if (!event) return;
    if (mutability?.kind !== "editable" || !cancellationMode) {
      // The delete affordance renders disabled with a visible reason in these
      // states; reaching here means an unexpected path, so restate the reason.
      setError(
        deleteUnavailableReason ??
          t("eventEditor.deleteRoleUnknown", {
            defaultValue:
              "Deleting is unavailable because your organizer or invitee role on this event is unknown.",
          }),
      );
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const deleteIdempotencyKey =
        deleteOperationKey.current ?? createEditorOperationKey();
      deleteOperationKey.current = deleteIdempotencyKey;
      const result = await calendarClient.deleteLifeOpsCalendarEvent(
        event.externalId,
        {
          side: event.side,
          grantId: event.grantId,
          calendarId: event.calendarId,
          expectedProviderVersion: mutability.providerVersion,
          idempotencyKey: deleteIdempotencyKey,
          notifyAttendees: false,
          cancellationMode,
        },
      );
      if (result.outcome === "invitation_declined") {
        setActionNotice(
          t("eventEditor.invitationDeclined", {
            defaultValue: "Invitation declined.",
          }),
          "success",
          2400,
        );
        onSaved?.(result.event);
      } else {
        setActionNotice(
          t("eventEditor.deleted", { defaultValue: "Event deleted." }),
          "success",
          2400,
        );
        onDeleted?.(event.id);
      }
      onClose();
    } catch (cause) {
      // error-policy:J4 A failed decline/delete remains visibly unresolved;
      // success callbacks only run after a typed provider receipt.
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("eventEditor.deleteFailed", {
              defaultValue: "Could not delete the event.",
            }),
      );
    } finally {
      setDeleting(false);
      setConfirmDeleteOpen(false);
    }
  }, [
    cancellationMode,
    deleteUnavailableReason,
    event,
    mutability,
    onClose,
    onDeleted,
    onSaved,
    setActionNotice,
    t,
  ]);

  if (!isCreate && !event) {
    return null;
  }

  const titleLabel = isCreate
    ? t("eventEditor.createTitle", { defaultValue: "New event" })
    : t("eventEditor.title", { defaultValue: "Edit event" });
  const primaryActionLabel = isCreate
    ? t("eventEditor.create", { defaultValue: "Create" })
    : t("common.save", { defaultValue: "Save" });
  const primaryActionLoadingLabel = isCreate
    ? t("eventEditor.creating", { defaultValue: "Creating event" })
    : t("common.saving", { defaultValue: "Saving event" });

  const deduplication = event?.metadata.deduplication;
  const pendingUpdate =
    event?.provider === "eliza" &&
    typeof deduplication === "object" &&
    deduplication !== null &&
    "pendingUpdate" in deduplication
      ? deduplication.pendingUpdate
      : null;
  const hasPendingGoogleUpdate =
    typeof pendingUpdate === "object" &&
    pendingUpdate !== null &&
    "linkId" in pendingUpdate &&
    typeof pendingUpdate.linkId === "string" &&
    pendingUpdate.linkId.length > 0;

  const selectedCalendarOption = findSelectedCalendarOption(
    calendarOptions,
    form,
  );
  const calendarSelectValue = selectedCalendarOption
    ? calendarOptionValue(selectedCalendarOption)
    : "";

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="fixed bottom-0 right-0 top-0 !left-auto !right-0 !top-0 m-0 h-full min-w-0 max-w-none !translate-x-0 !translate-y-0 overflow-x-hidden overflow-y-auto bg-bg p-0"
          data-testid="event-editor-drawer"
          style={{
            ...editorAccent,
            top: 0,
            right: 0,
            bottom: 0,
            left: "auto",
            width: "100vw",
            maxWidth: "28rem",
            boxSizing: "border-box",
            height: "100dvh",
            maxHeight: "100dvh",
            margin: 0,
            padding: 0,
            // The portaled editor must scroll its footer above the persistent composer.
            paddingBottom: "var(--eliza-chat-clearance, 5.25rem)",
            overflowX: "hidden",
            overflowY: "auto",
            transform: "none",
            translate: "none",
            animation: "none",
          }}
        >
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <div>
              <div className="text-sm font-semibold text-txt">{titleLabel}</div>
            </div>
            <Button
              variant="ghostMuted"
              size="icon-sm"
              type="button"
              onClick={onClose}
              className="size-11"
              aria-label={t("common.close", { defaultValue: "Close" })}
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="min-w-0 space-y-4 p-5">
            {error ? (
              <div className="p-1 text-xs text-danger">{error}</div>
            ) : null}

            {hasPendingGoogleUpdate ? (
              <p role="status" className="p-1 text-xs leading-5 text-muted">
                {t("eventEditor.googleUpdatePending", {
                  defaultValue:
                    "Saved in Eliza. Google calendar update pending.",
                })}
              </p>
            ) : null}

            {readOnlyReason ? (
              <p
                className="p-1 text-xs leading-5 text-muted"
                role="note"
                data-testid="event-editor-read-only-reason"
              >
                {readOnlyReason}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-title"
                className="block text-xs font-medium text-muted"
              >
                {t("common.title", { defaultValue: "Title" })}
              </label>
              <EventEditorInput
                mode={mode}
                field="title"
                label="Event title"
                description="Title of the calendar event"
                value={form.title}
                disabled={readOnly}
                onChange={(value) => updateForm("title", value)}
                placeholder={t("eventEditor.titlePlaceholder", {
                  defaultValue: "Event title",
                })}
                ariaLabel={t("eventEditor.titleAria", {
                  defaultValue: "Event title",
                })}
              />
            </div>

            <fieldset disabled={readOnly} className="space-y-2">
              <legend className="text-xs font-medium text-muted">
                {t("eventEditor.timing", { defaultValue: "Event timing" })}
              </legend>
              <div className="flex gap-2">
                <EventEditorActionButton
                  agentId={`event-${mode}-timed`}
                  label="Timed"
                  description="Use start and end times for this event"
                  variant="choice"
                  aria-pressed={!form.isAllDay}
                  data-state={!form.isAllDay ? "on" : "off"}
                  onClick={() => {
                    if (form.isAllDay) {
                      updateForm(
                        "startAt",
                        `${form.startDate}T${form.startAt.split("T")[1] ?? "09:00"}`,
                      );
                      updateForm(
                        "endAt",
                        `${form.lastDate}T${form.endAt.split("T")[1] ?? "09:30"}`,
                      );
                    }
                    updateForm("isAllDay", false);
                  }}
                >
                  {t("eventEditor.timed", { defaultValue: "Timed" })}
                </EventEditorActionButton>
                <EventEditorActionButton
                  agentId={`event-${mode}-all-day`}
                  label="All day"
                  description="Use whole calendar days for this event"
                  variant="choice"
                  aria-pressed={form.isAllDay}
                  data-state={form.isAllDay ? "on" : "off"}
                  onClick={() => {
                    if (!form.isAllDay) {
                      updateForm("startDate", form.startAt.split("T")[0] ?? "");
                      updateForm("lastDate", form.endAt.split("T")[0] ?? "");
                    }
                    updateForm("isAllDay", true);
                  }}
                >
                  {t("eventEditor.allDay", { defaultValue: "All day" })}
                </EventEditorActionButton>
              </div>
            </fieldset>

            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <label
                  htmlFor="event-editor-start-at"
                  className="block text-xs font-medium text-muted"
                >
                  {t(
                    form.isAllDay
                      ? "eventEditor.firstDay"
                      : "eventEditor.startAt",
                    {
                      defaultValue: form.isAllDay ? "First day" : "Start",
                    },
                  )}
                </label>
                <EventEditorInput
                  mode={mode}
                  field="start-at"
                  label={form.isAllDay ? "Event first day" : "Event start time"}
                  description="First day or start time of the event"
                  inputType={form.isAllDay ? "date" : "datetime-local"}
                  value={form.isAllDay ? form.startDate : form.startAt}
                  disabled={readOnly}
                  onChange={(value) =>
                    updateForm(form.isAllDay ? "startDate" : "startAt", value)
                  }
                  ariaLabel={t(
                    form.isAllDay
                      ? "eventEditor.firstDayAria"
                      : "eventEditor.startAtAria",
                    {
                      defaultValue: form.isAllDay ? "First day" : "Start time",
                    },
                  )}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <label
                  htmlFor="event-editor-end-at"
                  className="block text-xs font-medium text-muted"
                >
                  {t(
                    form.isAllDay ? "eventEditor.lastDay" : "eventEditor.endAt",
                    {
                      defaultValue: form.isAllDay
                        ? "Last day (included)"
                        : "End",
                    },
                  )}
                </label>
                <EventEditorInput
                  mode={mode}
                  field="end-at"
                  label={form.isAllDay ? "Event last day" : "Event end time"}
                  description="Last included day or end time of the event"
                  inputType={form.isAllDay ? "date" : "datetime-local"}
                  value={form.isAllDay ? form.lastDate : form.endAt}
                  disabled={readOnly}
                  onChange={(value) =>
                    updateForm(form.isAllDay ? "lastDate" : "endAt", value)
                  }
                  ariaLabel={t(
                    form.isAllDay
                      ? "eventEditor.lastDayAria"
                      : "eventEditor.endAtAria",
                    {
                      defaultValue: form.isAllDay
                        ? "Last day (included)"
                        : "End time",
                    },
                  )}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-location"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.location", { defaultValue: "Location" })}
              </label>
              <EventEditorInput
                mode={mode}
                field="location"
                label="Event location"
                description="Location of the calendar event"
                value={form.location}
                disabled={readOnly}
                onChange={(value) => updateForm("location", value)}
                placeholder={t("eventEditor.locationPlaceholder", {
                  defaultValue: "Location (optional)",
                })}
                ariaLabel={t("eventEditor.locationAria", {
                  defaultValue: "Event location",
                })}
              />
            </div>

            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">
                {t("eventEditor.attendees", { defaultValue: "Attendees" })}
              </span>
              {readOnly ? (
                // TagEditor has no disabled mode; a read-only event renders its
                // attendee list as plain text so no add/remove affordance exists.
                <div
                  className="flex flex-wrap gap-1.5"
                  data-testid="event-editor-attendees-read-only"
                >
                  {form.attendees.length > 0 ? (
                    form.attendees.map((attendee) => (
                      <span
                        key={attendee}
                        className="rounded bg-bg-muted/40 px-1.5 py-0.5 text-xs text-txt"
                      >
                        {attendee}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-muted">
                      {t("eventEditor.noAttendees", {
                        defaultValue: "No attendees",
                      })}
                    </span>
                  )}
                </div>
              ) : (
                <TagEditor
                  items={form.attendees}
                  onChange={(next) =>
                    updateForm(
                      "attendees",
                      next.filter((value) => basicEmailValid(value)),
                    )
                  }
                  placeholder={t("eventEditor.attendeePlaceholder", {
                    defaultValue: "Add email and press Enter",
                  })}
                  addLabel={t("eventEditor.attendeeAdd", {
                    defaultValue: "Add attendee",
                  })}
                  removeLabel={t("eventEditor.attendeeRemove", {
                    defaultValue: "Remove",
                  })}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-calendar"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.calendar", { defaultValue: "Calendar" })}
              </label>
              <EventEditorCalendarSelect
                mode={mode}
                calendarOptions={calendarOptions}
                value={calendarSelectValue}
                placeholder={
                  calendarsLoading
                    ? t("eventEditor.calendarLoading", {
                        defaultValue: "Calendar sync",
                      })
                    : t("eventEditor.calendarPlaceholder", {
                        defaultValue: "Select calendar",
                      })
                }
                ariaLabel={t("eventEditor.calendarAria", {
                  defaultValue: "Calendar of record",
                })}
                disabled={
                  calendarsLoading || Boolean(calendarsError) || readOnly
                }
                onSelect={(value) => {
                  const match = calendarOptions.find(
                    (calendar) => calendarOptionValue(calendar) === value,
                  );
                  if (!match) return;
                  if (isCreate) {
                    createOperationKey.current = createEditorOperationKey();
                  } else {
                    updateOperationKey.current = createEditorOperationKey();
                  }
                  setForm((prev) => ({
                    ...prev,
                    calendarId: match.calendarId,
                    grantId: match.grantId,
                    side: match.side,
                  }));
                }}
              />
              {calendarsError ? (
                <div className="text-[10px] text-danger">{calendarsError}</div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="event-editor-notes"
                className="block text-xs font-medium text-muted"
              >
                {t("eventEditor.notes", { defaultValue: "Notes" })}
              </label>
              <EventEditorNotes
                mode={mode}
                value={form.notes}
                disabled={readOnly}
                onChange={(value) => updateForm("notes", value)}
                placeholder={t("eventEditor.notesPlaceholder", {
                  defaultValue: "Notes",
                })}
              />
            </div>
          </div>

          {!isCreate && !readOnly && deleteUnavailableReason ? (
            <p
              className="px-5 pb-1 text-xs leading-5 text-muted"
              role="note"
              data-testid="event-editor-delete-unavailable"
            >
              {deleteUnavailableReason}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {!isCreate && onChat && event ? (
                <EventEditorActionButton
                  agentId={`event-${mode}-chat`}
                  label="Chat about event"
                  description="Open chat about this event"
                  variant="ghost"
                  size="sm"
                  className="size-11 p-0 text-muted"
                  onClick={() => onChat(event)}
                >
                  <MessageSquare className="size-3.5" aria-hidden />
                  <span className="sr-only">
                    {t("common.chat", { defaultValue: "Chat" })}
                  </span>
                </EventEditorActionButton>
              ) : null}
              {!isCreate ? (
                <EventEditorActionButton
                  agentId={`event-${mode}-delete`}
                  label={
                    declinesInvitation ? "Decline invitation" : "Delete event"
                  }
                  description={
                    declinesInvitation
                      ? "Decline this calendar invitation"
                      : "Delete this calendar event"
                  }
                  variant="surfaceDestructive"
                  size="sm"
                  className="size-11 p-0"
                  disabled={deleting || saving || !deleteCapable}
                  onClick={() => setConfirmDeleteOpen(true)}
                >
                  {deleting ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : declinesInvitation ? (
                    <X className="size-3.5" aria-hidden />
                  ) : (
                    <Trash2 className="size-3.5" aria-hidden />
                  )}
                  <span className="sr-only">
                    {declinesInvitation
                      ? t("eventEditor.declineInvitation", {
                          defaultValue: "Decline invitation",
                        })
                      : t("common.delete", { defaultValue: "Delete" })}
                  </span>
                </EventEditorActionButton>
              ) : null}
            </div>
            <div className="flex gap-2">
              <EventEditorActionButton
                agentId={`event-${mode}-cancel`}
                label="Cancel event editor"
                description="Close the event editor without saving"
                variant="outline"
                size="sm"
                className="size-11 p-0"
                onClick={onClose}
                disabled={saving}
              >
                <X className="size-3.5" aria-hidden />
                <span className="sr-only">
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </span>
              </EventEditorActionButton>
              {!readOnly ? (
                <>
                  <EventEditorActionButton
                    agentId={`event-${mode}-save-continue`}
                    label="Save and continue"
                    description="Save the event and keep the editor open"
                    variant="outline"
                    size="sm"
                    className="size-11 p-0"
                    disabled={saving || !form.title.trim() || !calendarReady}
                    onClick={() => void handleSave({ keepOpen: true })}
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Save className="size-3.5" aria-hidden />
                    )}
                    <span className="sr-only">
                      {saving
                        ? primaryActionLoadingLabel
                        : t("eventEditor.saveAndContinue", {
                            defaultValue: "Save and continue",
                          })}
                    </span>
                  </EventEditorActionButton>
                  <EventEditorActionButton
                    agentId={`event-${mode}-save`}
                    label={isCreate ? "Create event" : "Save event"}
                    description="Save the calendar event and close the editor"
                    size="sm"
                    className="size-11 p-0"
                    disabled={saving || !form.title.trim() || !calendarReady}
                    onClick={() => void handleSave()}
                  >
                    {saving ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : isCreate ? (
                      <Plus className="size-3.5" aria-hidden />
                    ) : (
                      <Check className="size-3.5" aria-hidden />
                    )}
                    <span className="sr-only">
                      {saving ? primaryActionLoadingLabel : primaryActionLabel}
                    </span>
                  </EventEditorActionButton>
                </>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDeleteOpen}
        title={
          declinesInvitation
            ? t("eventEditor.confirmDeclineTitle", {
                defaultValue: "Decline invitation?",
              })
            : t("eventEditor.confirmDeleteTitle", {
                defaultValue: "Delete event?",
              })
        }
        message={
          declinesInvitation
            ? t("eventEditor.confirmDeclineDescription", {
                defaultValue:
                  "Your response will change to declined. This does not delete the organizer's event.",
              })
            : t("eventEditor.confirmDeleteDescription", {
                defaultValue:
                  "This will delete the event from your calendar. This cannot be undone.",
              })
        }
        confirmLabel={
          declinesInvitation
            ? t("eventEditor.declineInvitation", {
                defaultValue: "Decline invitation",
              })
            : t("common.delete", { defaultValue: "Delete" })
        }
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant={declinesInvitation ? "warn" : "danger"}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </>
  );
}
