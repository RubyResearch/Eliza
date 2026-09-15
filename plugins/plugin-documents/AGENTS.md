# @elizaos/plugin-documents

HTTP API surface and reusable presentation components for the elizaOS document store.

## Purpose / role

Registers a set of REST routes that expose document CRUD, bulk upload, URL ingestion, semantic search, and fragment listing against the runtime's document store. The plugin delegates all persistence and search to `DocumentsServiceLike` (resolved from `@elizaos/agent/api/documents-service-loader`). It also registers the Knowledge document views through `src/register.ts`, so the app shell discovers and lazy-loads the UI from this plugin without importing feature views from `@elizaos/ui`. It also does not register owner actions; `OWNER_DOCUMENTS` is host-adapted by `@elizaos/plugin-personal-assistant`, which owns approval queue gating, scheduled-task deadline tracking, and document-request orchestration. This plugin has no providers, evaluators, or event handlers.

Loading: added explicitly to the agent plugin list or via character config. It is not unconditionally enabled by default; the runtime must resolve it by name (`@elizaos/plugin-documents`).

Repo-wide conventions (logger-only, ESM, naming, architecture rules, git workflow) live in the root [CLAUDE.md](../../CLAUDE.md) — not repeated here.

## Plugin surface

**Routes** (all registered under the agent HTTP server via `rawPath: true`):

| Method | Path | What it does |
|--------|------|--------------|
| GET    | `/api/documents` | List documents with filtering, pagination, access control |
| GET    | `/api/documents/stats` | Document and fragment counts for the agent |
| GET    | `/api/documents/search` | Semantic/keyword/hybrid search across documents |
| GET    | `/api/documents/:id` | Fetch a single document (includes content) |
| GET    | `/api/documents/:id/fragments` | List all text fragments for a document |
| POST   | `/api/documents` | Upload a single document (text, image, binary) |
| POST   | `/api/documents/bulk` | Bulk upload up to 100 documents |
| POST   | `/api/documents/url` | Fetch and ingest a URL or YouTube transcript |
| PATCH  | `/api/documents/:id` | Update document text content (re-fragments) |
| PATCH  | `/api/documents/:id/access` | Replace bounded direct entity read grants (OWNER or room ADMIN) |
| GET    | `/api/documents/:id/access` | Read direct grants through the same management authority |
| GET    | `/api/documents/:id/pins` | Read agent and chat pin placements with their review revision (OWNER) |
| PATCH  | `/api/documents/:id/pins` | Save reviewed agent and chat pin placements without changing read access (OWNER) |
| DELETE | `/api/documents/:id` | Delete document and all its fragments |

**Actions:** none registered here. `OWNER_DOCUMENTS` is registered by
`@elizaos/plugin-personal-assistant` and delegates to this package's document
routes/store where appropriate.

No providers, services, evaluators, or event handlers are registered. The
Knowledge route and its document-management views are app-shell registrations
owned by this plugin.

## Layout

```
src/
  index.ts               Barrel — re-exports plugin.ts, routes.ts, service-loader.ts
  plugin.ts              Builds Route[] + exports documentsPlugin (Plugin object)
  routes.ts              handleDocumentsRoutes() — all route logic; documentRouteHandler() adapter
  document-presenter.ts  presentDocument(), getDocumentEditability(), getDocumentDeleteability(),
                         getDocumentProvenance(), getDocumentVisibilityScope(), etc.
  service-loader.ts      Re-exports canonical types and getDocumentsService() from
                         @elizaos/agent/api/documents-service-loader
  components/
    documents/
      DocumentsView.tsx                  React document browser view
      DocumentsSpatialView.tsx            Spatial document browser view
      KnowledgeView.tsx                   Knowledge route shell
      KnowledgeDocumentsView.tsx          Multimedia Knowledge document view
      documents-detail.tsx                Document detail surface
      documents-upload.tsx                Upload surface
  register.ts                              Manifest-driven app-shell registration
test/
  documents-api.live.e2e.test.ts   Live API e2e tests
  documents-live.e2e.test.ts       Live document ingestion e2e tests
  routes.test.ts                   Unit tests for route logic
```

## Commands

Scripts that exist in this package's `package.json`:

```bash
bun run --cwd plugins/plugin-documents build               # build:js + build:views + build:types
bun run --cwd plugins/plugin-documents build:js            # tsup bundling
bun run --cwd plugins/plugin-documents build:views         # Vite Knowledge view bundle
bun run --cwd plugins/plugin-documents build:types         # tsc --noCheck type emit
bun run --cwd plugins/plugin-documents typecheck           # source TypeScript check
bun run --cwd plugins/plugin-documents clean               # rm -rf dist
bun run --cwd plugins/plugin-documents test                # vitest run (unit tests)
bun run --cwd plugins/plugin-documents test:e2e:manual     # vitest run live e2e tests
```

No package `lint` script is defined; use the repository lint gate.

## Config / env vars

The plugin itself reads no env vars directly. The `routes.ts` handler reads one runtime setting:

