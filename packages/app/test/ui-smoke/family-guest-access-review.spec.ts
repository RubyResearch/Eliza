/** Exercises named agreement sharing through the real app and production HTTP adapter with synthetic authority responses; no person receives access or a message. */
import { expect } from "@playwright/test";
import type {
  AgreementGuestAccessOptions,
  AgreementGuestGrantPreview,
  HouseholdKnowledgeGrant,
  ParentingAgreementView,
} from "../../../../plugins/plugin-personal-assistant/src/lifeops/household/agreement-knowledge";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  captureFamilyAccent,
  captureFamilyState,
} from "./helpers/family-review-capture";
import { seedStewardSession } from "./helpers/test-auth";
import { test } from "./helpers/viewport-video";

test.use({ video: "on", trace: "on" });
for (const width of [1280, 390]) {
  test.describe(`viewport ${width}`, () => {
    test.use({
      viewport: { width, height: 900 },
    });
    test(`agreement guest review binds the selected permission at ${width}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await seedAppStorage(page, { "eliza:ui-accent": "orange" });
      await seedStewardSession(page, { jwt: true });
      await installDefaultAppRoutes(page);
      const errors: string[] = [];
      const diagnostics: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) =>
        diagnostics.push(`${message.type()}: ${message.text()}`),
      );
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (path.startsWith("/api/lifeops/agreements"))
          diagnostics.push(`${response.status()} ${path}`);
      });
      const at = "2026-09-12T12:00:00Z";
      const agreement: ParentingAgreementView = {
        artifact: {
          id: "synthetic-agreement",
          agentId: "ui-smoke-agent",
          householdId: "default",
          agreementKey: "synthetic-plan",
          version: 1,
          supersedesArtifactId: null,
          title: "Synthetic parenting plan",
          originalFilename: "synthetic-plan.pdf",
          documentId: "synthetic-document",
          mediaUrl: "/api/media/synthetic.pdf",
          mediaFileName: "synthetic.pdf",
          contentSha256: "a".repeat(64),
          mimeType: "application/pdf",
          byteSize: 2048,
          pageCount: 2,
          uploadedByEntityId: "self",
          createdAt: at,
        },
        obligations: [],
      };
      const candidates: AgreementGuestAccessOptions["candidates"] = [
        {
          principalEntityId: "synthetic-alex",
          householdGrantId: "permission-alex",
          displayName: "Alex",
          identityLabel: "email: alex@example.test",
          role: "co_parent",
          expiresAt: null,
          issuedAt: at,
        },
        {
          principalEntityId: "synthetic-sam",
          householdGrantId: "permission-sam",
          displayName: "Sam",
          identityLabel: "email: sam@example.test",
          role: "caregiver",
          expiresAt: null,
          issuedAt: at,
        },
      ];
      let grant: HouseholdKnowledgeGrant | null = null;
      let issueCount = 0;
      let revokeCount = 0;
      let optionsUnavailable = true;
      await page.route("**/api/lifeops/agreements**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "GET") {
          if (path === "/api/lifeops/agreements")
            return route.fulfill({ json: { agreements: [agreement] } });
          if (path.endsWith("/pin-targets"))
            return route.fulfill({
              json: {
                agent: { id: "ui-smoke-agent", name: "Family test" },
                chats: [],
              },
            });
          if (path.endsWith("/review"))
            return route.fulfill({ json: { review: null } });
          if (path.endsWith("/pins"))
            return route.fulfill({ json: { pins: [] } });
          if (path.endsWith("/guest-options")) {
            if (optionsUnavailable)
              return route.fulfill({
                status: 503,
                json: {
                  error: "Guest permissions are temporarily unavailable",
                },
              });
            const options: AgreementGuestAccessOptions = {
              candidates,
              grants:
                grant && !grant.revokedAt
                  ? [
                      {
                        grantId: grant.id,
                        principalEntityId: grant.principalEntityId,
                        householdGrantId: grant.householdGrantId,
                        displayName: "Sam",
                        issuedAt: grant.createdAt,
                        canRead: true,
                        denial: null,
                      },
                    ]
                  : [],
            };
            return route.fulfill({ json: options });
          }
        }
        if (request.method() === "POST" && path.endsWith("/grants/preview")) {
          const input = request.postDataJSON();
          const selected = candidates.find(
            (item) => item.householdGrantId === input.householdGrantId,
          );
          expect(selected).toBeDefined();
          expect(input.principalEntityId).toBe(selected?.principalEntityId);
          expect(input.artifactId).toBe(agreement.artifact.id);
          const preview: AgreementGuestGrantPreview = {
            allowed: true,
            ...input,
            effects: ["read_artifact_metadata", "read_approved_obligations"],
            exclusions: [
              "read_proposed_or_rejected_obligations",
              "mutate_agreement",
              "inherit_access_from_pin",
            ],
            denial: null,
          };
          return route.fulfill({ json: { preview } });
        }
        if (request.method() === "POST" && path.endsWith("/grants")) {
          const input = request.postDataJSON();
          expect(input).toEqual({
            artifactId: agreement.artifact.id,
            principalEntityId: "synthetic-sam",
            householdGrantId: "permission-sam",
          });
          issueCount++;
          grant = {
            id: "synthetic-binding",
            agentId: "ui-smoke-agent",
            householdId: "default",
            ...input,
            issuedByEntityId: "self",
            revokedAt: null,
            revokedByEntityId: null,
            revocationReason: null,
            createdAt: at,
            updatedAt: at,
          };
          return route.fulfill({ json: { grant } });
        }
        if (
          request.method() === "POST" &&
          path === "/api/lifeops/agreements/grants/synthetic-binding/revoke"
        ) {
          expect(request.postDataJSON()).toEqual({
            reason: "Synthetic review complete",
          });
          expect(grant).not.toBeNull();
          if (!grant)
            throw new Error("Cannot revoke an unissued synthetic grant");
          grant.revokedAt = at;
          grant.revokedByEntityId = "self";
          grant.revocationReason = "Synthetic review complete";
          revokeCount++;
          return route.fulfill({ json: { grant } });
        }
        return route.fulfill({
          status: 400,
          json: { error: "Unexpected synthetic agreement request" },
        });
      });
      await openAppPath(page, "/lifeops/family");
      await expect(
        page.getByText("Guest permissions are temporarily unavailable", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Allow access", exact: true }),
      ).toHaveCount(0);
      optionsUnavailable = false;
      await page
        .getByRole("button", { name: "Refresh guest permissions" })
        .click();
      const choice = page.getByLabel("Verified guest permission", {
        exact: true,
      });
      const allow = page.getByRole("button", {
        name: "Allow access",
        exact: true,
      });
      await expect(choice).toBeVisible();
      const choiceBox = await choice.boundingBox();
      if (!choiceBox)
        throw new Error("Guest permission control has no rendered geometry");
      expect(choiceBox.height).toBeGreaterThanOrEqual(44);
      expect(choiceBox.width).toBeGreaterThanOrEqual(44);
      await choice.selectOption("permission-alex");
      await page
        .getByRole("button", { name: "Preview permission", exact: true })
        .click();
      await expect(allow).toBeEnabled();
      await choice.selectOption("permission-sam");
      await expect(allow).toBeDisabled();
      expect(issueCount).toBe(0);
      await page
        .getByRole("button", { name: "Preview permission", exact: true })
        .click();
      await expect(allow).toBeEnabled();
      await captureFamilyAccent(page, testInfo, allow, "guest-review", width);
      await allow.click();
      await expect(
        page.getByText("Guest access enabled.", { exact: true }),
      ).toBeVisible();
      expect(issueCount).toBe(1);
      await page
        .getByLabel("Existing guest access", { exact: true })
        .selectOption("synthetic-binding");
      await page
        .getByLabel("Reason for removing access", { exact: true })
        .fill("Synthetic review complete");
      await page
        .getByRole("button", { name: "Remove access", exact: true })
        .click();
      await expect(
        page.getByText("Guest access removed.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("No guest access to remove.", { exact: true }),
      ).toBeVisible();
      expect(revokeCount).toBe(1);
      await expect(
        page.getByLabel("Reason for removing access", { exact: true }),
      ).toHaveCount(0);
      await captureFamilyState(page, testInfo, `guest-removed-${width}`);
      await testInfo.attach("console-network-log", {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: "application/json",
      });
      expect(errors).toEqual([]);
    });
  });
}
