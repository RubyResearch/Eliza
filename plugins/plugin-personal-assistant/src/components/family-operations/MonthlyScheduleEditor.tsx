/** Owner editing of the persisted family task's monthly timing, preserving its timezone and lifecycle state. */

import { Button, Input } from "@elizaos/ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { FamilyMonthlyScheduleView } from "../../lifeops/family-workflows/runtime.js";
import type { FamilyOperationsAdapter } from "./types.js";

export function MonthlyScheduleEditor({
  schedule,
  busy,
  save,
  error,
}: {
  schedule: FamilyMonthlyScheduleView;
  busy: boolean;
  error: ReactNode;
  save: FamilyOperationsAdapter["updateMonthlySchedule"];
}) {
  const trigger = schedule.trigger;
  const timezone = trigger.kind === "cron" ? trigger.tz : "America/New_York";
  const expression = trigger.kind === "cron" ? trigger.expression : "";
  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(expression);
  const savedDay = monthly ? monthly[3] : "1";
  const savedTime = monthly
    ? `${monthly[2].padStart(2, "0")}:${monthly[1].padStart(2, "0")}`
    : "09:00";
  const errorRef = useRef<HTMLDivElement>(null);
  const hasError = Boolean(error);
  useEffect(() => {
    if (hasError) errorRef.current?.focus();
  }, [hasError]);
  const [day, setDay] = useState(savedDay);
  const [time, setTime] = useState(savedTime);
  useEffect(() => {
    setDay(savedDay);
    setTime(savedTime);
  }, [savedDay, savedTime]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          taskId: schedule.taskId,
          day: Number(day),
          time,
          timezone,
        });
      }}
    >
      <p>
        {monthly
          ? `Monthly on day ${savedDay} at ${savedTime} ${timezone}`
          : "Custom timing is saved. Saving below replaces it with a monthly schedule."}
      </p>
      <fieldset
        disabled={busy}
        style={{ border: 0, padding: 0, display: "grid", gap: 12 }}
      >
        <label htmlFor="family-monthly-day">Day of month</label>
        <Input
          id="family-monthly-day"
          className="min-h-12"
          type="number"
          min={1}
          max={31}
          required
          value={day}
          onChange={(event) => setDay(event.target.value)}
        />
        <label htmlFor="family-monthly-time">Time ({timezone})</label>
        <Input
          id="family-monthly-time"
          className="min-h-12"
          type="time"
          required
          value={time}
          onChange={(event) => setTime(event.target.value)}
        />
        {Number(day) > 28 && (
          <p>
            Months without this day will be skipped. Choose 1–28 to run every
            month.
          </p>
        )}
        <p>
          Changing the time keeps the task's current status. Stopped tasks stay
          stopped.
        </p>
        {error && (
          <div ref={errorRef} tabIndex={-1} className="outline-none">
            {error}
          </div>
        )}
        <Button className="min-h-12" type="submit">
          Save monthly schedule
        </Button>
      </fieldset>
    </form>
  );
}
