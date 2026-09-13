/**
 * Cloud-only onboarding UI-smoke (#13377) — the PRODUCTION DEFAULT flow.
 *
 * Unlike the onboarding-to-home lanes (which opt in to the dev-only runtime
 * chooser via injectFullCapabilityHost), these specs boot the app exactly as a
 * shipped build does: an explicit `"0"` override reproduces the production
 * default while the Playwright Vite server intentionally defaults development
 * to the chooser. Covered: the sign-in-only greeting (no
 * local/remote options), the tap-driven flow to a real completion at
 * provisioning success (no tutorial gate), session injection (a stored steward
 * session skips the sign-in ask — zero interactions to the onboarded home),
 * and existing-agents auto-adoption (the picker never appears in cloud-only).
 * Cloud login + provisioning are mocked at the network boundary, same as the
 * chooser-mode cloud lane.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { installDedicatedAdoptionConsentProof } from "../cloud-live-dedicated-adoption-consent";
import {
  expectNoPageDiagnostics,
  expectOnlyAllowedPageDiagnostics,
  installPageDiagnosticsGuard,
  seedAppStorage,
} from "./helpers";
import {
  CLOUD_AGENT_NAME,
  completeCloudOnlyOnboardingToHome,
  completeCloudOnlySessionInjectionToHome,
  expectCloudOnlySignInOnboarding,
  injectCloudAuthToken,
  installCloudRoutes,
  installHomeRoutes,
  makeScreenshotter,
  PERSONAL_ELIZA_ID,
  settleHomeEntrance,
} from "./onboarding-to-home.shared";

const SCREENSHOT_DIR = path.join(
  process.cwd(),
  "aesthetic-audit-output",
  "onboarding-cloud-only",
);
const screenshot = makeScreenshotter(SCREENSHOT_DIR);

/**
 * #14362: cloud-only onboarding lands the user straight in chat/home. The
 * one-time post-onboarding character-select landing was removed, so the
 * character-customization surface must never mount automatically — it is
 * reached explicitly from Settings/launcher. Assert both the surface (the
 * `character-editor-view` marker) and the route.
 */
async function expectNoCharacterSelectLanding(page: Page): Promise<void> {
  await expect(page.getByTestId("character-editor-view")).toHaveCount(0);
  expect(page.url()).not.toContain("character/select");
}

