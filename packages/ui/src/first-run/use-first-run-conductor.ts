/**
 * In-chat first-run conductor (headless).
 *
 * Onboarding is PART OF THE CHAT. When `firstRunComplete === false` this hook
 * seeds synthetic assistant turns into the SAME live transcript the floating
 * `ChatOverlay` renders (greeting → runtime CHOICE → provider
 * CHOICE → tutorial CHOICE; Cloud-only sign-in stays a single CTA), and
 * routes the user's first-run-scoped picks to the headless finish use case
 * (`first-run-finish.ts`). It owns NO presentation — the existing
 * `InlineWidgetText` + `SensitiveRequestBlock` renderers draw the widgets for
 * free from message fields. It registers an action handler on the first-run
 * channel so the chat's single send funnel short-circuits first-run picks
 * before they hit the server.
 *
 * The composer is UNLOCKED during onboarding (#12178): the user can type
 * freely, and a second channel handler (`setFirstRunTextHandler`) answers that
 * free text with a local user turn + a deterministic assistant reply that
 * varies by flow position. Free text NEVER reaches the server pre-completion —
 * the AppContext funnel enforces that — and the complete request is restored
 * to the real composer for review as soon as setup finishes.
 *
 * Provisioning runs exactly once and POSTs /api/first-run exactly once (the
 * finish module funnels + idempotency-guards it). The real `firstRunComplete`
 * flip is DEFERRED to the tutorial-or-skip pick, so the tutorial step is
 * reachable after every runtime path.
 *
 * Confused-user guards (spam taps, stale widgets, out-of-order picks):
 * - `busyRef` — one finish/provision flow at a time; extra picks are consumed
 *   as no-ops while one is in flight.
 * - `provisionedRef` latch — after provisioning succeeds only the tutorial
 *   pick is live; leftover runtime/provider/cloud-agent widgets no-op.
 * - Strict id validation per group — garbage under the reserved prefix is
 *   consumed, never acted on and never forwarded to the server.
 * - needs-cloud-login re-offers an UNLOCKED runtime choice and arms a
 *   connect-and-resume continuation (`pendingCloudResumeRef`).
 *
 * Device RAM-tier gating + reversibility (#14390): the runtime and provider
 * CHOICE blocks are built per-seed against the device's RAM-tier assessment
 * (`device-ram-gate.ts`) — a sub-4 GB phone sees "On this device" labeled
 * unavailable and its tap refused with the reason; 4–7 GB phones may choose
 * hybrid cloud inference but not an unconfigured local runtime, and a sub-12
 * GB phone gets on-device models blocked (never silently hidden). Every
 * sub-step CHOICE carries a "← Back" option whose handler unwinds any
 * partially-committed local runtime (persisted mode, local active server,
 * started service) before re-offering a fresh runtime choice, so onboarding
 * is never forward-only and switching local→cloud leaves nothing running.
 *
 * Cloud-only mode (#13377): the runtime chooser (local / remote) is gated by
 * `isRuntimeChooserEnabled()` and OFF by default. With the chooser off,
 * onboarding is a single "sign in to Eliza Cloud" step — the greeting IS the
 * sign-in prompt, an already-usable session (hosted web with a live login, a
 * durable token, a completed mobile OAuth round trip, or a session recovered
 * from the console's cross-subdomain cookie) enters SILENTLY (#15133): zero
 * onboarding turns for a pure agent reuse, the real provisioning narration
 * only when an agent is actually created or cold-boot woken. Provisioning
 * success flips the real gate immediately. The tutorial is never a completion
 * gate in this mode; it stays reachable from its home tile.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import {
  hasStewardAuthedCookie,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import * as React from "react";
import type {
  ConversationMessage,
  ConversationSecretRequest,
  LocalAgentBackupMetadata,
} from "../api";
import { client } from "../api";
import type {
  DedicatedAdoptionConfirmationQuote,
  DedicatedAdoptionConfirmationRequester,
} from "../api/client-cloud";
import {
  getCloudAuthToken,
  refreshCloudStewardSession,
} from "../api/client-cloud";
import type {
  DedicatedActivationConfirmationQuote,
  DedicatedActivationConfirmationRequester,
} from "../api/dedicated-activation-confirmation";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { getBootConfig } from "../config/boot-config";
import { useBranding } from "../config/branding";
import { APP_RESUME_EVENT } from "../events";
import {
  ACCENT_PRESETS,
  useAppSelector,
  useAppSelectorShallow,
} from "../state";
import { useConversationMessages } from "../state/ConversationMessagesContext.hooks";
import { consumeCloudAuthFirstScreenGreeting } from "../state/cloud-auth-first-screen";
import {
  claimCloudLoginWindow,
  prepareDesktopCloudLoginSession,
  releaseClaimedCloudLoginWindow,
} from "../state/cloud-login-launch";
import { hasUsableStoredStewardToken } from "../state/cloud-steward-login";
import {
  createFirstRunTranscriptEpoch,
  observeFirstRunTranscriptEpoch,
} from "../state/first-run-transcript-epoch";
import { startTutorial } from "../tutorial/tutorial-service";
import { openDesktopSettingsWindow } from "../utils/desktop-workspace";
import { isSafeNavigationUrl } from "../utils/navigation-url";
import { openExternalUrl } from "../utils/openExternalUrl";
import { clearFirstRunTranscriptMessages } from "./clear-first-run-transcript";
import {
  armCloudLoginWaitDeadline,
  createAttemptGuard,
} from "./cloud-login-wait-deadline";
import {
  peekDeviceRamTierAssessment,
  resolveDeviceRamTierAssessment,
} from "./device-ram-gate";
import {
  type DeviceRamTierAssessment,
  HYBRID_AGENT_MIN_MARKETED_RAM_GB,
  LOCAL_AGENT_MIN_MARKETED_RAM_GB,
} from "./device-ram-tier";
import { normalizeFirstRunName } from "./first-run";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
  setFirstRunTextHandler,
} from "./first-run-action-channel";
import {
  clearCloudLoginPending,
  markCloudLoginPending,
  readCloudLoginPending,
} from "./first-run-cloud-resume";
import {
  bindCloudAgent,
  type FirstRunFinishDraft,
  type FirstRunFinishOutcome,
  type FirstRunFinishPorts,
  listOrAutoProvisionCloudAgent,
  resetFirstRunPersistGuard,
  runFirstRunFinish,
} from "./first-run-finish";
import {
  FIRST_RUN_GREETING,
  FIRST_RUN_SIGN_IN_PROMPT,
} from "./first-run-greeting";
import {
  handoffPendingFirstRunText,
  readPendingFirstRunText,
  setPendingFirstRunTextReleaseHandler,
  writePendingFirstRunText,
} from "./first-run-pending-text";
import { isRuntimeChooserEnabled } from "./first-run-runtime-flag";
import { revertLocalRuntimeCommitment } from "./revert-local-runtime-commitment";

const GREETING = `${FIRST_RUN_GREETING} First, where should your agent run?`;

// Cloud-only greetings (#13377). The sign-in button reuses the runtime:cloud
// action value on purpose: the tap IS the user gesture that launches the real
// login flow (handleInteractiveCloudLogin inside the provision flow — popup
// where one can
// open, same-tab /login navigation where popups are blocked or hostile,
// #15143). Keep this as one obvious CTA; the Cloud flow itself owns OAuth and
// provisioning, so there is no second in-chat "Connect" step.
const CLOUD_SIGN_IN_GREETING = FIRST_RUN_GREETING;
const CLOUD_SIGN_IN_CHOICE = [
  FIRST_RUN_SIGN_IN_PROMPT,
  "",
  "[CHOICE:first-run id=runtime]",
  `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Sign in to Eliza Cloud`,
  "[/CHOICE]",
].join("\n");
const CLOUD_WELCOME_BACK =
  "Welcome back — you're already signed in to Eliza Cloud. Setting up your agent…";
const CLOUD_ONLY_DONE =
  'You\'re all set — ask me anything. Want a quick tour? Type "restart tutorial" whenever you like.';

// Bounded cookie-recovery refresh at conductor mount (#15133). Mirrors
// STEWARD_RESTORE_REFRESH_TIMEOUT_MS in startup-phase-restore.ts so a hung
// same-origin refresh costs an authenticated console user at most this long of
// quiet empty chat before degrading to the normal sign-in greeting.
const FIRST_RUN_COOKIE_REFRESH_TIMEOUT_MS = 4_000;

// onStatus codes that mark a REAL provisioning wait — an actual agent create,
// a sandbox build, or a dedicated container's cold-boot wake. Every other code
// the finish path narrates ("setup" / "listing" / "ready" / "persist") wraps a
// couple of fast REST calls, which reads as fake provisioning theater to an
// already-signed-in user (#15133) — the silent entry drops those.
const REAL_PROVISION_STATUS_CODES = new Set([
  "creating",
  "provisioning",
  "starting",
]);

/** User-facing recovery message when a cloud provisioning call rejects. */
function cloudFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message.trim() : "";
  return detail
    ? `Couldn't connect to Eliza Cloud: ${detail}${/[.!?]$/.test(detail) ? "" : "."}`
    : "Couldn't connect to Eliza Cloud.";
}

const RESTORE_GREETING =
  "I found an existing local backup for this device. Restore it before setup, or start fresh?";

// The onboarding composer is unlocked (#12178) — the user can type freely
// before the model is running. Free text never reaches the server; the
// conductor answers locally with a deterministic, friendly not-ready line that
// varies by where we are in the flow and re-points at the pending choice. Copy
// is a plain constant (deterministic — no clocks/RNG in the render path).
const FIRST_RUN_TEXT_REPLY = {
  // Before a runtime is picked / mid-choice: no agent exists yet.
  choosing:
    "Choose above: Cloud is easiest; local keeps things on this device. I'll pick up your request after setup.",
  // Cloud-only mode: the only pending step is the Eliza Cloud sign-in.
  signIn: "Sign in above and I'll finish setup, then pick up your request.",
  // A finish/provision call is in flight.
  provisioning:
    "I'm setting up your agent now; I'll pick up your request when it's ready.",
  // Provisioning succeeded; only the accent + tutorial wrap-up remains.
  wrapUp: "Your agent's ready. Start the quick tour, or skip it and get going.",
  // A finish failed and the recovery choice is on screen.
  error: "Setup hit a snag. Try again above; your request is still here.",
} as const;

function makeTurn(
  id: string,
  text: string,
  extra?: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id,
    role: "assistant",
    text,
    timestamp: Date.now(),
    source: "first_run",
    ...extra,
  };
}

