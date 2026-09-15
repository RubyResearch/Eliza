/**
 * NOTES — the chat door onto the durable notes store.
 *
 * The notes view already exposes create/read/update/delete as view
 * capabilities, but those resolve only through PAGE_DELEGATE against an OPEN
 * view, so an agent without a UI client (a Discord/chat-only deployment) had
 * no way to reach notes at all. "make a note" then fell through to whatever
 * else matched — DATABASE hand-writing SQL, or the room-gated owner todo
 * surface — and the note was silently lost.
 *
 * This action wraps the SAME `NotesService` the view uses, so a note written
 * in chat and a note written in the app are one record in one store. It adds
 * no storage, no second source of truth, and no new persistence path.
 */
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  normalizeEffectReceipt,
  type State,
  stringToUuid,
} from "@elizaos/core";

import { getNotesService } from "./service.js";
import { parseNoteContent } from "./validation.js";

const NOTES_OPS = ["create", "list", "get", "update", "delete"] as const;
type NotesOp = (typeof NOTES_OPS)[number];

function readParams(options?: HandlerOptions): Record<string, unknown> {
  const raw = options?.parameters;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * `undefined` means the caller named no operation at all — a bare NOTES call,
 * which reads. An unrecognised name is NOT that: it is a caller asking for
 * something specific that this action cannot do, and it must surface as an
 * explicit invalid result. Collapsing the two into one `undefined` made
 * `action: "remove"` silently LIST the notes instead of deleting one, directly
 * contradicting this action's own routing contract ("Deleting and updating are
 * NOT reads: never answer a removal or change request with action=list").
 */
type NotesOpParse =
  | { recognized: true; op: NotesOp }
  | { recognized: false; requested: string };

function readOp(params: Record<string, unknown>): NotesOpParse | undefined {
  const raw = readString(params.action ?? params.subaction ?? params.op);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  return (NOTES_OPS as readonly string[]).includes(normalized)
    ? { recognized: true, op: normalized as NotesOp }
    : { recognized: false, requested: raw };
}

function failure(
  text: string,
  code: string,
  missingParameter?: "content" | "replacementContent",
): ActionResult {
  return {
    success: false,
    text,
    error: code,
    data: {
      actionName: "NOTES",
      error: code,
      ...(missingParameter
        ? {
            parameterErrors: [
              `Missing required argument '${missingParameter}'`,
            ],
          }
        : {}),
    },
  };
}

/**
 * Notes return structured facts, not prose that could be mistaken for the
 * model-authored closing reply. Durable receipts remain available if reply
 * generation fails.
 */
function committed(data: Record<string, unknown>): ActionResult {
  // Bind the mutation to an applied effect receipt so the reply-egress
  // grounding contract (completed_side_effect claims require a committed
  // receipt from this turn) can verify the claim instead of failing closed to
  // the "couldn't verify" fallback on a real write. The store's *WithCommit
  // family persists durably before returning; the note row id is the commit
  // identifier ("durable transaction, row, or provider receipt identifier").
  const op = typeof data.op === "string" ? data.op : "commit";
  const noteId = typeof data.noteId === "string" ? data.noteId : undefined;
  const observedAt = new Date().toISOString();
  const effectReceipts = noteId
    ? [
        normalizeEffectReceipt({
          receiptId: stringToUuid(`notes:${op}:${noteId}:${observedAt}`),
          operation: `notes.note.${op}`,
          resource: { kind: "notes.note", id: noteId },
          artifacts: [],
          idempotency: { key: null, replayed: false },
          observedAt,
          outcome: "applied",
          commit: { kind: "durable", id: noteId, committedAt: observedAt },
        }),
      ]
    : undefined;
  return {
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    ...(effectReceipts
      ? {
          effectReceipts,
        }
      : {}),
    data: { actionName: "NOTES", ...data },
  };
}

export const notesAction: Action = {
  name: "NOTES",
  tags: [
    "resource:tracked-work",
    "capability:read",
    "capability:write",
    "capability:update",
    "capability:delete",
  ],
  contexts: ["notes", "general"],
  similes: [
    "NOTE",
    "TAKE_NOTE",
    "MAKE_NOTE",
    "SAVE_NOTE",
    "WRITE_NOTE",
    "JOT_DOWN",
    "WRITE_DOWN",
    "READ_NOTES",
    "SEARCH_NOTES",
    "NOTES_SEARCH",
    "NOTES_LIST",
    "NOTES_READ",
    "NOTES_CREATE",
    "NOTES_UPDATE",
    "NOTES_DELETE",
    "FIND_NOTE",
    "LOOKUP_NOTE",
    "DELETE_NOTE",
    "UPDATE_NOTE",
  ],
  description:
    "Durable notes the user can write and read back. action=create writes a note from one content field; action=get reads one exact noteId; action=list reads/searches note text; action=update applies a literal textEdit or replaces the complete note; action=delete removes one found by its text. The first line is the note's label and later lines are its body. Prefer textEdit for an exact substitution: the service preserves every other character without needing the model to read and rewrite the note. NOTES changes data, not the visible view: an explicit request to also open Notes needs its own navigation action (prefer VIEWS_SHOW when available).",
  descriptionCompressed:
    "notes: create, list/search, update by exact textEdit or complete replacementContent, delete; opening the Notes view separately uses VIEWS_SHOW when available, otherwise VIEWS",
  routingHint:
    "writing something down for later with no time attached ('make a note', 'note to self', 'write down that …', 'jot this down', 'remember that …') -> NOTES_CREATE with content. ANY read over the user's notes -> NOTES_LIST. For an exact note ID use NOTES_GET with noteId and omit content; content searches titles/bodies, not IDs. For a specific topic ('search my notes for X', 'find my note about X', 'do i have a note on X', 'what did my note say about X'), pass content=X so unrelated personal notes are not exposed; omit content when the owner asks for all notes, counts, or a recency comparison without a topic. Recency is determined from returned createdAt/updatedAt fields, never by searching for words such as 'latest' or 'most recently updated'. A notes search is NEVER a document search: never route it to SEARCH_DOCUMENTS, DOCUMENT, FILES or DATABASE, which do not index notes and will answer 'nothing found' for a note that exists. REMOVING one ('delete the note about X', 'forget the note about X', 'remove my note on X') -> NOTES_DELETE with content=the identifying text. CHANGING one -> NOTES_UPDATE with content identifying the existing note. For a literal substitution use textEdit with field, oldText and newText; no full-note read or rewrite is needed. For a general rewrite use replacementContent with the complete updated note, preserving the existing first-line label and all unedited lines. Deleting and updating are NOT reads: never answer a removal or change request with NOTES_LIST. RECALLING A FACT the user once asked you to note ('who is alex again', 'what did i say about X') is answered from the SAVED_NOTES context block, which is the same store; when that block reports notes it did not show, call NOTES_LIST before answering. A memory search that returns nothing is not evidence a note does not exist — MEMORY does not index notes. A note is NOT a todo and NOT a calendar event: anything with a date or time block -> CALENDAR, anything that should ping the user at a time -> TRIGGER. Never hand-write SQL through DATABASE to store or read a note.",
  // Notes are stored per agent rather than per sender. Only the owner may see
  // or mutate that personal store, including through direct tool execution.
  roleGate: { minRole: "OWNER" },
  validate: async () => true,
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: HandlerOptions,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = readParams(options);
    const parsed = readOp(params);
    if (parsed && !parsed.recognized) {
      // error-policy:J3 an unrecognised operation is untrusted planner input;
      // it becomes an explicit invalid result, never a fake-valid default.
      return failure(
        `I can create, get, list, update, or delete a note — I don't have a "${parsed.requested}" one.`,
        "NOTES_UNKNOWN_OP",
      );
    }
    const op: NotesOp = parsed?.op ?? "list";
    const service = getNotesService(runtime);

    if (op === "list" || op === "get") {
      const noteId = readString(params.noteId);
      const topic =
        readString(params.content) ??
        readString(params.query) ??
        readString(params.text);
      if ((op === "get" || params.noteId !== undefined) && !noteId) {
        return failure("Supply a nonempty exact note ID.", "NOTES_INVALID_ID");
      }
      if (noteId && topic) {
        return failure(
          "Use noteId for an exact ID lookup or content for a text search, not both.",
          "NOTES_CONFLICTING_LOOKUP",
        );
      }
      const notes = service.listNotes();
      const normalizedTopic = topic?.toLocaleLowerCase();
      const matches = noteId
        ? notes.filter((note) => note.id === noteId)
        : normalizedTopic
          ? notes.filter((note) =>
              `${note.title}\n${note.body}`
                .toLocaleLowerCase()
                .includes(normalizedTopic),
            )
          : notes;
      return committed({
        op,
        readOnlyOperation: true,
        count: matches.length,
        total: notes.length,
        filterApplied: noteId !== undefined || topic !== undefined,
        lookupMode: noteId ? "exact_id" : topic ? "text" : "all",
        ...(noteId ? { requestedNoteId: noteId } : {}),
        ...(topic ? { topic } : {}),
        notes: matches,
      });
    }

    // The service still receives one user-authored content value. Providers
    // may preserve an explicitly requested title and body as separate tool
    // arguments, so normalize that losslessly before deriving the label.
    // `text`/`note`/`title` remain planner aliases for `content`.
    const content =
      readString(params.content) ??
      readString(params.text) ??
      readString(params.note) ??
      readString(params.title);
    if (!content) {
      return failure(
        "Tell me what the note should say.",
        "NOTES_MISSING_TEXT",
        "content",
      );
    }

    if (op === "create") {
      const body = readString(params.body);
      const separateBody = body !== undefined && !content.includes("\n");
      const noteContent = parseNoteContent(
        separateBody ? `${content}\n${body}` : content,
      );
      if (body && !separateBody && noteContent.body !== body) {
        // Two different complete bodies are ambiguous; reject before writing
        // rather than appending them or silently selecting one.
        return failure(
          "The create arguments contain different note bodies. Pass the complete note in content only, or a title in content and its body in body.",
          "NOTES_CONFLICTING_BODY",
        );
      }
      const created = await service.createNoteWithCommit(noteContent);
      const note = created.value;
      return committed({
        op,
        noteId: note.id,
        note,
        replayed: created.replayed,
      });
    }

    if (op === "delete") {
      const removed = await service.deleteNoteByLookupWithCommit(
        "query",
        content,
      );
      return committed({
        op,
        noteId: removed.value.id,
        note: removed.value,
        removedCount: removed.removedCount,
      });
    }

    const replacement =
      readString(params.replacementContent) ??
      readString(params.body) ??
      readString(params.newText);
    const hasTextEdit =
      params.textEdit !== undefined && params.textEdit !== null;
    if (hasTextEdit && replacement) {
      return failure(
        "Pass either textEdit or replacementContent, not both. Nothing changed.",
        "NOTES_CONFLICTING_PATCH",
      );
    }
    if (!hasTextEdit && !replacement) {
      return failure(
        "Pass textEdit for an exact substitution, or replacementContent for the complete updated note.",
        "NOTES_MISSING_PATCH",
        "replacementContent",
      );
    }
    const updated = await service.updateNoteByLookupWithCommit(
      "query",
      content,
      hasTextEdit
        ? { textEdit: params.textEdit }
        : parseNoteContent(replacement),
    );
    return committed({
      op,
      noteId: updated.value.id,
      note: updated.value,
      consolidatedCount: updated.consolidatedCount,
    });
  },
  parameters: [
    {
      name: "action",
      description: `Which notes operation to run: ${NOTES_OPS.join(", ")}.`,
      required: true,
      schema: { type: "string", enum: [...NOTES_OPS] },
    },
    {
      name: "content",
      description:
        "For list, pass a title or topic to search note text; use noteId instead for an exact ID. Omit only for all notes, unfiltered counts, or recency comparisons without a title/topic; compare returned createdAt/updatedAt timestamps, never search for 'latest' or 'most recently updated'. For update/delete, identify the EXISTING note, not its replacement. For create, supply the exact title, newline, and body.",
      required: false,
      subactions: ["create", "list", "update", "delete"],
      requiredForSubactions: ["create", "update", "delete"],
      // Strict providers may serialize an omitted optional string as "". The
      // empty string is never valid note content (minLength is 1), so normalize
      // that provider sentinel back to omission before schema validation. This
      // lets an unfiltered list/count reach the authoritative NotesService
      // instead of failing and inviting a model-authored estimate.
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "noteId",
      description:
        "Read one note by its exact, case-sensitive ID. Required for get; optional instead of content for list. A text search cannot establish whether an ID exists.",
      subactions: ["list", "get"],
      required: false,
      requiredForSubactions: ["get"],
      modelOmissionSentinels: [""],
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "body",
      description:
        "For create only: optional body when content contains only the title. Prefer the complete note in content: title on the first line and body on subsequent lines, omitting body. Alternatively, pass only the exact title in content and the requested body here. Copy an explicit user title byte-for-byte, including spaces, capitalization, punctuation, and alphanumeric codes, even when the body is recalled from earlier conversation or generated. Do not reformat the title or substitute the spelling or spacing of a similar prior note. Preserve an explicitly supplied body exactly. Put a newline between title and body; do not join them with a dash into one title. For update use replacementContent, not body.",
      subactions: ["create"],
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replacementContent",
      description:
        "For full rewrites only: the COMPLETE updated note, including its first-line label and every unedited line. Read the note first if its full content is unknown. For an exact substitution use textEdit instead; omit replacementContent. Supply exactly one of these two update forms.",
      subactions: ["update"],
      required: false,
      // Old callers used body/newText for the complete replacement. Keep
      // their wire contract while exposing an unambiguous name to planners.
      aliases: ["body", "newText"],
      schema: { type: "string" },
    },
    {
      name: "textEdit",
      description:
        "For an exact substitution, prefer this instead of reading and rewriting the full note. content identifies the existing note; field selects title or body; oldText and newText are the exact user-requested strings, with no grammar correction or added context. The service replaces one unique literal match atomically and preserves every other character and field. A missing or repeated match fails without changes; read the note and use a unique surrounding phrase if needed. Omit replacementContent.",
      subactions: ["update"],
      required: false,
      schema: {
        type: "object",
        properties: {
          field: { type: "string", enum: ["title", "body"] },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
        },
        required: ["field", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  ],
  examples: [],
};
