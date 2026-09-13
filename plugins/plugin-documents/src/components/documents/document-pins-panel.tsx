/** Reviews independent chat and agent pins against the current server revision without changing readers. */
import { client, isApiError } from "@elizaos/ui/api";
import { Button, Checkbox } from "@elizaos/ui/components";
import { useActiveAgentAuthority } from "@elizaos/ui/hooks/useActiveAgentAuthority";
import { useEffect, useState } from "react";

type Pins = Awaited<ReturnType<typeof client.getDocumentPins>>;
type Chat = { id: string; title: string };
type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; pins: Pins; chats: Chat[] };

function pinError(cause: unknown): string {
  if (isApiError(cause)) {
    if (cause.status === 403 || cause.status === 401)
      return "Only the owner can manage document pins.";
    if (cause.status === 409)
      return "This document changed since your review. Reload and review its current pins.";
  }
  return "Pins could not be confirmed. Reload before trying again.";
}

function PinEditor({ documentId }: { documentId: string }) {
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [agent, setAgent] = useState(false);
  const [rooms, setRooms] = useState<string[]>([]);
  const [review, setReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    void reload;
    let cancelled = false;
    setState({ phase: "loading" });
    setReview(false);
    const load = async () => {
      const [pins, { conversations }] = await Promise.all([
        client.getDocumentPins(documentId),
        client.listConversations(),
      ]);
      const chats = new Map<string, Chat>();
      for (const conversation of conversations)
        chats.set(conversation.roomId, {
          id: conversation.roomId,
          title: conversation.title,
        });
      for (const id of pins.targets.roomIds)
        if (!chats.has(id))
          chats.set(id, { id, title: "Previously pinned chat" });
      if (cancelled) return;
      setAgent(pins.targets.agent);
      setRooms(pins.targets.roomIds);
      setState({ phase: "ready", pins, chats: [...chats.values()] });
    };
    void load().catch((cause) => {
      // error-policy:J4 Unavailable pins or chat inventory remain visibly unavailable.
      if (!cancelled) setState({ phase: "error", message: pinError(cause) });
    });
    return () => {
      cancelled = true;
    };
  }, [documentId, reload]);

  const save = async () => {
    if (state.phase !== "ready" || !review || saving) return;
    setSaving(true);
    setSaved(false);
    try {
      await client.updateDocumentPins(documentId, {
        agent,
        roomIds: rooms,
        expectedPinRevision: state.pins.pinRevision,
      });
      setState({ phase: "loading" });
      setReview(false);
      setSaved(true);
      setReload((value) => value + 1);
    } catch (cause) {
      // error-policy:J4 Conflicts and uncertain writes require server readback before another review.
      setState({ phase: "error", message: pinError(cause) });
    } finally {
      setSaving(false);
    }
  };
  if (state.phase === "loading")
    return <p role="status">Loading document pins…</p>;
  if (state.phase === "error")
    return (
      <div className="space-y-3">
        <p role="alert">{state.message}</p>
        <Button
          variant="outline"
          onClick={() => setReload((value) => value + 1)}
        >
          Reload pins
        </Button>
      </div>
    );
  const dirty =
    agent !== state.pins.targets.agent ||
    rooms.length !== state.pins.targets.roomIds.length ||
    rooms.some((id) => !state.pins.targets.roomIds.includes(id));
  return (
    <div className="space-y-4">
      {saved && (
        <p role="status">Pins saved. Current settings are shown below.</p>
      )}
      <p>
        Pinning makes this document available as reference material. It does not
        change who can read it. In a chat, everyone must have read access before
        its pinned content is included.
      </p>
      {review ? (
        <>
          <h3 className="font-semibold">Review pin destinations</h3>
          <p>
            {agent
              ? "Pinned to this agent across its chats."
              : "Not pinned to the agent."}
          </p>
          {rooms.length === 0 ? (
            <p>No individual chat pins.</p>
          ) : (
            <ul className="space-y-2">
              {rooms.map((id) => (
                <li key={id} className="break-words">
                  {state.chats.find((chat) => chat.id === id)?.title}
                  <span className="block text-sm text-muted-foreground">
                    {id}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? "Saving…" : "Save reviewed pins"}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setReview(false)}
            >
              Back to pin selection
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <Checkbox
              id={`agent-pin-${documentId}`}
              checked={agent}
              onCheckedChange={(value) => setAgent(value === true)}
            />
            <label htmlFor={`agent-pin-${documentId}`}>Pin to this agent</label>
          </div>
          <p className="text-sm text-muted-foreground">
            Individual chat pins are kept separately, so they remain if you
            remove the agent pin.
          </p>
          {state.chats.length === 0 ? (
            <p>No chats are available to select.</p>
          ) : (
            <fieldset className="space-y-3">
              <legend className="mb-2 font-semibold">
                Pin to specific chats
              </legend>
              {state.chats.map((chat) => (
                <div key={chat.id} className="flex items-start gap-3">
                  <Checkbox
                    id={`chat-pin-${documentId}-${chat.id}`}
                    checked={rooms.includes(chat.id)}
                    onCheckedChange={(checked) =>
                      setRooms((current) =>
                        checked === true
                          ? [...current, chat.id]
                          : current.filter((id) => id !== chat.id),
                      )
                    }
                  />
                  <label
                    htmlFor={`chat-pin-${documentId}-${chat.id}`}
                    className="min-w-0 break-words"
                  >
                    {chat.title}
                    <span className="block text-sm text-muted-foreground">
                      {chat.id}
                    </span>
                  </label>
                </div>
              ))}
            </fieldset>
          )}
          <Button disabled={!dirty} onClick={() => setReview(true)}>
            Review pins
          </Button>
        </>
      )}
    </div>
  );
}

export function DocumentPinsPanel({ documentId }: { documentId: string }) {
  const authority = useActiveAgentAuthority();
  const [open, setOpen] = useState(false);
  return (
    <section aria-label="Document pins" className="space-y-4">
      <Button
        variant="outline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Close document pins" : "Manage document pins"}
      </Button>
      {open && (
        <PinEditor key={`${authority}:${documentId}`} documentId={documentId} />
      )}
    </section>
  );
}
