/**
 * Real-runtime coverage for the SAVED_NOTES provider: a note written through
 * the durable service must come back out through `composeState`, which is the
 * only path that puts it in front of the planner. The harness is
 * integration-backed — a real `AgentRuntime`, a real `NotesService`, and a real
 * temp-file store — because the bug was precisely that two real subsystems
 * never met.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  ElizaError,
  filterProvidersByContextGate,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  stringToUuid,
  toWellFormedUnicode,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { notesPlugin } from "./plugin.js";
import { notesProvider, renderSavedNotesText } from "./provider.js";
import { NOTES_SERVICE_TYPE, NotesService } from "./service.js";
import { NotesStore } from "./store.js";
import type { StickyNote } from "./types.js";
import { parseNoteContent } from "./validation.js";

/**
 * `String.prototype.isWellFormed` is ES2024 and the workspace compiles against
 * the ES2023 lib, so assert well-formedness through the core helper instead.
 */
const isWellFormedText = (value: string): boolean =>
  toWellFormedUnicode(value) === value;

const temporaryDirectories: string[] = [];
const testRuntimes: AgentRuntime[] = [];
let runtimeSequence = 0;

afterEach(async () => {
  await Promise.all(testRuntimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function clock(start = "2026-08-14T12:00:00.000Z"): () => Date {
  let tick = 0;
  const epoch = Date.parse(start);
  return () => new Date(epoch + tick++ * 1_000);
}

function idFactory(): () => string {
  let next = 1;
  return () => `note-provider-${next++}`;
}

async function temporaryStateFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-provider-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "notes", "state.json");
}

async function serviceWithNotes(contents: string[]): Promise<NotesService> {
  const now = clock();
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: await temporaryStateFile(), now }),
    now,
    createId: idFactory(),
  });
  await service.initialize();
  for (const content of contents) {
    await service.createNote(parseNoteContent(content));
  }
  return service;
}