function newestLocalBackup(
  backups: LocalAgentBackupMetadata[],
): LocalAgentBackupMetadata | null {
  return (
    backups.slice().sort((a, b) => {
      const aCreatedAt = Date.parse(a.createdAt);
      const bCreatedAt = Date.parse(b.createdAt);
      const aHasValidDate = Number.isFinite(aCreatedAt);
      const bHasValidDate = Number.isFinite(bCreatedAt);

      if (aHasValidDate !== bHasValidDate) {
        return aHasValidDate ? -1 : 1;
      }
      if (aHasValidDate && bHasValidDate && aCreatedAt !== bCreatedAt) {
        return bCreatedAt - aCreatedAt;
      }
      return b.fileName.localeCompare(a.fileName);
    })[0] ?? null
  );
}

// The "go back and change an earlier pick" option appended to every sub-step
// CHOICE (#14390): onboarding must never be forward-only. Its handler runs the
// reversal cleanup (revert-local-runtime-commitment.ts) before re-offering a
// fresh runtime choice, so backing out of a partially-committed local pick
// leaves no persisted mode, no local active server, and no running service.
const BACK_TO_RUNTIME_OPTION = `${FIRST_RUN_ACTION_PREFIX}back:runtime=← Back — change where your agent runs`;

// The first-run location chooser: Cloud (managed), On this device, or Remote
// (connect to an existing agent elsewhere). "Bring your own keys" is NOT a
// location — it lives one step later on the provider sub-choice as
// "Other / configure in Settings" (provider:other), which finishes the local
// runtime with `configure-later` and hands off provider setup to Settings via
// the finish path's banner. Remote picks an already-running agent by URL +
// token; it owns its own provider, so it skips the provider sub-step.
//
// Built per-render because the local option is RAM-tier-gated (#14390): on a
// device below the hybrid runtime floor it stays VISIBLE but labeled unavailable (never
// silently hidden), and its tap is refused with the reason. The tier probe is
// synchronous on Android; when it has not resolved yet (iOS first frames) the
// plain label renders and the pick handler + finish backstop still enforce.
function runtimeChoiceBlock(): string {
  const tier = peekDeviceRamTierAssessment();
  const localLabel =
    tier && !tier.allowsHybridAgent
      ? `On this device (unavailable — needs ${HYBRID_AGENT_MIN_MARKETED_RAM_GB} GB+ RAM, ~${tier.marketedRamGb} GB detected)`
      : "On this device";
  return [
    "[CHOICE:first-run id=runtime]",
    `${FIRST_RUN_ACTION_PREFIX}runtime:cloud=Eliza Cloud (managed)`,
    `${FIRST_RUN_ACTION_PREFIX}runtime:local=${localLabel}`,
    `${FIRST_RUN_ACTION_PREFIX}runtime:remote=Connect to a remote agent`,
    "[/CHOICE]",
  ].join("\n");
}

const BACKUP_RESTORE_CHOICE = [
  "[CHOICE:first-run id=backup-restore]",
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:latest=Restore latest backup`,
  `${FIRST_RUN_ACTION_PREFIX}backup-restore:start-fresh=Start fresh`,
  "[/CHOICE]",
].join("\n");

// RAM-tier-gated (#14390): below the 12 GB on-device-model floor the
// on-device option stays visible but labeled unavailable (its tap is refused
// with the reason) and the recommendation moves to Eliza Cloud inference —
// the local agent remains allowed in cloud-inference mode on that band.
function providerChoice(opts: {
  defaultId: "on-device" | "other";
  tier: DeviceRamTierAssessment | null;
}): string {
  const modelsBlocked = opts.tier != null && !opts.tier.allowsLocalModels;
  const onDevice = modelsBlocked
    ? `${FIRST_RUN_ACTION_PREFIX}provider:on-device=On this device (unavailable — needs 12 GB+ RAM, ~${opts.tier?.marketedRamGb} GB detected)`
    : `${FIRST_RUN_ACTION_PREFIX}provider:on-device=On this device (recommended)`;
  const cloud = modelsBlocked
    ? `${FIRST_RUN_ACTION_PREFIX}provider:elizacloud=Eliza Cloud inference (recommended)`
    : `${FIRST_RUN_ACTION_PREFIX}provider:elizacloud=Eliza Cloud inference`;
  const other = `${FIRST_RUN_ACTION_PREFIX}provider:other=Other / configure in Settings`;
  const configuredOther =
    opts.tier != null && !opts.tier.allowsLocalAgent
      ? `${FIRST_RUN_ACTION_PREFIX}provider:other=Other / configure in Settings (unavailable — needs ${LOCAL_AGENT_MIN_MARKETED_RAM_GB} GB+ RAM)`
      : other;
  const ordered = modelsBlocked
    ? [cloud, onDevice, configuredOther]
    : opts.defaultId === "on-device"
      ? [onDevice, cloud, configuredOther]
      : [configuredOther, onDevice, cloud];
  return [
    "[CHOICE:first-run id=provider]",
    ...ordered,
    BACK_TO_RUNTIME_OPTION,
    "[/CHOICE]",
  ].join("\n");
}

const TUTORIAL_CHOICE = [
  "[CHOICE:first-run id=tutorial]",
  `${FIRST_RUN_ACTION_PREFIX}tutorial:start=Take the tutorial`,
  `${FIRST_RUN_ACTION_PREFIX}tutorial:skip=Skip for now`,
  "[/CHOICE]",
].join("\n");

// Recovery choice seeded when a finish/provision flow fails (e.g. a 404 from
// POST /api/first-run). Every option here is a real way forward — retry the
// same runtime, pick a different one, or bail out to Settings — so a persistent
// finish error surfaces an escape instead of re-looping the runtime prompt
// and configure a provider by hand.
const ERROR_CHOICE = [
  "[CHOICE:first-run id=error]",
  `${FIRST_RUN_ACTION_PREFIX}error:retry=Try again`,
  `${FIRST_RUN_ACTION_PREFIX}error:restart=Choose a different way to run`,
  `${FIRST_RUN_ACTION_PREFIX}error:settings=Configure in Settings`,
  "[/CHOICE]",
].join("\n");

// Cloud-only recovery: with the runtime chooser off there is no "different way
// to run", so the restart option would be a dead end — retry and the Settings
// escape are the two real ways forward.
const CLOUD_ONLY_ERROR_CHOICE = [
  "[CHOICE:first-run id=error]",
  `${FIRST_RUN_ACTION_PREFIX}error:retry=Try again`,
  `${FIRST_RUN_ACTION_PREFIX}error:settings=Configure in Settings`,
  "[/CHOICE]",
].join("\n");

type DedicatedHostingQuote =
  | DedicatedAdoptionConfirmationQuote
  | DedicatedActivationConfirmationQuote;
type DedicatedHostingDecision = {
  action: DedicatedHostingQuote["action"];
  quoteId: string;
} | null;

function dedicatedAdoptionConfirmationText(
  quote: DedicatedHostingQuote,
  reason: "initial" | "quote_changed",
): string {
  if (quote.action === "activate_dedicated") {
    return [
      "Start your Dedicated Eliza?",
      "",
      `Hosting costs $${quote.dailyRateUsd.toFixed(2)}/day ($${quote.hourlyRateUsd.toFixed(2)}/hour).`,
      `Minimum charge per successful start: $${quote.minimumActivationChargeUsd.toFixed(2)}. Applies again after stopping and restarting.`,
      `Your balance is $${quote.balanceUsd.toFixed(2)}. You need at least $${quote.minimumBalanceUsd.toFixed(2)} to start.`,
      "",
      "[CHOICE:first-run id=dedicated-adoption]",
      `${FIRST_RUN_ACTION_PREFIX}dedicated-adoption:confirm=Start Dedicated`,
      `${FIRST_RUN_ACTION_PREFIX}dedicated-adoption:cancel=Not now`,
      "[/CHOICE]",
    ].join("\n");
  }
  const disposition =
    quote.stateDisposition === "verified_backup_present"
      ? "Your verified backup will be restored."
      : quote.stateDisposition === "fresh_boot_no_verified_backup"
        ? "This starts fresh; no verified backup is available."
        : "Your current data stays. No verified Cloud backup is available.";
  const changed =
    reason === "quote_changed"
      ? "The hosting details changed. Please review them again.\n\n"
      : "";
  return [
    `${changed}Use your existing Dedicated agent?`,
    "",
    `$${quote.dailyRateUsd.toFixed(2)}/day ($${quote.hourlyRateUsd.toFixed(2)}/hour).`,
    ...(quote.startsCompute
      ? [
          `Minimum charge per successful start: $${quote.minimumActivationChargeUsd.toFixed(2)}. Applies again after stopping and restarting.`,
        ]
      : []),
    `Balance: $${quote.balanceUsd.toFixed(2)}; $${quote.minimumBalanceUsd.toFixed(2)} required.`,
    ...(quote.deficitUsd > 0
      ? [`Add $${quote.deficitUsd.toFixed(2)} to start.`]
      : []),
    disposition,
    "",
    "[CHOICE:first-run id=dedicated-adoption]",
    `${FIRST_RUN_ACTION_PREFIX}dedicated-adoption:confirm=${quote.startsCompute ? "Start Dedicated" : "Connect"}`,
    `${FIRST_RUN_ACTION_PREFIX}dedicated-adoption:cancel=Not now`,
    "[/CHOICE]",
  ].join("\n");
}

/**
 * Turn a raw finish error into a human sentence. The underlying message can be
 * a terse transport string ("Not found" for a 404, "Failed to fetch", …) that
 * means nothing to a first-run user; lead with a clear framing and keep the raw
 * detail for context. The recovery framing tracks the runtime chooser: with the
 * chooser off there is no "different way to run" to offer.
 */
function finishErrorMessage(
  message: string,
  runtimeChooserEnabled: boolean,
): string {
  const detail = message.trim();
  if (
    detail.includes(
      "did not become ready before the signed-in startup deadline",
    )
  ) {
    return "Your Dedicated agent took too long to connect. Try again to continue setup.";
  }
  const isTerse = /^(not found|failed to fetch|forbidden|unauthorized)$/i.test(
    detail,
  );
  const lead = isTerse
    ? `I couldn't finish setting up your agent (${detail}).`
    : `I couldn't finish setting up your agent: ${detail}`;
  const recovery = runtimeChooserEnabled
    ? "Try again, choose another way to run your agent, or open Settings."
    : "Try again, or open Settings for more options.";
  return `${lead}\n\n${recovery}`;
}

// The "make it yours" accent step. Reuses the shared ACCENT_PRESETS (the same
// list Appearance settings renders) so onboarding + Settings drive one
// persisted preference. In-chat CHOICE options render as text buttons, so each
// carries an emoji swatch to hint its color. Non-blocking: it's seeded next to
// the tutorial CHOICE, so a user who ignores it just taps the tutorial option;
// the `default` swatch keeps the brand accent.
const ACCENT_CHOICE = [
  "[CHOICE:first-run id=accent]",
  ...ACCENT_PRESETS.map(
    (p) => `${FIRST_RUN_ACTION_PREFIX}accent:${p.id}=${p.swatch} ${p.label}`,
  ),
  "[/CHOICE]",
].join("\n");

