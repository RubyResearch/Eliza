/**
 * Post-login landing that opens the account-native personal Eliza in chat.
 *
 * After Steward login the page activates or reconnects the account's Dedicated
 * Eliza, persists its Cloud binding, then transitions to chat in the current
 * document. Credit-gated accounts get a direct path to billing instead of a
 * retry loop that cannot succeed without funds.
 *
 * Signed-out app-host visitors first restore a live apex session through the
 * PKCE SSO bridge, or fall back to `/login?returnTo=/join` when no apex session
 * marker exists. This keeps the same URL safe for marketing and email links.
 *
 * Web-build-only (mounted by the cloud router shell); never loaded by the native
 * tab/view app directly.
 */

import {
  formatHourlyRate,
  formatUSD,
} from "@elizaos/cloud-sdk/browser-contracts";
import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { client } from "../../api";
import type {
  DedicatedAdoptionConfirmationQuote,
  DedicatedAdoptionConfirmationRequester,
} from "../../api/client-cloud";
import type {
  DedicatedActivationConfirmationQuote,
  DedicatedActivationConfirmationRequester,
} from "../../api/dedicated-activation-confirmation";
import { Button } from "../../components/ui/button";
import {
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../state/persistence";
import { appModeNavigation } from "../app-mode/app-mode";
import { publishPersonalEntryHandoff } from "../app-mode/use-personal-entry";
import { openCloudBillingConsole } from "../billing-console";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  redirectToSsoBridge,
  shouldAutoBridgeToSso,
} from "../sso-bridge/sso-bridge";
import { resolveApexJoinHandoff } from "./lib/apex-app-handoff";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./lib/resolve-cloud-connection";
import { runJoinFlow } from "./lib/run-join-flow";
import { useJoinSessionAuth } from "./lib/use-join-session";

type JoinPhase = "connecting" | "ready" | "error" | "sign-out-error";

interface DedicatedAdoptionReview {
  quote: DedicatedAdoptionConfirmationQuote;
  reason: "initial" | "quote_changed";
}

interface PendingDedicatedAdoptionDecision {
  quoteId: string;
  resolve: (
    decision: {
      action: "adopt_existing_dedicated";
      quoteId: string;
    } | null,
  ) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

type JoinFailure =
  | { kind: "insufficient-credit"; message: string }
  | { kind: "generic"; message: string };

function describeJoinError(err: unknown): JoinFailure {
  if (
    err instanceof Error &&
    err.message === "Dedicated adoption was not confirmed."
  ) {
    return {
      kind: "generic",
      message:
        "Dedicated setup was not started. Your Shared Eliza is unchanged.",
    };
  }
  const message =
    err instanceof Error && err.message.trim()
      ? err.message
      : "Could not connect to your agent. Try again.";
  if (err instanceof Error && "status" in err && err.status === 402) {
    return { kind: "insufficient-credit", message };
  }
  return { kind: "generic", message };
}

function readableDedicatedStatus(status: string): string {
  return status.replaceAll(/[_-]+/g, " ");
}

export default function JoinPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const [phase, setPhase] = useState<JoinPhase>("connecting");
  const [detail, setDetail] = useState<string>("");
  const [error, setError] = useState<JoinFailure | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [openingBilling, setOpeningBilling] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const billingOpeningRef = useRef(false);
  const [adoptionReview, setAdoptionReview] =
    useState<DedicatedAdoptionReview | null>(null);
  const pendingAdoptionDecisionRef =
    useRef<PendingDedicatedAdoptionDecision | null>(null);
  const [activationReview, setActivationReview] =
    useState<DedicatedActivationConfirmationQuote | null>(null);
  const pendingActivationDecisionRef = useRef<{
    quote: DedicatedActivationConfirmationQuote;
    resolve: (
      decision: Awaited<ReturnType<DedicatedActivationConfirmationRequester>>,
    ) => void;
    dispose: () => void;
  } | null>(null);
  const appHandoff =
    typeof window === "undefined"
      ? null
      : resolveApexJoinHandoff(window.location.hostname);
  const ssoDecisionRef = useRef(false);
  const [ssoBridging, setSsoBridging] = useState<boolean | null>(null);
  // Guard so React StrictMode's double-mount does not duplicate identity reads.
  const startedRef = useRef(false);
  const activeAttemptRef = useRef<{
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);

