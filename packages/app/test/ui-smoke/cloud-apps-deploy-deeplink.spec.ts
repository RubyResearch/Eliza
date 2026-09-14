/**
 * #10823 shell leg — the Apps Deploy UI is reachable in the app shell via the
 * deep-link navigation intent.
 *
 * `eliza://apps/deploy` (and `https://eliza.app/apps/deploy`) resolve to the
 * `{ viewId: "cloud-apps", viewPath: "/cloud-apps" }` intent
 * (src/deep-link-routing.ts — unit-tested there). This spec proves the OTHER
 * half in a real Chromium shell: dispatching that intent on the
 * `eliza:navigate:view` bus mounts the registered `cloud-apps` app-shell page
 * (NativeAppsStudio → ApplicationsPage → ApplicationDetailPage), all the way to
 * the repo/ref Deploy control and its Cloud API request payload.
 *
 * The `cloud-apps` page registers only on non-web platforms (the web build
 * serves the Applications surfaces via CloudRouterShell), so the Electrobun
 * runtime marker is injected BEFORE boot — the same desktop-platform signal the
 * packaged shell provides (precedent: voice-desktop-selftest.spec.ts). Eliza
 * Cloud API traffic (`https://api.eliza.app/**`) is route-mocked: this lane
 * proves the SHELL wiring; the cloud API contract itself is covered by the
 * packages/ui mock-cloud client e2e and the cloud API's own suites.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/cloud-apps-deploy-deeplink.spec.ts
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, type Route, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { seedStewardSession, setStewardSession } from "./helpers/test-auth";

const EVIDENCE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../test-results/ui-smoke-artifacts/8621-mobile-cloud-agent",
);

const APP_ID = "6e0a4f1c-9d2b-4c33-8f0e-5a7b1c2d3e4f";
const APP_NAME = "Deep Link Deploy Proof";
const DEPLOY_COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

function mockApp(): Record<string, unknown> {
  return {
    id: APP_ID,
    name: APP_NAME,
    description: "ui-smoke fixture app for the #10823 deep-link entry",
    slug: "deep-link-deploy-proof",
    organization_id: "org-1",
    created_by_user_id: "user-deploy-proof",
    app_url: "https://deploy-proof.example.test",
    allowed_origins: ["https://deploy-proof.example.test"],
    api_key_id: "key-1",
    affiliate_code: null,
    referral_bonus_credits: null,
    total_requests: 12,
    total_users: 3,
    total_credits_used: "0",
    logo_url: null,
    website_url: null,
    contact_email: null,
    metadata: {},
    deployment_status: "READY",
    production_url: "https://deploy-proof.apps.elizacloud.ai",
    last_deployed_at: "2026-07-01T00:00:00.000Z",
    github_repo: "elizaOS/eliza",
    linked_character_ids: null,
    monetization_enabled: false,
    inference_markup_percentage: null,
    purchase_share_percentage: null,
    platform_offset_amount: null,
    custom_pricing_enabled: null,
    total_creator_earnings: null,
    total_platform_revenue: null,
    discord_automation: null,
    telegram_automation: null,
    twitter_automation: null,
    promotional_assets: null,
    email_notifications: null,
    response_notifications: null,
    is_active: true,
    is_approved: true,
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    last_used_at: "2026-07-01T00:00:00.000Z",
  };
}

async function fulfillJson(
  route: Route,
  status: number,
  body: unknown,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/** Mock the Eliza Cloud control plane the NativeAppsStudio pages call. */