// The inline Remote connect form: a URL field + an optional access-token field.
// `delivery.canCollectValueInCurrentChannel` makes SensitiveRequestBlock render
// the form here on the owner's device; its `remote_connect` submit dispatches
// the hardened CONNECT_EVENT (validate URL → connect → adopt as the active
// runtime → finish first-run) rather than writing the values to the secret
// store — see SensitiveRequestBlock.handleSubmit.
function remoteConnectSecretRequest(): ConversationSecretRequest {
  return {
    key: "remote-agent",
    reason: "Connect to a remote agent by its URL and access token",
    status: "pending",
    delivery: {
      mode: "inline_owner_app",
      canCollectValueInCurrentChannel: true,
    },
    form: {
      type: "sensitive_request_form",
      kind: "remote_connect",
      mode: "inline_owner_app",
      fields: [
        {
          name: "url",
          label: "Remote agent URL",
          input: "text",
          required: true,
        },
        {
          name: "token",
          label: "Access token (optional)",
          input: "secret",
          required: false,
        },
      ],
      submitLabel: "Connect",
    },
  };
}

interface FirstRunTurnWriter {
  seedTurn(turn: ConversationMessage): void;
  replaceTurn(id: string, next: ConversationMessage): void;
}

export function surfaceCloudLoginRetryTurn(
  writer: FirstRunTurnWriter,
  runtimeChooserEnabled = isRuntimeChooserEnabled(),
): void {
  // Replacing the turn re-parses its CHOICE block, so the re-offered runtime
  // buttons arrive unlocked even when an earlier pick locked the originals —
  // without this the "pick again" instruction is a dead end (every prior
  // runtime widget locked itself on first tap). In cloud-only mode there is no
  // runtime to re-pick: the retry turn re-offers the single sign-in button
  // (whose tap re-enters the cloud flow with a fresh user gesture).
  const retryText = runtimeChooserEnabled
    ? `Sign in to Eliza Cloud to continue. You can also pick how to run your agent again.\n\n${runtimeChoiceBlock()}`
    : CLOUD_SIGN_IN_CHOICE;
  const connectTurn = makeTurn("first-run:cloud-oauth", retryText);
  writer.seedTurn(connectTurn);
  writer.replaceTurn("first-run:cloud-oauth", connectTurn);
}

