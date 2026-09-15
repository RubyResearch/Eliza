/** Owner review of the exact Google destination and durable calendar sync state. */
import type {
  LifeOpsCalendarSummary,
  LifeOpsLinkedCalendarControl,
  UpdateLifeOpsLinkedCalendarControlRequest,
} from "@elizaos/shared";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import { useEffect, useRef, useState } from "react";
import type { LifeOpsConnectionsAdapter } from "./types.js";

function destinationKey(
  destination: LifeOpsLinkedCalendarControl["destination"],
): string {
  return destination
    ? JSON.stringify([
        destination.connectorAccountId,
        destination.providerCalendarId,
      ])
    : "local";
}

export function CalendarSyncPanel({
  adapter,
  calendars,
}: {
  adapter: Pick<
    LifeOpsConnectionsAdapter,
    "getLinkedCalendarControl" | "updateLinkedCalendarControl"
  >;
  calendars: LifeOpsCalendarSummary[];
}) {
  const [control, setControl] = useState<LifeOpsLinkedCalendarControl | null>(
    null,
  );
  const [selection, setSelection] = useState("local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionGeneration = useRef(0);
  useEffect(() => {
    connectionGeneration.current += 1;
    setControl(null);
    setSelection("local");
    setBusy(false);
    setError(null);
    let active = true;
    void adapter
      .getLinkedCalendarControl()
      .then((next) => {
        if (active) {
          setControl(next);
          setSelection(destinationKey(next.destination));
        }
      })
      .catch((cause) => {
        // error-policy:J4 An unavailable control snapshot disables mutations and exposes retry.
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : "Calendar sync status is unavailable.",
          );
      });
    return () => {
      active = false;
      connectionGeneration.current += 1;
    };
  }, [adapter]);

  const choices = calendars.filter(
    (calendar) =>
      calendar.provider === "google" &&
      calendar.side === "owner" &&
      (calendar.accessRole === "owner" || calendar.accessRole === "writer"),
  );
  const choice = choices.find(
    (calendar) =>
      destinationKey({
        connectorAccountId: calendar.connectorAccountId,
        providerCalendarId: calendar.calendarId,
      }) === selection,
  );
  async function run(
    operation: "refresh" | "pause" | "select" | "resume" | "recover",
  ) {
    const generation = connectionGeneration.current;
    setBusy(true);
    setError(null);
    try {
      let next: LifeOpsLinkedCalendarControl;
      if (operation === "refresh") {
        next = await adapter.getLinkedCalendarControl();
      } else {
        if (!control)
          throw new Error("Refresh calendar sync status before continuing.");
        const common = {
          expectedRevision: control.revision,
          idempotencyKey: crypto.randomUUID(),
        };
        let request: UpdateLifeOpsLinkedCalendarControlRequest;
        if (operation === "select") {
          if (selection !== "local" && !choice)
            throw new Error(
              "Refresh the available calendars and select a destination.",
            );
          request = {
            ...common,
            operation,
            destination: choice
              ? {
                  connectorAccountId: choice.connectorAccountId,
                  providerCalendarId: choice.calendarId,
                }
              : null,
          };
        } else {
          request = { ...common, operation };
        }
        next = await adapter.updateLinkedCalendarControl(request);
      }
      if (generation !== connectionGeneration.current) return;
      setControl(next);
      setSelection(destinationKey(next.destination));
    } catch (cause) {
      if (generation !== connectionGeneration.current) return;
      // error-policy:J4 Failed verification and stale reviews remain errors; no local state pretends a write succeeded.
      setError(
        cause instanceof Error
          ? cause.message
          : "Calendar sync could not be updated. Refresh its status.",
      );
    } finally {
      if (generation === connectionGeneration.current) setBusy(false);
    }
  }
  const destination = control?.destination;
  const currentCalendar = destination
    ? calendars.find(
        (calendar) =>
          calendar.connectorAccountId === destination.connectorAccountId &&
          calendar.calendarId === destination.providerCalendarId,
      )
    : null;
  return (
    <section
      className="mb-4 space-y-3 rounded-2xl border border-border bg-card p-4"
      aria-labelledby="calendar-sync-title"
    >
      <h2 id="calendar-sync-title" className="font-semibold">
        Calendar synchronization
      </h2>
      <p className="text-sm text-muted-foreground">
        Use the built-in calendar on its own, or choose the Google calendar it
        should sync with.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {!control && !error ? (
        <p role="status">Loading calendar sync status…</p>
      ) : null}
      {control ? (
        <>
          <p role="status">
            {control.paused
              ? "Synchronization is paused."
              : "Synchronization is enabled."}
          </p>
          <p>
            {destination
              ? currentCalendar
                ? `Current destination: ${currentCalendar.summary} — ${currentCalendar.accountEmail ?? "Account identity unavailable"}`
                : "The saved destination is unavailable in the connected calendars. Refresh or reconnect its account."
              : "Current destination: built-in calendar only."}
          </p>
          {control.pendingDispatch ? (
            <p role="status">
              A previous calendar operation is still pending. Finish or
              reconcile it before changing destinations or resuming.
            </p>
          ) : null}
          <label htmlFor="calendar-sync-destination">
            Destination for built-in calendar events
          </label>
          <Select
            value={selection}
            onValueChange={setSelection}
            disabled={
              busy || !control.paused || Boolean(control.pendingDispatch)
            }
          >
            <SelectTrigger id="calendar-sync-destination">
              <SelectValue placeholder="Choose a calendar" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Built-in calendar only</SelectItem>
              {choices.map((calendar) => (
                <SelectItem
                  key={destinationKey({
                    connectorAccountId: calendar.connectorAccountId,
                    providerCalendarId: calendar.calendarId,
                  })}
                  value={destinationKey({
                    connectorAccountId: calendar.connectorAccountId,
                    providerCalendarId: calendar.calendarId,
                  })}
                >
                  {calendar.summary} —{" "}
                  {calendar.accountEmail ?? "Account identity unavailable"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex flex-wrap gap-2 pt-3">
            {control.paused && control.pendingDispatch ? (
              <Button
                variant="accentDarkHover"
                disabled={busy}
                onClick={() => void run("recover")}
              >
                Check pending operation
              </Button>
            ) : null}
            <Button
              variant="accentDarkHover"
              disabled={
                busy ||
                !control.paused ||
                Boolean(control.pendingDispatch) ||
                selection === destinationKey(control.destination)
              }
              onClick={() => void run("select")}
            >
              Verify and save destination
            </Button>
            {control.paused ? (
              control.destination ? (
                <Button
                  variant="accentDarkHover"
                  disabled={
                    busy ||
                    !control.destination ||
                    Boolean(control.pendingDispatch) ||
                    selection !== destinationKey(control.destination)
                  }
                  onClick={() => void run("resume")}
                >
                  Verify and resume sync
                </Button>
              ) : null
            ) : (
              <Button
                variant="accentDarkHover"
                disabled={busy}
                onClick={() => void run("pause")}
              >
                Pause sync
              </Button>
            )}
          </div>
        </>
      ) : null}
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => void run("refresh")}
      >
        Refresh sync status
      </Button>
    </section>
  );
}
