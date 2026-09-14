/**
 * Launcher curation — the single source of truth for what shows in the app
 * launcher.
 *
 * The launcher renders ONE page of view tiles (the home dashboard is the
 * adjacent page). Ordering: the everyday curated apps first, then developer
 * tools (only when Developer Mode is on), then any other loaded plugin app,
 * then — on the AOSP ElizaOS fork — the native-OS tiles.
 *
 * Visibility follows the view-kind taxonomy (`@elizaos/core`): `system` +
 * `release` always show; `developer` and `preview` are hidden by default and
 * appear only when their Settings toggle is on (both default off on every
 * build, dev included, so users and developers see the same launcher out of the
 * box). The curated developer TOOLS (trajectory viewer, database, runtime,
 * logs, skills, plugins) are treated as developer-kind regardless of how each is
 * declared, so the whole set hides together in production.
 *
 * Curation is a blocklist + canonical dedup, not a fixed allow-list: known apps
 * are ordered, grouped sub-pages collapse under their
 * parent tile, duplicate registrations collapse to one tile, and everything else
 * that is genuinely loaded and visible still appears so installing a new plugin
 * app keeps working. Native-OS tiles (phone/messages/contacts/camera/files) only
 * appear on the AOSP ElizaOS fork.
 */

import {
  type EnabledViewKinds,
  isViewKindEnabled,
  resolveViewKind,
} from "@elizaos/core";
import type { ViewEntry } from "../../hooks/view-catalog";
import {
  LAUNCHER_AOSP_ONLY_VIEW_IDS,
  pathForTab,
  STREAM_ENABLED,
} from "../../navigation";
import { getInternalToolAppTargetTab } from "../apps/internal-tool-apps";

/** Everyday apps, in display order. They lead the single launcher page; other
 *  loaded apps append after (alphabetically). */
export const LAUNCHER_APPS_ORDER: readonly string[] = [
  // `chat` is intentionally NOT here — chat is the app's home/primary surface,
  // so a launcher tile for it is pure redundancy; it lives in
  // LAUNCHER_HIDDEN_IDS instead (#14479). The home chat + default landing are
  // untouched.
  "settings",
  "wallet",
  "tasks",
  "calendar",
  // The runtime-backed compact Calendar keeps its own route id so launcher
  // navigation reaches the registered bundle, but occupies Calendar's curated
  // slot when it supersedes the connected-calendar surface below.
  "simple-calendar",
  "notes",
  "automations",
  "browser",
  // Cloud account app — gated to cloud-signed-in sessions below.
  "cloud",
  // Character family — ONE tile. Personality/Relationships/Skills/Experience
  // are sections inside it (CharacterSectionNav strip, #13560/#13591); their
  // standalone tiles live in LAUNCHER_HIDDEN_IDS so the grid shows a single
  // entry point while every /character/* deep link keeps working.
  "character",
  "documents",
  "memories",
  "stream",
  "pendant-transcript",
];

/** Developer-gated launcher surfaces, in display order. Shown on the same
 *  launcher page after the apps, only when Developer Mode is on. The whole set
 *  hides together under the Developer Mode toggle. */
export const LAUNCHER_DEVELOPER_ORDER: readonly string[] = [
  "trajectories",
  "database",
  "runtime",
  "logs",
  "skills",
  "plugins",
];

/**
 * Early-stage surfaces forced to `preview` kind for the launcher regardless of
 * how their views are declared: hidden from the default grid, shown only when
 * the Preview toggle is on. Keeps the out-of-the-box launcher to the everyday
 * core (stream/the pendant transcript are not there yet). Routes stay
 * addressable — this gates the tile, not the view.
 */
export const LAUNCHER_PREVIEW_IDS: ReadonlySet<string> = new Set([
  "stream",
  "pendant-transcript",
]);

/**
 * Native-OS surfaces that only belong on the AOSP ElizaOS fork. Appended to the
 * end of the launcher page when the AOSP shell is active; hidden on web,
 * desktop, iOS, and stock Play-Store Android. Sourced from the canonical
 * `LAUNCHER_AOSP_ONLY_VIEW_IDS` in `../../navigation` so this launcher gate and
 * the router-level `NATIVE_OS_VIEW_IDS` filter never drift.
 */
export const LAUNCHER_AOSP_ONLY_IDS: readonly string[] =
  LAUNCHER_AOSP_ONLY_VIEW_IDS;