  const settleDedicatedAdoption = useCallback(
    (
      decision: {
        action: "adopt_existing_dedicated";
        quoteId: string;
      } | null,
    ) => {
      const pending = pendingAdoptionDecisionRef.current;
      if (!pending) return;
      pendingAdoptionDecisionRef.current = null;
      if (pending.signal && pending.onAbort) {
        pending.signal.removeEventListener("abort", pending.onAbort);
      }
      setAdoptionReview(null);
      pending.resolve(decision?.quoteId === pending.quoteId ? decision : null);
    },
    [],
  );

  const requestDedicatedAdoptionConfirmation =
    useCallback<DedicatedAdoptionConfirmationRequester>(
      (quote, context) => {
        if (context.signal?.aborted) return Promise.resolve(null);
        // A replacement request can only follow a settled quote, but fail
        // closed if a future caller violates that ordering.
        settleDedicatedAdoption(null);
        return new Promise((resolve) => {
          const pending: PendingDedicatedAdoptionDecision = {
            quoteId: quote.quoteId,
            resolve,
            ...(context.signal ? { signal: context.signal } : {}),
          };
          const onAbort = () => {
            if (pendingAdoptionDecisionRef.current !== pending) return;
            settleDedicatedAdoption(null);
          };
          if (context.signal) {
            pending.onAbort = onAbort;
            context.signal.addEventListener("abort", onAbort, { once: true });
          }
          pendingAdoptionDecisionRef.current = pending;
          setAdoptionReview({ quote, reason: context.reason });
        });
      },
      [settleDedicatedAdoption],
    );

  const settleDedicatedActivation = useCallback((confirmed: boolean) => {
    const pending = pendingActivationDecisionRef.current;
    if (!pending) return;
    pendingActivationDecisionRef.current = null;
    pending.dispose();
    setActivationReview(null);
    pending.resolve(
      confirmed
        ? { action: "activate_dedicated", quoteId: pending.quote.quoteId }
        : null,
    );
  }, []);

  const requestDedicatedActivationConfirmation =
    useCallback<DedicatedActivationConfirmationRequester>(
      (quote, { signal }) => {
        if (signal?.aborted) return Promise.resolve(null);
        settleDedicatedActivation(false);
        return new Promise((resolve) => {
          const onAbort = () => settleDedicatedActivation(false);
          pendingActivationDecisionRef.current = {
            quote,
            resolve,
            dispose: () => signal?.removeEventListener("abort", onAbort),
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          setActivationReview(quote);
        });
      },
      [settleDedicatedActivation],
    );

  const start = useCallback(async () => {
    const authToken = resolveJoinAuthToken();
    if (!authToken) {
      // No session — the auth gate below redirects to login; bail quietly.
      return;
    }
    setPhase("connecting");
    setError(null);
    setBillingError(null);
    settleDedicatedAdoption(null);
    settleDedicatedActivation(false);
    activeAttemptRef.current?.controller.abort(
      new DOMException("Join attempt superseded", "AbortError"),
    );
    const controller = new AbortController();
    const attempt = (async () => {
      try {
        const result = await runJoinFlow({
          client,
          effects: {
            savePersistedActiveServer,
            savePersistedFirstRunComplete,
          },
          cloudApiBase: resolveJoinCloudApiBase(),
          authToken,
          signal: controller.signal,
          requestDedicatedAdoptionConfirmation,
          requestDedicatedActivationConfirmation,
          onProgress: (_status, progressDetail) => {
            if (progressDetail) setDetail(progressDetail);
          },
        });
        controller.signal.throwIfAborted();
        publishPersonalEntryHandoff(authToken, result);
        setPhase("ready");
        // The flow has configured the in-memory client and persisted the exact
        // binding. Its session-bound handoff receipt lets app-mode consume the
        // same authoritative result without a duplicate identity request.
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describeJoinError(err));
        setPhase("error");
      }
    })();
    activeAttemptRef.current = { controller, promise: attempt };
    await attempt;
    if (activeAttemptRef.current?.controller === controller) {
      activeAttemptRef.current = null;
    }
  }, [
    requestDedicatedAdoptionConfirmation,
    settleDedicatedAdoption,
    requestDedicatedActivationConfirmation,
    settleDedicatedActivation,
  ]);