export function useFirstRunConductor(): void {
  const { cloudOnly } = useBranding();
  const runtimeChooserEnabled = isRuntimeChooserEnabled(cloudOnly === true);
  const {
    firstRunComplete,
    firstRunName,
    completeFirstRun,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginFallbackUrl,
    handleInteractiveCloudLogin,
    setTab,
    setState,
    setUiAccent,
    uiLanguage,
  } = useAppSelectorShallow((s) => ({
    firstRunComplete: s.firstRunComplete,
    firstRunName: s.firstRunName,
    completeFirstRun: s.completeFirstRun,
    elizaCloudConnected: s.elizaCloudConnected,
    elizaCloudLoginBusy: s.elizaCloudLoginBusy,
    elizaCloudLoginFallbackUrl: s.elizaCloudLoginFallbackUrl,
    handleInteractiveCloudLogin: s.handleInteractiveCloudLogin,
    setTab: s.setTab,
    setState: s.setState,
    setUiAccent: s.setUiAccent,
    uiLanguage: s.uiLanguage,
  }));
  const { conversationMessages, setConversationMessages } =
    useConversationMessages();

  const active = firstRunComplete === false;

  const draftRef = React.useRef<FirstRunFinishDraft>({
    agentName: normalizeFirstRunName(firstRunName) || "Eliza",
    runtime: "cloud",
    localInference: "all-local",
    remoteApiBase: "",
    remoteToken: "",
  });
  const cloudPrefsRef = React.useRef<{
    preferAgentId?: string;
    forceCreate?: boolean;
  }>({});
  const latestLocalBackupRef = React.useRef<LocalAgentBackupMetadata | null>(
    null,
  );
  const restoringBackupRef = React.useRef(false);
  // Set true once provisioning's completeFirstRun fired; the REAL store
  // completeFirstRun is deferred to the tutorial-or-skip pick.
  const provisionedRef = React.useRef(false);
  // True while a finish/provision call is in flight; every other first-run
  // pick is consumed as a no-op until it settles (see handleFirstRunAction).
  const busyRef = React.useRef(false);
  // Generation guard for cloud sign-in attempts (#19255): outcomes of an
  // attempt the deadline abandoned must not mutate newer state.
  const cloudLoginAttemptRef = React.useRef(createAttemptGuard());
  // The visible waiting turn offers an immediate retry. Its callback abandons
  // the current owned attempt before launching the replacement, so the old
  // popup/provision promise can never keep the busy latch or mutate the new
  // flow when it settles late.
  const activeCloudLoginCancelRef = React.useRef<(() => void) | null>(null);
  const refreshCloudLoginWaitingRef = React.useRef<(() => void) | null>(null);
  const activeCloudLoginFallbackUrl =
    elizaCloudLoginBusy &&
    typeof elizaCloudLoginFallbackUrl === "string" &&
    isSafeNavigationUrl(elizaCloudLoginFallbackUrl)
      ? new URL(elizaCloudLoginFallbackUrl).href
      : null;
  const cloudLoginFallbackRef = React.useRef(activeCloudLoginFallbackUrl);
  React.useEffect(() => {
    cloudLoginFallbackRef.current = activeCloudLoginFallbackUrl;
    if (active) refreshCloudLoginWaitingRef.current?.();
  }, [active, activeCloudLoginFallbackUrl]);

  const pendingDedicatedAdoptionRef = React.useRef<{
    quote: DedicatedHostingQuote;
    choiceText: string;
    resolve: (confirmation: DedicatedHostingDecision) => void;
    dispose: () => void;
  } | null>(null);
  // Latched by the first tutorial pick: the store flip unregisters the handler
  // only on the next commit, so a double-tap could otherwise re-fire
  // completeFirstRun/startTutorial in the gap.
  const completedRef = React.useRef(false);
  // True while a finish error's recovery choice is on screen; steers the
  // free-text reply persona (below). Cleared when the next pick supersedes it.
  const erroredRef = React.useRef(false);
  // Silent cloud entry (#15133): set when onboarding starts with an
  // already-usable session (stored token, live connection, or a session
  // recovered from the console's cross-subdomain cookie). The user already
  // signed in, so the conductor seeds NOTHING — no greeting, no welcome-back,
  // no reuse-narration statuses, no done wrap-up; a pure agent reuse lands
  // straight in chat. The silence ends (ref cleared) the moment something
  // genuinely interactive or genuinely slow must render: a REAL provisioning
  // status, the multi-agent selector, a sign-in retry ask, or an error turn.
  const silentCloudEntryRef = React.useRef(false);
  const greetAfterCloudAuthRef = React.useRef(false);
  // Monotonic id source for typed-text turns: guarantees a unique user/reply id
  // per send even when two land in the same millisecond, so `seedTurn`'s id
  // dedup never silently swallows an acknowledged message.
  const textTurnSeqRef = React.useRef(0);
  // Every pre-agent request is retained losslessly. Multiple turns remain
  // distinct paragraphs when setup releases the real composer.
  const pendingFirstRunTextRef = React.useRef<string[]>(
    readPendingFirstRunText(),
  );
  const resumePendingFirstRunText = React.useCallback(() => {
    // The ref is authoritative in-session: a later localStorage quota failure
    // must not roll it back to an older durable prefix. On a cold mount the ref
    // was initialized from that same durable copy.
    const pending = pendingFirstRunTextRef.current;
    const durable = readPendingFirstRunText();
    if (pending.length === 0 && durable.length > 0) pending.push(...durable);
    if (pending.length === 0) return;
    pendingFirstRunTextRef.current = [];
    handoffPendingFirstRunText(pending);
  }, []);
  // Re-offered choice turns have the same collision risk: a user can reject
  // two unavailable options before the wall clock advances.
  const choiceTurnSeqRef = React.useRef(0);

  // ── Transcript seam ──────────────────────────────────────────────────────
  const seedTurn = React.useCallback(
    (turn: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.some((m) => m.id === turn.id) ? prev : [...prev, turn],
      );
    },
    [setConversationMessages],
  );
  const replaceTurn = React.useCallback(
    (id: string, next: ConversationMessage) => {
      setConversationMessages((prev) =>
        prev.map((m) => (m.id === id ? next : m)),
      );
    },
    [setConversationMessages],
  );
  // Seed a CHOICE turn that must arrive unlocked on every re-offer. A choice
  // widget locks itself after its first pick, and `seedTurn` dedups by id — so
  // re-offering into an existing turn would present a dead (locked) widget.
  // When the base turn already exists, seed a fresh retry turn instead.
  const seedFreshChoiceTurn = React.useCallback(
    (baseId: string, text: string) => {
      setConversationMessages((prev) => {
        if (!prev.some((m) => m.id === baseId)) {
          return [...prev, makeTurn(baseId, text)];
        }
        choiceTurnSeqRef.current += 1;
        const retryId = `${baseId}:retry:${Date.now()}:${choiceTurnSeqRef.current}`;
        return [...prev, makeTurn(retryId, text)];
      });
    },
    [setConversationMessages],
  );

  const requestDedicatedHostingConfirmation = React.useCallback<
    (
      quote: DedicatedHostingQuote,
      context: { reason: "initial" | "quote_changed"; signal?: AbortSignal },
    ) => Promise<DedicatedHostingDecision>
  >(
    (quote, context) => {
      context.signal?.throwIfAborted();
      pendingDedicatedAdoptionRef.current?.resolve(null);
      pendingDedicatedAdoptionRef.current?.dispose();
      silentCloudEntryRef.current = false;
      const choiceText = dedicatedAdoptionConfirmationText(
        quote,
        context.reason,
      );
      seedFreshChoiceTurn("first-run:dedicated-adoption", choiceText);
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          if (pendingDedicatedAdoptionRef.current?.quote !== quote) return;
          pendingDedicatedAdoptionRef.current = null;
          reject(context.signal?.reason);
        };
        context.signal?.addEventListener("abort", onAbort, { once: true });
        const dispose = () =>
          context.signal?.removeEventListener("abort", onAbort);
        pendingDedicatedAdoptionRef.current = {
          quote,
          choiceText,
          resolve,
          dispose,
        };
      });
    },
    [seedFreshChoiceTurn],
  );

  const requestDedicatedAdoptionConfirmation =
    React.useCallback<DedicatedAdoptionConfirmationRequester>(
      async (quote, context) => {
        const decision = await requestDedicatedHostingConfirmation(
          quote,
          context,
        );
        return decision?.action === "adopt_existing_dedicated"
          ? { action: decision.action, quoteId: decision.quoteId }
          : null;
      },
      [requestDedicatedHostingConfirmation],
    );
  const requestDedicatedActivationConfirmation =
    React.useCallback<DedicatedActivationConfirmationRequester>(
      async (quote, context) => {
        const decision = await requestDedicatedHostingConfirmation(quote, {
          ...context,
          reason: "initial",
        });
        return decision?.action === "activate_dedicated"
          ? { action: decision.action, quoteId: decision.quoteId }
          : null;
      },
      [requestDedicatedHostingConfirmation],
    );

  React.useEffect(() => {
    const pending = pendingDedicatedAdoptionRef.current;
    if (
      !pending ||
      conversationMessages.some(
        (message) =>
          message.source === "first_run" && message.text === pending.choiceText,
      )
    ) {
      return;
    }
    // A Personal binding can start server-history hydration while onboarding
    // still waits for explicit Dedicated adoption consent. If that hydration
    // replaces the local transcript, restore the exact pending choice instead
    // of leaving the provisioning promise parked behind an invisible control.
    seedFreshChoiceTurn("first-run:dedicated-adoption", pending.choiceText);
  }, [conversationMessages, seedFreshChoiceTurn]);

  React.useEffect(
    () => () => {
      const pending = pendingDedicatedAdoptionRef.current;
      pendingDedicatedAdoptionRef.current = null;
      pending?.dispose();
      pending?.resolve(null);
    },
    [],
  );

  const seedTutorial = React.useCallback(() => {
    provisionedRef.current = true;
    // "Make it yours" — the accent step is seeded alongside the tutorial prompt
    // so it never blocks finishing: a user who ignores it just taps a tutorial
    // option below. Picking a swatch applies + persists the accent live.
    seedTurn(
      makeTurn(
        "first-run:appearance",
        `First, make it yours — pick an accent color (or keep the default and continue below).\n\n${ACCENT_CHOICE}`,
      ),
    );
    seedTurn(
      makeTurn(
        "first-run:tutorial",
        `You're all set. Want a quick tour?\n\n${TUTORIAL_CHOICE}`,
      ),
    );
  }, [seedTurn]);

  const seedRuntimeChoice = React.useCallback(() => {
    seedTurn(
      makeTurn("first-run:greeting", `${GREETING}\n\n${runtimeChoiceBlock()}`),
    );
  }, [seedTurn]);

  // Cloud-only completion (#13377): signing in IS onboarding. The moment
  // provisioning succeeds we flip the real gate — no tutorial/accent pick gates
  // completion in this mode (the chat-native tutorial remains command-driven).
  // Latched by completedRef so a double-fired finish can't flip the gate twice.
  const completeCloudOnly = React.useCallback(() => {
    if (completedRef.current) return;
    provisionedRef.current = true;
    completedRef.current = true;
    // A silent entry that STAYED silent was a pure reuse (#15133): the user is
    // already signed in and their agent already exists — land straight in chat
    // with no wrap-up turn. A create/wake path cleared the ref on its first
    // real provisioning status, so its wrap-up still renders.
    if (greetAfterCloudAuthRef.current) {
      greetAfterCloudAuthRef.current = false;
      seedTurn(
        makeTurn(
          "first-run:cloud-welcome",
          `${FIRST_RUN_GREETING} ${CLOUD_ONLY_DONE}`,
        ),
      );
    } else if (!silentCloudEntryRef.current) {
      seedTurn(makeTurn("first-run:cloud-done", CLOUD_ONLY_DONE));
    }
    completeFirstRun("chat");
    resumePendingFirstRunText();
  }, [seedTurn, completeFirstRun, resumePendingFirstRunText]);

  const seedBackupRestoreChoice = React.useCallback(
    (backups: LocalAgentBackupMetadata[]) => {
      const latest = newestLocalBackup(backups);
      // The greeting + runtime choice is already seeded on mount, so there is
      // nothing to fall back to when there is no restorable backup.
      if (!latest) return;
      latestLocalBackupRef.current = latest;
      // Offer restore as an ADDITIONAL turn below the greeting — but only while
      // the user has NOT advanced past it (picking a runtime seeds a
      // provider / cloud-oauth / remote-connect / tutorial / error turn, all
      // source "first_run" with a non-greeting id). The atomic updater also
      // prevents a double-seed if the backup probe ever fires twice (the
      // restore turn itself is source "first_run" + non-greeting id).
      setConversationMessages((prev) => {
        const advancedPastGreeting = prev.some(
          (m) => m.source === "first_run" && m.id !== "first-run:greeting",
        );
        if (advancedPastGreeting) return prev;
        return [
          ...prev,
          makeTurn(
            "first-run:backup-restore",
            `${RESTORE_GREETING}\n\n${BACKUP_RESTORE_CHOICE}`,
          ),
        ];
      });
    },
    [setConversationMessages],
  );

  // Ports for the headless finish use case. completeFirstRun is INTERCEPTED:
  // with the runtime chooser on, provisioning calls it, we record + offer the
  // tutorial, and only flip the real gate when the user picks a tutorial
  // option. In cloud-only mode the intercept completes for real immediately.
  const ports = React.useMemo<FirstRunFinishPorts>(
    () => ({
      uiLanguage,
      elizaCloudConnected,
      handleInteractiveCloudLogin,
      setRuntimeState: (key, value) => {
        setState(key, value as never);
      },
      setTab,
      completeFirstRun: () => {
        if (runtimeChooserEnabled) {
          seedTutorial();
          return;
        }
        completeCloudOnly();
      },
      onStatus: (text, code) => {
        // A rejected startup may still deliver a late progress callback. Keep
        // the recovery choices visible until the user explicitly retries.
        if (!text || erroredRef.current || completedRef.current) return;
        if (silentCloudEntryRef.current) {
          // Silent cloud entry (#15133): reuse narration ("Setting up your
          // cloud agent", "Finding your agents...", "Connected to your
          // agent", "Saving first-run profile") wraps two fast REST calls —
          // provisioning theater for someone who already has an agent. Only
          // a REAL wait breaks the silence: an actual create, a sandbox
          // build, or a dedicated cold-boot wake take genuinely long, so
          // clear the ref and narrate honestly from that point on.
          if (!code || !REAL_PROVISION_STATUS_CODES.has(code)) return;
          silentCloudEntryRef.current = false;
        }
        const statusTurn = makeTurn(`first-run:status:${text}`, text);
        // The same phase can recur on retry. Move it to the current end of
        // setup instead of deduplicating it behind the previous error/login.
        setConversationMessages((prev) => [
          ...prev.filter(
            (turn) =>
              turn.id !== statusTurn.id &&
              turn.id !== "first-run:cloud-login-waiting",
          ),
          statusTurn,
        ]);
      },
      requestDedicatedAdoptionConfirmation,
      requestDedicatedActivationConfirmation,
    }),
    [
      uiLanguage,
      elizaCloudConnected,
      handleInteractiveCloudLogin,
      setState,
      setTab,
      seedTutorial,
      completeCloudOnly,
      setConversationMessages,
      runtimeChooserEnabled,
      requestDedicatedAdoptionConfirmation,
      requestDedicatedActivationConfirmation,
    ],
  );
  const portsRef = React.useRef(ports);
  portsRef.current = ports;

  const seedError = React.useCallback(
    (message: string) => {
      erroredRef.current = true;
      // An error turn ends a silent cloud entry: from here on the user is in
      // an interactive recovery conversation, so retry statuses and the done
      // wrap-up must render again.
      silentCloudEntryRef.current = false;
      // A DISTINCT, non-looping error surface: the error turn carries its own
      // recovery choice (retry / restart / Settings escape) so onboarding is
      // always recoverable. It must NOT re-append the runtime CHOICE — that
      // would re-offer the same runtime question forever with no way out on a
      // persistent finish error (e.g. the /api/first-run 404).
      seedTurn(
        makeTurn(
          `first-run:error:${Date.now()}`,
          `${finishErrorMessage(message, runtimeChooserEnabled)}\n\n${runtimeChooserEnabled ? ERROR_CHOICE : CLOUD_ONLY_ERROR_CHOICE}`,
        ),
      );
    },
    [runtimeChooserEnabled, seedTurn],
  );

  // Explicit, non-finish escape hatch out of onboarding: flip the real gate and
  // land the user in Settings so they can wire a model provider by hand. Used
  // ONLY by the error-recovery "Configure in Settings" choice, so a broken
  // finish never traps the user in the loop. Latched by completedRef so a
  // double-tap can't flip the gate twice.
  const exitToSettings = React.useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    if (isElectrobunRuntime()) {
      void openDesktopSettingsWindow().then(
        () => {
          completeFirstRun("chat");
          resumePendingFirstRunText();
        },
        (error: unknown) => {
          // error-policy:J4 keep onboarding recoverable when the native window cannot open
          completedRef.current = false;
          seedError(
            `Settings could not open. ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
      return;
    }
    setTab("settings");
    completeFirstRun("settings");
    resumePendingFirstRunText();
  }, [setTab, completeFirstRun, resumePendingFirstRunText, seedError]);

  const seedCloudAgentChoice = React.useCallback(
    (agents: { id?: string; name?: string }[]) => {
      const lines = agents
        .filter((a): a is { id: string; name?: string } => Boolean(a.id))
        .map(
          (a) =>
            `${FIRST_RUN_ACTION_PREFIX}cloud-agent:${a.id}=${a.name?.trim() || a.id}`,
        );
      lines.push(
        `${FIRST_RUN_ACTION_PREFIX}cloud-agent:new=Create a new agent`,
      );
      // Cloud-only mode has no runtime to go back to; only offer the back
      // affordance when the chooser owns this flow.
      if (runtimeChooserEnabled) {
        lines.push(BACK_TO_RUNTIME_OPTION);
      }
      seedFreshChoiceTurn(
        "first-run:cloud-agent",
        `Which Eliza Cloud agent should I use?\n\n[CHOICE:first-run id=cloud-agent]\n${lines.join("\n")}\n[/CHOICE]`,
      );
    },
    [runtimeChooserEnabled, seedFreshChoiceTurn],
  );

  // Armed by a needs-cloud-login outcome; consumed by the auto-resume effect
  // when the cloud connection lands (or cleared by the user's next pick).
  const pendingCloudResumeRef = React.useRef<"cloud" | "hybrid" | null>(null);
  // Bind tail for a chosen/auto-chosen cloud agent — assigned below (it and
  // handleOutcome reference each other; the ref breaks the cycle). Its own
  // in-flight latch exists because the provisioning flow's finally releases
  // busyRef right after handleOutcome kicks the bind off.
  const bindCloudAgentByIdRef = React.useRef<((id: string) => void) | null>(
    null,
  );
  const bindInFlightRef = React.useRef(false);
  // Live mirror of elizaCloudConnected for call-time reads inside callbacks that
  // must NOT list it as a dep (adding it re-registers the action handler and
  // re-seeds on every connection change). It also gates the needs-cloud-login
  // re-arm below so a stale-but-"connected" token can't spin the resume loop.
  const elizaCloudConnectedRef = React.useRef(elizaCloudConnected);
  elizaCloudConnectedRef.current = elizaCloudConnected;

  const handleOutcome = React.useCallback(
    (outcome: FirstRunFinishOutcome) => {
      switch (outcome.kind) {
        case "done":
          // provisioning's completeFirstRun port already ran the wrap-up
          // (tutorial offer, or the cloud-only real completion).
          if (!provisionedRef.current) {
            if (runtimeChooserEnabled) seedTutorial();
            else completeCloudOnly();
          }
          return;
        case "handoff-started":
          // A dedicated cloud agent is completing the official /pair handoff in
          // the current window. The navigation owns the next UI state.
          return;
        case "pick-cloud-agent": {
          // Compatibility path for any legacy/stale picker outcome. The main
          // Cloud first-run path now binds the best healthy agent directly so
          // onboarding stays a single sign-in flow.
          if (!runtimeChooserEnabled) {
            const first = outcome.agents[0]?.agent_id;
            if (outcome.agents.length === 1 && first) {
              bindCloudAgentByIdRef.current?.(first);
              return;
            }
            // The selector is an interactive ask — end any silent entry so
            // the post-pick bind statuses render.
            silentCloudEntryRef.current = false;
          }
          seedCloudAgentChoice(
            outcome.agents.map((a) => ({ id: a.agent_id, name: a.agent_name })),
          );
          return;
        }
        case "needs-cloud-login": {
          // Arm auto-resume ONLY when not already connected. If elizaCloudConnected
          // already reads true yet the bind still reported needs-cloud-login, the
          // stored token is stale/invalid (getCloudAuthToken shadowed empty) — arming
          // would let the auto-resume effect (gated on elizaCloudConnected) re-fire at
          // once and spin the provision→fail→re-arm loop that spammed the transcript
          // (#14387). Show the retry turn and wait for a genuine re-auth (a false→true
          // flip re-enables resume); its sign-in tap re-enters the flow meanwhile.
          pendingCloudResumeRef.current = elizaCloudConnectedRef.current
            ? null
            : draftRef.current.runtime === "cloud"
              ? "cloud"
              : "hybrid";
          // Asking for a sign-in ends a silent entry: the session turned out
          // not to be usable, so the flow is back to the visible ask path.
          silentCloudEntryRef.current = false;
          surfaceCloudLoginRetryTurn(
            { seedTurn, replaceTurn },
            runtimeChooserEnabled,
          );
          return;
        }
        case "error":
          seedError(outcome.message);
          return;
      }
    },
    [
      seedTutorial,
      completeCloudOnly,
      seedCloudAgentChoice,
      seedTurn,
      replaceTurn,
      seedError,
      runtimeChooserEnabled,
    ],
  );

  // ── Flow launchers (shared by the action handler + the auto-resume) ──────
  const allowInteractiveCloudLoginRef = React.useRef(true);
  const startCloudProvisionFlow = React.useCallback(() => {
    erroredRef.current = false;
    const allowInteractiveCloudLogin = allowInteractiveCloudLoginRef.current;
    allowInteractiveCloudLoginRef.current = true;
    busyRef.current = true;
    // Explicit waiting state on the opener while Cloud auth runs in the
    // popup/tab — the sign-in CTA must not look idle (#18001). A silent cloud
    // entry (#15133) reuses a stored session and never opens a window, so it
    // must stay silent: no waiting turn until the flow turns interactive.
    const attempt = cloudLoginAttemptRef.current.begin();
    // The wait is BOUNDED (#19255): a callback failure dead-ends cross-origin
    // in the popup and an abandoned popup never settles, so nothing in the
    // promise chain below rejects on its own. On deadline this attempt is
    // invalidated AND aborted — the abort stops the still-running provision
    // flow at its next checkpoint, so a retried attempt can never race the
    // abandoned one's side effects (single-flight preserved by ownership).
    // A sign-in completed after abandonment lands via the auto-resume effect.
    const abortController = new AbortController();
    let loginDeadline: { cancel(): void } | null = null;
    const abandonAttempt = () => {
      if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
      cloudLoginAttemptRef.current.invalidate();
      abortController.abort();
      loginDeadline?.cancel();
      busyRef.current = false;
      releaseClaimedCloudLoginWindow();
      if (activeCloudLoginCancelRef.current === abandonAttempt) {
        activeCloudLoginCancelRef.current = null;
        refreshCloudLoginWaitingRef.current = null;
      }
    };
    activeCloudLoginCancelRef.current = abandonAttempt;
    const seedWaitingTurn = () => {
      const fallbackUrl = cloudLoginFallbackRef.current;
      const waitingTurn = makeTurn(
        "first-run:cloud-login-waiting",
        [
          "Finish signing in to continue here.",
          fallbackUrl
            ? "If the page didn't open, continue sign-in below."
            : "Opening the sign-in page…",
          "",
          `[CHOICE:first-run id=cloud-login-retry-${attempt}]`,
          ...(fallbackUrl
            ? [
                `${FIRST_RUN_ACTION_PREFIX}cloud-login:continue=Continue sign-in`,
              ]
            : []),
          `${FIRST_RUN_ACTION_PREFIX}cloud-login:retry=Open sign-in again`,
          "[/CHOICE]",
        ].join("\n"),
      );
      setConversationMessages((prev) => {
        const index = prev.findIndex(
          ({ id }) => id === "first-run:cloud-login-waiting",
        );
        if (index === -1) return [...prev, waitingTurn];
        return prev.map((turn, turnIndex) =>
          turnIndex === index ? waitingTurn : turn,
        );
      });
    };
    refreshCloudLoginWaitingRef.current = seedWaitingTurn;
    // Idempotent and OAuth-only: arm at the moment the finish flow actually
    // enters interactive OAuth. An already-authenticated entry can spend up to
    // six minutes activating Dedicated compute; applying this 90s login guard
    // to that separate phase aborts healthy provisioning before its own bound.
    const armRecoveryDeadline = () => {
      if (loginDeadline) return;
      loginDeadline = armCloudLoginWaitDeadline({
        onDeadline: () => {
          if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
          abandonAttempt();
          // The notice carries the sign-in choice itself: at this point the
          // original cloud-oauth turn has been consumed, so re-seeding by
          // that id can no-op and "try again below" would have no below.
          replaceTurn(
            "first-run:cloud-login-waiting",
            makeTurn(
              "first-run:cloud-login-waiting",
              [
                "That sign-in window didn't finish. If you just completed sign-in, hold on — it will still connect. Otherwise, try again:",
                "",
                CLOUD_SIGN_IN_CHOICE,
              ].join("\n"),
            ),
          );
        },
      });
    };
    const hasStoredSession = hasUsableStoredStewardToken();
    if (!silentCloudEntryRef.current && !hasStoredSession) {
      seedWaitingTurn();
    } else if (hasStoredSession) {
      refreshCloudLoginWaitingRef.current = null;
      portsRef.current.onStatus?.(
        "Connecting to your Dedicated agent…",
        "listing",
      );
    }
    // Pre-open only when this gesture can actually enter OAuth. A usable
    // stored Steward token takes the silent provisioning path and may spend
    // the full Dedicated startup budget there; retaining an about:blank popup
    // for that entire phase is both misleading and unnecessary. Token-less
    // entries still claim synchronously because user activation does not
    // survive the network awaits before interactive login (#15143/#17064).
    if (!hasStoredSession) {
      claimCloudLoginWindow();
    }
    void listOrAutoProvisionCloudAgent(draftRef.current, {
      ...portsRef.current,
      allowInteractiveCloudLogin,
      signal: abortController.signal,
      onStatus: (text, code) => {
        if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
        portsRef.current.onStatus?.(text, code);
      },
      onInteractiveLogin: () => {
        if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
        // A silent entry (stored Steward token, #15133) just degraded into
        // real OAuth: the flow is interactive now, so the user gets the same
        // waiting turn and bounded recovery as a visible entry (#19255).
        silentCloudEntryRef.current = false;
        refreshCloudLoginWaitingRef.current = seedWaitingTurn;
        seedWaitingTurn();
        armRecoveryDeadline();
      },
      onInteractiveLoginComplete: () => {
        loginDeadline?.cancel();
        if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
        refreshCloudLoginWaitingRef.current = null;
        portsRef.current.onStatus?.(
          "Connecting to your Dedicated agent…",
          "listing",
        );
      },
    })
      .then((outcome) => {
        loginDeadline?.cancel();
        // Stale attempt: the deadline already surfaced the retry turn — this
        // outcome must not mutate newer state. A genuinely late successful
        // sign-in reaches the store and the auto-resume effect instead.
        if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
        if (
          outcome.kind === "done" ||
          outcome.kind === "pick-cloud-agent" ||
          outcome.kind === "handoff-started"
        ) {
          // Login resolved + provisioning is proceeding — the resume marker has
          // served its purpose; drop it so a later relaunch doesn't re-resume.
          clearCloudLoginPending();
        }
        handleOutcome(outcome);
      })
      // error-policy:J4 unlike runFirstRunFinish (which funnels throws to
      // seedError), these cloud entrypoints can reject (OAuth/network);
      // without this a rejected OAuth/provision call strands the user with no
      // recovery action.
      .catch((err: unknown) => {
        loginDeadline?.cancel();
        if (!cloudLoginAttemptRef.current.isCurrent(attempt)) return;
        seedError(cloudFailureMessage(err));
      })
      .finally(() => {
        // Only the current attempt owns the busy latch AND the claimed popup:
        // the deadline releases both at the moment it invalidates this
        // attempt, and a newer attempt's fresh claim must never be closed by
        // this stale settle (#19271 review). Paths that never reach
        // interactive login (already-authenticated sessions short-circuit
        // before the popup is consumed) still release here, on the owner.
        if (cloudLoginAttemptRef.current.isCurrent(attempt)) {
          busyRef.current = false;
          releaseClaimedCloudLoginWindow();
          if (activeCloudLoginCancelRef.current === abandonAttempt) {
            activeCloudLoginCancelRef.current = null;
            refreshCloudLoginWaitingRef.current = null;
          }
        }
      });
  }, [handleOutcome, replaceTurn, seedError, setConversationMessages]);

  const startProviderFinish = React.useCallback(() => {
    busyRef.current = true;
    // Same gesture-window rationale as startCloudProvisionFlow: hybrid/local
    // finishes may await device-RAM gates and status probes before reaching the
    // interactive login entry point — open the popup synchronously now.
    claimCloudLoginWindow();
    void runFirstRunFinish(draftRef.current, portsRef.current)
      .then(handleOutcome)
      .finally(() => {
        busyRef.current = false;
        // Local-runtime finishes never consume the claimed popup — close it.
        releaseClaimedCloudLoginWindow();
      });
  }, [handleOutcome]);

  // Continue an interrupted cloud/hybrid flow once the connection is present.
  // Shared by (a) the auto-resume effect below — used when the user connects
  // from the retry turn's OAuth block and the store later learns the connection
  // landed — and (b) the mount-time cloud-login rehydrate, which calls this
  // directly when the durable token already made the connection live at launch
  // (the effect fired once before the marker was armed, so it can't self-fire).
  const runCloudResume = React.useCallback(
    (resume: "cloud" | "hybrid") => {
      if (
        busyRef.current ||
        bindInFlightRef.current ||
        provisionedRef.current
      ) {
        return;
      }
      pendingCloudResumeRef.current = null;
      if (resume === "cloud") {
        // Automatic resume may reuse a valid session, but it has no user
        // gesture authorizing a browser handoff. A stale credential must fall
        // back to the visible sign-in choice instead of replacing localhost.
        allowInteractiveCloudLoginRef.current = false;
        startCloudProvisionFlow();
        return;
      }
      startProviderFinish();
    },
    [startCloudProvisionFlow, startProviderFinish],
  );

  // The one bind tail for a cloud agent, shared by the picker tap (chooser
  // mode) and the cloud-only auto-adopt of the first agent. Guarded by its own
  // in-flight latch (see bindCloudAgentByIdRef above) in addition to busyRef.
  const bindCloudAgentById = React.useCallback(
    (id: string) => {
      if (bindInFlightRef.current) return;
      const authToken = getCloudAuthToken(client) ?? "";
      if (!authToken) {
        handleOutcome({ kind: "needs-cloud-login" });
        return;
      }
      cloudPrefsRef.current =
        id === "new" ? { forceCreate: true } : { preferAgentId: id };
      bindInFlightRef.current = true;
      busyRef.current = true;
      void bindCloudAgent(
        draftRef.current,
        authToken,
        cloudPrefsRef.current,
        portsRef.current,
      )
        .then(handleOutcome)
        // error-policy:J4 bind failure is surfaced as an onboarding error turn
        .catch((err: unknown) => seedError(cloudFailureMessage(err)))
        .finally(() => {
          bindInFlightRef.current = false;
          busyRef.current = false;
        });
    },
    [handleOutcome, seedError],
  );
  bindCloudAgentByIdRef.current = bindCloudAgentById;

  // Read-only mirror so the auto-resume effect + the mount rehydrate can drive
  // runCloudResume without listing it as a dep. Its identity churns as its own
  // flow-launcher deps change; the effect below depending on it re-fired on
  // every seeded-turn render and, on a stale token, spun the
  // provision→fail→re-arm loop (#14387).
  const runCloudResumeRef = React.useRef(runCloudResume);
  runCloudResumeRef.current = runCloudResume;

  // Auto-resume: when the user connects Eliza Cloud from the retry turn's OAuth
  // block (instead of re-picking a runtime), continue the interrupted flow the
  // moment the store learns the connection landed. Fires AT MOST ONCE per
  // connection epoch: a resume that lands back on needs-cloud-login (stale token)
  // must not immediately re-fire — that is the loop that spammed the onboarding
  // transcript (#14387). A fresh false→true connection flip clears the latch and
  // re-enables resume; the retry turn's sign-in tap re-enters the flow meanwhile.
  // A fresh pick clears the pending marker, so the user's latest intent wins.
  const resumedForConnectionRef = React.useRef(false);
  React.useEffect(() => {
    if (!active || !elizaCloudConnected) {
      resumedForConnectionRef.current = false;
      return;
    }
    if (resumedForConnectionRef.current) return;
    const resume = pendingCloudResumeRef.current;
    if (!resume) return;
    resumedForConnectionRef.current = true;
    runCloudResumeRef.current(resume);
  }, [active, elizaCloudConnected]);

  const handleFirstRunAction = React.useCallback(
    (value: string): boolean => {
      if (!value.startsWith(FIRST_RUN_ACTION_PREFIX)) return false;
      const suffix = value.slice(FIRST_RUN_ACTION_PREFIX.length);
      const separator = suffix.indexOf(":");
      const group = separator === -1 ? suffix : suffix.slice(0, separator);
      const id = separator === -1 ? "" : suffix.slice(separator + 1);

      // Waiting for an external browser is always recoverable. This action is
      // intentionally handled before the generic busy guard: it abandons the
      // current owned attempt, then starts a fresh sign-in from the new user
      // gesture. Late completion from the old attempt is generation-gated.
      if (group === "cloud-login" && id === "continue") {
        const url = cloudLoginFallbackRef.current;
        const owner = activeCloudLoginCancelRef.current;
        if (!owner || !url) return true;
        const showOpenFailure = () => {
          if (activeCloudLoginCancelRef.current === owner) {
            seedError("The sign-in page could not open. Try again.");
          }
        };
        // The existing server-issued URL carries the same session and return
        // destination. Web stays in this tab so popup blocking cannot hide it.
        if (Capacitor.isNativePlatform() || isElectrobunRuntime()) {
          void openExternalUrl(url)
            .then((opened) => {
              if (!opened) showOpenFailure();
            })
            .catch(showOpenFailure);
        } else {
          window.location.assign(url);
        }
        return true;
      }

      if (group === "cloud-login" && id === "retry") {
        activeCloudLoginCancelRef.current?.();
        startCloudProvisionFlow();
        return true;
      }

      // The provisioning promise is deliberately still in flight while this
      // visible quote is on screen, so consent must be handled before the
      // generic busy guard. Only the exact current quote resolver is released;
      // stale confirmation widgets become harmless no-ops.
      if (group === "dedicated-adoption") {
        if (id !== "confirm" && id !== "cancel") return true;
        const pending = pendingDedicatedAdoptionRef.current;
        if (!pending) return true;
        pendingDedicatedAdoptionRef.current = null;
        pending.dispose();
        pending.resolve(
          id === "confirm"
            ? {
                action: pending.quote.action,
                quoteId: pending.quote.quoteId,
              }
            : null,
        );
        return true;
      }

      // One provisioning flow at a time. Stale widgets survive in the
      // transcript (error re-seeds, the cloud-agent picker next to a re-offered
      // runtime choice), so a confused user can tap a second option while a
      // finish call is still in flight — consume those as no-ops instead of
      // starting a concurrent flow.
      if (busyRef.current || bindInFlightRef.current) return true;
      // Once provisioning succeeded only the wrap-up picks (accent + tutorial)
      // are live; taps on leftover runtime/provider/cloud-agent widgets must not
      // re-provision.
      if (
        provisionedRef.current &&
        group !== "tutorial" &&
        group !== "accent"
      ) {
        return true;
      }
      // Once the real gate flipped (tutorial pick or the Settings escape),
      // every further first-run pick is a stale-widget no-op.
      if (completedRef.current) return true;
      // Cloud-only mode: runtime:cloud is the live "Sign in to Eliza Cloud"
      // button; every other runtime / provider / backup-restore / back pick
      // can only be a stale widget from a chooser-mode transcript (or
      // garbage) — consume those untouched so they can't start a local/remote
      // flow (there is no runtime chooser to go "back" to).
      if (!runtimeChooserEnabled) {
        if (
          group === "provider" ||
          group === "backup-restore" ||
          group === "back"
        ) {
          return true;
        }
        if (group === "runtime" && id !== "cloud") return true;
      }
      // A fresh pick supersedes any armed connect-and-resume continuation —
      // including the durable cloud-resume marker (the cloud/hybrid branches
      // below re-arm it if the new pick is a cloud one) — and clears the error
      // persona so the free-text reply tracks the live step, not a stale error.
      pendingCloudResumeRef.current = null;
      clearCloudLoginPending();
      erroredRef.current = false;

      if (group === "runtime") {
        if (id !== "cloud" && id !== "local" && id !== "remote") return true;
        // Switching AWAY from a previously-picked (possibly partially
        // committed) local runtime must unwind it: clear the persisted mode +
        // local active server and stop a service a failed finish may have
        // started (#14390). No-op when nothing local was committed.
        if (id !== "local") {
          void revertLocalRuntimeCommitment();
        }
        if (id === "cloud") {
          draftRef.current = {
            ...draftRef.current,
            runtime: "cloud",
            localInference: "cloud-inference",
          };
          // Persist a resume marker BEFORE the (device) external-browser OAuth
          // backgrounds/evicts the WebView, so a cold-launch on return
          // rehydrates this cloud flow instead of restarting at the greeting.
          markCloudLoginPending({
            runtime: "cloud",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
          startCloudProvisionFlow();
          return true;
        }
        if (id === "remote") {
          // Remote: point at an already-running agent. Seed the inline URL +
          // token form; its `remote_connect` submit dispatches CONNECT_EVENT,
          // and the App handler connects + adopts the remote as the active
          // runtime + flips firstRunComplete (finishing onboarding). Remote owns
          // its own provider, so there is no provider sub-step — and it never
          // routes through runFirstRunFinish, so draftRef (a FirstRunFinishDraft,
          // which excludes "remote") is intentionally left untouched.
          // The back CHOICE rides in the same turn's text, under the inline
          // connect form — the form comes from `secretRequest`, the widget
          // from the text, and both render (#14390 reversibility).
          const connect = makeTurn(
            "first-run:remote-connect",
            `Enter your remote agent's URL and access token to connect.\n\n[CHOICE:first-run id=remote-back]\n${BACK_TO_RUNTIME_OPTION}\n[/CHOICE]`,
            { secretRequest: remoteConnectSecretRequest() },
          );
          seedTurn(connect);
          replaceTurn("first-run:remote-connect", connect);
          return true;
        }
        // On this device: RAM-tier gate first (#14390). A device below the
        // hybrid runtime floor is refused with the reason and re-offered a fresh
        // runtime choice — enforced at the decision point, not just labeled.
        const tier = peekDeviceRamTierAssessment();
        if (tier && !tier.allowsHybridAgent) {
          seedTurn(
            makeTurn(
              `first-run:runtime-blocked:${Date.now()}`,
              `I can't run on this device — ${tier.reason}. Eliza Cloud runs your agent with nothing to install, or you can connect to an agent running somewhere else.\n\n${runtimeChoiceBlock()}`,
            ),
          );
          return true;
        }
        // Run the local backend, then ask which model provider. BYOK is the
        // provider:other sub-choice ("Other / configure in Settings"), which
        // finishes with `configure-later` and defers provider setup to
        // Settings. Sub-16 GB devices get the perf warning inline; sub-12 GB
        // devices get the on-device option blocked inside providerChoice.
        draftRef.current = {
          ...draftRef.current,
          runtime: "local",
          localInference: "all-local",
        };
        const modelWarning =
          tier?.localModelsWarning || (tier && !tier.allowsLocalModels)
            ? ` Heads up: ${tier.reason}.`
            : "";
        seedFreshChoiceTurn(
          "first-run:provider",
          `Which model provider should ${draftRef.current.agentName} use?${modelWarning}\n\n${providerChoice({ defaultId: "on-device", tier })}`,
        );
        return true;
      }

      if (group === "backup-restore") {
        if (id !== "latest" && id !== "start-fresh") return true;
        if (id === "start-fresh") {
          latestLocalBackupRef.current = null;
          seedRuntimeChoice();
          return true;
        }

        if (id === "latest") {
          const backup = latestLocalBackupRef.current;
          if (!backup || restoringBackupRef.current) return true;
          restoringBackupRef.current = true;
          seedTurn(
            makeTurn(
              "first-run:backup-restore-status",
              "Restoring the latest local backup...",
            ),
          );
          void client
            .restoreLocalAgentBackup(backup.fileName)
            .then(() => {
              seedTurn(
                makeTurn(
                  "first-run:backup-restore-complete",
                  "Backup restored. Restart the agent to use the restored state.",
                ),
              );
            })
            // error-policy:J4 restore failure is surfaced as an onboarding turn
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              seedTurn(
                makeTurn(
                  `first-run:backup-restore-error:${Date.now()}`,
                  `Restore failed: ${message}\n\n${BACKUP_RESTORE_CHOICE}`,
                ),
              );
            })
            .finally(() => {
              restoringBackupRef.current = false;
            });
          return true;
        }
      }

      if (group === "provider") {
        if (id !== "on-device" && id !== "elizacloud" && id !== "other") {
          return true;
        }
        // RAM-tier gate (#14390): below the 12 GB floor on-device models are
        // refused at the decision point with the reason and a fresh provider
        // choice; the finish backstop enforces the same rule for any caller.
        if (id === "on-device") {
          const tier = peekDeviceRamTierAssessment();
          if (tier && !tier.allowsLocalModels) {
            seedFreshChoiceTurn(
              "first-run:provider",
              `On-device models won't work here — ${tier.reason}. Eliza Cloud inference keeps the agent on this device and runs the models in the cloud.\n\n${providerChoice({ defaultId: "on-device", tier })}`,
            );
            return true;
          }
        }
        if (id === "other") {
          const tier = peekDeviceRamTierAssessment();
          if (tier && !tier.allowsLocalAgent) {
            seedFreshChoiceTurn(
              "first-run:provider",
              `An unconfigured local runtime won't work here — ${tier.reason}. Eliza Cloud inference keeps the agent on this device without loading a local model.\n\n${providerChoice({ defaultId: "other", tier })}`,
            );
            return true;
          }
          // "Other / configure in Settings" (bring your own keys): finish the
          // LOCAL runtime with no provider wired and no model download.
          // `configure-later` keeps `needsProviderSetup` true, so the finish
          // path still starts + persists the runtime (one POST /api/first-run)
          // and hands the user the "Open Settings" banner for provider setup.
          // If the finish fails, the ERROR_CHOICE recovery turn's
          // error:settings pick is the Settings escape.
          draftRef.current = {
            ...draftRef.current,
            localInference: "configure-later",
          };
        } else if (id === "elizacloud") {
          draftRef.current = {
            ...draftRef.current,
            localInference: "cloud-inference",
          };
          // Hybrid (local runtime + Cloud inference) also opens the external
          // OAuth browser — persist a resume marker so a WebView eviction on
          // return rehydrates the hybrid finish rather than restarting.
          markCloudLoginPending({
            runtime: "hybrid",
            localInference: "cloud-inference",
            agentName: draftRef.current.agentName,
          });
        } else {
          // on-device: run every model locally (kicks off the download now).
          draftRef.current = {
            ...draftRef.current,
            localInference: "all-local",
          };
        }
        startProviderFinish();
        return true;
      }

      if (group === "cloud-agent") {
        if (!id) return true;
        bindCloudAgentByIdRef.current?.(id);
        return true;
      }

      if (group === "back") {
        if (id !== "runtime") return true;
        // Reversal (#14390): unwind anything the abandoned path committed —
        // the persisted local mode/server and a service a partial finish may
        // have started — then re-offer a FRESH (unlocked) runtime choice.
        void revertLocalRuntimeCommitment();
        draftRef.current = {
          ...draftRef.current,
          runtime: "cloud",
          localInference: "all-local",
        };
        cloudPrefsRef.current = {};
        seedFreshChoiceTurn(
          "first-run:greeting",
          `${GREETING}\n\n${runtimeChoiceBlock()}`,
        );
        return true;
      }

      if (group === "error") {
        if (id !== "retry" && id !== "restart" && id !== "settings") {
          return true;
        }
        if (id === "settings") {
          exitToSettings();
          return true;
        }
        if (id === "restart" && runtimeChooserEnabled) {
          // Re-offer a FRESH (unlocked) runtime choice so the user can switch
          // how their agent runs after a failed finish — unwinding whatever
          // the failed local path committed first (#14390), so switching to
          // cloud can't leave a half-started local agent behind.
          // seedFreshChoiceTurn seeds a retry turn when the greeting already
          // exists (the original runtime widget locked itself on its first
          // pick). Cloud-only mode never offers restart; a stale restart tap
          // falls through to retry below — the only other way to run doesn't
          // exist there.
          void revertLocalRuntimeCommitment();
          seedFreshChoiceTurn(
            "first-run:greeting",
            `${GREETING}\n\n${runtimeChoiceBlock()}`,
          );
          return true;
        }
        // retry: re-run the SAME finish for the runtime the user last chose.
        // The persist guard released itself on the failed POST, so a local
        // retry re-POSTs; a cloud retry re-runs provisioning.
        if (draftRef.current.runtime === "cloud") {
          startCloudProvisionFlow();
          return true;
        }
        startProviderFinish();
        return true;
      }

      if (group === "accent") {
        // "Make it yours": apply + persist the chosen accent live. Non-blocking
        // — the tutorial CHOICE seeded alongside still finishes onboarding, so
        // this never gates completion. Garbage ids are consumed as no-ops.
        if (!ACCENT_PRESETS.some((p) => p.id === id)) return true;
        setUiAccent(id);
        return true;
      }

      if (group === "tutorial") {
        if (id !== "start" && id !== "skip") return true;
        completedRef.current = true;
        // The single real completion: flip the gate (deactivates the conductor),
        // then optionally launch the interactive tutorial.
        completeFirstRun("chat");
        resumePendingFirstRunText();
        if (id === "start") startTutorial();
        return true;
      }

      // Unknown group under the reserved prefix: consume it (the value is
      // never a real chat message) and do nothing.
      return true;
    },
    [
      seedTurn,
      seedFreshChoiceTurn,
      seedRuntimeChoice,
      replaceTurn,
      completeFirstRun,
      resumePendingFirstRunText,
      exitToSettings,
      startCloudProvisionFlow,
      startProviderFinish,
      seedError,
      setUiAccent,
      runtimeChooserEnabled,
    ],
  );
  const handleActionRef = React.useRef(handleFirstRunAction);
  handleActionRef.current = handleFirstRunAction;

  // Free-text handler: the user can type freely during onboarding (#12178).
  // Render their text as a local user turn, then a deterministic assistant
  // reply keyed on the live flow position. Nothing here touches the network —
  // the "no server send pre-completion" property is enforced at the AppContext
  // funnel; the complete text is queued for the real composer after setup.
  const handleFirstRunText = React.useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (!trimmed) return true;
      // A silent cloud entry counts as provisioning even before its first
      // network call lands (the bounded cookie refresh): there is no sign-in
      // ask on screen, so the signIn nudge would point at nothing.
      const waitingForProvision =
        busyRef.current ||
        bindInFlightRef.current ||
        silentCloudEntryRef.current;
      const reply = waitingForProvision
        ? FIRST_RUN_TEXT_REPLY.provisioning
        : provisionedRef.current
          ? FIRST_RUN_TEXT_REPLY.wrapUp
          : erroredRef.current
            ? FIRST_RUN_TEXT_REPLY.error
            : runtimeChooserEnabled
              ? FIRST_RUN_TEXT_REPLY.choosing
              : FIRST_RUN_TEXT_REPLY.signIn;
      textTurnSeqRef.current += 1;
      pendingFirstRunTextRef.current.push(trimmed);
      writePendingFirstRunText(pendingFirstRunTextRef.current);
      const seq = textTurnSeqRef.current;
      seedTurn({
        id: `first-run:user:${seq}`,
        role: "user",
        text: trimmed,
        timestamp: Date.now(),
        source: "first_run",
      });
      seedTurn(
        makeTurn(
          `first-run:reply:${waitingForProvision ? "wait" : "choice"}:${seq}`,
          reply,
        ),
      );
      return true;
    },
    [runtimeChooserEnabled, seedTurn],
  );
  const handleTextRef = React.useRef(handleFirstRunText);
  handleTextRef.current = handleFirstRunText;

  // Register the interceptor + seed the greeting while onboarding is active.
  React.useEffect(() => {
    if (!active) {
      setFirstRunActionHandler(null);
      setFirstRunTextHandler(null);
      setPendingFirstRunTextReleaseHandler(null);
      // Onboarding just completed: the overlay stops filtering the transcript to
      // the current first-run card (`selectFirstRunDisplayMessages`) and renders
      // the raw store, so every synthetic `first-run:*` turn the conductor
      // seeded (greeting + welcome-back + cloud-done + typed reply turns) would
      // otherwise paint as stacked real chat bubbles — the first message then
      // looks duplicated into multiple greetings + doubled user turns until the
      // first send's history reload full-replaces the store (#15354). Drop them
      // now so the real chat opens on a clean thread. Pure id/source-scoped
      // filter: it never touches a real server or optimistic `temp-*` turn, and
      // is a no-op when onboarding seeded nothing (silent reuse, #15133).
      setConversationMessages(clearFirstRunTranscriptMessages);
      return;
    }
    resetFirstRunPersistGuard();
    // Warm the RAM-tier probe (#14390) so the pick handlers' synchronous
    // `peek` has an answer by the time a human can tap: Android resolves
    // synchronously inside peek anyway; this covers the iOS async path. Never
    // gates the greeting — the finish backstop enforces the policy even when
    // a pick lands before the probe settles.
    void resolveDeviceRamTierAssessment();
    // A fresh activation decides silence for itself below — a stale `true`
    // from a previous mount (silent entry unmounted mid-flight, user signed
    // out, conductor re-entered) must not suppress this run's turns.
    silentCloudEntryRef.current = false;
    setFirstRunActionHandler((value) => handleActionRef.current(value));
    setFirstRunTextHandler((value) => handleTextRef.current(value));
    setPendingFirstRunTextReleaseHandler(resumePendingFirstRunText);
    // Cloud-only onboarding (#13377): sign in to Eliza Cloud is the single
    // path. An already-usable session (hosted web where the user is logged in
    // to Eliza Cloud, a durable token from a previous login, a completed
    // OAuth round trip after a mobile WebView eviction, or a session
    // recovered from the console's cross-subdomain cookie) enters SILENTLY
    // (#15133): no greeting, no welcome-back, no reuse narration — a pure
    // reuse lands straight in chat, and only a real provision/wake narrates.
    // Otherwise the greeting offers the one sign-in button; its tap enters
    // the normal cloud pick path (the gesture the real login flow needs). A
    // cold relaunch just re-enters this branch, so no durable resume marker
    // is needed — any stale chooser-mode marker is dropped. The local-backup
    // restore probe is skipped: restoring a local agent is a chooser-mode
    // concept.
    if (!runtimeChooserEnabled) {
      clearCloudLoginPending();
      draftRef.current = {
        ...draftRef.current,
        runtime: "cloud",
        localInference: "cloud-inference",
      };
      // The resume is armed in ALL branches: with a usable session it drives
      // the immediate provision; without one it lets a session that lands
      // later without a tap (login from another same-origin tab, an injected
      // hosted-web session) auto-continue via the auto-resume effect.
      pendingCloudResumeRef.current = "cloud";
      let tokenPoll: ReturnType<typeof setInterval> | null = null;
      let cancelled = false;
      const stopTokenPoll = () => {
        if (tokenPoll) clearInterval(tokenPoll);
        tokenPoll = null;
      };
      const resumeStoredToken = () => {
        if (provisionedRef.current) {
          stopTokenPoll();
          return;
        }
        if (busyRef.current || bindInFlightRef.current) return;
        if (!hasUsableStoredStewardToken()) return;
        stopTokenPoll();
        seedTurn(makeTurn("first-run:cloud-signin", CLOUD_WELCOME_BACK));
        runCloudResumeRef.current("cloud");
      };
      const startTokenPoll = () => {
        if (tokenPoll) return;
        tokenPoll = setInterval(resumeStoredToken, 500);
      };
      // Degrade target shared by the no-session path and a failed cookie
      // recovery: the sign-in greeting plus a cheap localStorage poll. A
      // usable session can LAND after mount without any elizaCloudConnected
      // flip (the native storage bridge hydrates the durable token from
      // Capacitor Preferences asynchronously; a web login in another
      // same-origin tab writes it directly), so poll (one localStorage read
      // per tick) and upgrade to the welcome-back skip the moment it appears;
      // a pick already in flight always wins. The welcome-back turn stays on
      // THIS path only — a greeting was genuinely shown, so silently yanking
      // the conversation would read as broken.
      const seedSignInGreetingAndPoll = () => {
        const cloudApiBase =
          getBootConfig().cloudApiBase?.trim() || "https://eliza.app";
        void prepareDesktopCloudLoginSession(cloudApiBase, () =>
          client.cloudLoginDirect(cloudApiBase),
        );
        seedTurn(makeTurn("first-run:greeting", CLOUD_SIGN_IN_GREETING));
        seedTurn(makeTurn("first-run:cloud-oauth", CLOUD_SIGN_IN_CHOICE));
        startTokenPoll();
      };
      const onNativeResume = () => {
        if (cancelled) return;
        startTokenPoll();
        resumeStoredToken();
      };
      const onVisibilityChange = () => {
        if (typeof document !== "undefined" && document.hidden) return;
        onNativeResume();
      };
      document.addEventListener(APP_RESUME_EVENT, onNativeResume);
      document.addEventListener("visibilitychange", onVisibilityChange);
      if (elizaCloudConnectedRef.current || hasUsableStoredStewardToken()) {
        greetAfterCloudAuthRef.current = consumeCloudAuthFirstScreenGreeting();
        silentCloudEntryRef.current = true;
        runCloudResumeRef.current("cloud");
      } else if (typeof window !== "undefined" && hasStewardAuthedCookie()) {
        // Same-origin session recovery: a returning hosted-app user can carry
        // the host-only HttpOnly refresh cookie while the localStorage access
        // token is missing. Seed NOTHING and recover the access
        // token first (same-origin refresh, bounded like
        // startup-phase-restore's resolveRestoredStewardToken) so an
        // authenticated user never sees a sign-in greeting that a
        // welcome-back then has to walk back — the "onboarding theater"
        // report. During the sub-second hold the already-painted shell shows
        // the empty first-run chat; a stale marker cookie costs at most the
        // 4s bound before the normal greeting appears. Web-only by
        // construction: native has no document cookie and carries the durable
        // token through the branch above.
        silentCloudEntryRef.current = true;
        void (async () => {
          let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
          // error-policy:J4 a failed/timed-out cookie refresh degrades to the
          // normal sign-in greeting below; it never fabricates a session.
          const refreshed = await Promise.race([
            refreshCloudStewardSession().catch(() => null),
            new Promise<null>((resolve) => {
              refreshTimeout = setTimeout(
                () => resolve(null),
                FIRST_RUN_COOKIE_REFRESH_TIMEOUT_MS,
              );
            }),
          ]);
          if (refreshTimeout) clearTimeout(refreshTimeout);
          if (cancelled) return;
          if (refreshed?.token) {
            try {
              await writeStoredStewardToken(refreshed.token);
            } catch (error) {
              // error-policy:J4 a rejected protected-store write keeps the
              // user visibly signed out instead of claiming a volatile login.
              logger.error(
                { error },
                "[first-run-conductor] could not persist recovered Steward session",
              );
              silentCloudEntryRef.current = false;
              seedSignInGreetingAndPoll();
              return;
            }
            try {
              window.dispatchEvent(new CustomEvent("steward-token-sync"));
            } catch (error) {
              void error;
              // error-policy:J6 best-effort nudge — consumers re-read the
              // stored token on their next tick regardless.
            }
            greetAfterCloudAuthRef.current =
              consumeCloudAuthFirstScreenGreeting();
            runCloudResumeRef.current("cloud");
            return;
          }
          silentCloudEntryRef.current = false;
          seedSignInGreetingAndPoll();
        })();
      } else {
        seedSignInGreetingAndPoll();
      }
      return () => {
        cancelled = true;
        stopTokenPoll();
        document.removeEventListener(APP_RESUME_EVENT, onNativeResume);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        setFirstRunActionHandler(null);
        setFirstRunTextHandler(null);
        setPendingFirstRunTextReleaseHandler(null);
      };
    }
    // Cloud-login resume: if the app was cold-launched mid cloud OAuth (the
    // external browser evicted the WebView on a device), rehydrate the
    // interrupted cloud/hybrid flow instead of restarting at the greeting.
    // The durable steward token (persisted at login) makes elizaCloudConnected
    // recompute true after relaunch, so the auto-resume effect above completes
    // onboarding into chat. If login never finished, re-offer the same single
    // sign-in CTA instead of rendering a second in-chat Connect card.
    const cloudResume = readCloudLoginPending();
    if (cloudResume) {
      draftRef.current = {
        ...draftRef.current,
        agentName: cloudResume.agentName || draftRef.current.agentName,
        runtime: cloudResume.runtime === "cloud" ? "cloud" : "local",
        localInference: cloudResume.localInference,
      };
      pendingCloudResumeRef.current = cloudResume.runtime;
      seedTurn(makeTurn("first-run:cloud-oauth", CLOUD_SIGN_IN_CHOICE));
      // If the durable token already made the connection live at launch, the
      // auto-resume effect above fired once before this marker was armed, so it
      // won't self-fire — resume now. Otherwise leave the marker armed for the
      // effect to catch when elizaCloudConnected flips true after the poll.
      if (elizaCloudConnectedRef.current) {
        runCloudResumeRef.current(cloudResume.runtime);
      }
    } else {
      // Seed the greeting + runtime choice IMMEDIATELY on mount — never gate it
      // on the agent-readiness probe below. `listLocalAgentBackups()` hits the
      // local agent API, which on a fresh/booting/wedged device can hang
      // indefinitely; coupling the greeting to it stranded the user at a locked
      // composer ("Tap a highlighted option above to continue") with no visible
      // choices. The backup probe is now a purely additive upgrade.
      seedRuntimeChoice();
    }
    let cancelled = false;
    void client
      .listLocalAgentBackups()
      .then((backups) => {
        if (!cancelled && backups.length > 0) seedBackupRestoreChoice(backups);
      })
      .catch((err: unknown) => {
        // error-policy:J4 the backup probe is a purely additive upgrade (see
        // above): on failure first-run proceeds without the restore choice.
        // Logged so a wedged local agent is diagnosable.
        logger.debug(
          { err },
          "[useFirstRunConductor] local-agent backup probe failed",
        );
      });
    return () => {
      cancelled = true;
      setFirstRunActionHandler(null);
      setFirstRunTextHandler(null);
      setPendingFirstRunTextReleaseHandler(null);
    };
  }, [
    active,
    seedBackupRestoreChoice,
    seedRuntimeChoice,
    seedTurn,
    setConversationMessages,
    runtimeChooserEnabled,
    resumePendingFirstRunText,
  ]);
}

