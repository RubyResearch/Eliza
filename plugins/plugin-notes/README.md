# Notes

`@elizaos/plugin-notes` provides the lightweight managed Cloud **Notes** view
(`notes`): sticky-note creation, editing, deletion, and clearing.

The surface uses the standard VIEWS broker. The user can open it directly or
ask the agent to create/show notes. Android and iOS receive a statically
packaged React renderer; the backend capabilities and durable state run in the
user's managed Cloud agent.

State is stored atomically per agent under
`ELIZA_STATE_DIR/notes/agents/<agentId>/state.json`. UI controls and agent
capabilities share one validated mutation path, and mounted views converge
through the normal runtime update event.

The chat update action identifies the existing note with `content` and takes
its complete new text in `replacementContent` (label, newline, then body).
For literal substitutions, supply `textEdit: { field: "title" | "body", oldText,
newText }` instead of `replacementContent`. The service requires one unique
case-sensitive literal match in the current field and commits under the existing
write barrier; every other character and field is preserved. Missing or repeated
matches, mixed update forms, and edits requiring storage normalization fail
without writing. No full-note read or model rewrite is needed when the user
already supplied the exact target and replacement.

`body` is shown only for create calls; legacy update callers using `body` or
`newText` remain supported. Partial edits must preserve the unchanged label
and lines in the replacement; the server does not infer or invent them.

Calendar UI lives in `@elizaos/plugin-calendar`, which renders real Google,
Microsoft, Apple, and ICS calendar data from its own services.

## Release path

- Runtime plugin: `src/plugin.ts` (service, routes, view manifest,
  capabilities, server interaction broker).
- App registration: `src/register.ts` statically registers the Notes page in
  the signed app bundle.
- Dynamic view bundle: `bun run build:views` emits `dist/views/bundle.js` for
  web hosts that load plugin views dynamically.

## Testing

```bash
bun run --cwd plugins/plugin-notes typecheck
bun run --cwd plugins/plugin-notes test
```

Read a specific saved ID with `NOTES_GET { noteId }`; IDs match exactly and
case-sensitively. Use `content` for title/body search, or neither field to list
all notes. Mixed ID and text filters fail explicitly. Read results record
`lookupMode` (`exact_id`, `text`, or `all`) so an empty text search is not
mistaken for proof that an ID is absent. Reads do not mutate notes.
The `NOTES_GET_NOTE` retrieval hint resolves to `NOTES_GET`. This promoted
operation requires noteId and has no text-search field. Both reads use the
existing Notes service; `NOTES_LIST { noteId }` also retains exact-ID support.

The fresh saved-note discovery index retains every current ID and title. It
supports exact-ID existence and count checks without exposing note bodies.
Full context retains IDs in note order alongside unchanged complete content;
body retrieval still requires the full reference or an exact read.