async function installCloudApiMocks(
  page: Page,
  unmocked: string[],
  deployRequests: unknown[],
): Promise<void> {
  await page.route("https://api.eliza.app/api/v1/apps{,/**}", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (method === "GET" && path === "/api/v1/apps") {
      await fulfillJson(route, 200, { apps: [mockApp()] });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}`) {
      await fulfillJson(route, 200, { app: mockApp() });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}/monetization`) {
      // The Overview tab preloads monetization settings alongside the app.
      await fulfillJson(route, 200, {
        success: true,
        monetization: {
          monetization_enabled: false,
          inference_markup_percentage: 0,
          purchase_share_percentage: 0,
          platform_offset_amount: 0,
          custom_pricing_enabled: false,
        },
      });
      return;
    }
    if (method === "GET" && path === `/api/v1/apps/${APP_ID}/deploy/status`) {
      await fulfillJson(route, 200, {
        success: true,
        deploymentId: "dep-1",
        status: "READY",
        vercelUrl: "https://deploy-proof.apps.elizacloud.ai",
        error: null,
        startedAt: "2026-07-01T00:00:00.000Z",
      });
      return;
    }
    if (method === "POST" && path === `/api/v1/apps/${APP_ID}/deploy`) {
      deployRequests.push(route.request().postDataJSON());
      await fulfillJson(route, 202, {
        success: true,
        deploymentId: "dep-2",
        status: "BUILDING",
        startedAt: "2026-07-02T00:00:00.000Z",
      });
      return;
    }
    unmocked.push(`${method} ${path}`);
    await fulfillJson(route, 404, { error: `unmocked in spec: ${path}` });
  });
}

test.beforeEach(async ({ page }) => {
  // Desktop-platform signal BEFORE boot: registers the `cloud-apps` app-shell
  // page (web builds route Applications through CloudRouterShell instead).
  await page.addInitScript(() => {
    const secureStore = new Map<string, string>();
    const host = window as unknown as Record<string, unknown>;
    host.__electrobunWindowId = 1;
    host.__ELIZA_ELECTROBUN_RPC__ = {
      request: {
        desktopGetVersion: async () => ({ runtime: "playwright-smoke" }),
        desktopRegisterShortcut: async () => ({ success: true }),
        desktopSetTrayMenu: async () => undefined,
        secureStoreGet: async ({ kind }: { kind: string }) =>
          secureStore.has(kind)
            ? { ok: true, value: secureStore.get(kind) }
            : { ok: false, reason: "not_found" },
        secureStoreSet: async ({
          kind,
          value,
        }: {
          kind: string;
          value: string;
        }) => {
          secureStore.set(kind, value);
          return { ok: true };
        },
        secureStoreDelete: async ({ kind }: { kind: string }) => ({
          ok: true,
          deleted: secureStore.delete(kind),
        }),
      },
      onMessage: () => undefined,
      offMessage: () => undefined,
    };
  });
  await seedStewardSession(page, {
    jwt: true,
    subject: "user-deploy-proof",
    userId: "user-deploy-proof",
  });
  // Mark first-run complete with a local active server: since #19511 a fresh
  // boot drives cloud onboarding through GET /api/v1/eliza/personal, which this
  // spec's cloud mock deliberately does not serve — the deep-link contract under
  // test assumes an already-set-up shell, not the onboarding flow.
  await seedAppStorage(page, {
    "eliza:ui-shell-mode": "web",
    "elizaos:active-server": JSON.stringify({
      id: "cloud:deploy-proof",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://api.eliza.app/api/v1",
      accessToken: "shared-agent-token",
    }),
  });
  // Instrument the navigate-view bus BEFORE boot: the listener count is the
  // explicit shell-ready boundary the deep-link dispatch below waits on, and
  // the dispatch count backs the single-delivery assertion — a real OS deep
  // link is delivered exactly once, so the spec must never retry the event.
  await page.addInitScript(() => {
    const instrumented = window as unknown as {
      __elizaNavigateViewListenerCount?: number;
      __elizaCloudAppsNavigateDispatchCount?: number;
    };
    instrumented.__elizaNavigateViewListenerCount = 0;
    instrumented.__elizaCloudAppsNavigateDispatchCount = 0;
    const originalAdd = window.addEventListener.bind(window);
    const originalRemove = window.removeEventListener.bind(window);
    const originalDispatch = window.dispatchEvent.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "eliza:navigate:view") {
        instrumented.__elizaNavigateViewListenerCount =
          (instrumented.__elizaNavigateViewListenerCount ?? 0) + 1;
      }
      return (originalAdd as (...args: unknown[]) => unknown)(type, ...rest);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "eliza:navigate:view") {
        instrumented.__elizaNavigateViewListenerCount =
          (instrumented.__elizaNavigateViewListenerCount ?? 0) - 1;
      }
      return (originalRemove as (...args: unknown[]) => unknown)(type, ...rest);
    }) as typeof window.removeEventListener;
    window.dispatchEvent = ((event: Event) => {
      const detail = (event as CustomEvent<{ viewId?: string }>).detail;
      if (
        event.type === "eliza:navigate:view" &&
        detail?.viewId === "cloud-apps"
      ) {
        instrumented.__elizaCloudAppsNavigateDispatchCount =
          (instrumented.__elizaCloudAppsNavigateDispatchCount ?? 0) + 1;
      }
      return originalDispatch(event);
    }) as typeof window.dispatchEvent;
  });
  await installDefaultAppRoutes(page);
});

