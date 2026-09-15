/** Focused onboarding and ongoing-management UI for Gmail and calendar sources. */

import type {
  LifeOpsCalendarProvider,
  LifeOpsCalendarSourceHealth,
  LifeOpsCalendarSummary,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  PermissionState,
} from "@elizaos/shared";
import {
  Button,
  Checkbox,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import {
  AlertTriangle,
  CalendarDays,
  Check,
  ChevronRight,
  CircleDot,
  Inbox,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AccountTransitionPanel } from "./AccountTransitionPanel.js";
import { defaultLifeOpsConnectionsAdapter } from "./adapter.js";
import { CalendarSyncPanel } from "./CalendarSyncPanel.js";
import type { AccountHandoffAdapter } from "./handoff-adapter.js";
import type {
  LifeOpsConnectionsAdapter,
  LifeOpsConnectionsSnapshot,
  LifeOpsPurgeReceipt,
  LifeOpsSeedPhase,
  LifeOpsSeedRangeDays,
  LifeOpsSeedReceipt,
} from "./types.js";

const CALENDAR_PROVIDER_LABELS: Record<LifeOpsCalendarProvider, string> = {
  eliza: "Eliza Calendar",
  google: "Google Calendar",
  microsoft: "Microsoft Calendar",
  apple_calendar: "Apple Calendar",
  ics: "Calendar subscription",
};

const GOOGLE_CAPABILITY_OPTIONS: Array<{
  capability: LifeOpsGoogleCapability;
  title: string;
  scope: string;
  detail: string;
  defaultOn: boolean;
}> = [
  {
    capability: "google.gmail.triage",
    title: "Read and search Gmail",
    scope: "gmail.readonly",
    detail: "Seed and summarize messages without changing the mailbox.",
    defaultOn: true,
  },
  {
    capability: "google.gmail.compose",
    title: "Create drafts",
    scope: "gmail.compose",
    detail: "Save drafts for review. Drafting never sends.",
    defaultOn: true,
  },
  {
    capability: "google.gmail.send",
    title: "Send approved email",
    scope: "gmail.send",
    detail: "Send email using your approval and automation settings.",
    defaultOn: false,
  },
  {
    capability: "google.gmail.manage",
    title: "Manage labels and mailbox state",
    scope: "gmail.modify + gmail.settings.basic",
    detail:
      "Archive, label, trash, or change settings only after confirmation.",
    defaultOn: false,
  },
  {
    capability: "google.calendar.read",
    title: "Read Google Calendar",
    scope: "calendar.readonly",
    detail: "Find availability and seed selected calendars.",
    defaultOn: true,
  },
  {
    capability: "google.calendar.write",
    title: "Change Google Calendar",
    scope: "calendar.events",
    detail: "Sync events and run calendar changes you authorize.",
    defaultOn: false,
  },
];

const ROOT_STYLE: CSSProperties = {
  width: "100%",
  height: "100%",
  minHeight: 0,
  overflowY: "auto",
  color: "var(--txt)",
  background:
    "radial-gradient(circle at 10% 0%, var(--accent-subtle), transparent 34%), var(--bg)",
};

const PANEL_STYLE: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 22,
  background: "var(--card)",
};

const LOCAL_SERVICE_UNAVAILABLE_MESSAGE =
  "Eliza is offline or its local service is unavailable. Restart Eliza if needed, then retry.";

function userFacingError(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message.trim() : "";
  if (/^(failed to fetch|load failed|network ?error)$/i.test(message)) {
    return LOCAL_SERVICE_UNAVAILABLE_MESSAGE;
  }
  return message || fallback;
}

function accountEmail(account: LifeOpsGoogleConnectorStatus): string {
  const identity = account.identity;
  const email = identity?.email;
  return typeof email === "string" && email.trim()
    ? email.trim()
    : "Google account";
}

function grantId(account: LifeOpsGoogleConnectorStatus): string | null {
  return account.grant?.id ?? null;
}

function connectorAccountId(
  account: LifeOpsGoogleConnectorStatus | undefined,
  calendars: readonly LifeOpsCalendarSummary[],
): string | null {
  const fromGrant = account?.grant?.connectorAccountId;
  if (typeof fromGrant === "string" && fromGrant.length > 0) return fromGrant;
  const selectedGrantId = account ? grantId(account) : null;
  return (
    calendars.find(
      (calendar) =>
        calendar.provider === "google" &&
        calendar.grantId === selectedGrantId &&
        calendar.connectorAccountId.length > 0,
    )?.connectorAccountId ?? null
  );
}

