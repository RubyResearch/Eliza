/** Browser acceptance for document-pin review over the real app with controlled HTTP authority responses; no real document is shared. */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

test.use({ video: "on", trace: "on" });
for (const width of [1280, 390]) {
  test(`document pins require a fresh review after conflict at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await seedAppStorage(page, { "eliza:ui-accent": "orange" });
    await installDefaultAppRoutes(page);
    const logs: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) =>
      logs.push(`${message.type()}: ${message.text()}`),
    );
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path.startsWith("/api/documents"))
        logs.push(`${response.status()} ${path}`);
    });
    const document = {
      id: "10000000-0000-4000-8000-000000000001",
      filename: "Synthetic parenting agreement.md",
      contentType: "text/markdown",
      fileSize: 85,
      createdAt: Date.parse("2026-09-12T12:00:00Z"),
      fragmentCount: 1,
      source: "upload",
      scope: "owner-private",
      provenance: { kind: "upload", label: "Manual upload" },
      canEditText: true,
      canDelete: true,
      content: {
        text: "Synthetic agreement for UI review only. School pickup is Friday at 3 PM.",
      },
    };
    const roomId = "10000000-0000-4000-8000-000000000002";
    let revision = `dar1_${"a".repeat(64)}`;
    let rooms: string[] = [];
    let writes = 0;
    let agentPin = false;
    await page.route("**/api/documents**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/documents")
        return route.fulfill({
          json: {
            ok: true,
            available: true,
            agentId: "ui-smoke-agent",
            documents: [document],
            total: 1,
            limit: 100,
            offset: 0,
          },
        });
      if (path === `/api/documents/${document.id}`)
        return route.fulfill({ json: { document } });
      if (path === `/api/documents/${document.id}/fragments`)
        return route.fulfill({
          json: {
            documentId: document.id,
            fragments: [
              {
                id: "fragment",
                text: document.content.text,
                position: 0,
                createdAt: document.createdAt,
              },
            ],
            count: 1,
          },
        });
      if (path !== `/api/documents/${document.id}/pins`)
        return route.fallback();
      if (route.request().method() === "GET")
        return route.fulfill({
          json: {
            documentId: document.id,
            targets: { agent: agentPin, roomIds: rooms },
            pinRevision: revision,
          },
        });
      expect(route.request().method()).toBe("PATCH");
      writes++;
      const payload = route.request().postDataJSON();
      expect(payload.agent).toBe(true);
      expect(payload.roomIds).toEqual([roomId]);
      expect(payload.expectedPinRevision).toBe(revision);
      if (writes === 1) {
        revision = `dar1_${"b".repeat(64)}`;
        return route.fulfill({
          status: 409,
          json: { error: "This document changed" },
        });
      }
      rooms = payload.roomIds;
      agentPin = payload.agent;
      revision = `dar1_${"c".repeat(64)}`;
      return route.fulfill({
        json: {
          ok: true,
          documentId: document.id,
          targets: { agent: agentPin, roomIds: rooms },
        },
      });
    });
    await page.route("**/api/conversations**", (route) =>
      route.fulfill({
        json: {
          conversations: [
            {
              id: "different-conversation-id",
              roomId,
              title: "Family planning",
              createdAt: "2026-09-12T12:00:00Z",
              updatedAt: "2026-09-12T12:00:00Z",
            },
          ],
        },
      }),
    );
    await openAppPath(page, "/character/documents");
    await page
      .getByRole("button", { name: new RegExp(document.filename) })
      .first()
      .click();
    await page.getByRole("button", { name: "Manage document pins" }).click();
    const sharing = page.getByRole("region", { name: "Document pins" });
    const reader = sharing.getByRole("checkbox", { name: /Family planning/ });
    await expect(reader).toBeVisible();
    await sharing.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`selection-${width}.png`),
      fullPage: true,
    });
    await sharing.getByRole("checkbox", { name: "Pin to this agent" }).check();
    await reader.check();
    await sharing.getByRole("button", { name: "Review pins" }).click();
    expect(writes).toBe(0);
    const save = sharing.getByRole("button", { name: "Save reviewed pins" });
    await page.mouse.move(0, 0);
    await page.screenshot({
      path: testInfo.outputPath(`review-rest-${width}.png`),
      fullPage: true,
    });
    await save.hover();
    await page.screenshot({
      path: testInfo.outputPath(`review-hover-${width}.png`),
      fullPage: true,
    });
    await save.click();
    await expect(sharing.getByRole("alert")).toContainText(
      "This document changed",
    );
    await expect(save).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`conflict-${width}.png`),
      fullPage: true,
    });
    await sharing.getByRole("button", { name: "Reload pins" }).click();
    await sharing.getByRole("checkbox", { name: "Pin to this agent" }).check();
    await reader.check();
    await sharing.getByRole("button", { name: "Review pins" }).click();
    expect(writes).toBe(1);
    await save.click();
    await expect(sharing.getByRole("status")).toContainText("Pins saved");
    await expect(reader).toBeChecked();
    expect(writes).toBe(2);
    await page.screenshot({
      path: testInfo.outputPath(`saved-${width}.png`),
      fullPage: true,
    });
    await testInfo.attach("console-network-log", {
      body: JSON.stringify(logs, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  });
}