/**
 * Views that never appear in the launcher grid:
 *  - shell surfaces reached another way (views/apps launchers; background +
 *    voice are set from Settings/chat; character-select is inline),
 *  - character and cloud sub-pages reached from their parent surface,
 *  - retired app registrations that may still arrive from a stale runtime.
 */
export const LAUNCHER_HIDDEN_IDS: ReadonlySet<string> = new Set([
  "views",
  "views-manager",
  "apps",
  "background",
  "voice",
  "character-select",
  // Character-family sections — reached via the Character tile's section
  // strip (CharacterSectionNav); standalone tiles would triple-tile one hub.
  // The hidden-set check runs on the CANONICAL id, so this also swallows the
  // `rolodex` alias and `@elizaos/app-relationship-viewer`'s targetTab.
  "character-skills",
  "experience",
  "relationships",
  "desktop",
  // `chat` is the home/primary surface, not a launcher tile — a Chat tile is
  // pure redundancy next to the always-present home chat (#14479).
  "chat",
  // Headless agent-capability surface (VIEWS action=interact set-flashlight):
  // it declares no `path` and renders nothing, on any platform, so a tile
  // would open a broken route and push real tiles below the mobile fold.
  "device-control",
  // The Eliza Cloud Applications studio (`cloud-apps`, registered by
  // `@elizaos/app` on native shells). Projects is the ONE apps destination in
  // the launcher: the studio is reached from the Projects view's Apps-segment
  // Eliza Cloud row and by the /cloud-apps deep link, so a second tile next to
  // Projects would double one destination.
  "cloud-apps",
  "companion",
  "model-tester",
  "shopify",
]);

/**
 * Legacy id-alias fallback: duplicate/short-id aliases collapsed onto one
 * canonical launcher id. Kills the double "Wallet" (standalone `wallet` view +
 * `wallet.inventory` app-shell page + builtin `inventory` tab) and double
 * "Automations" (`automations` + `triggers`) tiles, and folds the standalone
 * tasks/todos surfaces into Automations.
 *
 * These are SHORT builtin-tab / view-id aliases only — NOT package names. The
 * Package-name → canonical mappings used to live here as a hand-maintained
 * `@elizaos/...` switch that silently drifted from owning declarations; they
 * now derive
 * from the internal-tool app declarations' own `targetTab` metadata via
 * {@link getInternalToolAppTargetTab} (see `canonicalLauncherId`). This map is
 * the covered legacy host-owned fallback for the remaining id aliases that have
 * no owning declaration.
 */
const LEGACY_ID_ALIAS_FALLBACK: ReadonlyMap<string, string> = new Map([
  ["inventory", "wallet"],
  ["wallet.inventory", "wallet"],
  ["triggers", "automations"],
  ["todos", "automations"],
  // The task-coordinator plugin view + the builtin Tasks tab are the one Tasks
  // orchestrator surface (/apps/tasks); collapse to a single tile.
  ["task-coordinator", "tasks"],
  // My Apps folded into the consolidated Projects surface (#17031): the app
  // inventory is the Apps segment of /apps/tasks, so a stale `my-apps`
  // registration collapses onto the Projects tile instead of resurrecting the
  // retired standalone view.
  ["my-apps", "tasks"],
  ["knowledge", "documents"],
  // Transcripts fold into the one Knowledge multimedia hub (#13594): transcript
  // records surface as the hub's Transcripts media-format facet over the shared
  // knowledge store, so Transcripts is not a separate launcher tile. The
  // `/apps/transcripts` route stays alive as the chrome-minimal live-meeting
  // affordance, reached by deep link, not the launcher. (`files` is the AOSP
  // native file-manager tile and is intentionally NOT folded here; its raw store
  // also flows into the hub as image/audio/video/doc facets.)
  ["transcripts", "documents"],
  ["plugins-page", "plugins"],
  ["trajectory-logger", "trajectories"],
  ["trajectory-viewer", "trajectories"],
  // The legacy contact-book alias shares the Relationships renderer and tile.
  ["rolodex", "relationships"],
  ["log-viewer", "logs"],
  ["database-viewer", "database"],
]);

/**
 * Resolve the canonical launcher id an entry id collapses onto.
 *
 * Precedence:
 *  1. Owner-declared metadata: if `id` is an internal-tool app package name, its
 *     declaration's `targetTab` IS the canonical launcher id (so a package
 *     rename/add flows through with no edit here — the coupling the audit
 *     flagged). This replaces the old hand-kept `@elizaos/...` → canonical
 *     switch.
 *  2. Legacy id-alias fallback: covered short builtin-tab / view-id aliases with
 *     no owning declaration (`inventory`, `triggers`, `rolodex`, …).
 *  3. Identity: the id is already canonical.
 */
