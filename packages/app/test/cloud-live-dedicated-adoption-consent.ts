/**
 * Certifies the existing-Dedicated consent shown by the real renderer.
 *
 * The proof only observes the quote response already requested by the product
 * and clicks the visible confirmation control. It never calls a Cloud endpoint
 * itself, so the user's consent boundary remains the only way forward.
 */

import type { Locator, Page, Response } from "@playwright/test";

type DedicatedAdoptionStateDisposition =
  | "fresh_boot_no_verified_backup"
  | "verified_backup_present"
  | "unreviewed_existing_target";

interface VisibleDedicatedAdoptionQuote {
  sourceAgentId: string;
  quoteId: string;
  dedicatedAgentId: string;
  status: string;
  startsCompute: boolean;
  hourlyRateUsd: number;
  dailyRateUsd: number;
  minimumBalanceUsd: number;
  minimumRunwayDays: number;
  balanceUsd: number;
  deficitUsd: number;
  stateDisposition: DedicatedAdoptionStateDisposition;
  requiresCatalogRestore: boolean;
}

export interface DedicatedAdoptionConsentProof {
  confirmVisibleConsent(
    confirm: Locator,
  ): Promise<DedicatedAdoptionApprovalBinding>;
  dispose(): void;
}

export interface DedicatedAdoptionApprovalBinding {
  sourceAgentId: string;
  quoteId: string;
  dedicatedAgentId: string;
}

class CloudLiveDedicatedAdoptionConsentProofError extends Error {
  readonly code = "CLOUD_LIVE_DEDICATED_ADOPTION_CONSENT_PROOF";