function calendarKey(calendar: LifeOpsCalendarSummary): string {
  return JSON.stringify([
    calendar.provider,
    calendar.side,
    calendar.grantId,
    calendar.connectorAccountId,
    calendar.calendarId,
  ]);
}

function formatTime(value: string | null): string {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function toneColor(tone: "good" | "warn" | "bad" | "muted"): string {
  switch (tone) {
    case "good":
      return "var(--status-success)";
    case "warn":
      return "var(--status-warning)";
    case "bad":
      return "var(--status-danger)";
    default:
      return "var(--muted)";
  }
}

function StatusPill({
  label,
  tone = "muted",
}: {
  label: string;
  tone?: "good" | "warn" | "bad" | "muted";
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        minHeight: 28,
        borderRadius: 999,
        padding: "0 10px",
        background: "var(--bg-muted)",
        color: toneColor(tone),
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      <CircleDot size={12} aria-hidden />
      {label}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section style={{ ...PANEL_STYLE, padding: "clamp(16px, 3vw, 24px)" }}>
      <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.2 }}>{title}</h2>
      <p
        style={{
          margin: "7px 0 18px",
          color: "var(--muted)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        {description}
      </p>
      {children}
    </section>
  );
}

function sourceTone(
  source: LifeOpsCalendarSourceHealth,
): "good" | "warn" | "bad" | "muted" {
  if (source.status === "fresh") {
    return source.changeDelivery?.status === "degraded" ? "warn" : "good";
  }
  if (source.status === "error") return "bad";
  if (source.status === "stale") return "warn";
  return "muted";
}

function permissionPresentation(permission: PermissionState): {
  label: string;
  tone: "good" | "warn" | "bad" | "muted";
  detail: string;
} {
  switch (permission.status) {
    case "granted":
      return {
        label: "Full access",
        tone: "good",
        detail: "Selected Apple calendars can be read and kept current.",
      };
    case "limited":
      return {
        label: "Write only",
        tone: "warn",
        detail: "Events can be added, but Eliza cannot read them back.",
      };
    case "denied":
      return {
        label: "Permission denied",
        tone: "bad",
        detail: "Allow Calendar access in System Settings, then retry.",
      };
    case "restricted":
      return {
        label: "Restricted",
        tone: "bad",
        detail: "A device or organization policy prevents Calendar access.",
      };
    case "not-applicable":
      return {
        label: "Not available here",
        tone: "muted",
        detail: "Apple Calendar requires a supported Apple device.",
      };
    default:
      return {
        label: "Permission needed",
        tone: "warn",
        detail:
          "macOS or iOS will show the standard Calendar permission prompt.",
      };
  }
}

export interface LifeOpsConnectionsViewProps {
  adapter?: LifeOpsConnectionsAdapter;
  handoffAdapter?: AccountHandoffAdapter;
}

export function LifeOpsConnectionsView({
  adapter = defaultLifeOpsConnectionsAdapter,
  handoffAdapter,
}: LifeOpsConnectionsViewProps) {
  const [snapshot, setSnapshot] = useState<LifeOpsConnectionsSnapshot | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedGrantId, setSelectedGrantId] = useState("");
  const [rangeDays, setRangeDays] = useState<LifeOpsSeedRangeDays>(30);
  const [selectedCalendarKeys, setSelectedCalendarKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [capabilities, setCapabilities] = useState<
    Set<LifeOpsGoogleCapability>
  >(
    () =>
      new Set(
        GOOGLE_CAPABILITY_OPTIONS.filter((option) => option.defaultOn).map(
          (option) => option.capability,
        ),
      ),
  );
  const [seedPhase, setSeedPhase] = useState<LifeOpsSeedPhase | null>(null);
  const [seedReceipt, setSeedReceipt] = useState<LifeOpsSeedReceipt | null>(
    null,
  );
  const [purgeReceipt, setPurgeReceipt] = useState<LifeOpsPurgeReceipt | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState<
    "disconnect" | "purge-google" | "purge-apple" | null
  >(null);
  const cancelConfirmationRef = useRef<HTMLButtonElement>(null);
  const confirmationDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirmation) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    cancelConfirmationRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmation(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        confirmationDialogRef.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      previouslyFocused?.focus();
    };
  }, [confirmation]);

  const refresh = useCallback(
    async (forceSync = false) => {
      setLoading(true);
      setError(null);
      try {
        const next = await adapter.load({ forceSync });
        setSnapshot(next);
        const connectedGrantIds = next.googleAccounts
          .filter((account) => account.connected && account.grant)
          .map((account) => account.grant?.id)
          .filter((id): id is string => typeof id === "string");
        setSelectedGrantId((current) =>
          connectedGrantIds.includes(current)
            ? current
            : (connectedGrantIds[0] ?? ""),
        );
        setSelectedCalendarKeys(
          new Set(
            next.calendars
              .filter((calendar) => calendar.includeInFeed)
              .map(calendarKey),
          ),
        );
      } catch (cause) {
        // error-policy:J4 Network failures become a visible retryable local-service state.
        setError(userFacingError(cause, "LifeOps connections could not load."));
      } finally {
        setLoading(false);
      }
    },
    [adapter],
  );

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const connectedAccounts = useMemo(
    () =>
      snapshot?.googleAccounts.filter(
        (account) => account.connected && account.grant,
      ) ?? [],
    [snapshot],
  );
  const selectedAccount = connectedAccounts.find(
    (account) => grantId(account) === selectedGrantId,
  );
  const googleCalendars =
    snapshot?.calendars.filter(
      (calendar) =>
        calendar.provider === "google" &&
        (!selectedGrantId || calendar.grantId === selectedGrantId),
    ) ?? [];
  const appleCalendars =
    snapshot?.calendars.filter(
      (calendar) => calendar.provider === "apple_calendar",
    ) ?? [];
  const selectedCalendars = [...googleCalendars, ...appleCalendars].filter(
    (calendar) => selectedCalendarKeys.has(calendarKey(calendar)),
  );
  const permission = snapshot
    ? permissionPresentation(snapshot.applePermission)
    : null;
  const selectedAccountLabel = selectedAccount
    ? accountEmail(selectedAccount)
    : "selected Google account";
  const confirmationTitle =
    confirmation === "disconnect"
      ? `Disconnect ${selectedAccountLabel}?`
      : confirmation === "purge-google"
        ? `Remove imported Google data for ${selectedAccountLabel}?`
        : "Remove imported Apple Calendar data from Eliza?";

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      await adapter.connectGoogle([...capabilities]);
    } catch (cause) {
      // error-policy:J4 OAuth start failures surface as a visible, retryable banner.
      setError(userFacingError(cause, "Google connect failed."));
      setBusy(null);
    }
  };

  const toggleCalendar = async (calendar: LifeOpsCalendarSummary) => {
    const key = calendarKey(calendar);
    const include = !selectedCalendarKeys.has(key);
    setBusy(`calendar:${key}`);
    setError(null);
    try {
      const updated = await adapter.setCalendarIncluded(calendar, include);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              calendars: current.calendars.map((candidate) =>
                calendarKey(candidate) === key ? updated : candidate,
              ),
            }
          : current,
      );
      setSelectedCalendarKeys((current) => {
        const next = new Set(current);
        if (include) next.add(key);
        else next.delete(key);
        return next;
      });
    } catch (cause) {
      // error-policy:J4 A rejected selection write keeps the prior state and shows the failure.
      setError(
        userFacingError(cause, "Calendar selection could not be saved."),
      );
    } finally {
      setBusy(null);
    }
  };

  const seed = async () => {
    if (!selectedGrantId && selectedCalendars.length === 0) return;
    setBusy("seed");
    setError(null);
    setSeedReceipt(null);
    try {
      const receipt = await adapter.seed(
        {
          grantId: selectedGrantId || null,
          rangeDays,
          includeGmail: Boolean(
            selectedAccount?.grantedCapabilities.includes(
              "google.gmail.triage",
            ),
          ),
          calendarKeys: selectedCalendars.map(calendarKey),
        },
        setSeedPhase,
      );
      setSeedReceipt(receipt);
      await refresh(false);
    } catch (cause) {
      // error-policy:J4 A failed seed shows the failure and leaves no receipt behind.
      setError(userFacingError(cause, "Initial sync failed."));
    } finally {
      setBusy(null);
    }
  };

  const requestApple = async () => {
    setBusy("apple-permission");
    setError(null);
    try {
      const nextPermission = await adapter.requestApplePermission();
      setSnapshot((current) =>
        current ? { ...current, applePermission: nextPermission } : current,
      );
      await refresh(false);
    } catch (cause) {
      // error-policy:J4 Permission request failures become a visible recovery state.
      setError(userFacingError(cause, "Calendar permission failed."));
    } finally {
      setBusy(null);
    }
  };

  const openAppleSettings = async () => {
    setBusy("apple-settings");
    setError(null);
    try {
      await adapter.openApplePermissionSettings();
    } catch (cause) {
      // error-policy:J4 Settings deep-link failures are shown instead of silently ignored.
      setError(userFacingError(cause, "System Settings could not be opened."));
    } finally {
      setBusy(null);
    }
  };

  const confirmAction = async () => {
    if (!confirmation || !snapshot) return;
    const action = confirmation;
    setConfirmation(null);
    setBusy(action);
    setError(null);
    try {
      if (action === "disconnect") {
        await adapter.disconnectGoogle(selectedGrantId);
      } else if (action === "purge-google") {
        setPurgeReceipt(
          await adapter.purgeImportedData({
            grantId: selectedGrantId,
            connectorAccountId: connectorAccountId(
              selectedAccount,
              snapshot.calendars,
            ),
            includeGmail: true,
            calendars: snapshot.calendars.filter(
              (calendar) =>
                calendar.provider === "google" &&
                calendar.grantId === selectedGrantId,
            ),
          }),
        );
      } else {
        setPurgeReceipt(
          await adapter.purgeImportedData({
            grantId: "apple-calendar",
            connectorAccountId: null,
            includeGmail: false,
            calendars: appleCalendars,
          }),
        );
      }
      await refresh(false);
    } catch (cause) {
      // error-policy:J4 Disconnect/purge failures are shown; no receipt is fabricated.
      setError(userFacingError(cause, "Action failed."));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !snapshot) {
    return (
      <main style={ROOT_STYLE} aria-busy="true">
        <div className="lifeops-shell">Checking Gmail and calendars…</div>
        <LifeOpsStyles />
      </main>
    );
  }

  if (!snapshot) {
    return (
      <main style={ROOT_STYLE}>
        <div className="lifeops-shell">
          <h1>Connections are unavailable</h1>
          <div className="lifeops-banner lifeops-banner-error" role="alert">
            <AlertTriangle size={18} aria-hidden />
            <span>{error}</span>
          </div>
          <Button type="button" onClick={() => void refresh(false)}>
            Retry
          </Button>
        </div>
        <LifeOpsStyles />
      </main>
    );
  }

  return (
    <main style={ROOT_STYLE}>
      <div className="lifeops-shell">
        <header className="lifeops-header">
          <div>
            <p className="lifeops-eyebrow">LifeOps connections</p>
            <h1>Bring your inbox and calendars into one trustworthy view.</h1>
            <p>
              You choose accounts, calendars, history, and permissions. Calendar
              synchronization uses the destination and settings you approve.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => void refresh(true)}
            disabled={loading || busy !== null}
            className="lifeops-primary"
            aria-label="Retry all connection checks and synchronization"
          >
            <RefreshCw size={16} aria-hidden /> Refresh health
          </Button>
        </header>

        <div aria-live="polite" aria-atomic="true">
          {error ? (
            <div className="lifeops-banner lifeops-banner-error" role="alert">
              <AlertTriangle size={18} aria-hidden />
              <span>{error}</span>
              <Button type="button" onClick={() => void refresh(false)}>
                Retry
              </Button>
            </div>
          ) : null}
          {snapshot?.calendarFeed.state === "partial" ? (
            <div className="lifeops-banner" role="status">
              Some calendar sources failed. Cached results remain labeled, and
              retryable sources can be refreshed without discarding healthy
              data.
            </div>
          ) : null}
        </div>

        {snapshot ? (
          <CalendarSyncPanel adapter={adapter} calendars={snapshot.calendars} />
        ) : null}

        {snapshot ? (
          <AccountTransitionPanel
            snapshot={snapshot}
            api={handoffAdapter}
            refresh={() => refresh(false)}
          />
        ) : null}

        <div className="lifeops-grid">
          <Section
            title="1. Connect Google"
            description="Choose only the access that is useful now. Identity scopes (openid, email, profile) identify the selected account; tokens stay in Eliza's protected credential store."
          >
            {connectedAccounts.length > 0 ? (
              <label className="lifeops-field" htmlFor="lifeops-google-account">
                <span>Active Google account</span>
                <Select
                  value={selectedGrantId}
                  onValueChange={setSelectedGrantId}
                >
                  <SelectTrigger id="lifeops-google-account">
                    <SelectValue placeholder="Choose account" />
                  </SelectTrigger>
                  <SelectContent>
                    {connectedAccounts.map((account) => (
                      <SelectItem
                        key={grantId(account)}
                        value={grantId(account) ?? ""}
                      >
                        {accountEmail(account)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <p className="lifeops-empty">No Google account is connected.</p>
            )}

            <fieldset className="lifeops-options">
              <legend>OAuth access requested</legend>
              {GOOGLE_CAPABILITY_OPTIONS.map((option) => (
                <label
                  key={option.capability}
                  className="lifeops-check-row"
                  htmlFor={`lifeops-capability-${option.capability}`}
                >
                  <Checkbox
                    id={`lifeops-capability-${option.capability}`}
                    checked={capabilities.has(option.capability)}
                    onCheckedChange={() =>
                      setCapabilities((current) => {
                        const next = new Set(current);
                        if (next.has(option.capability)) {
                          next.delete(option.capability);
                        } else {
                          next.add(option.capability);
                        }
                        return next;
                      })
                    }
                  />
                  <span>
                    <strong>{option.title}</strong>
                    <small>{option.detail}</small>
                    <code>{option.scope}</code>
                  </span>
                </label>
              ))}
            </fieldset>
            <Button
              type="button"
              className="lifeops-primary"
              onClick={() => void connect()}
              disabled={busy !== null || capabilities.size === 0}
            >
              {connectedAccounts.length > 0
                ? "Connect another Google account"
                : "Continue to Google"}
              <ChevronRight size={17} aria-hidden />
            </Button>
          </Section>

          <Section
            title="2. Allow Apple Calendar"
            description="Uses EventKit on this device. Eliza never reads Calendar databases or Keychain credentials directly."
          >
            {permission ? (
              <div className="lifeops-status-row">
                <CalendarDays size={22} aria-hidden />
                <div>
                  <strong>Apple Calendar</strong>
                  <span>{permission.detail}</span>
                </div>
                <StatusPill label={permission.label} tone={permission.tone} />
              </div>
            ) : null}
            <div className="lifeops-actions">
              {snapshot?.applePermission.canRequest ? (
                <Button
                  type="button"
                  onClick={() => void requestApple()}
                  disabled={busy !== null}
                >
                  Request permission
                </Button>
              ) : null}
              {snapshot?.applePermission.status === "denied" ? (
                <Button
                  type="button"
                  onClick={() => void openAppleSettings()}
                  disabled={busy !== null}
                >
                  Open System Settings
                </Button>
              ) : null}
            </div>
          </Section>

          <Section
            title="3. Choose what to seed"
            description="A bounded first import creates local searchable context. It never sends mail, invites attendees, or mirrors events between providers."
          >
            <fieldset className="lifeops-range">
              <legend>Gmail and calendar history</legend>
              <SegmentedControl
                className="lifeops-range-choices"
                value={String(rangeDays)}
                onValueChange={(value) => {
                  const days = Number(value);
                  if (days === 7 || days === 30 || days === 90) {
                    setRangeDays(days);
                  }
                }}
                items={([7, 30, 90] as const).map((days) => ({
                  value: String(days),
                  label: `${days} days`,
                }))}
              />
            </fieldset>
            <div className="lifeops-calendar-list">
              {[...googleCalendars, ...appleCalendars].map((calendar) => {
                const key = calendarKey(calendar);
                return (
                  <label
                    key={key}
                    className="lifeops-check-row compact"
                    htmlFor={`lifeops-calendar-${key}`}
                  >
                    <Checkbox
                      id={`lifeops-calendar-${key}`}
                      checked={selectedCalendarKeys.has(key)}
                      disabled={busy === `calendar:${key}`}
                      onCheckedChange={() => void toggleCalendar(calendar)}
                    />
                    <span>
                      <strong>{calendar.summary || "Unnamed calendar"}</strong>
                      <small>
                        {calendar.provider === "google"
                          ? `Google · ${calendar.accountEmail ?? "account"}`
                          : "Apple Calendar · this device"}
                      </small>
                    </span>
                  </label>
                );
              })}
            </div>
            <Button
              type="button"
              className="lifeops-primary"
              onClick={() => void seed()}
              disabled={
                (!selectedGrantId && selectedCalendars.length === 0) ||
                busy !== null
              }
            >
              Seed selected context
            </Button>
            {seedPhase ? (
              <p className="lifeops-progress" role="status">
                {seedPhase === "complete"
                  ? "Initial sync complete"
                  : `Initial sync · ${seedPhase}`}
              </p>
            ) : null}
            {seedReceipt ? (
              <div className="lifeops-receipt" data-testid="seed-receipt">
                <Check size={18} aria-hidden />
                <span>
                  {seedReceipt.gmailMessageCount} Gmail messages and{" "}
                  {seedReceipt.calendarEventCount} calendar events from{" "}
                  {seedReceipt.calendarSourceCount}{" "}
                  {seedReceipt.calendarSourceCount === 1 ? "source" : "sources"}
                  . {seedReceipt.duplicateEventCount} duplicate{" "}
                  {seedReceipt.duplicateEventCount === 1
                    ? "delivery"
                    : "deliveries"}{" "}
                  ignored.
                </span>
              </div>
            ) : null}
          </Section>
        </div>

        <Section
          title="Sync health"
          description="Provider cursors and source freshness are reported separately from cached content, so an empty result never disguises a failed sync."
        >
          <div className="lifeops-health-grid">
            {connectedAccounts.map((account) => {
              const id = grantId(account);
              const health = id ? snapshot?.gmailHealthByGrantId[id] : null;
              return (
                <article
                  key={id ?? account.cloudConnectionId ?? accountEmail(account)}
                >
                  <Inbox size={20} aria-hidden />
                  <div>
                    <strong>Gmail · {accountEmail(account)}</strong>
                    <span>
                      {health
                        ? `${health.cachedMessageCount} cached · last sync ${formatTime(health.syncedAt)}`
                        : "Gmail read access not granted"}
                    </span>
                    {health ? (
                      <small>
                        History cursor: {health.cursorStatus.replace("_", " ")}
                        {health.fullResyncReason
                          ? ` · ${health.fullResyncReason.replaceAll("_", " ")}`
                          : ""}
                      </small>
                    ) : null}
                  </div>
                  <StatusPill
                    label={health?.state.replace("_", " ") ?? "unavailable"}
                    tone={health?.state === "current" ? "good" : "warn"}
                  />
                </article>
              );
            })}
            {snapshot?.calendarFeed.sources.map((source) => (
              <article
                key={JSON.stringify(source.key)}
                data-provider={source.key.provider}
              >
                <CalendarDays size={20} aria-hidden />
                <div>
                  <strong>
                    {CALENDAR_PROVIDER_LABELS[source.key.provider]}
                    {source.summary &&
                    source.summary !==
                      CALENDAR_PROVIDER_LABELS[source.key.provider]
                      ? ` · ${source.summary}`
                      : ""}
                  </strong>
                  <span>Last sync {formatTime(source.syncedAt)}</span>
                  <small>
                    {source.changeDelivery
                      ? `${source.changeDelivery.mode} updates · ${source.changeDelivery.status}`
                      : source.key.provider === "eliza"
                        ? "Stored in Eliza"
                        : source.key.provider === "apple_calendar"
                          ? "EventKit store-change updates with polling recovery"
                          : "Polling recovery available"}
                  </small>
                  {source.error ? (
                    <small className="lifeops-error-copy">
                      {source.error.message}
                      {source.error.retryable ? " · retry available" : ""}
                    </small>
                  ) : null}
                </div>
                <StatusPill label={source.status} tone={sourceTone(source)} />
              </article>
            ))}
          </div>
        </Section>

        <div className="lifeops-grid">
          <Section
            title="Safe actions"
            description="Reading and drafting are separate from effects. Provider writes show a review, then require a fresh confirmation and return a provider receipt."
          >
            <div className="lifeops-safety-list">
              <p>
                <ShieldCheck size={17} aria-hidden /> Drafting does not send.
              </p>
              <p>
                <ShieldCheck size={17} aria-hidden /> Proposing an event does
                not create it.
              </p>
              <p>
                <ShieldCheck size={17} aria-hidden /> Partial provider failures
                keep successful receipts and offer retry for only failed items.
              </p>
            </div>
            <div className="lifeops-actions">
              <Button type="button" onClick={() => adapter.navigate("/inbox")}>
                Review inbox drafts
              </Button>
              <Button
                type="button"
                onClick={() => adapter.navigate("/calendar")}
              >
                Review calendar changes
              </Button>
            </div>
          </Section>

          <Section
            title="Data and connection controls"
            description="Disconnecting stops future access. Purging removes only Eliza's imported projection; it does not delete provider mail or events. Reconnecting the same account reuses stable identities, so it does not duplicate rows."
          >
            <div className="lifeops-danger-actions">
              <Button
                type="button"
                onClick={() => setConfirmation("purge-google")}
                disabled={!selectedGrantId || busy !== null}
              >
                <Trash2 size={17} aria-hidden /> Purge imported Google data
              </Button>
              <Button
                type="button"
                onClick={() => setConfirmation("purge-apple")}
                disabled={appleCalendars.length === 0 || busy !== null}
              >
                <Trash2 size={17} aria-hidden /> Purge imported Apple data
              </Button>
              <Button
                type="button"
                onClick={() => setConfirmation("disconnect")}
                disabled={!selectedGrantId || busy !== null}
              >
                <Unplug size={17} aria-hidden /> Disconnect Google account
              </Button>
            </div>
            {purgeReceipt ? (
              <p className="lifeops-receipt" data-testid="purge-receipt">
                Local purge complete:{" "}
                {purgeReceipt.gmail?.deletedMessageCount ?? 0} Gmail messages
                and{" "}
                {purgeReceipt.calendars.reduce(
                  (sum, receipt) => sum + receipt.deletedEventCount,
                  0,
                )}{" "}
                calendar events removed. Providers were not changed.
              </p>
            ) : null}
          </Section>
        </div>

        <aside className="lifeops-provenance">
          <strong>How duplicate prevention works</strong>
          <span>
            Every message and event keeps provider, account, calendar, external
            id, recurrence identity, and tombstone provenance. Title and time
            alone are never used to merge unrelated events. A Google calendar
            also visible through Apple Calendar is read once and never written
            back twice.
          </span>
        </aside>
      </div>

      {confirmation ? (
        <div className="lifeops-dialog-backdrop" role="presentation">
          <div
            className="lifeops-dialog"
            ref={confirmationDialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="lifeops-confirm-title"
            aria-describedby="lifeops-confirm-description"
          >
            <h2 id="lifeops-confirm-title">{confirmationTitle}</h2>
            <p id="lifeops-confirm-description">
              {confirmation === "disconnect"
                ? "Future Gmail and Google Calendar sync will stop. Provider data is unchanged; imported data can be purged separately."
                : "This deletes only Eliza's local imported projection and sync cursor. Gmail and calendar providers are not changed."}
            </p>
            <div className="lifeops-actions">
              <Button
                type="button"
                ref={cancelConfirmationRef}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                className="lifeops-danger-confirm"
                onClick={() => void confirmAction()}
              >
                Confirm {confirmation === "disconnect" ? "disconnect" : "purge"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      <LifeOpsStyles />
    </main>
  );
}

function LifeOpsStyles() {
  return (
    <style>{`
      .lifeops-shell{box-sizing:border-box;width:min(1180px,100%);margin:0 auto;padding:clamp(18px,4vw,42px);padding-bottom:calc(100px + var(--safe-area-bottom,0px));font-family:inherit}
      .lifeops-header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:24px}.lifeops-header h1{max-width:760px;margin:4px 0 10px;font-size:clamp(28px,5vw,48px);line-height:1.02;letter-spacing:-.035em}.lifeops-header p:not(.lifeops-eyebrow){max-width:720px;margin:0;color:var(--muted);line-height:1.55}.lifeops-eyebrow{margin:0;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
      .lifeops-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-items:start;gap:16px;margin-bottom:16px}.lifeops-grid>section:nth-child(3){grid-column:1/-1}
      .lifeops-options,.lifeops-range{margin:16px 0;border:0;padding:0}.lifeops-options legend,.lifeops-range legend{margin-bottom:10px;font-size:12px;font-weight:750;color:var(--muted)}
      .lifeops-check-row{display:flex;align-items:flex-start;gap:12px;padding:12px;border-radius:14px;background:var(--bg-accent);margin-bottom:7px;cursor:pointer}.lifeops-check-row.compact{align-items:center}.lifeops-check-row input{width:20px;height:20px;margin:1px 0 0;accent-color:var(--accent);flex:0 0 auto}.lifeops-check-row span{display:grid;gap:3px;min-width:0}.lifeops-check-row small{color:var(--muted);line-height:1.4}.lifeops-check-row code{width:max-content;max-width:100%;overflow-wrap:anywhere;color:var(--accent);font-size:11px}
      .lifeops-field{display:grid;gap:7px;font-size:12px;font-weight:700}.lifeops-field select{min-height:44px;border:1px solid var(--border);border-radius:13px;padding:0 12px;background:var(--card);color:inherit;font:inherit}.lifeops-range-choices{display:flex;flex-wrap:wrap;gap:8px}.lifeops-range legend{width:100%}
      .lifeops-primary,.lifeops-danger-confirm{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:46px;border:0;border-radius:13px;padding:0 17px;background:var(--accent);color:var(--accent-foreground);font:inherit;font-weight:800;cursor:pointer}.lifeops-primary:hover{background:var(--accent-muted,#c94400);color:var(--brand-white,#fdfaf7)}.lifeops-primary:disabled,button:disabled{opacity:.48;cursor:not-allowed}.lifeops-danger-confirm{background:var(--destructive-solid);color:var(--destructive-foreground)}.lifeops-danger-confirm:hover{background:var(--destructive-solid-hover)}
      .lifeops-actions{display:flex;flex-wrap:wrap;gap:9px;margin-top:14px}.lifeops-actions button{display:inline-flex;align-items:center;justify-content:center;gap:8px}.lifeops-empty{padding:14px;border:1px dashed var(--border-strong);border-radius:13px;color:var(--muted)}
      .lifeops-status-row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px}.lifeops-status-row div{display:grid;gap:4px}.lifeops-status-row span{color:var(--muted);font-size:13px;line-height:1.4}
      .lifeops-calendar-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-bottom:14px}.lifeops-progress{color:var(--status-warning);text-transform:capitalize}.lifeops-receipt{display:flex;align-items:flex-start;gap:9px;margin:12px 0 0;padding:12px;border-radius:12px;background:var(--status-success-bg);color:var(--txt);font-size:13px;line-height:1.45}
      .lifeops-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.lifeops-health-grid article{display:grid;grid-template-columns:auto 1fr auto;align-items:start;gap:11px;padding:14px;border-radius:15px;background:var(--bg-accent)}.lifeops-health-grid article>div{display:grid;gap:4px}.lifeops-health-grid span,.lifeops-health-grid small{color:var(--muted);font-size:12px;line-height:1.4}.lifeops-error-copy{color:var(--status-danger)!important}
      .lifeops-banner{display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:13px 15px;border-radius:14px;background:var(--status-warning-bg);color:var(--txt)}.lifeops-banner-error{background:var(--status-danger-bg);color:var(--txt)}.lifeops-banner button{margin-left:auto;min-height:36px;border:0;border-radius:10px;padding:0 12px;background:var(--bg-muted);color:inherit;font:inherit;font-weight:700}
      .lifeops-safety-list p{display:flex;align-items:flex-start;gap:9px;margin:10px 0;color:var(--muted);line-height:1.45}.lifeops-safety-list svg{color:var(--status-success);flex:0 0 auto}.lifeops-danger-actions{display:grid;gap:8px}.lifeops-danger-actions button{display:flex;align-items:center;gap:9px;min-height:44px;border:1px solid var(--border-strong);border-radius:12px;padding:0 13px;background:var(--destructive-subtle);color:var(--txt);font:inherit;font-weight:700;text-align:left}
      .lifeops-provenance{display:grid;grid-template-columns:auto 1fr;gap:13px;margin-top:16px;padding:16px 18px;border:1px solid var(--border);border-radius:16px;background:var(--accent-subtle)}.lifeops-provenance span{color:var(--muted);font-size:13px;line-height:1.5}
      .lifeops-dialog-backdrop{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:20px;background:var(--scrim);backdrop-filter:blur(8px)}.lifeops-dialog{width:min(480px,100%);box-sizing:border-box;padding:24px;border:1px solid var(--border);border-radius:20px;background:var(--card);box-shadow:0 28px 90px var(--scrim)}.lifeops-dialog h2{margin:0 0 10px}.lifeops-dialog p{margin:0;color:var(--muted);line-height:1.55}
      button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
      @media(max-width:760px){.lifeops-header{display:grid}.lifeops-grid,.lifeops-health-grid,.lifeops-calendar-list{grid-template-columns:1fr}.lifeops-grid>section:nth-child(3){grid-column:auto}.lifeops-status-row,.lifeops-health-grid article{grid-template-columns:auto 1fr}.lifeops-status-row>span,.lifeops-health-grid article>span{grid-column:2}.lifeops-provenance{grid-template-columns:1fr}.lifeops-actions>*{flex:1 1 100%}}
      @media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
    `}</style>
  );
}
