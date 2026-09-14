/**
 * Playwright UI-smoke spec for the Documents View app flow using the real
 * renderer fixture.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";

/**
 * Visual + smoke coverage for the builtin standalone Knowledge surface at
 * `/character/documents` (#8876).
 *
 * This is the surface where files become knowledge: documents list from
 * `GET /api/documents` and carry provenance (uploaded file vs learned vs a
 * mirrored voice transcript), plus per-doc delete affordances — the
 * file<->knowledge lifecycle the issue calls out. Here we stub `/api/documents`
 * with a populated fixture covering those provenances so the populated state
 * renders, then capture it at desktop + mobile.
 *
 * Assertions are deliberately lenient (mirroring files-view / builtin-views-
 * visual): the view must mount, render readable content (the stubbed documents
 * surface), and never throw an uncaught page error — a redesign/regression
 * guard, not pixel-exact.
 */

const DOCS_FIXTURE = {
  documents: [
    {
      id: "doc-upload",
      filename: "q3-strategy.pdf",
      contentType: "application/pdf",
      fileSize: 81_920,
      createdAt: 1_700_000_003_000,
      fragmentCount: 12,
      scope: "shared",
      source: "upload",
      url: "/api/media/" + "c".repeat(64) + ".pdf",
      provenance: {
        kind: "upload",
        label: "Uploaded file",
        detail: "q3-strategy.pdf",
      },
      canEditText: false,
      canDelete: true,
      content: { text: "Q3 strategy: expand the assistant surface area..." },
    },
    {
      id: "doc-learned",
      filename: "Notes from chat",
      contentType: "text/plain",
      fileSize: 2_048,
      createdAt: 1_700_000_002_000,
      fragmentCount: 3,
      scope: "shared",
      source: "learned",
      provenance: {
        kind: "learned",
        label: "Learned in conversation",
      },
      canEditText: true,
      canDelete: true,
      content: { text: "User prefers morning meetings and async updates." },
    },
    {
      id: "doc-transcript",
      filename: "Standup recording",
      contentType: "text/plain",
      fileSize: 6_144,
      createdAt: 1_700_000_001_000,
      fragmentCount: 5,
      scope: "shared",
      source: "upload",
      provenance: {
        kind: "upload",
        label: "Voice transcript",
        detail: "Standup recording",
      },
      canEditText: false,
      canDelete: true,
      transcriptId: "transcript-1",
      transcriptAudioUrl: "/api/media/" + "d".repeat(64) + ".webm",
      content: {
        text: "Standup: shipped the files view, knowledge linkage...",
      },
    },
  ],
  total: 3,
  limit: 100,
  offset: 0,
};

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
] as const;

test.describe("Knowledge/Documents view visual + smoke (desktop + mobile)", () => {
  for (const vp of VIEWPORTS) {
    test(`documents ${vp.name}`, async ({ page }) => {
      const screenshotDir =
        process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
        path.join(process.cwd(), "test-results", "documents-view");
      await mkdir(screenshotDir, { recursive: true });

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await seedAppStorage(page);
      await installDefaultAppRoutes(page);

      // Registered AFTER the defaults so these take precedence (Playwright runs
      // route handlers in reverse registration order). Match the list endpoint
      // exactly so the populated fixture renders.
      await page.route("**/api/documents?**", (route) => {
        const facet = new URL(route.request().url()).searchParams.get(
          "knowledgeFacet",
        );
        const documents =
          facet === "transcript"
            ? DOCS_FIXTURE.documents.filter((document) => document.transcriptId)
            : DOCS_FIXTURE.documents;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ...DOCS_FIXTURE,
            documents,
            total: documents.length,
          }),
        });
      });
      await page.route("**/api/documents", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(DOCS_FIXTURE),
        }),
      );
      // The viewer auto-selects the first document and fetches its detail +
      // fragments; stub both so the populated "good" state (a document open in
      // the reader) renders instead of a load error. Matches `{ document }` and
      // `{ documentId, fragments, count }` (the client contracts).
      await page.route("**/api/documents/*/fragments", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            documentId: "doc-upload",
            fragments: [
              {
                id: "frag-1",
                text: "Q3 strategy: expand the assistant surface area...",
                position: 0,
                createdAt: 1_700_000_003_000,
              },
            ],
            count: 1,
          }),
        }),
      );
      await page.route("**/api/documents/*", (route) => {
        // Skip the list endpoint (handled above) and the fragments sub-path.
        const url = route.request().url();
        if (url.includes("/fragments")) return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ document: DOCS_FIXTURE.documents[0] }),
        });
      });

      await openAppPath(page, "/character/documents");

      const viewRoot = page.getByTestId("documents-view");
      await expect(viewRoot).toBeVisible({ timeout: 60_000 });
      const uploaded = viewRoot.getByRole("button", {
        name: "Open q3-strategy.pdf",
        exact: true,
      });
      await expect(uploaded).toBeVisible();
      const facets = viewRoot.getByRole("navigation", {
        name: "Filter knowledge by media type",
      });
      await facets.getByRole("button", { name: /^Transcripts/ }).click();
      await expect(uploaded).toHaveCount(0);
      await expect(
        viewRoot.getByRole("button", {
          name: "Open Standup recording",
          exact: true,
        }),
      ).toBeVisible();
      await facets.getByRole("button", { name: /^All/ }).click();
      await expect(uploaded).toBeVisible();
      await expect
        .poll(
          async () =>
            viewRoot.evaluate(
              (root) =>
                (root as HTMLElement).innerText.trim().replace(/\s+/g, " ")
                  .length,
            ),
          {
            message: `documents ${vp.name} should render readable content`,
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(10);

      await captureScreenshotWithQualityRetry(page, `documents ${vp.name}`, {
        fullPage: false,
        path: path.join(screenshotDir, `documents-${vp.name}.png`),
        attempts: 3,
      });

      expect(
        pageErrors,
        `documents ${vp.name} must not throw an uncaught page error`,
      ).toEqual([]);
    });
  }
});
