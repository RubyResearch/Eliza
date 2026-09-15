/** Reviews exact owner choices before advancing a durable, recoverable Google account switch. */
import { Button, Checkbox, NativeSelect } from "@elizaos/ui";
import { useEffect, useRef, useState } from "react";
import type { AccountHandoffRetirementCandidate } from "../../lifeops/account-handoff-approval-inventory.js";
import type {
  AccountHandoffCalendarEntry,
  AccountHandoffChoices,
} from "../../lifeops/account-handoff-review.js";
import type { AccountHandoffRecord } from "../../lifeops/account-handoff-store.js";
import type { FamilyEmailOptions } from "../../lifeops/family-workflows/runtime.js";
import {
  type AccountHandoffAdapter,
  defaultAccountHandoffAdapter,
} from "./handoff-adapter.js";
import { formatHandoffEventDate } from "./handoff-event-date.js";
import type { LifeOpsConnectionsSnapshot } from "./types.js";

const phases: Record<AccountHandoffRecord["phase"], string> = {
  reviewed: "Ready for your review",
  pausing: "Pausing scheduled delivery",
  draining: "Waiting for active deliveries",
  retiring_approvals: "Retiring reviewed approvals",
  applying_mappings: "Applying calendar choices",
  verifying_replacement: "Checking the replacement account and recipients",
  disconnecting_previous: "Disconnecting the previous account",
  disposing_imports: "Applying your imported-data choice",
  resuming: "Restoring reviewed operation",
  completed: "Account switch complete",
  cancelled: "Review cancelled",
};
interface Inventory {
  entries: AccountHandoffCalendarEntry[];
  candidates: AccountHandoffRetirementCandidate[];
  options: FamilyEmailOptions;
}

