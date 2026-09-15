# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents. See `README.md` for the surface
overview and `../../CLAUDE.md` (repo root) for monorepo-wide rules.

## Role

Owns the calendar domain extracted from `@elizaos/plugin-personal-assistant`: the calendar
event/sync store + schema, the Google + Apple calendar feed, event CRUD, the
`CALENDAR` action and its LLM handler, the shared calendar route dispatcher,
the provider-authenticated Google webhook, the client API methods augmented
onto `@elizaos/ui`, and the owner-facing calendar views. Private
`/api/lifeops/calendar/*` routes are mounted by the personal-assistant host
behind its OWNER/ADMIN role gate.

## Boundary rules

- **Storage + provider logic live here.** The cross-connector **grant registry**
  (Google account selection, scopes, multi-account) stays in `plugin-personal-assistant`,
  which injects a `CalendarConnectorGate` into `CalendarService` at init. Never
  import `@elizaos/plugin-personal-assistant` from this package — the dependency direction
  is `plugin-personal-assistant -> plugin-calendar`.
- **Schema namespace is `app_calendar`.** Calendar events and sync states were
  carved out of PA's `app_lifeops` schema; ICS sources, the durable secret
  cleanup outbox, feed preferences, and Google watch channels are
  calendar-native tables. `calendarPgSchema = pgSchema("app_calendar")` is
  registered via the plugin `schema` field, and `CalendarMigrationService`
  performs a non-destructive one-time reconciliation of existing `app_lifeops`
  rows only into empty owner tables without completed migration claims. Fresh
  imports verify the full projection; established owner rows and deletions remain
  authoritative, and legacy sources are never dropped. Requires
  `@elizaos/plugin-sql` loaded first. Raw SQL
  must qualify table names with the `app_calendar.` prefix.
- **Contract types live in `@elizaos/shared/contracts/calendar`** so `@elizaos/ui`
  (which types its `client` against them) and the plugins can both depend on them
  without a cycle.
- **Logger only, never `console`.** Prefix with `[ClassName]`.

## Layout

```
src/
  plugin.ts          Plugin definition (action, service, provider webhook)
  index.ts           Public exports
  service/           CalendarService + connector gate + repository + schema
  apple-calendar.ts  Native Apple Calendar bridge
  actions/           CALENDAR action + handler
  routes/            Shared host adapter + Google push webhook
  api/               client-calendar.ts (side-effect client augmentation)
  components/        Calendar views + event editor (React)
  hooks/             useCalendarWeek
  internal/          Shared utilities (normalize, format, sql helpers, errors, constants)
  ui.ts              UI entry (side-effectful)
```

## Commands

```bash
bun run --cwd plugins/plugin-calendar build
bun run --cwd plugins/plugin-calendar build:types
bun run --cwd plugins/plugin-calendar test
bun run --cwd plugins/plugin-calendar typecheck
```

## Google push configuration

- `GOOGLE_CALENDAR_WEBHOOK_ENABLED` must be exactly `true` before the public
  callback or watch creation is active; omission is fail-closed.
- `GOOGLE_CALENDAR_WEBHOOK_URL` must be a public HTTPS URL with the exact
  `/api/lifeops/calendar/google/webhook` path.

## Verification

Follow the repository-wide verification and evidence standard in the [root CLAUDE.md](../../CLAUDE.md). Run
the package's relevant build, typecheck, lint, and test commands, then exercise
the real integration boundary changed by the work. Inspect the produced domain
artifacts and failure behavior; do not substitute mocked success for the system
under test.

Calendar feed and event-search promoted tools use operation-specific details schemas authored in the calendar leaf module. Preserve all consumed range, timezone, calendar/connector selection, refresh and search-query aliases, plus original optionality and owner gates. Parent, trip and mutation schemas retain their full contracts; never narrow them by applying a read-only schema globally.
