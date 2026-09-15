/**
 * Shared domain contracts for the managed Cloud Notes view. The backend store,
 * authenticated routes, capability broker, and view bundle all consume these
 * shapes so persisted state has one owner and one schema instead of parallel
 * browser/server models.
 */

export const NOTES_SCHEMA_VERSION = 1 as const;

export const STICKY_COLORS = ["yellow", "green", "rose", "slate"] as const;

export type StickyColor = (typeof STICKY_COLORS)[number];

export interface StickyNote {
  id: string;
  title: string;
  body: string;
  color: StickyColor;
  createdAt: string;
  updatedAt: string;
}

export interface NotesSnapshot {
  notes: StickyNote[];
  revision: number;
}

export interface NotesDocument extends NotesSnapshot {
  schemaVersion: typeof NOTES_SCHEMA_VERSION;
  persistedAt: string;
}

export type NotesStorePhase =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "stopped";

export interface NotesStoreStatus {
  phase: NotesStorePhase;
  filePath: string;
  revision?: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface CreateNoteInput {
  title: string;
  body: string;
  color: StickyColor;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string;
  color?: StickyColor;
  textEdit?: {
    field: "title" | "body";
    oldText: string;
    newText: string;
  };
}