async function bareRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    agentId: stringToUuid(`notes-provider-runtime-${runtimeSequence++}`),
    character: createCharacter({ name: "Notes provider" }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  testRuntimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function runtimeWith(service: NotesService): Promise<AgentRuntime> {
  const runtime = await bareRuntime();
  class BoundNotesService extends NotesService {
    static override async start(
      _runtime: IAgentRuntime,
    ): Promise<NotesService> {
      return service;
    }
  }
  await runtime.registerService(BoundNotesService);
  await runtime.getServiceLoadPromise(NOTES_SERVICE_TYPE);
  return runtime;
}

function recallMessage(runtime: AgentRuntime, text: string): Memory {
  return {
    id: stringToUuid(`notes-provider-message-${text}`),
    entityId: stringToUuid("notes-provider-owner"),
    agentId: runtime.agentId,
    roomId: stringToUuid("notes-provider-room"),
    content: { text, source: "test" },
    createdAt: Date.parse("2026-08-14T12:05:00.000Z"),
  };
}

function registeredNotesProvider(): Provider {
  const provider = notesPlugin.providers?.find(
    (candidate) => candidate.name === "SAVED_NOTES",
  );
  if (!provider) {
    throw new Error("notesPlugin must register the SAVED_NOTES provider.");
  }
  return provider;
}

const EMPTY_STATE = { values: {}, data: {}, text: "" } satisfies State;

describe("SAVED_NOTES provider", () => {
  it("is absent from non-owner context and available to the owner", () => {
    expect(notesProvider.roleGate).toEqual({ minRole: "OWNER" });
    expect(
      filterProvidersByContextGate([notesProvider], ["general"], ["USER"]),
    ).toEqual([]);
    expect(
      filterProvidersByContextGate([notesProvider], ["memory"], ["ADMIN"]),
    ).toEqual([]);
    expect(
      filterProvidersByContextGate([notesProvider], ["general"], ["OWNER"]),
    ).toEqual([notesProvider]);
    expect(
      filterProvidersByContextGate([notesProvider], ["notes"], ["OWNER"]),
    ).toEqual([notesProvider]);
  });

  it("indexes current IDs and labels while retaining complete bodies for context reads", async () => {
    const body = "Exact body\n  spacing and punctuation!?";
    const service = await serviceWithNotes([
      `Lookup label\n${body}`,
      "Second label",
    ]);
    const runtime = await runtimeWith(service);
    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "open notes"),
      EMPTY_STATE,
    );
    expect(result.discoveryText).toContain('"Lookup label"');
    expect(result.discoveryText).toContain('"Second label"');
    expect(result.discoveryText).toContain("Exact note count: 2");
    expect(result.discoveryText).not.toContain("Exact body");
    const identities = service
      .listNotes()
      .map(({ id, title }) => ({ id, title }));
    expect(
      result.discoveryText
        ?.split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => JSON.parse(line.slice(2))),
    ).toEqual(identities);
    for (const { id } of identities) expect(result.text).toContain(id);
    expect(result.text).toContain(JSON.stringify(`Lookup label\n${body}`));
    expect(
      service.listNotes().find((note) => note.title === "Lookup label")?.body,
    ).toBe(body);
    await service.deleteNote(identities[0].id);
    const after = await notesProvider.get(
      runtime,
      recallMessage(runtime, "read my notes"),
      EMPTY_STATE,
    );
    expect(after.discoveryText).not.toContain(identities[0].id);
    expect(after.discoveryText).toContain(identities[1].id);
    expect(after.discoveryText).toContain("Exact note count: 1");
  });

  it("surfaces a saved note through composeState so recall does not depend on memory search", async () => {
    // The live failure (2026-08-14): this note existed while "who is alex
    // again" answered "Found 0 memory item(s)" twice.
    const service = await serviceWithNotes([
      "alex is my cofounder and we met at ethdenver",
    ]);
    const runtime = await runtimeWith(service);
    runtime.registerProvider(registeredNotesProvider());

    const state = await runtime.composeState(
      recallMessage(runtime, "who is alex again"),
      ["SAVED_NOTES"],
      true,
    );

    expect(state.text).toContain(
      "alex is my cofounder and we met at ethdenver",
    );
    expect(state.values.savedNotesAvailable).toBe(true);
    expect(state.values.savedNoteCount).toBe(1);
  });

  it("is routed to the contexts a recall turn actually selects", () => {
    // "make a note …" routes general and "who is alex again" routes memory;
    // a notes-only gate would have reproduced the bug on the recall turn.
    expect(registeredNotesProvider().contexts).toEqual([
      "notes",
      "general",
      "memory",
    ]);
  });

  it("renders designed-empty distinctly from unavailable", async () => {
    const service = await serviceWithNotes([]);
    const runtime = await runtimeWith(service);

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "what notes do i have"),
      EMPTY_STATE,
    );

    expect(result.text).toBe("");
    expect(result.values?.savedNotesAvailable).toBe(true);
    expect(result.values?.savedNoteCount).toBe(0);
    expect(result.data?.savedNotes).toEqual([]);
  });

  it("reports an unreadable store as unavailable instead of an empty note list", async () => {
    const service = await serviceWithNotes([
      "alex is my cofounder and we met at ethdenver",
    ]);
    const runtime = await runtimeWith(service);
    const reported: unknown[] = [];
    runtime.reportError = (_scope: string, error: unknown) => {
      reported.push(error);
    };
    service.listNotes = () => {
      throw new ElizaError("Notes state is not loaded.", {
        code: "NOTES_STORE_UNAVAILABLE",
        severity: "ephemeral",
      });
    };

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "who is alex again"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("SAVED NOTES: unavailable");
    expect(result.values?.savedNotesAvailable).toBe(false);
    expect(result.data?.savedNotes).toBeNull();
    expect(reported).toHaveLength(1);
  });

  it("reports an unregistered notes service as unavailable, not as zero notes", async () => {
    const runtime = await bareRuntime();
    const reported: unknown[] = [];
    runtime.reportError = (_scope: string, error: unknown) => {
      reported.push(error);
    };

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "who is alex again"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("SAVED NOTES: unavailable");
    expect(result.values?.savedNotesAvailable).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it("renders every saved note", () => {
    const notes: StickyNote[] = Array.from({ length: 23 }, (_, index) => ({
      id: `note-${index}`,
      title: `note ${index}`,
      body: "",
      color: "yellow",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
    }));

    const text = renderSavedNotesText(notes);

    expect(text).toContain("Exact note count: 23.");
    expect(text).toContain('- "note 0"');
    expect(text).toContain('- "note 19"');
    expect(text).toContain('- "note 20"');
    expect(text).toContain('- "note 22"');
    expect(text).not.toContain("not shown");
  });

  it("round-trips label and multiline body without inventing a display separator", async () => {
    const content =
      'Packing label\nFirst line — keep this dash.\n\n"Quoted" line with \\ slash and 🦊';
    const service = await serviceWithNotes([content, "Label only"]);
    const runtime = await runtimeWith(service);
    runtime.registerProvider(registeredNotesProvider());
    const state = await runtime.composeState(
      recallMessage(runtime, "change just one word"),
      ["SAVED_NOTES"],
      true,
    );
    const encoded = state.text
      .split("\n")
      .filter((line) => line.startsWith("- "));
    const decoded = encoded.map((line) => JSON.parse(line.slice(2)));
    expect(decoded).toContain(content);
    expect(decoded).toContain("Label only");
    expect(
      parseNoteContent(
        decoded.find((value) => value.startsWith("Packing label")),
      ),
    ).toEqual(parseNoteContent(content));
  });

  it("renders a complete oversized note body", () => {
    const body = "x".repeat(5_000);
    const text = renderSavedNotesText([
      {
        id: "note-long",
        title: "launch checklist",
        body,
        color: "slate",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);

    expect(text).toContain("launch checklist");
    expect(text).toContain(body);
    expect(text).not.toContain("(truncated)");
  });

  it("keeps UTF-16 surrogate pairs intact in a long note", () => {
    const body = `${"a".repeat(382)}🦊${"b".repeat(100)}`;
    const text = renderSavedNotesText([
      {
        id: "note-emoji-boundary",
        title: "x",
        body,
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    const noteLine = text
      .split("\n")
      .find((line) => line.startsWith('- "x\\n'));
    expect(noteLine).toBeDefined();
    if (noteLine) {
      expect(isWellFormedText(noteLine)).toBe(true);
      expect(noteLine).toContain(body);
    }
    expect(noteLine).toContain("🦊");
  });

  it("sanitizes lone surrogates in a note", () => {
    const text = renderSavedNotesText([
      {
        id: "note-lone",
        title: "a\ud800bc",
        body: "",
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    expect(text).toContain("a\ufffdbc");
    expect(isWellFormedText(text)).toBe(true);
  });

  it("preserves an emoji that fits entirely under the 400 cap", () => {
    const body = `${"a".repeat(10)}🦊`;
    const text = renderSavedNotesText([
      {
        id: "note-fitting",
        title: "t",
        body,
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    expect(text).toContain("🦊");
    expect(isWellFormedText(text)).toBe(true);
    const noteLine = text
      .split("\n")
      .find((line) => line.startsWith('- "t\\n'));
    expect(noteLine).toBeDefined();
    if (noteLine) {
      expect(isWellFormedText(noteLine)).toBe(true);
    }
  });
});