export function canonicalLauncherId(id: string): string {
  const declaredTargetTab = getInternalToolAppTargetTab(id);
  if (declaredTargetTab) return declaredTargetTab;
  return LEGACY_ID_ALIAS_FALLBACK.get(id) ?? id;
}

const APPS_INDEX = new Map(LAUNCHER_APPS_ORDER.map((id, i) => [id, i]));
const DEVELOPER_INDEX = new Map(
  LAUNCHER_DEVELOPER_ORDER.map((id, i) => [id, i]),
);
const AOSP_INDEX = new Map(LAUNCHER_AOSP_ONLY_IDS.map((id, i) => [id, i]));

/**
 * Effective view-kind for launcher visibility. A curated developer TOOL
 * (DEVELOPER_INDEX) is developer-kind and a curated preview surface
 * (LAUNCHER_PREVIEW_IDS) is preview-kind regardless of how each view happens to
 * be declared, so each set hides together under its Settings toggle; everything
 * else follows its own declared kind.
 */
function launcherViewKind(canonicalId: string, entry: ViewEntry) {
  if (DEVELOPER_INDEX.has(canonicalId)) return "developer";
  if (LAUNCHER_PREVIEW_IDS.has(canonicalId)) return "preview";
  return resolveViewKind(entry);
}

function isGroupedLauncherSubPage(
  canonicalId: string,
  entry: ViewEntry,
): boolean {
  return entry.group === "wallet" && canonicalId !== "wallet";
}

/**
 * Score competing registrations for the same canonical id so the richest one
 * wins the single tile (a loaded standalone view beats an app-shell alias beats
 * a builtin placeholder).
 */
function preferenceScore(entry: ViewEntry): number {
  let score = 0;
  if (entry.state === "loaded") score += 100;
  if (entry.kind === "view") score += 50;
  if (entry.builtin) score += 10;
  if (canonicalLauncherId(entry.id) === entry.id) score += 20;
  return score;
}

function hasRuntimeBackedSimpleCalendar(entries: ViewEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.id === "simple-calendar" &&
      entry.state === "loaded" &&
      entry.view?.available === true,
  );
}

/**
 * Launcher tiles that require an Eliza Cloud account. Plugin-provided views
 * such as Notes and Calendar are governed by the live view catalogue instead:
 * if a local or Cloud runtime registers them, they belong on the Apps page.
 */
export const LAUNCHER_CLOUD_IDS: ReadonlySet<string> = new Set(["cloud"]);

export interface CurateLauncherOptions {
  /** Include the native-OS tiles (phone/messages/contacts/camera/files). */
  isAosp: boolean;
  /** Which view kinds the user/build has enabled (system+release always on). */
  enabledKinds: EnabledViewKinds;
  /** True when signed into Eliza Cloud; gates cloud-only launcher tiles. */
  cloudActive: boolean;
  /** Build-level Stream visibility. Routes remain addressable when hidden. */
  streamEnabled?: boolean;
}

