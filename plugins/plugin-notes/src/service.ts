/**
 * Server-owned Notes domain service. It is the only layer allowed to mutate
 * the durable per-agent document; HTTP routes and view capabilities call this
 * API so validation, identity, timestamps, and restart behavior remain
 * identical across every entry point.
 */

import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { NotesStore } from "./store.js";
import type {
  NotesSnapshot,
  NotesStoreStatus,
  StickyNote,
  UpdateNoteInput,
} from "./types.js";
import {
  parseCreateNoteInput,
  parseEntityId,
  parseUpdateNoteInput,
} from "./validation.js";

export const NOTES_SERVICE_TYPE = "notes";
export const NOTES_STATE_UPDATED_EVENT = "notes:state-updated";

function isBroadcastService(
  value: unknown,
): value is { broadcastWs(data: object): void } {
  return (
    value !== null &&
    typeof value === "object" &&
    "broadcastWs" in value &&
    typeof value.broadcastWs === "function"
  );
}

function notFound(id: string): ElizaError {
  return new ElizaError(`Note "${id}" was not found.`, {
    code: "NOTES_NOT_FOUND",
    context: { kind: "note", id },
    severity: "ephemeral",
  });
}

type NoteLookupSelector = "title" | "query";

function normalizedLookup(value: string): string {
  return value
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .normalize("NFC")
    .replace(/\s+/gu, " ");
}

function titleAppearsAsNamedPhrase(text: string, title: string): boolean {
  const normalizedText = normalizedLookup(text);
  const normalizedTitle = normalizedLookup(title);
  if (!normalizedText || !normalizedTitle) return false;
  const escapedTitle = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}\\p{M}])${escapedTitle}(?=$|[^\\p{L}\\p{N}\\p{M}])`,
    "u",
  ).test(normalizedText);
}

function queryMatches(
  notes: readonly StickyNote[],
  value: string,
): Array<{ index: number; note: StickyNote }> {
  const target = normalizedLookup(value);
  if (!target) return [];
  const indexed = notes.map((note, index) => ({ index, note }));
  const exactTitle = indexed.filter(
    ({ note }) => normalizedLookup(note.title) === target,
  );
  if (exactTitle.length > 0) return exactTitle;
  const contained = indexed.filter(({ note }) =>
    normalizedLookup(`${note.title} ${note.body} ${note.color}`).includes(
      target,
    ),
  );
  if (contained.length > 0) return contained;
  return indexed.filter(({ note }) =>
    titleAppearsAsNamedPhrase(value, note.title),
  );
}

function lookupError(
  code:
    | "NOTES_NOT_FOUND"
    | "NOTES_AMBIGUOUS_NOTE"
    | "NOTES_DELETE_NAME_MISMATCH",
  selector: NoteLookupSelector,
  value: string,
  candidates: StickyNote[],
): ElizaError {
  const target = value.trim();
  return new ElizaError(
    code === "NOTES_NOT_FOUND"
      ? `No sticky note matches "${target}".`
      : code === "NOTES_DELETE_NAME_MISMATCH"
        ? `The closest note is "${candidates[0]?.title ?? target}" — that isn't what you named, so nothing was deleted. Delete it?`
        : `"${target}" matches multiple sticky notes: ${candidates
            .map((note) => `${note.title} (${note.color})`)
            .join(", ")}.`,
    {
      code,
      context: {
        kind: "note",
        selector,
        target,
        candidateIds: candidates.map((note) => note.id),
      },
      severity: "ephemeral",
    },
  );
}

/** Identity key for copies with exactly the same user-visible content. */
function noteContentKey(note: StickyNote): string {
  return `${note.title}\0${note.body}\0${note.color}`;
}