/**
 * Mount point for the conductor. The callback fires only after an active
 * conductor has produced a first-run turn in the shared transcript.
 */
export function FirstRunConductorMount({
  onFirstRunTranscriptMounted,
  firstRunMountEpoch = null,
  firstRunAuthorityEpoch = null,
}: {
  onFirstRunTranscriptMounted?: (epoch: number) => void;
  firstRunMountEpoch?: number | null;
  firstRunAuthorityEpoch?: number | null;
} = {}): null {
  useFirstRunConductor();
  const firstRunIncomplete = useAppSelector(
    (state) => state.firstRunComplete === false,
  );
  const { conversationMessages } = useConversationMessages();
  const transcriptEpochRef = React.useRef(
    createFirstRunTranscriptEpoch(conversationMessages, firstRunIncomplete),
  );
  React.useLayoutEffect(() => {
    const transcriptWasMounted = transcriptEpochRef.current.transcriptMounted;
    transcriptEpochRef.current = observeFirstRunTranscriptEpoch(
      transcriptEpochRef.current,
      conversationMessages,
      firstRunIncomplete,
    );
    if (
      firstRunMountEpoch !== null &&
      ((!transcriptWasMounted &&
        transcriptEpochRef.current.transcriptMounted) ||
        (firstRunAuthorityEpoch === firstRunMountEpoch &&
          transcriptEpochRef.current.transcriptMounted))
    ) {
      onFirstRunTranscriptMounted?.(firstRunMountEpoch);
    }
  }, [
    conversationMessages,
    firstRunAuthorityEpoch,
    firstRunIncomplete,
    firstRunMountEpoch,
    onFirstRunTranscriptMounted,
  ]);
  return null;
}