  constructor(readonly phase: "quote" | "copy" | "control") {
    super(`[cloud-live] Dedicated adoption consent ${phase} proof failed`);
    this.name = "CloudLiveDedicatedAdoptionConsentProofError";
  }
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectVisibleQuote(
  value: unknown,
  sourceAgentId: string,
): VisibleDedicatedAdoptionQuote | null {
  const root = recordOrNull(value);
  const quote = recordOrNull(root?.data);
  const status = typeof quote?.status === "string" ? quote.status.trim() : "";
  const quoteId =
    typeof quote?.quoteId === "string" ? quote.quoteId.trim() : "";
  const dedicatedAgentId =
    typeof quote?.dedicatedAgentId === "string"
      ? quote.dedicatedAgentId.trim()
      : "";
  const hourlyRateUsd = finiteNumber(quote?.hourlyRateUsd);
  const dailyRateUsd = finiteNumber(quote?.dailyRateUsd);
  const minimumBalanceUsd = finiteNumber(quote?.minimumBalanceUsd);
  const minimumRunwayDays = finiteNumber(quote?.minimumRunwayDays);
  const balanceUsd = finiteNumber(quote?.balanceUsd);
  const deficitUsd = finiteNumber(quote?.deficitUsd);
  const stateDisposition = quote?.stateDisposition;
  if (
    root?.success !== true ||
    !sourceAgentId ||
    !quoteId ||
    !dedicatedAgentId ||
    !status ||
    typeof quote?.startsCompute !== "boolean" ||
    typeof quote?.requiresCatalogRestore !== "boolean" ||
    hourlyRateUsd === null ||
    dailyRateUsd === null ||
    minimumBalanceUsd === null ||
    minimumRunwayDays === null ||
    balanceUsd === null ||
    deficitUsd === null ||
    (stateDisposition !== "fresh_boot_no_verified_backup" &&
      stateDisposition !== "verified_backup_present" &&
      stateDisposition !== "unreviewed_existing_target") ||
    quote?.requiresConfirmation !== true ||
    quote?.action !== "adopt_existing_dedicated"
  ) {
    return null;
  }
  return {
    sourceAgentId,
    quoteId,
    dedicatedAgentId,
    status,
    startsCompute: quote.startsCompute,
    hourlyRateUsd,
    dailyRateUsd,
    minimumBalanceUsd,
    minimumRunwayDays,
    balanceUsd,
    deficitUsd,
    stateDisposition,
    requiresCatalogRestore: quote.requiresCatalogRestore,
  };
}

function exactVisibleConsentLines(
  quote: VisibleDedicatedAdoptionQuote,
): string[] {
  const disposition =
    quote.stateDisposition === "verified_backup_present"
      ? "Your verified backup will be restored."
      : quote.stateDisposition === "fresh_boot_no_verified_backup"
        ? "This starts fresh; no verified backup is available."
        : "Your current data stays. No verified Cloud backup is available.";
  return [
    "Use your existing Dedicated agent?",
    `$${quote.dailyRateUsd.toFixed(2)}/day ($${quote.hourlyRateUsd.toFixed(2)}/hour).`,
    `Balance: $${quote.balanceUsd.toFixed(2)}; $${quote.minimumBalanceUsd.toFixed(2)} required.`,
    ...(quote.deficitUsd > 0
      ? [`Add $${quote.deficitUsd.toFixed(2)} to start.`]
      : []),
    disposition,
  ];
}

function exactJoinVisibleConsentLines(
  quote: VisibleDedicatedAdoptionQuote,
): string[] {
  const disposition =
    quote.stateDisposition === "verified_backup_present"
      ? "Cloud will restore its reviewed backup before switching."
      : quote.stateDisposition === "fresh_boot_no_verified_backup"
        ? "No verified backup will be restored. This Dedicated Eliza starts fresh."
        : "Cloud has not verified a restorable backup for this existing Dedicated Eliza.";
  return [
    "Bring this Dedicated Eliza online?",
    "We found an existing Dedicated Eliza for this account. Confirming reuses it — it does not create another one.",
    quote.startsCompute
      ? `This starts Dedicated hosting at $${quote.dailyRateUsd.toFixed(2)}/day ($${quote.hourlyRateUsd.toFixed(2)}/hr).`
      : "Dedicated hosting is already active; confirming does not start another server.",
    `Balance: $${quote.balanceUsd.toFixed(2)} · Required: $${quote.minimumBalanceUsd.toFixed(2)} (${quote.minimumRunwayDays} days of runway)`,
    `Current Dedicated status: ${quote.status.replaceAll(/[_-]+/g, " ")}.`,
    disposition,
    ...(quote.requiresCatalogRestore
      ? ["Cloud must repair its saved setup before it can start."]
      : []),
    "Your Shared Eliza keeps working until Dedicated is healthy. If setup fails or you cancel, nothing switches.",
  ];
}

function dedicatedAdoptionQuoteSourceAgentId(response: Response): string {
  if (response.request().method() !== "GET" || response.status() !== 200) {
    return "";
  }
  try {
    const match = new URL(response.url()).pathname.match(
      /^\/api\/(?:cloud\/)?v1\/eliza\/agents\/([^/]+)\/upgrade-tier\/adopt-existing$/,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  } catch {
    // error-policy:J3 malformed response URLs cannot establish the source
    // identity for a billable approval and remain ineligible for confirmation.
    return "";
  }
}

/**
 * Observe the product's own quote request and certify the exact consent copy
 * before performing the same visible click a human uses.
 */
export function installDedicatedAdoptionConsentProof(
  page: Page,
): DedicatedAdoptionConsentProof {
  let latestQuoteAttempt: Promise<VisibleDedicatedAdoptionQuote | null> | null =
    null;
  let confirmationInFlight = false;
  const observeResponse = (response: Response): void => {
    const sourceAgentId = dedicatedAdoptionQuoteSourceAgentId(response);
    if (!sourceAgentId) return;
    latestQuoteAttempt = response
      .json()
      .then((value) => projectVisibleQuote(value, sourceAgentId))
      .catch(() => null);
  };
  page.on("response", observeResponse);

  return {
    async confirmVisibleConsent(confirm) {
      if (confirmationInFlight) return;
      confirmationInFlight = true;
      try {
        const quoteAttempt = latestQuoteAttempt;
        if (!quoteAttempt) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("quote");
        }
        const quote = await quoteAttempt;
        if (!quote) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("quote");
        }

        const isJoinConfirmation =
          (await confirm.getAttribute("data-testid")) ===
          "dedicated-adoption-confirm";
        const consentSurface = confirm.locator(
          isJoinConfirmation
            ? "xpath=ancestor::*[@data-testid='dedicated-adoption-review'][1]"
            : "xpath=ancestor::*[@data-testid='thread-line'][1]",
        );
        if (!(await consentSurface.isVisible())) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("copy");
        }
        const copyMatches = await consentSurface.evaluate(
          (element, expectedLines) => {
            const normalize = (text: string) =>
              text.replace(/\s+/g, " ").trim();
            const visibleCopy = normalize((element as HTMLElement).innerText);
            let cursor = 0;
            for (const expectedLine of expectedLines) {
              const expected = normalize(expectedLine);
              const index = visibleCopy.indexOf(expected, cursor);
              if (index < 0) return false;
              cursor = index + expected.length;
            }
            return true;
          },
          isJoinConfirmation
            ? exactJoinVisibleConsentLines(quote)
            : exactVisibleConsentLines(quote),
        );
        if (!copyMatches) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("copy");
        }
        const confirmationControlMatches = await confirm.evaluate(
          (element, expected) =>
            (element as HTMLElement).innerText.replace(/\s+/g, " ").trim() ===
            expected,
          isJoinConfirmation
            ? quote.startsCompute
              ? "Start Dedicated"
              : "Continue Dedicated setup"
            : quote.startsCompute
              ? "Start Dedicated"
              : "Connect",
        );
        if (!confirmationControlMatches || !(await confirm.isEnabled())) {
          throw new CloudLiveDedicatedAdoptionConsentProofError("control");
        }
        try {
          await confirm.click({ timeout: 15_000 });
        } catch {
          throw new CloudLiveDedicatedAdoptionConsentProofError("control");
        }
        return {
          sourceAgentId: quote.sourceAgentId,
          quoteId: quote.quoteId,
          dedicatedAgentId: quote.dedicatedAgentId,
        };
      } finally {
        confirmationInFlight = false;
      }
    },
    dispose() {
      page.off("response", observeResponse);
    },
  };
}
