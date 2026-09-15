/** Exercises owner review preparation, provider failure, decisions and reload through the full app and production HTTP adapter; synthetic responses isolate browser behavior from live-model and database acceptance. */
import { expect } from "@playwright/test";
import type {
  ParentingAgreementView,
  PreparedAgreementReview,
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
    test(`owner prepares and decides cited agreement review at ${width}px`, async ({
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
      const at = "2026-09-13T00:00:00Z";
      const agreement: ParentingAgreementView = {
        artifact: {
          id: "synthetic-review",
          agentId: "ui-smoke-agent",
          householdId: "default",
          agreementKey: "synthetic-review",
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
      let review: PreparedAgreementReview | null = null;
      let requests = 0;
      let correctionLostResponse = false;
      await page.route("**/api/lifeops/agreements**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "GET") {
          if (path === "/api/lifeops/agreements")
            return route.fulfill({ json: { agreements: [agreement] } });
          if (path.endsWith("/review"))
            return route.fulfill({ json: { review } });
          if (path.endsWith("/pins"))
            return route.fulfill({ json: { pins: [] } });
          if (path.endsWith("/guest-options"))
            return route.fulfill({ json: { candidates: [], grants: [] } });
          if (path.endsWith("/pin-targets"))
            return route.fulfill({
              json: {
                agent: { id: "ui-smoke-agent", name: "Family test" },
                chats: [],
              },
            });
        }
        if (request.method() === "POST" && path.endsWith("/review")) {
          requests++;
          if (requests === 1)
            return route.fulfill({
              status: 503,
              json: {
                error: {
                  code: "AGREEMENT_REVIEW_UNAVAILABLE",
                  message:
                    "Review model is temporarily unavailable; retry preparation.",
                },
              },
            });
          if (!review) {
            agreement.obligations = [
              {
                id: "travel-review",
                agentId: agreement.artifact.agentId,
                artifactId: agreement.artifact.id,
                title: "Unanswered travel requests",
                obligationText:
                  "An unanswered travel request remains unresolved; silence is not consent.",
                pageStart: 2,
                pageEnd: 2,
                citationText:
                  "An unanswered request is unresolved; silence must not be represented as consent.",
                status: "proposed",
                proposedByEntityId: agreement.artifact.agentId,
                decidedByEntityId: null,
                decisionReason: null,
                decidedAt: null,
                createdAt: at,
                updatedAt: at,
              },
            ];
            agreement.obligations.push({
              ...agreement.obligations[0],
              id: "notice-review",
              title: "Share school notices",
              obligationText: "Share school notices within 24 hours.",
              citationText:
                "Each parent forwards school notices within 24 hours.",
              pageStart: 1,
              pageEnd: 1,
            });
            review = {
              artifactId: agreement.artifact.id,
              generatedAt: at,
              explanation:
                "This synthetic unsigned plan requires owner review.",
              outcome: "proposals",
              obligations: agreement.obligations,
            };
          }
          return route.fulfill({ json: { review } });
        }
        if (
          request.method() === "POST" &&
          path.endsWith("/synthetic-review/obligations")
        ) {
          const payload = request.postDataJSON();
          if (
            payload.citationText !==
            "Overnight travel requires seven days notice."
          )
            return route.fulfill({
              status: 422,
              json: {
                error: {
                  code: "AGREEMENT_REVIEW_CITATION_INVALID",
                  message: "The citation does not match its source pages.",
                },
              },
            });
          let obligation = agreement.obligations.find(
            (item) => item.id === "owner-travel-notice",
          );
          const created = !obligation;
          if (!obligation) {
            obligation = {
              ...agreement.obligations[0],
              ...payload,
              id: "owner-travel-notice",
              status: "proposed",
              proposedByEntityId: "self",
              decidedByEntityId: null,
              decidedAt: null,
              decisionReason: null,
            };
            agreement.obligations.push(obligation);
          }
          if (!correctionLostResponse) {
            correctionLostResponse = true;
            return route.abort("failed");
          }
          return route.fulfill({
            status: created ? 201 : 200,
            json: { obligation, created },
          });
        }
        if (
          request.method() === "POST" &&
          path.endsWith("/travel-review/decision")
        ) {
          expect(request.postDataJSON()).toEqual({
            decision: "approve",
            reason: "Checked the page 2 citation against the synthetic source.",
          });
          const obligation = agreement.obligations[0];
          expect(obligation.status).toBe("proposed");
          obligation.status = "approved";
          obligation.decidedByEntityId = "self";
          obligation.decisionReason = request.postDataJSON().reason;
          obligation.decidedAt = at;
          return route.fulfill({ json: { obligation } });
        }
        return route.fulfill({
          status: 400,
          json: { error: "Unexpected synthetic agreement request" },
        });
      });
      await openAppPath(page, "/lifeops/family");
      const prepare = page.getByRole("button", {
        name: "Prepare review",
        exact: true,
      });
      await expect(prepare).toBeVisible();
      await captureFamilyAccent(page, testInfo, prepare, "prepare", width);
      await prepare.click();
      await expect(
        page.getByText(
          "Review model is temporarily unavailable; retry preparation.",
        ),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Approve", exact: true }),
      ).toHaveCount(0);
      await prepare.click();
      const proposal = page
        .getByRole("article")
        .filter({ hasText: "Unanswered travel requests" });
      await expect(proposal).toContainText("Pages 2–2");
      await expect(proposal).toContainText(
        "silence must not be represented as consent",
      );
      const approve = proposal.getByRole("button", {
        name: "Approve",
        exact: true,
      });
      await expect(approve).toBeDisabled();
      await proposal
        .getByLabel("Decision reason")
        .fill("Checked the page 2 citation against the synthetic source.");
      const otherClause = page
        .getByRole("article")
        .filter({ hasText: "Share school notices" });
      await expect(otherClause.getByLabel("Decision reason")).toHaveValue("");
      await expect(
        otherClause.getByRole("button", { name: "Approve", exact: true }),
      ).toBeDisabled();
      const approveBox = await approve.boundingBox();
      if (!approveBox)
        throw new Error("Approval control has no rendered geometry");
      expect(approveBox.height).toBeGreaterThanOrEqual(44);
      await approve.scrollIntoViewIfNeeded();
      await captureFamilyState(page, testInfo, `cited-review-${width}`);
      await approve.click();
      await expect(proposal).toContainText("approved");
      await page.reload();
      await expect(
        page
          .getByRole("article")
          .filter({ hasText: "Unanswered travel requests" }),
      ).toContainText("approved");
      await expect(
        page.getByRole("button", { name: "Prepare review", exact: true }),
      ).toHaveCount(0);
      expect(requests).toBe(2);
      await page
        .getByRole("article")
        .filter({ hasText: "Unanswered travel requests" })
        .scrollIntoViewIfNeeded();
      await captureFamilyState(page, testInfo, `review-restored-${width}`);
      await page
        .getByRole("button", { name: "Add missing requirement" })
        .click();
      const editor = page.getByRole("region", {
        name: "Add a cited requirement",
      });
      await editor
        .getByLabel("Requirement title")
        .fill("Overnight travel notice");
      await editor
        .getByLabel("Requirement", { exact: true })
        .fill("Give seven days notice before overnight travel.");
      await editor
        .getByLabel("Exact source quote")
        .fill("Incorrect synthetic quote.");
      await editor.getByLabel("First page").fill("2");
      await editor.getByLabel("Last page").fill("2");
      await editor.getByRole("button", { name: "Save proposal" }).click();
      await expect(editor.getByRole("alert")).toContainText(
        "citation does not match",
      );
      await captureFamilyState(
        page,
        testInfo,
        `owner-correction-invalid-${width}`,
      );
      await editor
        .getByLabel("Exact source quote")
        .fill("Overnight travel requires seven days notice.");
      const saveCorrection = editor.getByRole("button", {
        name: "Save proposal",
      });
      await captureFamilyAccent(
        page,
        testInfo,
        saveCorrection,
        "owner-correction",
        width,
      );
      await saveCorrection.click();
      await expect(editor.getByRole("alert")).toBeVisible();
      await expect(editor.getByLabel("Requirement title")).toHaveValue(
        "Overnight travel notice",
      );
      await saveCorrection.click();
      await expect(
        editor.getByRole("button", { name: "Add missing requirement" }),
      ).toBeVisible();
      const correction = page
        .getByRole("article")
        .filter({ hasText: "Overnight travel notice" });
      await expect(correction).toHaveCount(1);
      await expect(correction).toContainText("proposed");
      await expect(
        correction.getByRole("button", { name: "Approve", exact: true }),
      ).toBeDisabled();
      await page.reload();
      await expect(correction).toHaveCount(1);
      await expect(correction).toContainText("proposed");
      await expect(proposal).toContainText("approved");
      await correction.scrollIntoViewIfNeeded();
      await captureFamilyState(
        page,
        testInfo,
        `owner-correction-restored-${width}`,
      );
      await testInfo.attach("console-network-log", {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: "application/json",
      });
      expect(errors).toEqual([]);
    });
  });
}
