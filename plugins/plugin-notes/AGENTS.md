# @elizaos/plugin-notes

Managed Cloud Notes view for lightweight personal notes that users and agents
can create, inspect, update, and delete together.

## Role

This package owns one intentionally focused Cloud surface:

- `notes` — note CRUD with one user-authored content field and optional color.

The persisted schema retains a derived first-line label plus body for stable
lookup and compatibility with existing notes. That split is deterministic:
planner capabilities prefer one `content` value, while the chat action also
losslessly normalizes providers that preserve an explicitly requested title and
body as separate arguments. The view renders the combined content as one field.

Managed dedicated agents load the runtime plugin through the `lean-chat`
profile. The app build loads `src/register.ts` through the manifest-driven app
registration scanner, which statically packages the React renderer for Android
and iOS. Native clients therefore never fetch plugin JavaScript.

The shared VIEWS broker and shell own navigation, tabs, windows, and
interaction transport. Do not introduce another layout or navigation system
here. Calendar belongs to `@elizaos/plugin-calendar` — do not add calendar
views or event state to this package.

## Layout

- `src/types.ts` — shared domain contracts (one schema, no parallel models).
- `src/validation.ts` — the only validation layer; every untrusted boundary
  (persisted JSON, HTTP bodies, capability params) goes through it.
- `src/store.ts` — atomic per-agent JSON persistence with a shared in-process
  write barrier.
- `src/service.ts` — `NotesService`, the only layer allowed to mutate state.
- `src/action.ts` — owner-only chat CRUD over the same service.
- `src/provider.ts` — owner-only saved-note context for chat recall.
- `src/interact.ts` — server capability broker (`serverInteract`).
- `src/capabilities.ts` — planner-visible capability declarations.
- `src/routes.ts` — authenticated `GET /api/notes/state`.
- `src/register.ts` — static app-shell page registration.
- `src/views/` — React renderer, browser transport, and sync hook.

## Invariants

- The server owns all state; the view renders the authoritative snapshot.
- Loading, designed-empty, and error are three distinguishable renders.
- Failures throw typed `ElizaError`s; nothing fabricates a healthy empty state.
- All chat action and provider exposure is OWNER-gated because storage is
  per-agent rather than per-sender.
- `clear-notes` validates `expectedRevision` inside the store write barrier, so
  a note committed between confirmation and commit aborts the clear instead of
  being wiped. The dispatch-time snapshot check is only a fast path.

Saved-note prompt content is encoded as complete JSON strings with canonical label/newline/body boundaries; never flatten it into a display dash that can corrupt a partial update.

Direct-text planner/completion context can use the provider-owned exact title/count index. Complete note bodies remain in the authorized provider result and are retrieved through the shared context-restoration protocol or NOTES before body recall or replacement. Never turn labels into inferred body text; keep full JSON-string line boundaries on retrieval.

Literal chat updates may supply textEdit with a field, exact oldText and newText.
Validate this alternative at the existing boundary and match under the store
write barrier. Require a unique current match and preserve every other character;
reject ambiguous, absent, conflicting or normalization-dependent edits without a
write. Full replacement and legacy caller contracts remain supported. This is
structured tool input, never a natural-language shortcut or a second write path.
