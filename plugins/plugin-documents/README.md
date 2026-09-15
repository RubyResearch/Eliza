# @elizaos/plugin-documents

Adds a document management REST API and Knowledge app-shell views to an elizaOS agent.

## What it does

This plugin registers HTTP routes on the agent server that let clients (the dashboard UI, other agents, and external tools) upload, retrieve, search, edit, and delete documents from the agent's document store.

Documents are stored as memories in the runtime's `documents` table and chunked into fragments in the `document_fragments` table for vector/semantic search. The plugin handles:

- Uploading text files, markdown, JSON, CSV, images, and other content types
- Fetching and ingesting content from arbitrary URLs or YouTube transcripts
- Bulk uploading up to 100 documents in a single request
- Semantic, keyword, and hybrid search across document fragments
- Listing fragments for a document (ordered by position)
- Editing text-backed documents (replaces content and re-fragments)
- Deleting documents and their fragments
- Access control: `global`, `owner-private`, `user-private`, and `agent-private` document scopes

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/documents` | List documents; supports `scope`, `addedBy`, `tags`, `timeRangeStart/End`, `q` query, `limit`, `offset` |
| GET    | `/api/documents/stats` | Document and fragment counts |
| GET    | `/api/documents/search` | Semantic/keyword/hybrid search; params: `q`, `threshold`, `limit`, `searchMode` |
| GET    | `/api/documents/:id` | Fetch a document with full content |
| GET    | `/api/documents/:id/fragments` | List all text fragments ordered by position |
| POST   | `/api/documents` | Upload a document: `{ content, filename, contentType?, metadata?, scope?, ... }` |
| POST   | `/api/documents/bulk` | Upload up to 100 documents at once |
| POST   | `/api/documents/url` | Ingest a URL or YouTube transcript: `{ url, scope?, metadata? }` |
| PATCH  | `/api/documents/:id` | Update document text (only for non-bundled, non-character, text-backed documents) |
| PATCH  | `/api/documents/:id/access` | Replace explicit entity read grants (OWNER or current room ADMIN) |
| GET    | `/api/documents/:id/access` | Read explicit entity grants under the same management authority |
| GET    | `/api/documents/:id/pins` | Read agent and chat pin placements with their review revision (OWNER) |
| PATCH  | `/api/documents/:id/pins` | Save reviewed agent and chat pin placements without changing read access (OWNER) |
| DELETE | `/api/documents/:id` | Delete document and all its fragments |

## Document scopes

| Scope | Who can read/write |
|-------|--------------------|
| `global` | Current room participants and privileged agent roles; not public internet |
| `owner-private` | OWNER and RUNTIME only |
| `user-private` | Scoped to a specific user entity |
| `agent-private` | OWNER, AGENT, and RUNTIME |

The caller's role comes from the authenticated `AccessContext` supplied by the
host route boundary. A request without that context returns `401`; request
headers and `ELIZA_ADMIN_ENTITY_ID` never create an authenticated caller. Roles
remain exact at this boundary: ADMIN is not OWNER, GUEST is not USER, and an
unresolved role is rejected. Guests may read global documents in rooms where
they are current members, and non-agent-private documents explicitly shared with
their resolved entity identity. They cannot mutate or re-share documents.
List, facet, search, single-document, and fragment reads are resolved by
`DocumentService` with that authenticated context. Routes never fetch a parent
row, scan the document tables, or rank search results and then attempt to apply
authorization locally. List pagination and facet counts are constructed only
from the service-authorized set; fragment counts use the authorized parent and
fragment path.
PATCH and DELETE resolve mutation authority through the same service. Deletes
use the adapter's atomic snapshot operation instead of route-managed fragment
and parent deletion.
Direct grants are independent of room membership for reads, but never grant
mutation authority and never open `agent-private` documents. Grant replacement
is atomic, validates every entity against the current agent, and is limited to
OWNER or a current room ADMIN for `global` and `user-private` documents.

Read `GET /api/documents/:id/access` before editing grants. It returns
`directGrantEntityIds` and an opaque `accessRevision`. Send that revision as
`expectedAccessRevision` with the complete desired grant list in PATCH. A
changed authorization snapshot returns a conflict; reload and review the
current audience before saving again. A successful PATCH does not return a
new review revision, so read the current access state before another edit.

## Sharing knowledge from a chat

A text upload with `addedFrom: "chat"` and no explicit private scope shares with
current participants of its `roomId`. Clients can request the same behavior
with `audience: "chat"`. The authenticated author must be a current member of
that chat with OWNER, ADMIN, or USER authority; guest access remains read-only.
An explicit private scope preserves private storage instead of applying the
chat default. Combining an explicit chat audience with a private scope is an
invalid request.

Chat sharing uses the existing room-scoped `global` storage policy. It does not
publish to the internet, add direct readers, or pin the document. Membership
changes affect subsequent reads. Existing role rules still govern edits;
sharing a document does not grant participants permission to modify it.

Repeated uploads of the same text and filename by the same author in the same
chat reuse the document. Private copies and copies in other chats keep separate
document identities. If its reader policy has changed, a repeated chat upload
returns a conflict and requires reviewing the current policy. The service
checks the author's membership again before completing ingestion.

## Configuration

No additional environment variables are required beyond those needed by the document storage service (`@elizaos/agent`). The plugin uses `ELIZA_ADMIN_ENTITY_ID` (read from the agent runtime settings) to identify the owner actor for access control decisions.

## Enabling the plugin

Add `@elizaos/plugin-documents` to the agent's plugin list in the character configuration or register it programmatically:

```typescript
import { documentsPlugin } from "@elizaos/plugin-documents";

const character = {
  plugins: ["@elizaos/plugin-documents"],
  // ...
};
```

When the package is included in the renderer workspace, its manifest-driven
`src/register.ts` entry auto-registers the `/documents` Knowledge route and
lazy-loads the view bundle. The app shell does not import these feature views
from `@elizaos/ui`.

## Limitations

- Image uploads are converted to text descriptions when `includeImageDescriptions: true` is set in metadata (requires a vision model). Without a generated description, the stored text explicitly records that text extraction or image description was unavailable.
- Bundled documents (seeded by the runtime) and character documents (from character source files) cannot be edited or deleted through this API.
- Bulk upload is capped at 100 documents per request; individual upload bodies are capped at 32 MB.

## Document pins

The document detail view offers separate reader and pin editors. Pin placement is owner-managed and independent of read permissions: an agent pin applies across its chats, while individual chat pins persist independently. Every save requires the opaque revision returned by the pin read; stale writes return 409 and require a new read and review. The editor preserves saved chat identities missing from the current conversation directory and displays an error if either inventory cannot be loaded.

Core owns persistence and response-context admission. Its automatic pin provider includes a document only when every current chat participant can read it; participant or document changes during preparation require retry. Pinning does not publish a document on the internet or change its readers.