  useEffect(
    () => () => {
      // React StrictMode performs a development-only setup → cleanup → setup
      // cycle while preserving refs. Reset the launch guard before aborting so
      // the second setup can replace the intentionally cancelled request.
      // On a real unmount there is no second setup, so this remains inert.
      startedRef.current = false;
      activeAttemptRef.current?.controller.abort(
        new DOMException("Join page unmounted", "AbortError"),
      );
    },
    [],
  );

  useEffect(() => {
    if (!session.ready) return;
    if (!session.authenticated) {
      if (ssoDecisionRef.current) return;
      ssoDecisionRef.current = true;
      if (!shouldAutoBridgeToSso()) {
        setSsoBridging(false);
        return;
      }
      void redirectToSsoBridge("/join").then((started) => {
        setSsoBridging(started);
      });
      return;
    }
    if (appHandoff) {
      // The apex is the billing console and cannot boot chat. Hand off before
      // any Shared identity request. Preserve /join so the app host restores
      // the domain-wide session before opening the same account-native Eliza.
      appModeNavigation.replace(appHandoff);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [session.ready, session.authenticated, appHandoff, start]);

  const handleRetry = useCallback(() => {
    startedRef.current = true;
    void start();
  }, [start]);

  const handleOpenBilling = useCallback(async () => {
    if (billingOpeningRef.current) return;
    billingOpeningRef.current = true;
    setOpeningBilling(true);
    setBillingError(null);
    const failedMessage = t("cloud.join.billingOpenFailed", {
      defaultValue: "Could not open billing. Please try again.",
    });
    try {
      if (!(await openCloudBillingConsole(resolveJoinCloudApiBase()))) {
        setBillingError(failedMessage);
      }
    } catch {
      // error-policy:J4 a platform browser launch failure keeps credit recovery available.
      setBillingError(failedMessage);
    } finally {
      billingOpeningRef.current = false;
      setOpeningBilling(false);
    }
  }, [t]);

  const handleSignOut = useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    const active = activeAttemptRef.current;
    active?.controller.abort(
      new DOMException("User signed out during join", "AbortError"),
    );
    await active?.promise;
    const { signOutFromSsoBridgedHost } = await import(
      "../sso-bridge/sso-bridge"
    );
    try {
      await signOutFromSsoBridgedHost();
      appModeNavigation.replace("/login");
    } catch {
      // error-policy:J4 the server still owns an authenticated session, so
      // keep the user here and expose a retry instead of claiming sign-out.
      setError({
        kind: "generic",
        message: t("cloud.userMenu.signOutFailed", {
          defaultValue: "Could not sign out safely. Please try again.",
        }),
      });
      setPhase("sign-out-error");
      setSigningOut(false);
    }
  }, [signingOut, t]);

  const signOutButton = (
    <Button
      variant="ghostMuted"
      size="wide"
      type="button"
      disabled={signingOut}
      onClick={() => void handleSignOut()}
    >
      {signingOut
        ? t("cloud.join.signingOut", { defaultValue: "Signing out..." })
        : t("cloud.join.signOut", { defaultValue: "Sign out" })}
    </Button>
  );

  // Signed out → send to login, returning here once authenticated.
  if (session.ready && !session.authenticated && ssoBridging === false) {
    return <Navigate to="/login?returnTo=/join" replace />;
  }

  if (phase === "ready") {
    return <Navigate to="/" replace />;
  }