export function AccountTransitionPanel({
  snapshot,
  refresh,
  api = defaultAccountHandoffAdapter,
}: {
  snapshot: LifeOpsConnectionsSnapshot;
  refresh: () => Promise<void>;
  api?: AccountHandoffAdapter;
}) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [previous, setPrevious] = useState("");
  const [replacement, setReplacement] = useState("");
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [readIds, setReadIds] = useState<string[]>([]);
  const [writeId, setWriteId] = useState("");
  const [copies, setCopies] = useState<string[]>([]);
  const [recipient, setRecipient] = useState("");
  const [imports, setImports] =
    useState<AccountHandoffChoices["importedData"]>("retain");
  const [record, setRecord] = useState<AccountHandoffRecord | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [needsReadback, setNeedsReadback] = useState(false);
  const workInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const errorElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorElement.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  const accounts = snapshot.googleAccounts.filter(
    (a) => a.connected && a.grant,
  );
  const calendars = snapshot.calendars.filter((c) => c.grantId === replacement);
  const terminal =
    record?.phase === "completed" || record?.phase === "cancelled";
  async function run(work: () => Promise<void>) {
    if (workInFlight.current) return;
    workInFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      // error-policy:J4 Failed checkpoints remain visible; saved readback is a separate recovery action.
      if (!mounted.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Account switch unavailable. Refresh saved progress before retrying.",
      );
    } finally {
      workInFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function reopen() {
    const saved = await api.getActiveLifeOpsAccountHandoff();
    setRecord(saved.handoff);
    setNeedsReadback(false);
    setLoaded(true);
  }
  function resetChoices() {
    setInventory(null);
    setReadIds([]);
    setWriteId("");
    setCopies([]);
    setRecipient("");
    setOperationId(crypto.randomUUID());
  }
  async function loadChoices() {
    const [links, approvals, email] = await Promise.all([
      api.getLifeOpsHandoffCalendarEntries(previous),
      api.getLifeOpsHandoffRetirementCandidates(previous),
      api.getLifeOpsFamilyEmailOptions(),
    ]);
    setInventory({
      entries: links.entries,
      candidates: approvals.candidates,
      options: email.options,
    });
  }
  async function saveReview() {
    if (!inventory) throw new Error("Load the account details first.");
    const target = accounts.find((a) => a.grant?.id === replacement)?.grant;
    const destination = inventory.options.recipients.find(
      (r) => r.entityId === recipient,
    );
    if (!target?.connectorAccountId || !destination)
      throw new Error(
        "Choose a connected replacement and verified email recipient.",
      );
    const result = await api.createLifeOpsAccountHandoff({
      operationId,
      previousGrantId: previous,
      replacementGrantId: replacement,
      readCalendarIds: readIds,
      writeCalendarId: writeId || null,
      calendarLinks: inventory.entries.map(({ link }) => ({
        linkId: link.id,
        expectedUpdatedAt: link.updatedAt,
        expectedLocalRevision: link.localRevision,
        disposition: copies.includes(link.id)
          ? "copy_to_replacement"
          : "retain_local",
      })),
      messageDestinations: [
        {
          channel: "email",
          connectorAccountId: target.connectorAccountId,
          recipientId: destination.address,
          recipientEntityId: destination.entityId,
        },
      ],
      importedData: imports,
      retireApprovalIds: inventory.candidates.map((a) => a.id),
    });
    setRecord(result.handoff);
  }
  async function advance() {
    if (!record) throw new Error("Refresh saved progress first.");
    let current = record;
    while (mounted.current) {
      // A lost response leaves this set until the owner reads the durable state.
      setNeedsReadback(true);
      const { handoff: next } = await api.advanceLifeOpsAccountHandoff(
        current.operationId,
        current.revision,
      );
      if (!mounted.current) return;
      if (
        next.operationId !== current.operationId ||
        next.revision < current.revision
      )
        throw new Error("Account switch changed. Refresh saved progress.");
      setRecord(next);
      setNeedsReadback(false);
      if (next.phase === "completed") {
        await refresh();
        return;
      }
      if (next.phase === "cancelled" || next.revision === current.revision)
        return;
      current = next;
    }
  }
  const calendarName = (id: string) =>
    snapshot.calendars.find(
      (c) =>
        c.grantId === record?.review.replacement.grantId && c.calendarId === id,
    )?.summary || `Calendar identity: ${id}`;
  return (
    <section
      className="lifeops-handoff"
      style={{
        border: "1px solid var(--border)",
        borderRadius: 22,
        padding: 24,
        marginBottom: 16,
        background: "var(--card)",
        overflowWrap: "anywhere",
      }}
      aria-labelledby="account-transition-title"
    >
      <h2
        id="account-transition-title"
        style={{ fontSize: 19, lineHeight: 1.2 }}
      >
        Switch from test to real accounts
      </h2>
      <p>
        Connect the replacement Google account below. Review calendars, email
        recipients and imported history before starting the switch.
      </p>
      <p>
        iMessage, Telegram and Discord require separate verification. This flow
        switches Google accounts and does not send an email.
      </p>
      <Button
        variant="outline"
        disabled={busy}
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) setExpanded(false);
          else {
            setExpanded(true);
            void run(reopen);
          }
        }}
      >
        {expanded ? "Close account replacement" : "Replace an account"}
      </Button>
      {expanded && loaded && !record ? (
        <>
          <div className="lifeops-grid">
            {(["previous", "replacement"] as const).map((kind) => (
              <div className="lifeops-field" key={kind}>
                <label htmlFor={`handoff-${kind}`}>
                  {kind === "previous"
                    ? "Test account to disconnect"
                    : "Real account to keep"}
                </label>
                <NativeSelect
                  id={`handoff-${kind}`}
                  disabled={busy}
                  value={kind === "previous" ? previous : replacement}
                  onChange={(e) => {
                    kind === "previous"
                      ? setPrevious(e.target.value)
                      : setReplacement(e.target.value);
                    resetChoices();
                  }}
                >
                  <option value="">Choose an account</option>
                  {accounts.map((a) =>
                    a.grant ? (
                      <option value={a.grant.id} key={a.grant.id}>
                        {a.grant.identityEmail || "Identity unavailable"}
                      </option>
                    ) : null,
                  )}
                </NativeSelect>
              </div>
            ))}
          </div>
          <Button
            disabled={
              busy || !previous || !replacement || previous === replacement
            }
            onClick={() => void run(loadChoices)}
          >
            Load account details
          </Button>
          {inventory ? (
            <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
              <legend>Choose what continues</legend>
              <p>Read calendars from the replacement account:</p>
              {calendars.map((c) => (
                <label
                  key={c.calendarId}
                  htmlFor={`handoff-read-${c.calendarId}`}
                  style={{ display: "block" }}
                >
                  <Checkbox
                    id={`handoff-read-${c.calendarId}`}
                    checked={readIds.includes(c.calendarId)}
                    onCheckedChange={(checked) =>
                      setReadIds(
                        checked === true
                          ? [...readIds, c.calendarId]
                          : readIds.filter((id) => id !== c.calendarId),
                      )
                    }
                  />{" "}
                  {c.summary}
                </label>
              ))}
              {calendars.length === 0 ? (
                <p>
                  No replacement calendars are available. Refresh connections if
                  you expected one.
                </p>
              ) : null}
              <div className="lifeops-field">
                <label htmlFor="handoff-write">New calendar events</label>
                <NativeSelect
                  id="handoff-write"
                  value={writeId}
                  onChange={(e) => {
                    setWriteId(e.target.value);
                    if (!e.target.value) setCopies([]);
                  }}
                >
                  <option value="">Keep in Eliza only</option>
                  {calendars
                    .filter(
                      (c) =>
                        c.accessRole === "owner" || c.accessRole === "writer",
                    )
                    .map((c) => (
                      <option key={c.calendarId} value={c.calendarId}>
                        {c.summary}
                      </option>
                    ))}
                </NativeSelect>
              </div>
              <p>
                Existing linked events stay in Eliza. Select any to copy to the
                replacement calendar. Originals in the previous Google account
                are retained.
              </p>
              {inventory.entries.map(({ link, event }) => (
                <label
                  key={link.id}
                  htmlFor={`handoff-copy-${link.id}`}
                  style={{ display: "block" }}
                >
                  <Checkbox
                    id={`handoff-copy-${link.id}`}
                    disabled={!writeId || !event}
                    checked={copies.includes(link.id)}
                    onCheckedChange={(checked) =>
                      setCopies(
                        checked === true
                          ? [...copies, link.id]
                          : copies.filter((id) => id !== link.id),
                      )
                    }
                  />
                  {event
                    ? `${event.title} · ${formatHandoffEventDate(event)}`
                    : `Local event missing; retain the disconnected mapping (${link.localEventId})`}
                </label>
              ))}
              <div className="lifeops-field">
                <label htmlFor="handoff-recipient">
                  Verified monthly email recipient
                </label>
                <NativeSelect
                  id="handoff-recipient"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                >
                  <option value="">Choose a verified contact</option>
                  {inventory.options.recipients.map((r) => (
                    <option key={r.entityId} value={r.entityId}>
                      {r.name} · {r.address}
                    </option>
                  ))}
                </NativeSelect>
                {!inventory.options.recipients.length ? (
                  <p>
                    Add and verify a recipient in Family Operations before
                    continuing.
                  </p>
                ) : null}
              </div>
              <div className="lifeops-field">
                <label htmlFor="handoff-imports">
                  Previously imported email and calendar history
                </label>
                <NativeSelect
                  id="handoff-imports"
                  value={imports}
                  onChange={(e) =>
                    setImports(
                      e.target.value === "retain"
                        ? "retain"
                        : "remove_previous_account_imports",
                    )
                  }
                >
                  <option value="retain">Keep imported history in Eliza</option>
                  <option value="remove_previous_account_imports">
                    Remove previous account imports from Eliza
                  </option>
                </NativeSelect>
              </div>
              <p>
                These pending approvals will be retired and require a fresh
                review:
              </p>
              {inventory.candidates.length ? (
                inventory.candidates.map((a) => (
                  <details key={a.id}>
                    <summary>
                      {a.action} · {a.reason}
                    </summary>
                    <pre style={{ whiteSpace: "pre-wrap" }}>
                      {JSON.stringify(a.payload, null, 2)}
                    </pre>
                  </details>
                ))
              ) : (
                <p>No approvals need retirement.</p>
              )}
              <Button
                disabled={!recipient}
                onClick={() => void run(saveReview)}
              >
                Save choices for review
              </Button>
            </fieldset>
          ) : null}
        </>
      ) : null}
      {expanded && record ? (
        <div className="lifeops-handoff-review">
          <h3 role="status">{phases[record.phase]}</h3>
          <p>
            Disconnect <strong>{record.review.previous.email}</strong>. Keep{" "}
            <strong>{record.review.replacement.email}</strong>.
          </p>
          <p>
            Read calendars:{" "}
            {record.review.readCalendars.length
              ? record.review.readCalendars
                  .map((c) => calendarName(c.calendarId))
                  .join(", ")
              : "None"}
            .
          </p>
          <p>
            New events:{" "}
            {record.review.writeCalendar
              ? calendarName(record.review.writeCalendar.calendarId)
              : "Eliza only"}
            .
          </p>
          <p>
            Email recipients:{" "}
            {record.review.messageDestinations
              .map((d) => `${d.channel}: ${d.recipientId}`)
              .join(", ") || "None"}
            .
          </p>
          <p>
            Imported history:{" "}
            {record.review.importedData === "retain"
              ? "Keep in Eliza"
              : "Remove previous account imports from Eliza"}
            . Google originals are retained.
          </p>
          <p>
            {
              record.review.calendarLinks.filter(
                (l) => l.disposition === "copy_to_replacement",
              ).length
            }{" "}
            {record.review.calendarLinks.filter(
              (link) => link.disposition === "copy_to_replacement",
            ).length === 1
              ? "event"
              : "events"}{" "}
            selected for copying; {record.review.retireApprovalIds.length}{" "}
            {record.review.retireApprovalIds.length === 1
              ? "approval"
              : "approvals"}{" "}
            selected for retirement.
          </p>
          <details>
            <summary>Exact saved choices</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(record.review, null, 2)}
            </pre>
          </details>
          {!terminal ? (
            <>
              <p>
                Progress is saved after each step. If a request fails or you
                leave this page, refresh saved progress before continuing.
              </p>
              <Button
                disabled={busy || needsReadback}
                onClick={() => void run(advance)}
              >
                {record.phase === "reviewed"
                  ? "Start reviewed account switch"
                  : "Continue account switch"}
              </Button>
              {record.phase === "reviewed" ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const cancelled = await api.cancelLifeOpsAccountHandoff(
                        record.operationId,
                        record.revision,
                      );
                      setRecord(cancelled.handoff);
                    })
                  }
                >
                  Cancel review
                </Button>
              ) : null}
            </>
          ) : (
            <p>
              {record.phase === "completed"
                ? "Create a fresh monthly draft and approve its exact contents before sending."
                : "No account-switch steps were started."}
            </p>
          )}
        </div>
      ) : null}
      {expanded ? (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (record)
                setRecord(
                  (await api.getLifeOpsAccountHandoff(record.operationId))
                    .handoff,
                );
              else await reopen();
              setNeedsReadback(false);
            })
          }
        >
          Refresh saved progress
        </Button>
      ) : null}
      {busy ? <p role="status">Checking account switch…</p> : null}
      {error ? (
        <p ref={errorElement} role="alert">
          {error}
        </p>
      ) : null}
      <style>{`
        .lifeops-handoff{display:grid;gap:14px}
        .lifeops-handoff p{margin:0;font-size:13px;line-height:1.55;color:var(--muted)}
        .lifeops-handoff h3{font-size:17px;font-weight:600}
        .lifeops-handoff fieldset,.lifeops-handoff-review{display:grid;gap:14px;min-width:0}
        .lifeops-handoff>button,.lifeops-handoff-review>button,.lifeops-handoff fieldset>button{justify-self:start;max-width:100%;white-space:normal;text-align:left}
        .lifeops-handoff pre{max-width:100%;overflow-wrap:anywhere;font-size:12px}
        .lifeops-handoff [role=alert]{color:var(--status-danger)}
      `}</style>
    </section>
  );
}