function distinctNotes(notes: readonly StickyNote[]): StickyNote[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = noteContentKey(note);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveNoteIndex(
  notes: StickyNote[],
  selector: NoteLookupSelector,
  value: string,
): number {
  const target = normalizedLookup(value);
  if (!target) {
    throw lookupError("NOTES_NOT_FOUND", selector, value, []);
  }
  const exact = notes
    .map((note, index) => ({ index, note }))
    .filter(({ note }) => normalizedLookup(note.title) === target);
  const candidates = selector === "title" ? exact : queryMatches(notes, value);
  if (candidates.length === 0) {
    throw lookupError("NOTES_NOT_FOUND", selector, value, []);
  }
  // Ambiguity exists only between notes a user could tell apart. Multiple
  // byte-identical copies (the duplicate-create case) are one logical note:
  // asking "which one?" has no answerable form, and refusing made identical
  // duplicates permanently unaddressable through chat. Differing matches keep
  // the explicit ambiguity error.
  if (
    candidates.length > 1 &&
    new Set(candidates.map(({ note }) => noteContentKey(note))).size > 1
  ) {
    throw lookupError(
      "NOTES_AMBIGUOUS_NOTE",
      selector,
      value,
      candidates.map(({ note }) => note),
    );
  }
  const candidate = candidates[0];
  if (!candidate) {
    throw new ElizaError("Resolved sticky note was missing.", {
      code: "NOTES_NOTE_RESOLUTION_FAILED",
      severity: "fatal",
    });
  }
  return candidate.index;
}

function applyNotePatch(
  existing: StickyNote,
  patch: UpdateNoteInput,
  updatedAt: string,
): StickyNote {
  const updated: StickyNote = { ...existing, updatedAt };
  if (patch.textEdit) {
    const { field, oldText, newText } = patch.textEdit;
    const original = existing[field];
    const first = original.indexOf(oldText);
    const ambiguous = first >= 0 && original.indexOf(oldText, first + 1) >= 0;
    if (first < 0 || ambiguous) {
      throw new ElizaError(
        first < 0
          ? "The exact old text is absent from the current note; read it before choosing another edit. Nothing changed."
          : "The old text matches more than once; include enough surrounding text to identify one occurrence. Nothing changed.",
        {
          code:
            first < 0
              ? "NOTES_EDIT_TEXT_NOT_FOUND"
              : "NOTES_EDIT_TEXT_AMBIGUOUS",
          context: { noteId: existing.id, field },
          severity: "ephemeral",
        },
      );
    }
    // A replacement callback keeps $&, $1 and similar text literal. The
    // match is checked under the same store barrier that commits the update.
    const replacement = original.replace(oldText, () => newText);
    const validated = parseUpdateNoteInput({ [field]: replacement });
    if (validated[field] !== replacement) {
      throw new ElizaError(
        "The exact edit would require whitespace normalization; nothing changed.",
        {
          code: "NOTES_EDIT_NORMALIZATION_REQUIRED",
          context: { noteId: existing.id, field },
          severity: "ephemeral",
        },
      );
    }
    updated[field] = replacement;
    return updated;
  }
  if (patch.title !== undefined) updated.title = patch.title;
  if (patch.body !== undefined) updated.body = patch.body;
  if (patch.color !== undefined) updated.color = patch.color;
  return updated;
}

export class NotesService extends Service {
  static override readonly serviceType = NOTES_SERVICE_TYPE;

  override capabilityDescription =
    "Durable managed Cloud Notes CRUD with view switching.";

  readonly store: NotesStore;

  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly eventRuntime: IAgentRuntime | undefined;

  constructor(
    runtime?: IAgentRuntime,
    options: {
      store?: NotesStore;
      stateDir?: string;
      now?: () => Date;
      createId?: () => string;
    } = {},
  ) {
    super(runtime);
    this.eventRuntime = runtime;
    this.store = options.store
      ? options.store
      : new NotesStore({
          stateDir: options.stateDir,
          agentId: runtime ? String(runtime.agentId) : undefined,
        });
    this.now = options.now ? options.now : () => new Date();
    this.createId = options.createId
      ? options.createId
      : () => `note-${randomUUID()}`;
  }

  static override async start(runtime: IAgentRuntime): Promise<NotesService> {
    const service = new NotesService(runtime);
    await service.initialize();
    logger.info(
      {
        src: "plugin-notes",
        filePath: service.store.filePath,
      },
      "[NotesService] Ready",
    );
    return service;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  override async stop(): Promise<void> {
    await this.store.stop();
    logger.info({ src: "plugin-notes" }, "[NotesService] Stopped");
  }

  status(): NotesStoreStatus {
    return this.store.getStatus();
  }

  snapshot(): NotesSnapshot {
    const snapshot = this.store.snapshot();
    return { ...snapshot, notes: distinctNotes(snapshot.notes) };
  }

  listNotes(): StickyNote[] {
    return this.snapshot().notes;
  }

  getNote(idValue: unknown): StickyNote {
    const id = parseEntityId(idValue);
    const note = this.snapshot().notes.find((candidate) => candidate.id === id);
    if (!note) throw notFound(id);
    return note;
  }

  getNoteByLookup(selector: NoteLookupSelector, value: string): StickyNote {
    const notes = this.snapshot().notes;
    const note = notes[resolveNoteIndex(notes, selector, value)];
    if (!note) {
      throw new ElizaError("Resolved sticky note was missing.", {
        code: "NOTES_NOTE_RESOLUTION_FAILED",
        severity: "fatal",
      });
    }
    return note;
  }

  findNotesByQuery(value: string): StickyNote[] {
    const notes = this.snapshot().notes;
    return queryMatches(notes, value).map(({ note }) => note);
  }

  async createNoteWithCommit(inputValue: unknown): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    replayed: boolean;
  }> {
    const input = parseCreateNoteInput(inputValue);
    const now = this.now().toISOString();
    const id = parseEntityId(this.createId());
    const transaction = await this.store.transact((draft) => {
      const requestedKey = noteContentKey({
        id,
        title: input.title,
        body: input.body,
        color: input.color,
        createdAt: now,
        updatedAt: now,
      });
      const existing = draft.notes.find(
        (note) => noteContentKey(note) === requestedKey,
      );
      if (existing) return { note: existing, replayed: true };
      if (draft.notes.some((note) => note.id === id)) {
        throw new ElizaError(`Notes generated duplicate note id "${id}".`, {
          code: "NOTES_DUPLICATE_ID",
          context: { kind: "note", id },
          severity: "fatal",
        });
      }
      const note: StickyNote = {
        id,
        title: input.title,
        body: input.body,
        color: input.color,
        createdAt: now,
        updatedAt: now,
      };
      draft.notes.unshift(note);
      return { note, replayed: false };
    });
    if (!transaction.value.replayed) {
      await this.emitStateUpdated(transaction.snapshot, "note:created");
    }
    return {
      value: transaction.value.note,
      snapshot: {
        ...transaction.snapshot,
        notes: distinctNotes(transaction.snapshot.notes),
      },
      replayed: transaction.value.replayed,
    };
  }

  async createNote(inputValue: unknown): Promise<StickyNote> {
    return (await this.createNoteWithCommit(inputValue)).value;
  }

  async updateNoteWithCommit(
    idValue: unknown,
    patchValue: unknown,
  ): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    consolidatedIds: string[];
  }> {
    const id = parseEntityId(idValue);
    const patch = parseUpdateNoteInput(patchValue);
    const updatedAt = this.now().toISOString();
    let consolidatedIds: string[] = [];
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound(id);
      const updated = applyNotePatch(existing, patch, updatedAt);
      const oldKey = noteContentKey(existing);
      const updatedKey = noteContentKey(updated);
      consolidatedIds = draft.notes
        .filter(
          (note, candidateIndex) =>
            candidateIndex !== index &&
            (noteContentKey(note) === oldKey ||
              noteContentKey(note) === updatedKey),
        )
        .map((note) => note.id);
      draft.notes = draft.notes.flatMap((note, candidateIndex) => {
        if (candidateIndex === index) return [updated];
        return consolidatedIds.includes(note.id) ? [] : [note];
      });
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:updated");
    return {
      ...transaction,
      snapshot: {
        ...transaction.snapshot,
        notes: distinctNotes(transaction.snapshot.notes),
      },
      consolidatedIds,
    };
  }

  async updateNote(idValue: unknown, patchValue: unknown): Promise<StickyNote> {
    return (await this.updateNoteWithCommit(idValue, patchValue)).value;
  }

  async updateNoteByLookupWithCommit(
    selector: NoteLookupSelector,
    value: string,
    patchValue: unknown,
  ): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    consolidatedCount: number;
    consolidatedIds: string[];
  }> {
    const patch = parseUpdateNoteInput(patchValue);
    const updatedAt = this.now().toISOString();
    const consolidatedIds: string[] = [];
    const transaction = await this.store.transact((draft) => {
      const index = resolveNoteIndex(draft.notes, selector, value);
      const existing = draft.notes[index];
      if (!existing) {
        throw new ElizaError("Resolved sticky note was missing.", {
          code: "NOTES_NOTE_RESOLUTION_FAILED",
          severity: "fatal",
        });
      }
      const updated = applyNotePatch(existing, patch, updatedAt);
      const oldKey = noteContentKey(existing);
      const updatedKey = noteContentKey(updated);
      const next: StickyNote[] = [];
      for (
        let candidateIndex = 0;
        candidateIndex < draft.notes.length;
        candidateIndex += 1
      ) {
        const candidate = draft.notes[candidateIndex];
        if (!candidate) continue;
        if (candidateIndex === index) {
          next.push(updated);
        } else if (
          noteContentKey(candidate) === oldKey ||
          noteContentKey(candidate) === updatedKey
        ) {
          consolidatedIds.push(candidate.id);
        } else {
          next.push(candidate);
        }
      }
      draft.notes = next;
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:updated");
    return {
      ...transaction,
      snapshot: {
        ...transaction.snapshot,
        notes: distinctNotes(transaction.snapshot.notes),
      },
      consolidatedCount: consolidatedIds.length,
      consolidatedIds,
    };
  }

  async deleteNoteWithCommit(idValue: unknown): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    removedIds: string[];
  }> {
    const id = parseEntityId(idValue);
    let removedIds: string[] = [];
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound(id);
      const key = noteContentKey(existing);
      removedIds = draft.notes
        .filter((note) => noteContentKey(note) === key)
        .map((note) => note.id);
      draft.notes = draft.notes.filter((note) => noteContentKey(note) !== key);
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:deleted");
    return {
      ...transaction,
      snapshot: {
        ...transaction.snapshot,
        notes: distinctNotes(transaction.snapshot.notes),
      },
      removedIds,
    };
  }

  async deleteNote(idValue: unknown): Promise<StickyNote> {
    return (await this.deleteNoteWithCommit(idValue)).value;
  }

  async deleteNoteByLookupWithCommit(
    selector: NoteLookupSelector,
    value: string,
    options?: { requireTitleInText?: string },
  ): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    removedCount: number;
    removedIds: string[];
  }> {
    let removedIds: string[] = [];
    const transaction = await this.store.transact((draft) => {
      const index = resolveNoteIndex(draft.notes, selector, value);
      const existing = draft.notes[index];
      if (!existing) {
        throw new ElizaError("Resolved sticky note was missing.", {
          code: "NOTES_NOTE_RESOLUTION_FAILED",
          severity: "fatal",
        });
      }
      // Bind a planner-selected title to a complete phrase in the owner's
      // current wording; substring collisions must not authorize deletion.
      if (
        typeof options?.requireTitleInText === "string" &&
        options.requireTitleInText.trim().length > 0 &&
        !titleAppearsAsNamedPhrase(options.requireTitleInText, existing.title)
      ) {
        throw lookupError("NOTES_DELETE_NAME_MISMATCH", selector, value, [
          existing,
        ]);
      }
      // Deleting "the note" deletes every byte-identical copy: duplicates are
      // one logical note, and leaving three identical survivors after "delete
      // the milk note" contradicts what the deletion just confirmed.
      const key = noteContentKey(existing);
      const kept = draft.notes.filter((note) => noteContentKey(note) !== key);
      removedIds = draft.notes
        .filter((note) => noteContentKey(note) === key)
        .map((note) => note.id);
      draft.notes = kept;
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:deleted");
    return {
      ...transaction,
      snapshot: {
        ...transaction.snapshot,
        notes: distinctNotes(transaction.snapshot.notes),
      },
      removedCount: removedIds.length,
      removedIds,
    };
  }

  /**
   * Clear every note, optionally guarded by `expectedRevision`. The guard is
   * validated inside the serialized write barrier where `draft.revision` still
   * equals the committed revision, so a note that commits between a caller's
   * snapshot and this transaction aborts the clear instead of being wiped. A
   * dispatch-time check upstream is only a fast path; this is the atomic one.
   */
  async clearNotesWithCommit(expectedRevision?: number): Promise<{
    value: number;
    snapshot: NotesSnapshot;
  }> {
    const transaction = await this.store.transact((draft) => {
      if (
        expectedRevision !== undefined &&
        draft.revision !== expectedRevision
      ) {
        throw new ElizaError(
          "clear-notes expectedRevision is stale; refresh the notes snapshot and try again.",
          {
            code: "NOTES_VALIDATION_FAILED",
            context: {
              field: "expectedRevision",
              expectedRevision,
              currentRevision: draft.revision,
            },
            severity: "ephemeral",
          },
        );
      }
      const count = draft.notes.length;
      draft.notes = [];
      return count;
    });
    await this.emitStateUpdated(transaction.snapshot, "notes:cleared");
    return transaction;
  }

  async clearNotes(expectedRevision?: number): Promise<number> {
    return (await this.clearNotesWithCommit(expectedRevision)).value;
  }

  private async emitStateUpdated(
    snapshot: NotesSnapshot,
    mutation: string,
  ): Promise<void> {
    if (!this.eventRuntime) return;
    try {
      const service =
        await this.eventRuntime.getServiceLoadPromise("connector-setup");
      if (!isBroadcastService(service)) {
        throw new ElizaError(
          "connector-setup service does not expose broadcastWs.",
          {
            code: "NOTES_BROADCAST_UNAVAILABLE",
            severity: "ephemeral",
          },
        );
      }
      service.broadcastWs({
        type: "view:event",
        viewEventType: NOTES_STATE_UPDATED_EVENT,
        payload: {
          revision: snapshot.revision,
          mutation,
        },
      });
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — persistence already
      // committed atomically, so a transient shell fan-out failure is reported
      // rather than turning a successful write into a retryable duplicate.
      this.eventRuntime.reportError("NotesService.broadcast", error, {
        eventType: NOTES_STATE_UPDATED_EVENT,
        revision: snapshot.revision,
        mutation,
      });
    }
  }
}

export function getNotesService(runtime: IAgentRuntime): NotesService {
  const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
  if (!service) {
    throw new ElizaError(
      "Notes service is not registered or has not finished loading.",
      {
        code: "NOTES_SERVICE_UNAVAILABLE",
        severity: "ephemeral",
      },
    );
  }
  return service;
}
