// Real interaction coverage for the built-in app page-views that all-pages-
// clicksafe only render-smokes (runtime, plugins, database, skills, trajectories,
// relationships, stream, and rolodex). Each test proves the page is
// wired to a real endpoint (fires its data query on load) AND that a primary
// control does something — not just that the page renders. Sibling of
// apps-diagnostics-interactions.spec.ts; runs keyless against the stub.

import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.beforeEach(async ({ page }) => {
  await seedAppStorage(page, { "eliza:developerMode": "1" });
  await installDefaultAppRoutes(page);
});

function countRequests(page: Page, pattern: RegExp): () => number {
  let n = 0;
  page.on("request", (req) => {
    if (pattern.test(req.url())) n += 1;
  });
  return () => n;
}

test("runtime view loads a snapshot and re-queries it on a poll", async ({
  page,
}) => {
  // The minimal redesign dropped the manual Refresh button: the snapshot stays
  // live via a silent background poll. Assert the load query fires on mount and
  // the poll re-queries the source (no user-facing refresh control).
  const runtimeReqs = countRequests(page, /\/api\/runtime(?:\?|$)/);
  await openAppPath(page, "/apps/runtime");
  await expect(page.getByTestId("runtime-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(runtimeReqs).toBeGreaterThan(0);

  const before = runtimeReqs();
  await expect.poll(runtimeReqs, { timeout: 30_000 }).toBeGreaterThan(before);
});

test("plugins view loads plugins and search filters the list", async ({
  page,
}) => {
  const pluginReqs = countRequests(page, /\/api\/plugins(?:\?|$)/);
  await openAppPath(page, "/apps/plugins");
  await expect(page.getByTestId("plugins-view-page")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(pluginReqs).toBeGreaterThan(0);

  // Search now runs through the floating chat composer — the plugins view takes
  // over its placeholder + live draft (no in-page search box). The stub serves
  // openai + anthropic + plugin-browser: a specific search must narrow the
  // visible set; clearing it must restore.
  const search = page.getByTestId("chat-composer-textarea");
  await expect(search).toHaveAttribute("placeholder", /search plugins/i, {
    timeout: 15_000,
  });
  const cardsAll = await page.locator("[data-plugin-toggle]").count();
  await search.fill("browser");
  await expect
    .poll(() => page.locator("[data-plugin-toggle]").count())
    .toBeLessThan(Math.max(cardsAll, 2));
  await search.fill("");
  await expect
    .poll(() => page.locator("[data-plugin-toggle]").count())
    .toBe(cardsAll);
});

test("database view loads tables and runs a SQL query", async ({ page }) => {
  const queryReqs = countRequests(page, /\/api\/database\/query/);
  await openAppPath(page, "/apps/database");
  await expect(page.getByTestId("database-view")).toBeVisible({
    timeout: 60_000,
  });

  // Switch to the SQL editor, run a query, and prove a query request fired.
  await page
    .getByRole("button", { name: /SQL Editor/i })
    .first()
    .click();
  const editor = page.getByPlaceholder(/SELECT.*FROM/i).first();
  await expect(editor).toBeVisible({ timeout: 15_000 });
  await editor.fill("SELECT * FROM memories");
  const before = queryReqs();
  await page
    .getByRole("button", { name: /run query/i })
    .first()
    .click();
  await expect.poll(queryReqs).toBeGreaterThan(before);
});

test("skills view shows empty state and New Skill opens the create form", async ({
  page,
}) => {
  await openAppPath(page, "/apps/skills");
  await expect(page.getByTestId("skills-shell")).toBeVisible({
    timeout: 60_000,
  });
  // Stub serves no skills.
  await expect(page.getByTestId("skills-empty-state")).toBeVisible({
    timeout: 15_000,
  });

  await page
    .getByRole("button", { name: /new skill/i })
    .first()
    .click();
  // The create form exposes a "Create Skill" submit button.
  await expect(
    page.getByRole("button", { name: /create skill/i }).first(),
  ).toBeVisible({ timeout: 10_000 });
});

test("learning a skill opens an editable conversation draft", async ({
  page,
}) => {
  let sentMessages = 0;
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/(?:chat|conversations\/[^/]+\/messages)(?:\/stream)?(?:\?|$)/.test(
        request.url(),
      )
    )
      sentMessages += 1;
  });
  await openAppPath(page, "/character/skills");
  const learn = page.getByRole("button", {
    name: "Learn a skill",
    exact: true,
  });
  await expect(learn).toBeVisible({ timeout: 60_000 });
  const before = sentMessages;
  await learn.click();
  const composer = page.getByTestId("chat-composer-textarea");
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue(/Help me learn a new skill/);
  await composer.fill("Help me practice Spanish conversation.");
  await expect(composer).toHaveValue("Help me practice Spanish conversation.");
  expect(sentMessages).toBe(before);
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      /\/api\/(?:chat|conversations\/[^/]+\/messages)(?:\/stream)?(?:\?|$)/.test(
        request.url(),
      ),
  );
  await page.getByRole("button", { name: "send", exact: true }).click();
  expect((await submitted).postDataJSON()).toMatchObject({
    text: "Help me practice Spanish conversation.",
  });
  const thread = page.getByTestId("chat-thread");
  await expect(thread).toBeVisible();
  await expect(
    thread.getByText(/"fixture":"ui-smoke-assistant-v1"/),
  ).toHaveCount(1);
  expect(sentMessages).toBe(before + 1);
});

test("trajectories view loads and search re-queries", async ({ page }) => {
  const trajReqs = countRequests(page, /\/api\/trajectories(?:\?|$|\/)/);
  await openAppPath(page, "/apps/trajectories");
  await expect(page.getByTestId("trajectories-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(trajReqs).toBeGreaterThan(0);

  // Search runs through the floating chat composer now (the view overrides its
  // placeholder); typing re-queries the trajectories list.
  const before = trajReqs();
  const search = page.getByTestId("chat-composer-textarea");
  await expect(search).toHaveAttribute("placeholder", /search/i, {
    timeout: 15_000,
  });
  await search.fill("smoke-query");
  await expect.poll(trajReqs).toBeGreaterThan(before);
});

test("relationships view loads the entity and relationship graph", async ({
  page,
}) => {
  const relReqs = countRequests(
    page,
    /\/api\/lifeops\/(entities|relationships)(?:\?|$)/,
  );
  await openAppPath(page, "/apps/relationships");
  await expect(page.getByTestId("relationships-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect.poll(relReqs).toBeGreaterThan(0);
});

test("stream view renders the offline status surface", async ({ page }) => {
  await openAppPath(page, "/stream");
  await expect(page.locator("[data-stream-view]").first()).toBeVisible({
    timeout: 60_000,
  });
});

test("legacy rolodex URL opens the working relationship graph", async ({
  page,
}) => {
  const graphRequests = countRequests(
    page,
    /\/api\/lifeops\/(entities|relationships)(?:\?|$)/,
  );
  await openAppPath(page, "/rolodex");
  await expect(page.getByTestId("relationships-view")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page).toHaveURL(/\/apps\/relationships$/);
  await expect.poll(graphRequests).toBeGreaterThan(0);
});
