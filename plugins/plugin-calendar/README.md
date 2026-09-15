# @elizaos/plugin-calendar

First-class calendar plugin for elizaOS agents. Owns the calendar domain that
previously lived inside `@elizaos/plugin-personal-assistant`:

- **Calendar feed** aggregated across Google Calendar (via `@elizaos/plugin-google-workspace`),
  delegated Microsoft 365/Outlook accounts (via Microsoft Graph), guarded
  ICS/webcal subscriptions, and Apple Calendar (native macOS/iOS bridge via
  `@elizaos/capacitor-calendar`).
- **Event CRUD** — create / update / delete events through the writable Google
  and Apple providers. Microsoft and ICS sources are intentionally read-only.
- **Guest free/busy** — privacy-minimized Google free/busy and Microsoft Graph
  `getSchedule` queries return anonymous intervals or explicit unknown states.
- **CALENDAR action** — natural-language calendar read/write and scheduling.
- **HTTP boundary** — a shared `/api/lifeops/calendar/*` dispatcher mounted by
  the personal-assistant host behind its OWNER/ADMIN role gate, plus the
  provider-authenticated Google change-notification webhook registered here.
- **Client API** — `client.getLifeOpsCalendarFeed` / `createLifeOpsCalendarEvent` / …
  augmented onto the `@elizaos/ui` client.
- **Owner-facing views** — week / day / month / agenda calendar UI and the event
  editor drawer.

## Boundary

The calendar **storage and provider logic** live here. Google grants and
cross-domain reminder/audit hooks are supplied through the host
`CalendarConnectorGate`. Microsoft account identity comes from the runtime's
`ConnectorAccountManager`; OAuth material remains behind durable secret
references and the calendar-owned Graph port. Apple and ICS keep their existing
native and guarded-source boundaries.

Calendar **contract types** (`LifeOpsCalendarEvent`, `LifeOpsCalendarFeed`, …)
live in `@elizaos/shared/contracts/calendar` because the contract layer is the
only package both `@elizaos/ui` and the plugins can depend on without a cycle.

## Microsoft account contract

The host acquires delegated OAuth consent and registers a connected
`ConnectorAccount` with provider `microsoft`. Account metadata records the
granted scopes plus `accountKind` or `tenantId`; calendar derives capabilities
from those scopes instead of assuming permission. Calendar discovery needs
`Calendars.ReadBasic`, event delta sync needs `Calendars.Read`, and
organization-account guest free/busy uses `getSchedule` with
`Calendars.ReadBasic`. Microsoft does not support delegated `getSchedule` for
personal accounts, so those queries return an explicit unavailable state.

Access and refresh tokens must be stored behind connector-account credential
references (`oauth.access_token`, `oauth.refresh_token`, or a JSON
`oauth.tokens` reference) in a registered secret service. Plaintext token
metadata is rejected. The resolver refreshes expiring credentials when the
runtime supplies `MICROSOFT_CLIENT_ID` (and, for confidential clients,
`MICROSOFT_CLIENT_SECRET`); missing readers, writers, refs, or client
configuration fail explicitly rather than producing an empty feed.

## Commands

```bash
bun run --cwd plugins/plugin-calendar build       # tsup + views + types
bun run --cwd plugins/plugin-calendar build:types  # declaration emit
bun run --cwd plugins/plugin-calendar test         # vitest
bun run --cwd plugins/plugin-calendar typecheck    # tsgo --noEmit
```

See the root `AGENTS.md` for repo-wide architecture rules.

## Linked-event review

The owner-only linked-calendar list accepts `?view=events` to include each
local event's current title and dates. Missing local events remain visible with
`event: null`; database failures remain errors. The ordinary list response stays
unchanged. Family Operations uses this view for recognizable event headings and
keeps provider identifiers in expandable connection details.
