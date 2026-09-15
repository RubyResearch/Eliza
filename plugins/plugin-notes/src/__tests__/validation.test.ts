/**
 * Unit tests for untrusted Notes boundary validators in validation.ts.
 */

import { describe, expect, it } from "vitest";
import { NOTES_SCHEMA_VERSION } from "../types.js";
import {
  isRecord,
  parseCreateNoteInput,
  parseEntityId,
  parseNoteContent,
  parseNotesDocument,
  parseStickyColor,
  parseUpdateNoteInput,
} from "../validation.js";

describe("Notes boundary validation", () => {
  describe("isRecord", () => {
    it("identifies plain objects and rejects primitives or arrays", () => {
      expect(isRecord({ key: "val" })).toBe(true);
      expect(isRecord({})).toBe(true);
      expect(isRecord(null)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord("string")).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
    });
  });

  describe("parseNoteContent", () => {
    it("splits single-line content into title and empty body", () => {
      const result = parseNoteContent("Simple Note Title");
      expect(result).toEqual({
        title: "Simple Note Title",
        body: "",
      });
    });

    it("splits multi-line content into first line title and remaining body", () => {
      const result = parseNoteContent(
        "Header Line\nFirst paragraph\nSecond paragraph",
      );
      expect(result).toEqual({
        title: "Header Line",
        body: "First paragraph\nSecond paragraph",
      });
    });

    it("handles leading and trailing whitespace on lines cleanly", () => {
      const result = parseNoteContent("   Padded Title   \n   Padded Body   ");
      expect(result).toEqual({
        title: "Padded Title",
        body: "Padded Body",
      });
    });

    it('splits a one-line "Label: details" note at the labelled colon', () => {
      // Planners flatten "create a note titled X saying Y" and users write
      // "create a note called X: Y" into exactly this one-line shape.
      expect(parseNoteContent("Demo Checklist: mic, charger, water")).toEqual({
        title: "Demo Checklist",
        body: "mic, charger, water",
      });
      expect(parseNoteContent("Groceries: eggs, bread")).toEqual({
        title: "Groceries",
        body: "eggs, bread",
      });
    });

    it("keeps colons that are not label separators in the title", () => {
      expect(parseNoteContent("https://example.com/docs")).toEqual({
        title: "https://example.com/docs",
        body: "",
      });
      expect(parseNoteContent("Standup at 9:30")).toEqual({
        title: "Standup at 9:30",
        body: "",
      });
      expect(parseNoteContent("re:invent recap")).toEqual({
        title: "re:invent recap",
        body: "",
      });
    });

    it("leaves multi-line content on the first-line label contract", () => {
      expect(parseNoteContent("Demo Checklist: mic\ncharger")).toEqual({
        title: "Demo Checklist: mic",
        body: "charger",
      });
    });

    it("rejects non-string or empty content", () => {
      expect(() => parseNoteContent(123)).toThrow();
      expect(() => parseNoteContent("   ")).toThrow();
    });

    it("splits long single-line content with surrogate safety at max title length", () => {
      const longTitle = `${"a".repeat(239)}😀${"b".repeat(20)}`;
      const result = parseNoteContent(longTitle);
      expect(result.title.length).toBe(239);
      expect(result.title.endsWith("😀")).toBe(false);
      expect(result.body.startsWith("😀")).toBe(true);
    });
  });

  describe("parseEntityId", () => {
    it("accepts valid lowercase alphanumeric IDs", () => {
      expect(parseEntityId("note-123")).toBe("note-123");
      expect(parseEntityId("abc")).toBe("abc");
    });

    it("rejects invalid IDs (uppercase, symbols, starting with number)", () => {
      expect(() => parseEntityId("123note")).toThrow();
      expect(() => parseEntityId("Note-123")).toThrow();
      expect(() => parseEntityId("ab")).toThrow();
      expect(() => parseEntityId("note_123")).toThrow();
    });
  });

  describe("parseStickyColor", () => {
    it("accepts valid sticky colors", () => {
      expect(parseStickyColor("yellow")).toBe("yellow");
      expect(parseStickyColor("green")).toBe("green");
      expect(parseStickyColor("rose")).toBe("rose");
      expect(parseStickyColor("slate")).toBe("slate");
    });

    it("rejects unknown colors", () => {
      expect(() => parseStickyColor("blue")).toThrow();
      expect(() => parseStickyColor(123)).toThrow();
    });
  });

  describe("parseCreateNoteInput", () => {
    it("validates and defaults sticky color to yellow", () => {
      const note = parseCreateNoteInput({ title: "Test Note" });
      expect(note).toEqual({
        title: "Test Note",
        body: "",
        color: "yellow",
      });
    });

    it("accepts custom body and valid color", () => {
      const note = parseCreateNoteInput({
        title: "Task Note",
        body: "Details here",
        color: "rose",
      });
      expect(note).toEqual({
        title: "Task Note",
        body: "Details here",
        color: "rose",
      });
    });

    it("rejects extra unknown keys in create input", () => {
      expect(() =>
        parseCreateNoteInput({ title: "Test", unknownKey: true }),
      ).toThrow();
    });
  });

  describe("parseUpdateNoteInput", () => {
    it("accepts valid partial patch", () => {
      const patch = parseUpdateNoteInput({ title: "Updated Title" });
      expect(patch).toEqual({ title: "Updated Title" });
    });

    it("retains exact edit whitespace and rejects malformed or combined edits", () => {
      const textEdit = { field: "body", oldText: " green ", newText: "" };
      expect(parseUpdateNoteInput({ textEdit })).toEqual({ textEdit });
      for (const invalid of [
        null,
        {},
        { ...textEdit, field: "color" },
        { ...textEdit, oldText: "" },
        { ...textEdit, newText: null },
        { ...textEdit, extra: true },
      ])
        expect(() => parseUpdateNoteInput({ textEdit: invalid })).toThrow();
      expect(() =>
        parseUpdateNoteInput({ textEdit, body: "rewrite" }),
      ).toThrow();
    });

    it("rejects empty patch", () => {
      expect(() => parseUpdateNoteInput({})).toThrow();
    });
  });

  describe("parseNotesDocument", () => {
    it("validates complete notes document structure", () => {
      const validDoc = {
        schemaVersion: NOTES_SCHEMA_VERSION,
        revision: 1,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [
          {
            id: "note-001",
            title: "First Note",
            body: "Content",
            color: "green",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      };
      const parsed = parseNotesDocument(validDoc);
      expect(parsed).toEqual(validDoc);
    });

    it("rejects duplicate note IDs in document", () => {
      const docWithDuplicates = {
        schemaVersion: NOTES_SCHEMA_VERSION,
        revision: 1,
        persistedAt: "2026-08-12T12:00:00.000Z",
        notes: [
          {
            id: "note-001",
            title: "First Note",
            body: "",
            color: "yellow",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
          {
            id: "note-001",
            title: "Duplicate Note",
            body: "",
            color: "slate",
            createdAt: "2026-08-12T12:00:00.000Z",
            updatedAt: "2026-08-12T12:00:00.000Z",
          },
        ],
      };
      expect(() => parseNotesDocument(docWithDuplicates)).toThrow();
    });
  });
});