| Setting key | Source | Purpose |
|-------------|--------|---------|
| `ELIZA_ADMIN_ENTITY_ID` | `runtime.getSetting(...)` | Identifies the OWNER actor for document access-control decisions |

Access control is role-based and requires the authenticated `AccessContext`
provided by the host route boundary. Missing context returns `401`; the plugin
never treats an absent caller as owner. Request headers alone are not an
identity or authorization authority. Preserve the caller's exact role through
storage authorization: ADMIN is not OWNER, GUEST is not USER, and an unresolved
role is rejected. Guests may read global documents in their current rooms and
non-agent-private documents explicitly granted to their resolved entity identity.
Direct grants never confer document mutation or sharing authority.

List, facet, search, parent, and fragment REST reads must call the
access-context-aware `DocumentService` methods. Do not use
`runtime.getMemoryById()` or `getMemories()` and apply route-local authorization
afterward: authorization belongs in the adapter query before rows, search
ranking, fragment bytes, counts, or pagination are constructed. Route list and
facet filters may narrow the already-authorized set for presentation, and
fragment counts must use the authorized parent/fragment path.

PATCH and DELETE must use the access-context-aware mutation methods. The route
may inspect the already-authorized parent for editability, but it may not scan
or delete fragments itself; `DocumentService` owns snapshot validation and the
adapter performs the atomic parent/revision mutation.
Direct-grant replacement is a separate storage-enforced CAS operation. OWNER
may manage grants on any valid document; ADMIN may manage global or
user-private documents only while a current member of the document room.

## How to extend

**Add a new route:**
1. Add the method + path to `DOCUMENT_ROUTES` in `src/plugin.ts`.
2. Implement the handler branch inside `handleDocumentsRoutes()` in `src/routes.ts`. Resolve the authenticated access context, delegate authorization to the access-context-aware `DocumentService` method, then call `json(res, ...)` or `error(res, ...)`.
3. Every route must have a real caller (UI or agent action) per root CLAUDE.md rule 10.

**Add a new presenter field:**
Add to `PresentedDocument` in `src/document-presenter.ts` and populate it in `presentDocument()`.

**Add document scope enforcement logic:**
Canonical read/mutation authorization belongs in `DocumentService` and its
adapter queries. Route helpers may validate upload scope and presentation, but
must never become a competing read authority or post-filter raw storage rows.

## Conventions / gotchas

- **No service ownership.** This plugin does not define `DocumentsServiceLike` — it imports it from `@elizaos/agent/api/documents-service-loader`. If the service times out during loading, the route returns 503 with a `Retry-After: 5` header; if the service is simply absent (e.g. agent not running), it returns 503 without that header.
- **Scope defaults.** Uploads with `addedFrom: "chat"` and no explicit scope use the current chat participant audience; `audience: "chat"` requests this explicitly. The canonical service validates the human author and current room membership. Explicit private uploads remain private, and contradictory chat/private options are rejected. Other uploads default to `user-private` for USER/ADMIN, `agent-private` for AGENT, and `global` for OWNER/RUNTIME. GUEST and unresolved callers cannot upload. Chat sharing neither publishes to the internet nor grants mutation authority.
- **Bundled and character documents** are read-only: `getDocumentEditability` and `getDocumentDeleteability` enforce this in the presenter, and the PATCH/DELETE handlers check these flags before proceeding.
- **Image upload.** Images are stored as text. If `includeImageDescriptions: true` is passed in the metadata, the handler calls `runtime.useModel(ModelType.IMAGE_DESCRIPTION, ...)` to generate a description. If the model call fails, a warning is included in the response and the stored text explicitly says that image description was unavailable.
- **YouTube URLs.** `POST /api/documents/url` detects YouTube URLs via `isYouTubeUrl()` from `@elizaos/core` and sets `source: "youtube"` in metadata; the transcript is fetched by `fetchDocumentFromUrl()`.
- **Fragment pagination.** `DocumentService` paginates authorized fragments through the adapter's document-fragment query. Routes must not scan the raw fragment table.
- **Max body size.** Single and bulk upload endpoints cap at 32 MB (`DOCUMENT_UPLOAD_MAX_BODY_BYTES`). Bulk is further capped at 100 documents per request.
- **rawPath routing.** All routes are registered with `rawPath: true`, meaning the agent server dispatches them directly without prefix stripping. The path `/api/documents` is absolute.
- **OWNER_DOCUMENTS is host-adapted.** Do not add a second action here unless the PA-hosted approval, scheduler, and document-request behavior is moved with tests that prove parity.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

## Document pins

The document detail view offers separate reader and pin editors. Pin placement is owner-managed and independent of read permissions: an agent pin applies across its chats, while individual chat pins persist independently. Every save requires the opaque revision returned by the pin read; stale writes return 409 and require a new read and review. The editor preserves saved chat identities missing from the current conversation directory and displays an error if either inventory cannot be loaded.

Core owns persistence and response-context admission. Its automatic pin provider includes a document only when every current chat participant can read it; participant or document changes during preparation require retry. Pinning does not publish a document on the internet or change its readers.