test.describe("cloud-only onboarding (production default)", () => {
  test.beforeEach(({ page }) => {
    installPageDiagnosticsGuard(page);
  });

  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.title.includes("activation redirect")) {
      await expectOnlyAllowedPageDiagnostics(page, testInfo.title, [
        /^http\.409: POST .*\/upgrade-tier$/,
        /^console\.error: Failed to load resource: the server responded with a status of 409 \(Conflict\)$/,
      ]);
      return;
    }
    await expectNoPageDiagnostics(page, testInfo.title);
  });

  test("fresh boot offers exactly one path — Sign in to Eliza Cloud — and the tap completes onboarding at provisioning success", async ({
    page,
  }) => {
    await rm(SCREENSHOT_DIR, { force: true, recursive: true });
    const state = await installHomeRoutes(page);
    // Zero existing cloud agents: the bind is a silent auto-provision, so the
    // whole flow is greeting → one tap → onboarded home.
    await installCloudRoutes(page, { agentCount: 0 });
    await seedAppStorage(page, {
      "eliza:first-run-complete": "",
      "eliza:enable-runtime-chooser": "0",
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expectCloudOnlySignInOnboarding(page);
    await screenshot(page, "cloud-only-sign-in-greeting");

    const { surface } = await completeCloudOnlyOnboardingToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });

  test("session injection: a stored Eliza Cloud session skips the sign-in ask — zero interactions to the onboarded home", async ({
    page,
  }) => {
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page, { agentCount: 0 });
    await seedAppStorage(page, {
      "eliza:first-run-complete": "",
      "eliza:enable-runtime-chooser": "0",
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnlySessionInjectionToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-session-injection-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });

  test("existing cloud agents are auto-adopted — no picker, zero interactions", async ({
    page,
  }) => {
    await injectCloudAuthToken(page);
    const state = await installHomeRoutes(page);
    await installCloudRoutes(page);
    await seedAppStorage(page, {
      "eliza:first-run-complete": "",
      "eliza:enable-runtime-chooser": "0",
    });

    await page.goto("/", { waitUntil: "domcontentloaded" });

    const { surface } = await completeCloudOnlySessionInjectionToHome(page, {
      state,
    });
    await settleHomeEntrance(page);
    await screenshot(page, "cloud-only-auto-adopt-home");
    expect(await surface.getAttribute("data-page")).toBe("home");
    await expectNoCharacterSelectLanding(page);
  });

  test("an existing Dedicated row requires visible hosting terms before one confirmed POST", async ({
    page,
  }, testInfo) => {
    await injectCloudAuthToken(page);
    await installHomeRoutes(page);
    await installCloudRoutes(page);
    const dedicatedAgentId = "22222222-2222-4222-8222-222222222222";
    const quoteId = "b".repeat(64);
    let adoptionPosts = 0;
    await page.unroute("**/api/v1/eliza/personal");
    await page.route("**/api/v1/eliza/personal", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            identity: {
              id: PERSONAL_ELIZA_ID,
              displayName: CLOUD_AGENT_NAME,
              runtime: "shared",
            },
          },
        }),
      });
    });
    await page.route("**/upgrade-tier/adopt-existing", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              quoteId,
              dedicatedAgentId,
              adoptionState: "available",
              status: "stopped",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54059,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          }),
        });
        return;
      }
      adoptionPosts += 1;
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({
        action: "adopt_existing_dedicated",
        quoteId,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            dedicatedAgentId,
            runtime: "dedicated_pending_cutover",
            status: "running",
          },
        }),
      });
    });
    await page.route("**/upgrade-tier/cutover", async (route) => {
      const origin = new URL(page.url()).origin;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            personalElizaId: PERSONAL_ELIZA_ID,
            activeAgentId: dedicatedAgentId,
            runtime: "dedicated",
            apiBase: origin,
            importedMessages: 0,
          },
        }),
      });
    });
    await page.route("**/upgrade-tier", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              quoteId: "a".repeat(64),
              canActivate: true,
              activation: {
                state: "in_progress",
                dedicatedAgentId,
                status: "stopped",
              },
            },
          }),
        });
        return;
      }
      throw new Error("The generic activation POST must not be dispatched");
    });
    await seedAppStorage(page, {
      "eliza:first-run-complete": "",
      "eliza:enable-runtime-chooser": "0",
    });

    const dedicatedAdoptionProof = installDedicatedAdoptionConsentProof(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const confirm = page.getByTestId(
      "choice-__first_run__:dedicated-adoption:confirm",
    );
    try {
      await expect(confirm).toBeVisible({ timeout: 20_000 });
      expect(adoptionPosts).toBe(0);

      await page.screenshot({
        path: testInfo.outputPath("existing-consent.png"),
      });
      await dedicatedAdoptionProof.confirmVisibleConsent(confirm);
      await expect.poll(() => adoptionPosts).toBe(1);
      await expect(page.getByTestId("home-screen")).toBeVisible({
        timeout: 20_000,
      });
      await settleHomeEntrance(page);
    } finally {
      dedicatedAdoptionProof.dispose();
    }
  });

  test("an activation redirect surfaces existing Dedicated adoption and completes cutover", async ({
    page,
  }, testInfo) => {
    await injectCloudAuthToken(page);
    await installHomeRoutes(page);
    await installCloudRoutes(page);
    const dedicatedAgentId = "22222222-2222-4222-8222-222222222222";
    const adoptionQuoteId = "b".repeat(64);
    let activationPosts = 0;
    let adoptionQuoteGets = 0;
    let adoptionPosts = 0;
    let cutoverPosts = 0;
    await page.route("**/api/auth/cli-session", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessionId: "dedicated-adoption-session" }),
      });
    });
    await page.route("**/api/auth/cli-session/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "authenticated",
          apiKey: "ui-smoke-onboarding-cloud-token",
          organizationId: "ui-smoke-onboarding-org",
          userId: "ui-smoke-onboarding-user",
        }),
      });
    });
    await page.unroute("**/api/v1/eliza/personal");
    await page.route("**/api/v1/eliza/personal", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            identity: {
              id: PERSONAL_ELIZA_ID,
              displayName: CLOUD_AGENT_NAME,
              runtime: "shared",
            },
          },
        }),
      });
    });
    await page.route("**/upgrade-tier/adopt-existing", async (route) => {
      if (route.request().method() === "GET") {
        adoptionQuoteGets += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              quoteId: adoptionQuoteId,
              dedicatedAgentId,
              adoptionState: "available",
              status: "stopped",
              startsCompute: true,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54059,
              deficitUsd: 0,
              stateDisposition: "verified_backup_present",
              canAdopt: true,
              requiresCatalogRestore: false,
              requiresConfirmation: true,
              action: "adopt_existing_dedicated",
            },
          }),
        });
        return;
      }
      adoptionPosts += 1;
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({
        action: "adopt_existing_dedicated",
        quoteId: adoptionQuoteId,
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            dedicatedAgentId,
            runtime: "dedicated_pending_cutover",
            status: "running",
          },
        }),
      });
    });
    await page.route("**/upgrade-tier/cutover", async (route) => {
      cutoverPosts += 1;
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({
        dedicatedAgentId,
      });
      const origin = new URL(page.url()).origin;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: {
            personalElizaId: PERSONAL_ELIZA_ID,
            activeAgentId: dedicatedAgentId,
            runtime: "dedicated",
            apiBase: origin,
            importedMessages: 0,
          },
        }),
      });
    });
    await page.route("**/upgrade-tier", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            success: true,
            data: {
              quoteId: "a".repeat(64),
              sourceAgentId: PERSONAL_ELIZA_ID,
              hourlyRateUsd: 0.01,
              dailyRateUsd: 0.24,
              minimumBalanceUsd: 0.72,
              minimumRunwayDays: 3,
              balanceUsd: 115.54059,
              deficitUsd: 0,
              canActivate: true,
              requiresConfirmation: true,
              action: "activate_dedicated",
              activation: { state: "available" },
            },
          }),
        });
        return;
      }
      activationPosts += 1;
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({
        action: "activate_dedicated",
        quoteId: "a".repeat(64),
      });
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          success: false,
          code: "dedicated_adoption_selection_required",
          error: "Continue with same-row adoption.",
        }),
      });
    });
    await seedAppStorage(page, {
      "eliza:first-run-complete": "",
      "eliza:enable-runtime-chooser": "0",
    });

    const dedicatedAdoptionProof = installDedicatedAdoptionConsentProof(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const confirm = page.getByTestId(
      "choice-__first_run__:dedicated-adoption:confirm",
    );
    try {
      await expect(confirm).toBeVisible({ timeout: 20_000 });
      await expect(page.getByText("Start your Dedicated Eliza?")).toBeVisible();
      expect(activationPosts).toBe(0);
      expect(adoptionQuoteGets).toBe(0);
      expect(adoptionPosts).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath("activation-consent.png"),
      });
      await confirm.click();
      await expect.poll(() => adoptionQuoteGets).toBe(1);
      await expect(
        page.getByText("Use your existing Dedicated agent?"),
      ).toBeVisible();
      expect(activationPosts).toBe(1);
      expect(adoptionQuoteGets).toBe(1);
      expect(adoptionPosts).toBe(0);

      await page.screenshot({
        path: testInfo.outputPath("redirect-adoption-consent.png"),
      });
      await dedicatedAdoptionProof.confirmVisibleConsent(confirm);
      await expect.poll(() => adoptionPosts).toBe(1);
      await expect.poll(() => cutoverPosts).toBe(1);
      await expect(page.getByTestId("home-screen")).toBeVisible({
        timeout: 20_000,
      });
      await settleHomeEntrance(page);
    } finally {
      dedicatedAdoptionProof.dispose();
    }
  });
});
