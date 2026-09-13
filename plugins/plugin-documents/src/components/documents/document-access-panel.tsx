/** Reviews explicit document readers against the server's authorization revision; grants never change a person's role. */
import { client, isApiError } from "@elizaos/ui/api";
import { Button, Checkbox } from "@elizaos/ui/components";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
import { useEffect, useState } from "react";

type Access = Awaited<ReturnType<typeof client.getDocumentAccess>>;
type Reader = { id: string; name: string };
type State =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; access: Access; readers: Reader[] };

function accessError(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 403 || error.status === 401)
      return "You cannot manage sharing for this document.";
    if (error.status === 409)
      return "Access changed since your review. Reload and review the current readers before saving.";
  }
  return "Sharing could not be confirmed. Reload the current readers before trying again.";
}

function ReaderEditor({ documentId }: { documentId: string }) {
  const [state, setState] = useState<State>({ phase: "loading" });
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void reload; // Reload fetches the current server revision after review or recovery.
    let cancelled = false;
    setState({ phase: "loading" });
    setReviewing(false);
    const load = async () => {
      const [access, { people }] = await Promise.all([
        client.getDocumentAccess(documentId),
        client.getRelationshipsPeople(),
      ]);
      const readers = new Map<string, Reader>();
      for (const person of people) {
        // A group is not an identity grant. Do not expand aliases into recipients.
        readers.set(person.primaryEntityId, {
          id: person.primaryEntityId,
          name: person.displayName,
        });
      }
      for (const id of access.directGrantEntityIds) {
        if (!readers.has(id)) readers.set(id, { id, name: "Existing reader" });
      }
      if (cancelled) return;
      setSelected(access.directGrantEntityIds);
      setState({ phase: "ready", access, readers: [...readers.values()] });
    };
    void load().catch((error) => {
      // error-policy:J4 Failed inventory or permission reads show an unavailable state.
      if (!cancelled) setState({ phase: "error", message: accessError(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [documentId, reload]);

  const save = async () => {
    if (state.phase !== "ready" || saving) return;
    setSaving(true);
    setSaved(false);
    try {
      await client.updateDocumentAccess(documentId, {
        directGrantEntityIds: selected,
        expectedAccessRevision: state.access.accessRevision,
      });
      setState({ phase: "loading" });
      setReviewing(false);
      setSaved(true);
      setReload((value) => value + 1);
    } catch (error) {
      // error-policy:J4 A conflict or uncertain write requires fresh server readback before another edit.
      setState({ phase: "error", message: accessError(error) });
    } finally {
      setSaving(false);
    }
  };

  if (state.phase === "loading")
    return <p role="status">Loading document readers…</p>;
  if (state.phase === "error")
    return (
      <div className="space-y-3">
        <p role="alert">{state.message}</p>
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          Reload readers
        </Button>
      </div>
    );
  const dirty =
    selected.length !== state.access.directGrantEntityIds.length ||
    selected.some((id) => !state.access.directGrantEntityIds.includes(id));
  return (
    <div className="space-y-4">
      {saved && (
        <p role="status">Sharing saved. Current readers are shown below.</p>
      )}
      <p>
        These people can read this document in addition to its existing
        audience. Removing a reader does not remove access they have through the
        chat or their role.
      </p>
      <p>
        Each selection applies to the identity shown. Linked accounts are not
        automatically included.
      </p>
      {reviewing ? (
        <>
          <h3 className="font-semibold">Review additional readers</h3>
          {selected.length === 0 ? (
            <p>No additional readers.</p>
          ) : (
            <ul className="space-y-2">
              {selected.map((id) => (
                <li key={id} className="break-words">
                  {state.readers.find((reader) => reader.id === id)?.name}
                  <span className="block text-sm text-muted-foreground">
                    {id}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save reviewed readers"}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setReviewing(false)}
            >
              Back to selection
            </Button>
          </div>
        </>
      ) : (
        <>
          {state.readers.length === 0 ? (
            <p>No people are available to select.</p>
          ) : (
            <div className="space-y-2">
              {state.readers.map((reader) => (
                <label
                  key={reader.id}
                  htmlFor={`document-reader-${reader.id}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3"
                >
                  <Checkbox
                    id={`document-reader-${reader.id}`}
                    checked={selected.includes(reader.id)}
                    onCheckedChange={(checked) => {
                      setSaved(false);
                      setSelected((ids) =>
                        checked === true
                          ? [...ids, reader.id]
                          : ids.filter((id) => id !== reader.id),
                      );
                    }}
                  />
                  <span className="min-w-0 break-words">
                    {reader.name}
                    <span className="block break-all text-sm text-muted-foreground">
                      {reader.id}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <Button disabled={!dirty} onClick={() => setReviewing(true)}>
            Review reader changes
          </Button>
        </>
      )}
    </div>
  );
}

export function DocumentAccessPanel({ documentId }: { documentId: string }) {
  const authority = useActiveAgentAuthority();
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Document sharing" className="space-y-4">
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close document sharing" : "Manage document readers"}
      </Button>
      {open && (
        <ReaderEditor
          key={`${authority}:${documentId}`}
          documentId={documentId}
        />
      )}
    </section>
  );
}
