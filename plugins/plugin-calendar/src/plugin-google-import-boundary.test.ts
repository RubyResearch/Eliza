/** Verifies Calendar can boot without evaluating the optional Google API SDK. */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const rejectGoogleapisLoader = fileURLToPath(
  new URL("../test/reject-googleapis-loader.mjs", import.meta.url),
);

describe("Calendar Google import boundary", () => {
  it("loads the plugin and local calendar view without the Google SDK", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--conditions=eliza-source",
        "--experimental-loader",
        rejectGoogleapisLoader,
        "--input-type=module",
        "--eval",
        [
          'const { calendarPlugin } = await import("./plugins/plugin-calendar/src/plugin.ts");',
          'const view = calendarPlugin.views?.find(({ id }) => id === "calendar");',
          'if (view?.componentExport !== "CalendarView") process.exit(2);',
          'process.stdout.write("calendar-loaded");',
        ].join("\n"),
      ],
      // Cold source transforms can exceed 30 seconds on a shared build host.
      { cwd: repoRoot, encoding: "utf8", timeout: 90_000 },
    );

    expect(output).toBe("calendar-loaded");
  }, 95_000);
});
