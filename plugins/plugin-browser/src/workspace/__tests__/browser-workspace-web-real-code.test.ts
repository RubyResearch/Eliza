/**
 * Real-code web workspace tests for command execution against JSDOM pages.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetBrowserWorkspaceStateForTests,
  executeBrowserWorkspaceCommand,
  openBrowserWorkspaceTab,
} from "../browser-workspace.js";

const webEnv: NodeJS.ProcessEnv = {};

const homeHtml = `<!doctype html>
<html>
  <head><title>Browser Workspace Test Shop</title></head>
  <body>
    <main>
      <h1>Browser Workspace Test Shop</h1>
      <p id="intro">Ready for a real web-mode command flow.</p>
      <a id="details-link" href="/details">View Details</a>
      <form id="search-form" action="/search" method="post">
        <label for="query">Search</label>
        <input id="query" name="query" value="" />
        <textarea id="notes" name="notes"></textarea>
        <button id="submit-search" type="submit">Submit Search</button>
      </form>
    </main>
  </body>
</html>`;

const detailsHtml = `<!doctype html>
<html>
  <head><title>Details Loaded</title></head>
  <body>
    <h1>Details Loaded</h1>
    <p id="details-copy">The details route was reached by a structured click.</p>
  </body>
</html>`;

const searchHtml = `<!doctype html>
<html>
  <head><title>Search Submitted</title></head>
  <body>
    <h1>Search Submitted</h1>
    <p id="search-result">Form submission reached the routed POST response.</p>
  </body>
</html>`;

const longSnapshotTail = "complete-snapshot-tail";
const longSnapshotHtml = `<!doctype html>
<html>
  <head><title>Complete Snapshot</title></head>
  <body><main><p>${"browser content ".repeat(80)}${longSnapshotTail}</p></main></body>
</html>`;

describe("browser workspace web-mode real-code command flow", () => {
  beforeEach(async () => {
    await __resetBrowserWorkspaceStateForTests();
  });

  it("reads page prose without script or style payloads and leaves HTML intact", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "network",
        networkAction: "route",
        url: "https://example.test/text",
        responseBody:
          '<html><body><h1>Rehearsal</h1><p>Keep all prose.</p><script>window.privateImplementation="script-noise";</script><style>.style-noise{color:red}</style><input name="query" value="visible-search"><input type="hidden" name="csrf" value="hidden-token"><input type="password" name="password" value="password-secret"></body></html>',
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://example.test/text" },
      webEnv,
    );
    const text = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "body" },
      webEnv,
    );
    expect(text.value).toBe("RehearsalKeep all prose.");
    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    expect(JSON.stringify(snapshot)).not.toContain("script-noise");
    expect(JSON.stringify(snapshot)).not.toContain("style-noise");
    expect(JSON.stringify(snapshot)).toContain("visible-search");
    expect(JSON.stringify(snapshot)).not.toContain("hidden-token");
    expect(JSON.stringify(snapshot)).not.toContain("password-secret");
    const html = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "get", selector: "body", getMode: "html" },
      webEnv,
    );
    expect(html.value).toContain("script-noise");
    expect(html.value).toContain("style-noise");
  });

  it("navigates, clicks, types, screenshots, and extracts DOM through the command router", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );

    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: homeHtml,
        subaction: "network",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: detailsHtml,
        subaction: "network",
        url: "https://example.test/details",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: searchHtml,
        subaction: "network",
        url: "https://example.test/search",
      },
      webEnv,
    );

    const navigated = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/",
      },
      webEnv,
    );
    expect(navigated).toMatchObject({
      mode: "web",
      subaction: "navigate",
      tab: {
        url: "https://example.test/",
      },
    });

    const title = await executeBrowserWorkspaceCommand(
      { getMode: "title", id: tab.id, subaction: "get" },
      webEnv,
    );
    expect(title.value).toBe("Browser Workspace Test Shop");

    const typed = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#query",
        subaction: "type",
        value: "calendar",
      },
      webEnv,
    );
    expect(typed.value).toMatchObject({
      selector: "#query",
      value: "calendar",
    });

    const filled = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#notes",
        subaction: "fill",
        value: "prefer morning slots",
      },
      webEnv,
    );
    expect(filled.value).toMatchObject({
      selector: "#notes",
      value: "prefer morning slots",
    });

    const queryValue = await executeBrowserWorkspaceCommand(
      {
        getMode: "value",
        id: tab.id,
        selector: "#query",
        subaction: "get",
      },
      webEnv,
    );
    expect(queryValue.value).toBe("calendar");

    const screenshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "screenshot" },
      webEnv,
    );
    expect(screenshot.mode).toBe("web");
    expect(screenshot.snapshot?.data).toEqual(expect.any(String));
    expect(screenshot.snapshot?.data.length).toBeGreaterThan(100);

    const clicked = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#details-link",
        subaction: "click",
      },
      webEnv,
    );
    expect(clicked).toMatchObject({
      mode: "web",
      subaction: "click",
      tab: { title: "Details Loaded", url: "https://example.test/details" },
    });

    const detailsSnapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );
    expect(detailsSnapshot.value).toMatchObject({
      bodyText: expect.stringContaining("structured click"),
      title: "Details Loaded",
      url: "https://example.test/details",
    });

    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#query",
        subaction: "fill",
        value: "travel",
      },
      webEnv,
    );
    const submitted = await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        selector: "#submit-search",
        subaction: "click",
      },
      webEnv,
    );

    expect(submitted).toMatchObject({
      mode: "web",
      subaction: "click",
      tab: { title: "Search Submitted", url: "https://example.test/search" },
    });

    const resultText = await executeBrowserWorkspaceCommand(
      {
        getMode: "text",
        id: tab.id,
        selector: "#search-result",
        subaction: "get",
      },
      webEnv,
    );
    expect(resultText.value).toBe(
      "Form submission reached the routed POST response.",
    );
  });

  it("preserves semantic page content beyond the former fixed snapshot ceiling", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: longSnapshotHtml,
        subaction: "network",
        url: "https://example.test/complete-snapshot",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        subaction: "navigate",
        url: "https://example.test/complete-snapshot",
      },
      webEnv,
    );

    const snapshot = await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "snapshot" },
      webEnv,
    );

    expect(snapshot.value?.bodyText).toContain(longSnapshotTail);
    expect(snapshot.value?.bodyText?.length).toBeGreaterThan(800);
  });

  it("scrolls and hovers a routed page through the command router (#18259)", async () => {
    const tab = await openBrowserWorkspaceTab(
      { show: true, url: "about:blank" },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      {
        id: tab.id,
        networkAction: "route",
        responseBody: homeHtml,
        subaction: "network",
        url: "https://example.test/",
      },
      webEnv,
    );
    await executeBrowserWorkspaceCommand(
      { id: tab.id, subaction: "navigate", url: "https://example.test/" },
      webEnv,
    );

    const scrolledDown = await executeBrowserWorkspaceCommand(
      { direction: "down", id: tab.id, pixels: 480, subaction: "scroll" },
      webEnv,
    );
    expect(scrolledDown.mode).toBe("web");
    expect(scrolledDown.value).toMatchObject({ axis: "y", value: 480 });

    const scrolledUp = await executeBrowserWorkspaceCommand(
      { direction: "up", id: tab.id, pixels: 200, subaction: "scroll" },
      webEnv,
    );
    expect(scrolledUp.value).toMatchObject({ axis: "y", value: 280 });

    const hovered = await executeBrowserWorkspaceCommand(
      { id: tab.id, selector: "#details-link", subaction: "hover" },
      webEnv,
    );
    expect(hovered.mode).toBe("web");
    expect(hovered.value).toMatchObject({
      hovered: true,
      selector: "#details-link",
    });
  });
});