function comparator(indexes: Array<Map<string, number>>) {
  return (a: ViewEntry, b: ViewEntry): number => {
    for (const index of indexes) {
      const ai = index.get(a.id);
      const bi = index.get(b.id);
      if (ai != null || bi != null) {
        // Curated ids sort by their list order and before uncurated ids.
        if (ai == null) return 1;
        if (bi == null) return -1;
        if (ai !== bi) return ai - bi;
      }
    }
    return a.label.localeCompare(b.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  };
}

/**
 * Curate raw launcher entries into the ordered list of tiles the launcher's
 * single scrolling page renders. Entries are deduped by canonical id;
 * hidden/removed apps are dropped; native-OS tiles are AOSP-gated; developer +
 * preview views (including the curated developer TOOLS) are hidden unless their
 * kind is enabled. Ordering: curated apps first, then developer tools (when
 * shown), then AOSP tiles, then any other loaded app alphabetically. Returns
 * `[]` when nothing is visible.
 */
export function curateLauncherPages(
  entries: ViewEntry[],
  {
    isAosp,
    enabledKinds,
    cloudActive,
    streamEnabled = STREAM_ENABLED,
  }: CurateLauncherOptions,
): ViewEntry[] {
  const byCanonical = new Map<string, ViewEntry>();
  // Simple Views is the product Calendar surface when its live view-registry
  // entry is available. Native clients intentionally strip remote bundle URLs
  // and contribute the bundled component through the in-process app-shell
  // registry, so `view.available` — not bundle transport — is authoritative.
  const connectedCalendarIsPresent = entries.some(
    (entry) =>
      entry.id === "calendar" &&
      entry.state === "loaded" &&
      entry.view?.available !== false,
  );
  const simpleCalendarIsRuntimeBacked = hasRuntimeBackedSimpleCalendar(entries);
  // Each winner's score is frozen at insert time. Re-scoring the STORED entry
  // on later comparisons would hand an alias-winning tile the canonical-id
  // bonus it never earned (its id is rewritten to the canonical id below),
  // making the winner order-dependent: an alias arriving first could then never
  // be displaced by the genuine canonical registration — which is how a stale
  // alias label ("Fin Tuning") could beat the real Fine-Tuning tile.
  const scoreByCanonical = new Map<string, number>();
  for (const entry of entries) {
    if (entry.id === "calendar" && simpleCalendarIsRuntimeBacked) continue;
    if (
      entry.id === "simple-calendar" &&
      connectedCalendarIsPresent &&
      !simpleCalendarIsRuntimeBacked
    ) {
      continue;
    }
    const canonicalId = canonicalLauncherId(entry.id);
    if (canonicalId === "stream" && !streamEnabled) continue;
    if (LAUNCHER_HIDDEN_IDS.has(canonicalId)) continue;
    if (isGroupedLauncherSubPage(canonicalId, entry)) continue;
    // Cloud-only tiles (e.g. the Cloud Applications dashboard) never surface
    // unless the user is signed into Eliza Cloud.
    if (LAUNCHER_CLOUD_IDS.has(canonicalId) && !cloudActive) continue;

    if (AOSP_INDEX.has(canonicalId)) {
      // Native-OS tiles are gated ONLY by the fork (they are OS surfaces, shown
      // on AOSP regardless of the developer/preview toggles); hidden everywhere
      // else — this is the "system ones that are not native" carve-out on web +
      // the mobile app.
      if (!isAosp) continue;
    } else if (
      // Every other tile follows the view-kind taxonomy: system + release always
      // show; developer + preview are hidden unless their toggle is on. The
      // curated developer TOOLS count as developer even if declared otherwise.
      !isViewKindEnabled(launcherViewKind(canonicalId, entry), enabledKinds)
    ) {
      continue;
    }

    const existingScore = scoreByCanonical.get(canonicalId);
    const score = preferenceScore(entry);
    if (existingScore === undefined || score > existingScore) {
      scoreByCanonical.set(canonicalId, score);
      // Preserve the canonical id so navigation + telemetry stay stable even
      // when an aliased registration (e.g. `wallet.inventory`) wins the tile.
      // When the id is REWRITTEN (an alias won), re-point `path` at the canonical
      // tab's own route (`pathForTab`) — NOT the alias route and NOT `undefined`.
      // Leaving it undefined made handleLaunch fall back to `/apps/<canonicalId>`,
      // which for `wallet`/`tasks` is not a real route — it resolved to the apps
      // browse surface (the old AppsView), so those tiles opened the wrong view.
      byCanonical.set(
        canonicalId,
        canonicalId === entry.id
          ? entry
          : { ...entry, id: canonicalId, path: pathForTab(canonicalId) },
      );
    }
  }

  const page = [...byCanonical.values()];
  // One combined order: curated apps, then developer tools, then AOSP tiles,
  // then uncurated apps alphabetically (the comparator falls through to label).
  page.sort(comparator([APPS_INDEX, DEVELOPER_INDEX, AOSP_INDEX]));
  // Normalize every visible label so two tiles can never diverge on
  // whitespace/hyphenation alone (the audit's `Fin Tuning` / `Fine-Tuning`
  // sloppiness). The launcher-label-duplication test asserts this holds.
  return page.map((entry) =>
    entry.label === normalizeLauncherLabel(entry.label)
      ? entry
      : { ...entry, label: normalizeLauncherLabel(entry.label) },
  );
}

/**
 * Canonicalize a tile's display label so registrations that mean the same
 * surface cannot render as visually different tiles. Collapses runs of
 * whitespace (incl. the case where a hyphen was dropped, `Fin Tuning`) and
 * normalizes the surrounding spacing of hyphens/slashes to a single form. This
 * is the display-side complement to {@link canonicalLauncherId}: id dedup folds
 * duplicate *routes* onto one tile; label normalization keeps the one surviving
 * tile's *text* consistent across builds. The launcher-label-duplication test
 * treats the normalized label as the uniqueness key.
 */
export function normalizeLauncherLabel(label: string): string {
  return label
    .replace(/\s*([-/])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