test("eliza://apps/deploy intent mounts the Apps studio and submits repo/ref deploy", async ({
  page,
}) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const unmocked: string[] = [];
  const deployRequests: unknown[] = [];
  await installCloudApiMocks(page, unmocked, deployRequests);

  await openAppPath(page, "/");
  // Desktop startup reconciles protected storage after document-start seeds.
  // Restore the canonical session at the live boundary the Apps studio reads.
  await setStewardSession(page, {
    jwt: true,
    subject: "user-deploy-proof",
    userId: "user-deploy-proof",
  });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("steward-token-sync")),
  );

  // The seeded completed first-run can surface the one-time "Set up Eliza"
  // permissions dialog, whose modal inerts the page behind it — dismiss it
  // BEFORE driving the deep-link navigation.
  const setupDialog = page.getByRole("dialog", { name: "Set up Eliza" });
  const setupDialogShown = await setupDialog
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (setupDialogShown) {
    await setupDialog.getByRole("button", { name: "Skip for now" }).click();
    await expect(setupDialog).toBeHidden();
  }

  // The shell registers its `eliza:navigate:view` listener in a mount effect,
  // so an intent dispatched before registration would be silently lost. Wait
  // on the instrumented registration count (the explicit shell-ready
  // boundary), then dispatch the exact intent
  // `resolveDeepLinkNavigationIntent("apps/deploy")` produces (unit-locked in
  // packages/app/src/deep-link-routing.test.ts) exactly once, on the same bus
  // main.tsx's live deep-link handler uses.
  await page.waitForFunction(
    () =>
      ((window as unknown as { __elizaNavigateViewListenerCount?: number })
        .__elizaNavigateViewListenerCount ?? 0) > 0,
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("eliza:navigate:view", {
        detail: { viewId: "cloud-apps", viewPath: "/cloud-apps" },
      }),
    );
  });
  // Applications list (NativeAppsStudio → ApplicationsPage) with the fixture
  // app, mounted by that single delivery.
  const appCard = page.getByText(APP_NAME, { exact: true }).first();
  await expect(appCard).toBeVisible({ timeout: 30_000 });
  // Negative assertion: the intent was delivered once and only once — a retry
  // loop here would mask a lost-intent regression at the listener boundary.
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as {
            __elizaCloudAppsNavigateDispatchCount?: number;
          }
        ).__elizaCloudAppsNavigateDispatchCount,
    ),
  ).toBe(1);
  await page.screenshot({
    path: `${EVIDENCE_DIR}/cloud-apps-deploy-01-list.png`,
    fullPage: true,
  });

  // Into the detail page — the Overview tab hosts Deploy/Redeploy.
  await appCard.click();
  const deployButton = page
    .getByRole("button", { name: /redeploy|deploy/i })
    .first();
  await expect(deployButton).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("Repository URL")).toHaveValue(
    "https://github.com/elizaOS/eliza.git",
  );
  await page.getByLabel("Commit SHA").fill(DEPLOY_COMMIT_SHA);
  await page.getByLabel("Dockerfile path").fill("Dockerfile");
  await page.screenshot({
    path: `${EVIDENCE_DIR}/cloud-apps-deploy-02-detail-deploy.png`,
    fullPage: true,
  });
  await deployButton.click();
  await expect.poll(() => deployRequests.length).toBe(1);
  expect(deployRequests[0]).toEqual({
    repoUrl: "https://github.com/elizaOS/eliza.git",
    ref: DEPLOY_COMMIT_SHA,
    dockerfile: "Dockerfile",
  });
  await page.screenshot({
    path: `${EVIDENCE_DIR}/cloud-apps-deploy-03-submit.png`,
    fullPage: true,
  });

  expect(
    unmocked,
    `cloud API calls the spec did not mock: ${unmocked.join(", ")}`,
  ).toEqual([]);
});