  return (
    <div
      className="theme-cloud flex min-h-dvh w-full flex-col items-center justify-center bg-black px-4 text-white"
      style={{ background: "var(--background)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
          alt="Eliza Cloud"
          className="h-8 w-auto"
          draggable={false}
        />

        {phase === "sign-out-error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.signOutErrorTitle", {
                defaultValue: "Couldn't sign out",
              })}
            </h1>
            <p className="text-sm text-white/70" role="alert">
              {error?.message}
            </p>
            {signOutButton}
          </div>
        ) : activationReview ? (
          <div
            className="flex w-full flex-col items-center gap-4"
            data-testid="dedicated-activation-review"
          >
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.dedicatedActivationTitle", {
                defaultValue: "Start your Dedicated Eliza",
              })}
            </h1>
            <p className="text-sm leading-relaxed text-white/72">
              {t("cloud.join.dedicatedActivationDescription", {
                defaultValue:
                  "Your agent runs on Dedicated hosting. Review the cost, then start chatting when setup finishes.",
              })}
            </p>
            <p className="text-base font-medium text-white">
              {t("cloud.join.dedicatedActivationPrice", {
                defaultValue: "{{daily}}/day ({{hourly}})",
                daily: formatUSD(activationReview.dailyRateUsd),
                hourly: formatHourlyRate(activationReview.hourlyRateUsd),
              })}
            </p>
            <p className="text-sm leading-relaxed text-white/72">
              {t("cloud.join.dedicatedActivationBalance", {
                defaultValue:
                  "Balance: {{balance}} · Minimum to start: {{minimum}}",
                balance: formatUSD(activationReview.balanceUsd),
                minimum: formatUSD(activationReview.minimumBalanceUsd),
              })}
            </p>
            <p className="text-sm leading-relaxed text-white/72">
              {t("cloud.join.dedicatedActivationMinimum", {
                defaultValue:
                  "Minimum charge per successful start: {{minimum}}. Applies again after stopping and restarting.",
                minimum: formatUSD(activationReview.minimumActivationChargeUsd),
              })}
            </p>
            <div className="flex w-full flex-col gap-3">
              <Button
                variant="surface"
                size="wide"
                type="button"
                onClick={() => settleDedicatedActivation(true)}
              >
                {t("cloud.join.dedicatedActivationConfirm", {
                  defaultValue: "Start Dedicated",
                })}
              </Button>
              <Button
                variant="ghostMuted"
                size="wide"
                type="button"
                onClick={() => settleDedicatedActivation(false)}
              >
                {t("cloud.join.dedicatedActivationCancel", {
                  defaultValue: "Not now",
                })}
              </Button>
            </div>
            {signOutButton}
          </div>
        ) : adoptionReview ? (
          <div
            className="flex w-full flex-col items-center gap-4"
            data-testid="dedicated-adoption-review"
          >
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.dedicatedAdoptionTitle", {
                defaultValue: "Bring this Dedicated Eliza online?",
              })}
            </h1>
            {adoptionReview.reason === "quote_changed" ? (
              <p className="text-sm font-medium text-white" role="alert">
                {t("cloud.join.dedicatedAdoptionQuoteChanged", {
                  defaultValue:
                    "The Dedicated terms changed. Review the current quote before continuing.",
                })}
              </p>
            ) : null}
            <div className="space-y-3 text-sm leading-relaxed text-white/72">
              <p>
                {t("cloud.join.dedicatedAdoptionExisting", {
                  defaultValue:
                    "We found an existing Dedicated Eliza for this account. Confirming reuses it — it does not create another one.",
                })}
              </p>
              <p className="text-white">
                {adoptionReview.quote.startsCompute
                  ? t("cloud.join.dedicatedAdoptionStartsCompute", {
                      defaultValue:
                        "This starts Dedicated hosting at {{daily}}/day ({{hourly}}).",
                      daily: formatUSD(adoptionReview.quote.dailyRateUsd),
                      hourly: formatHourlyRate(
                        adoptionReview.quote.hourlyRateUsd,
                      ),
                    })
                  : t("cloud.join.dedicatedAdoptionKeepsCompute", {
                      defaultValue:
                        "Dedicated hosting is already active; confirming does not start another server.",
                    })}
              </p>
              {adoptionReview.quote.startsCompute && (
                <p>
                  {t("cloud.join.dedicatedActivationMinimum", {
                    defaultValue:
                      "Minimum charge per successful start: {{minimum}}. Applies again after stopping and restarting.",
                    minimum: formatUSD(
                      adoptionReview.quote.minimumActivationChargeUsd,
                    ),
                  })}
                </p>
              )}
              <p>
                {t("cloud.join.dedicatedAdoptionBalance", {
                  defaultValue:
                    "Balance: {{balance}} · Required: {{minimum}} ({{days}} days of runway)",
                  balance: formatUSD(adoptionReview.quote.balanceUsd),
                  minimum: formatUSD(adoptionReview.quote.minimumBalanceUsd),
                  days: String(adoptionReview.quote.minimumRunwayDays),
                })}
              </p>
              <p>
                {t("cloud.join.dedicatedAdoptionStatus", {
                  defaultValue: "Current Dedicated status: {{status}}.",
                  status: readableDedicatedStatus(adoptionReview.quote.status),
                })}
              </p>
              {adoptionReview.quote.stateDisposition ===
              "verified_backup_present" ? (
                <p>
                  {t("cloud.join.dedicatedAdoptionVerifiedBackup", {
                    defaultValue:
                      "Cloud will restore its reviewed backup before switching.",
                  })}
                </p>
              ) : adoptionReview.quote.stateDisposition ===
                "fresh_boot_no_verified_backup" ? (
                <p>
                  {t("cloud.join.dedicatedAdoptionFreshStart", {
                    defaultValue:
                      "No verified backup will be restored. This Dedicated Eliza starts fresh.",
                  })}
                </p>
              ) : (
                <p>
                  {t("cloud.join.dedicatedAdoptionUnreviewedState", {
                    defaultValue:
                      "Cloud has not verified a restorable backup for this existing Dedicated Eliza.",
                  })}
                </p>
              )}
              {adoptionReview.quote.requiresCatalogRestore ? (
                <p>
                  {t("cloud.join.dedicatedAdoptionRestoreSetup", {
                    defaultValue:
                      "Cloud must repair its saved setup before it can start.",
                  })}
                </p>
              ) : null}
              <p>
                {t("cloud.join.dedicatedAdoptionSafety", {
                  defaultValue:
                    "Your Shared Eliza keeps working until Dedicated is healthy. If setup fails or you cancel, nothing switches.",
                })}
              </p>
            </div>
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
              <Button
                variant="ghostMuted"
                size="wide"
                type="button"
                data-testid="dedicated-adoption-cancel"
                onClick={() => settleDedicatedAdoption(null)}
              >
                {t("cloud.join.dedicatedAdoptionCancel", {
                  defaultValue: "Cancel setup",
                })}
              </Button>
              <Button
                variant="surface"
                size="wide"
                type="button"
                data-testid="dedicated-adoption-confirm"
                onClick={() =>
                  settleDedicatedAdoption({
                    action: "adopt_existing_dedicated",
                    quoteId: adoptionReview.quote.quoteId,
                  })
                }
              >
                {adoptionReview.quote.startsCompute
                  ? t("cloud.join.dedicatedAdoptionConfirmStart", {
                      defaultValue: "Start Dedicated",
                    })
                  : t("cloud.join.dedicatedAdoptionConfirmContinue", {
                      defaultValue: "Continue Dedicated setup",
                    })}
              </Button>
            </div>
            {signOutButton}
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.errorTitle", {
                defaultValue: "Couldn't open your Eliza",
              })}
            </h1>
            <p className="text-sm text-white/70">
              {error?.message ??
                t("cloud.join.errorBody", {
                  defaultValue: "Something went wrong. Try again.",
                })}
            </p>
            {error?.kind === "insufficient-credit" ? (
              <>
                <Button
                  variant="surface"
                  size="wide"
                  type="button"
                  disabled={openingBilling}
                  aria-busy={openingBilling || undefined}
                  onClick={() => void handleOpenBilling()}
                >
                  {openingBilling
                    ? t("cloud.join.openingBilling", {
                        defaultValue: "Opening billing...",
                      })
                    : t("cloud.join.addCredits", {
                        defaultValue: "Add credits",
                      })}
                </Button>
                {billingError && (
                  <p role="alert" className="text-sm text-orange-400">
                    {billingError}
                  </p>
                )}
                <Button
                  variant="ghostMuted"
                  size="wide"
                  type="button"
                  onClick={handleRetry}
                >
                  {t("cloud.join.retry", { defaultValue: "Try again" })}
                </Button>
              </>
            ) : (
              <Button
                variant="surface"
                size="wide"
                type="button"
                onClick={handleRetry}
              >
                {t("cloud.join.retry", { defaultValue: "Try again" })}
              </Button>
            )}
            {signOutButton}
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4"
            role="status"
            aria-busy="true"
          >
            <div className="size-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            <p className="text-sm text-white/72">
              {detail ||
                t("cloud.join.connecting", {
                  defaultValue: "Opening your personal Eliza...",
                })}
            </p>
            {signOutButton}
          </div>
        )}
      </div>
    </div>
  );
}
