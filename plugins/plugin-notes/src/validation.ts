/**
 * Runtime validation for every untrusted Notes boundary. Persisted JSON,
 * HTTP bodies, and agent capability params are normalized here before domain
 * code sees them; malformed data fails with a typed error and is never replaced
 * by an apparently healthy empty state.
 */

import {
  ElizaError,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import {
  type CreateNoteInput,
  NOTES_SCHEMA_VERSION,
  type NotesDocument,
  type StickyColor,
  type StickyNote,
  type UpdateNoteInput,
} from "./types.js";

const ENTITY_ID_PATTERN = /^[a-z][a-z0-9-]{2,127}$/;
const MAX_TITLE_LENGTH = 240;
const MAX_BODY_LENGTH = 20_000;
const MAX_NOTE_CONTENT_LENGTH = 20_000;

function validationError(message: string, field: string): ElizaError {
  return new ElizaError(message, {
    code: "NOTES_VALIDATION_FAILED",
    context: { field },
    severity: "ephemeral",
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  source: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw validationError(`${source} must be a JSON object.`, source);
  }
  return value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  source: string,
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(record).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw validationError(
      `${source} contains unsupported field "${unknownKey}".`,
      `${source}.${unknownKey}`,
    );
  }
}

function parseString(
  value: unknown,
  field: string,
  options: { allowEmpty: boolean; maxLength: number },
): string {
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`, field);
  }
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw validationError(`${field} must not be empty.`, field);
  }
  if (normalized.length > options.maxLength) {
    throw validationError(
      `${field} must be at most ${options.maxLength} characters.`,
      field,
    );
  }
  return normalized;
}

function parseRequiredTitle(value: unknown, field: string): string {
  return parseString(value, field, {
    allowEmpty: false,
    maxLength: MAX_TITLE_LENGTH,
  });
}

function parseText(value: unknown, field: string): string {
  return parseString(value, field, {
    allowEmpty: true,
    maxLength: MAX_BODY_LENGTH,
  });
}

/**
 * Split the one user-authored note field into the storage schema's stable list
 * label and remainder. The first line is the label; overflow and later lines
 * stay in the body, so the transformation never asks a model to invent text or
 * discards user content. A one-line note written as "Label: details" keeps the
 * label as the title and the details as the body — planners flatten "titled X
 * saying Y" into exactly that shape — and the colon must be followed by
 * whitespace so URLs ("https://…") and clock times ("5:30") never split.
 */
export function parseNoteContent(
  value: unknown,
  field = "content",
): Pick<CreateNoteInput, "title" | "body"> {
  const content = parseString(value, field, {
    allowEmpty: false,
    maxLength: MAX_NOTE_CONTENT_LENGTH,
  });
  const [firstLine = "", ...remainingLines] = content.split(/\r?\n/);
  let labelLine = toWellFormedUnicode(firstLine.trim());
  let inlineDetails = "";
  if (remainingLines.length === 0) {
    const labeled = /^([^:]+):\s+(.+)$/.exec(labelLine);
    if (labeled) {
      labelLine = labeled[1].trim();
      inlineDetails = labeled[2].trim();
    }
  }
  const title = truncateWellFormed(labelLine, MAX_TITLE_LENGTH).trim();
  const overflow = labelLine.slice(title.length).trim();
  const body = [overflow, inlineDetails, ...remainingLines]
    .filter((part, index) => index >= 2 || part.length > 0)
    .join("\n")
    .trim();
  return {
    title: parseRequiredTitle(title, `${field}.firstLine`),
    body: parseText(body, `${field}.remainder`),
  };
}

export function parseEntityId(value: unknown, field = "id"): string {
  const id = parseString(value, field, { allowEmpty: false, maxLength: 128 });
  if (!ENTITY_ID_PATTERN.test(id)) {
    throw validationError(
      `${field} must be a lowercase alphanumeric identifier.`,
      field,
    );
  }
  return id;
}

export function parseStickyColor(value: unknown, field = "color"): StickyColor {
  if (
    value === "yellow" ||
    value === "green" ||
    value === "rose" ||
    value === "slate"
  ) {
    return value;
  }
  throw validationError(
    `${field} must be yellow, green, rose, or slate.`,
    field,
  );
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw validationError(`${field} must be a UTC ISO-8601 timestamp.`, field);
  }
  if (new Date(value).toISOString() !== value) {
    throw validationError(
      `${field} must use canonical UTC ISO-8601 format.`,
      field,
    );
  }
  return value;
}

function parseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(
      "revision must be a non-negative integer.",
      "revision",
    );
  }
  return value;
}

export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const record = requireRecord(value, "note");
  assertOnlyKeys(record, ["title", "body", "color"], "note");
  return {
    title: parseRequiredTitle(record.title, "note.title"),
    body: hasOwn(record, "body") ? parseText(record.body, "note.body") : "",
    color: hasOwn(record, "color")
      ? parseStickyColor(record.color, "note.color")
      : "yellow",
  };
}

export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const record = requireRecord(value, "note patch");
  assertOnlyKeys(record, ["title", "body", "color", "textEdit"], "note patch");
  const patch: UpdateNoteInput = {};
  if (hasOwn(record, "textEdit")) {
    if (Object.keys(record).length !== 1) {
      throw validationError(
        "Pass either textEdit or replacement fields, not both.",
        "note patch",
      );
    }
    const edit = requireRecord(record.textEdit, "textEdit");
    assertOnlyKeys(edit, ["field", "oldText", "newText"], "textEdit");
    if (edit.field !== "title" && edit.field !== "body") {
      throw validationError(
        "textEdit.field must be title or body.",
        "textEdit.field",
      );
    }
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw validationError(
        "textEdit.oldText must be a nonempty literal string.",
        "textEdit.oldText",
      );
    }
    if (typeof edit.newText !== "string") {
      throw validationError(
        "textEdit.newText must be a literal string, including empty for deletion.",
        "textEdit.newText",
      );
    }
    // Whitespace is part of the literal match and replacement, never an
    // omission sentinel. Validate the resulting field inside the transaction.
    return {
      textEdit: {
        field: edit.field,
        oldText: edit.oldText,
        newText: edit.newText,
      },
    };
  }
  if (hasOwn(record, "title")) {
    patch.title = parseRequiredTitle(record.title, "note.title");
  }
  if (hasOwn(record, "body")) {
    patch.body = parseText(record.body, "note.body");
  }
  if (hasOwn(record, "color")) {
    patch.color = parseStickyColor(record.color, "note.color");
  }
  if (Object.keys(patch).length === 0) {
    throw validationError(
      "note patch must change at least one field.",
      "note patch",
    );
  }
  return patch;
}

function parseStickyNote(value: unknown, index: number): StickyNote {
  const field = `notes[${index}]`;
  const record = requireRecord(value, field);
  assertOnlyKeys(
    record,
    ["id", "title", "body", "color", "createdAt", "updatedAt"],
    field,
  );
  return {
    id: parseEntityId(record.id, `${field}.id`),
    title: parseRequiredTitle(record.title, `${field}.title`),
    body: parseText(record.body, `${field}.body`),
    color: parseStickyColor(record.color, `${field}.color`),
    createdAt: parseTimestamp(record.createdAt, `${field}.createdAt`),
    updatedAt: parseTimestamp(record.updatedAt, `${field}.updatedAt`),
  };
}

export function parseNotesDocument(value: unknown): NotesDocument {
  const record = requireRecord(value, "notes state");
  assertOnlyKeys(
    record,
    ["schemaVersion", "revision", "persistedAt", "notes"],
    "notes state",
  );
  if (record.schemaVersion !== NOTES_SCHEMA_VERSION) {
    throw validationError(
      `schemaVersion must be ${NOTES_SCHEMA_VERSION}.`,
      "schemaVersion",
    );
  }
  if (!Array.isArray(record.notes)) {
    throw validationError("notes must be an array.", "notes");
  }
  const notes = record.notes.map(parseStickyNote);
  const noteIds = new Set(notes.map((note) => note.id));
  if (noteIds.size !== notes.length) {
    throw validationError("notes contain duplicate ids.", "notes");
  }
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    revision: parseRevision(record.revision),
    persistedAt: parseTimestamp(record.persistedAt, "persistedAt"),
    notes,
  };
}
