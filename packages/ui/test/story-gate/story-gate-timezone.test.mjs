/**
 * Exercises the real Story Gate browser under a DST-observing host timezone.
 * Local calendar arithmetic and formatted hour labels must share the same zone.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("keeps summer event positions aligned with winter-derived hour labels", () => {
  const directory = mkdtempSync(join(tmpdir(), "story-timezone-"));
  try {
    writeFileSync(
      join(directory, "index.json"),
      JSON.stringify({
        entries: {
          "calendar--timezone": {
            id: "calendar--timezone",
            type: "story",
            title: "Calendar",
            name: "Timezone",
          },
        },
      }),
    );
    writeFileSync(
      join(directory, "iframe.html"),
      `<!doctype html>
      <html><body class="sb-show-main"><main>Calendar timezone alignment</main><script>
      window.__STORYBOOK_PREVIEW__ = { currentRender: { phase: 'finished' } };
      const format = value => new Intl.DateTimeFormat(undefined, {hour: 'numeric'}).format(value);
      const hourLabel = format(new Date(2024, 0, 1, 10));
      const eventLabel = format(new Date(2025, 5, 1, 10));
      if (hourLabel !== eventLabel) console.error('Calendar hour misalignment: ' + hourLabel + ' vs ' + eventLabel);
      if (new Date(2025, 5, 1, 10).getHours() !== 10) console.error('Local calendar arithmetic changed');
      </script></body></html>`,
    );
    const result = spawnSync(
      process.execPath,
      [
        join(dirname(fileURLToPath(import.meta.url)), "run-story-gate.mjs"),
        "--static-dir",
        directory,
        "--out",
        join(directory, "output"),
        "--concurrency",
        "1",
        "--no-a11y",
        "--no-screenshots",
      ],
      {
        env: { ...process.env, TZ: "America/New_York" },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    // A runner that could not start (no installed browser, a crash, the
    // spawn timeout) leaves no report; surface its stderr instead of an
    // ENOENT that hides the cause.
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      readFileSync(join(directory, "output", "report.json"), "utf8"),
    );
    expect(report.results[0].consoleErrors, result.stderr).toEqual([]);
    expect(report.results[0].verdict).toBe("good");
    expect(result.status).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 40000);
