/** Lets the owner review a contact/address pair before recording it as a monthly-email recipient; confirmation never sends a message. */
import { Button, Checkbox, Input, NativeSelect } from "@elizaos/ui";
import { type FormEvent, useState } from "react";
import type {
  FamilyOperationsAdapter,
  FamilyRecipientContact,
} from "./types.js";

export function RecipientSetup({
  adapter,
  onConfirmed,
}: {
  adapter: Pick<
    FamilyOperationsAdapter,
    "listRecipientContacts" | "confirmEmailRecipient"
  >;
  onConfirmed: (
    recipient: FamilyRecipientContact & { address: string },
  ) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<FamilyRecipientContact[] | null>(
    null,
  );
  const [entityId, setEntityId] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setOpen(true);
    setBusy(true);
    setError(null);
    try {
      setContacts(await adapter.listRecipientContacts());
    } catch (cause) {
      // error-policy:J4 failed contact loading remains distinct from an empty list.
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load contacts. Retry to continue.",
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reviewed || busy || contacts === null) return;
    setBusy(true);
    setError(null);
    try {
      const recipient = await adapter.confirmEmailRecipient({
        entityId: entityId || null,
        name: name.trim(),
        address: address.trim(),
      });
      await onConfirmed(recipient);
      setOpen(false);
      setReviewed(false);
    } catch (cause) {
      // error-policy:J4 preserve the reviewed input so a failed request can be corrected or retried.
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not confirm the recipient. Review the details and retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <Button variant="outline" onClick={() => void load()}>
        Add or confirm email recipient
      </Button>
    );
  return (
    <section
      aria-label="Email recipient setup"
      style={{ display: "grid", gap: 12 }}
    >
      <h3>Confirm an email recipient</h3>
      <p>
        This records your confirmation of the delivery address. It sends no
        email and grants no chat or document access.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {contacts === null ? (
        <div>
          <p role="status">
            {busy ? "Loading contacts…" : "Contacts could not be loaded."}
          </p>
          <Button disabled={busy} onClick={() => void load()}>
            Retry contacts
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setReviewed(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => void submit(event)}
          style={{ display: "grid", gap: 12 }}
        >
          <label htmlFor="recipient-setup-person">Person</label>
          <NativeSelect
            id="recipient-setup-person"
            value={entityId}
            disabled={busy}
            onChange={(event) => {
              const id = event.target.value;
              const person = contacts.find(
                (candidate) => candidate.entityId === id,
              );
              if (id && !person) {
                setError(
                  "That contact is no longer available. Reload the contacts.",
                );
                setReviewed(false);
                return;
              }
              setEntityId(id);
              setName(person ? person.name : "");
              setReviewed(false);
            }}
          >
            <option value="">Create a new contact</option>
            {contacts.map((person) => (
              <option key={person.entityId} value={person.entityId}>
                {person.name}
              </option>
            ))}
          </NativeSelect>
          <label htmlFor="recipient-setup-name">Name</label>
          <Input
            id="recipient-setup-name"
            required
            value={name}
            disabled={busy || Boolean(entityId)}
            onChange={(event) => {
              setName(event.target.value);
              setReviewed(false);
            }}
          />
          <label htmlFor="recipient-setup-address">Email address</label>
          <Input
            id="recipient-setup-address"
            type="email"
            required
            value={address}
            disabled={busy}
            onChange={(event) => {
              setAddress(event.target.value);
              setReviewed(false);
            }}
          />
          <label htmlFor="recipient-setup-reviewed">
            <Checkbox
              id="recipient-setup-reviewed"
              checked={reviewed}
              disabled={busy || !name.trim() || !address.trim()}
              onCheckedChange={(checked) => setReviewed(checked === true)}
            />{" "}
            I have checked that {address.trim() || "this address"} belongs to{" "}
            {name.trim() || "this person"}.
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button
              type="submit"
              disabled={busy || !reviewed || !name.trim() || !address.trim()}
            >
              {busy ? "Confirming…" : "Confirm recipient"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setReviewed(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
