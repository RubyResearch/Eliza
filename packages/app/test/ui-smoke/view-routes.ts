/**
 * Canonical built-in view route enumeration for the ui-smoke lane.
 *
 * Mirrors the `@elizaos/ui` navigation `TAB_PATHS` table (inlined so the
 * Playwright runner never imports the UI bundle), plus non-tab surfaces such
 * as `/settings/voice`. Consumed by the generic per-view coverage specs —
 * `all-views-interaction.spec.ts` (semantic interaction coverage) and
 * `tap-target-geometry-all-views.spec.ts` (rendered-geometry 44px tap-target +
 * role/DOM coherence gate) — so both walk the exact same set of surfaces.
 * The `all-views-aesthetic-audit.spec.ts` "builtin coverage matches navigation
 * TAB_PATHS" guard asserts this table stays a superset of navigation
 * TAB_PATHS (path agreement on shared ids + every distinct navigation route
 * covered), so a newly added tab fails that suite until it is added here.
 */
export type ViewRoute = { id: string; path: string };

export const VIEW_ROUTES: readonly ViewRoute[] = [
  { id: "chat", path: "/chat" },
  { id: "phone", path: "/phone" },
  { id: "messages", path: "/messages" },
  { id: "contacts", path: "/contacts" },
  { id: "camera", path: "/camera" },
  { id: "tasks", path: "/apps/tasks" },
  { id: "browser", path: "/browser" },
  { id: "stream", path: "/stream" },
  { id: "pendant-transcript", path: "/pendant/transcript" },
  { id: "apps", path: "/apps" },
  { id: "views", path: "/views" },
  { id: "character", path: "/character" },
  { id: "character-select", path: "/character/select" },
  { id: "automations", path: "/automations" },
  { id: "inventory", path: "/wallet" },
  { id: "documents", path: "/character/documents" },
  { id: "character-skills", path: "/character/skills" },
  { id: "experience", path: "/character/experience" },
  { id: "files", path: "/apps/files" },
  { id: "plugins", path: "/apps/plugins" },
  { id: "skills", path: "/apps/skills" },
  { id: "trajectories", path: "/apps/trajectories" },
  { id: "transcripts", path: "/apps/transcripts" },
  { id: "relationships", path: "/apps/relationships" },
  { id: "memories", path: "/apps/memories" },
  { id: "rolodex", path: "/apps/relationships" },
  { id: "voice", path: "/settings/voice" },
  { id: "runtime", path: "/apps/runtime" },
  { id: "database", path: "/apps/database" },
  { id: "desktop", path: "/desktop" },
  { id: "settings", path: "/settings" },
  { id: "vault", path: "/vault" },
  { id: "logs", path: "/apps/logs" },
  { id: "background", path: "/background" },
] as const;
