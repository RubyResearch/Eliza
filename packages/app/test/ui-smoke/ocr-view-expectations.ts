/**
 * Closed semantic OCR contracts for every view in the app aesthetic audit.
 * Positive labels come from designed view states; universal
 * developer-string and placeholder rejection remains in `ocr-content-rules`.
 * Typed exemptions retain a fallback expectation, so they waive only ownership
 * of distinct view semantics rather than pixel correctness.
 */
import type { OcrExpectation } from "./ocr-content-rules";

export interface SemanticOcrExpectationPolicy {
  kind: "expectation";
  expectation: OcrExpectation;
}

export interface SemanticOcrExemptionPolicy {
  kind: "semantic-exemption";
  applicability: "native-platform-gated" | "unregistered-remote-bundle";
  reason: string;
  /** Observable browser fallback that must still render without semantic drift. */
  fallbackExpectation: OcrExpectation;
}

export type ViewOcrPolicy =
  | SemanticOcrExpectationPolicy
  | SemanticOcrExemptionPolicy;

function expected(expectation: OcrExpectation): SemanticOcrExpectationPolicy {
  return { kind: "expectation", expectation };
}

function exempt(
  applicability: SemanticOcrExemptionPolicy["applicability"],
  reason: string,
  fallbackExpectation: OcrExpectation,
): SemanticOcrExemptionPolicy {
  return {
    kind: "semantic-exemption",
    applicability,
    reason,
    fallbackExpectation,
  };
}

const LAUNCHER_FALLBACK: OcrExpectation = {
  requireAll: ["Settings", "Wallet"],
  requireAny: ["Projects", "Calendar", "Automations"],
};

const VIEW_REGISTRY_FALLBACK: OcrExpectation = {
  requireAll: ["Views", "Refresh"],
  requireAny: ["ready views", "gui ready"],
};

const VIEW_UNAVAILABLE_FALLBACK: OcrExpectation = {
  requireAll: [
    "View unavailable",
    "This app is unavailable here",
    "Install or enable it",
    "App",
  ],
  requireAny: ["Retry", "Back to views"],
};

export const VIEW_OCR_POLICIES = {
  "builtin-chat": expected({
    requireAny: [
      "Mostly clear",
      "Learn conversational Spanish",
      "Submit the quarterly report",
    ],
  }),
  "builtin-camera": exempt(
    "native-platform-gated",
    "The camera is an AOSP-native surface, so the browser audit intentionally renders the truthful unavailable state.",
    VIEW_UNAVAILABLE_FALLBACK,
  ),
  "builtin-tasks": expected({
    requireAll: ["Tasks"],
  }),
  "builtin-browser": expected({
    requireAny: [
      "Enter a URL",
      "Open a website",
      "No browser tabs yet",
      "Browser Bridge",
      "Summarize a page",
      "Search the web",
    ],
  }),
  "builtin-stream": expected({
    requireAny: ["Stream Ready", "GO LIVE", "Go Live", "OFFLINE"],
  }),
  "builtin-pendant-transcript": expected({
    requireAll: ["Pendant Transcript"],
    requireAny: [
      "No transcript segments yet",
      "Local offline cache",
      "Connect",
    ],
  }),
  "builtin-apps": expected({
    requireAll: ["Apps"],
    requireAny: [
      "elizaOS apps",
      "Advanced",
      "Load",
      "No apps installed",
      "Create new app",
      "Install, create",
    ],
  }),
  "builtin-views": expected(LAUNCHER_FALLBACK),
  "builtin-character": expected({
    requireAny: ["Personality", "Relationships", "Knowledge", "Skills"],
  }),
  "builtin-relationships": expected({
    requireAll: ["Relationships"],
    requireAny: ["People", "Organizations"],
  }),
  "builtin-character-select": expected({
    requireAny: [
      "Name",
      "System prompt",
      "About Me",
      "Style Rules",
      "Chat Examples",
      "Post Examples",
      "You are",
    ],
  }),
  "builtin-automations": expected({
    requireAll: ["Show"],
    requireAny: [
      "Nothing scheduled yet",
      "Active",
      "Prompts",
      "Tasks",
      "Workflows",
      "Inactive",
      "New",
    ],
  }),
  "builtin-workflow-studio": expected({
    requireAny: ["New workflow", "Run", "Build", "Schedule", "smthrs"],
  }),
  "builtin-inventory": expected({
    requireAny: ["Wallet", "USDC", "Tokens", "Perps"],
  }),
  "builtin-documents": expected({
    requireAll: ["Library", "Add"],
    requireAny: ["Docs", "No documents yet"],
  }),
  "builtin-character-skills": expected({
    requireAll: ["Skills"],
    requireAny: ["proposed", "active", "abilities", "Browse the catalog"],
  }),
  "builtin-experience": expected({
    requireAll: ["Experience"],
    requireAny: ["Captured", "Avg importance", "need review"],
  }),
  "builtin-files": expected({
    requireAny: ["No files yet", "Documents", "Images", "Search files"],
  }),
  "builtin-plugins": expected({
    requireAny: ["Plugin Catalog", "Search plugins", "Providers"],
  }),
  "builtin-skills": expected({
    requireAny: [
      "Skills",
      "Browse Marketplace",
      "No Skills Installed",
      "Search skills",
    ],
  }),
  "builtin-trajectories": expected({
    requireAny: ["No trajectories yet", "No recorded activity yet", "Browse"],
  }),
  "builtin-transcripts": expected({
    requireAll: ["Live meeting"],
    requireAny: [
      "Paste a Meet",
      "Teams",
      "Zoom link",
      "Join meeting",
      "No transcripts yet",
      "transcribe",
      "recordings",
    ],
  }),
  "builtin-memories": expected({
    requireAny: [
      "No memories yet",
      "Facts",
      "Browse",
      "Memories",
      "Feed",
      "Import",
      "Filter by type",
    ],
  }),
  "builtin-rolodex": expected({
    requireAny: ["People", "Organizations", "Graph"],
  }),
  "builtin-runtime": expected({
    requireAny: ["Plugins", "Actions", "Providers"],
  }),
  "builtin-database": expected({
    requireAny: [
      "Databases",
      "Tables",
      "SQL Editor",
      "Select a table",
      "Open SQL editor",
      "Filter tables",
    ],
  }),
  "builtin-desktop": expected({
    requireAll: ["Desktop"],
    requireAny: ["Desktop workspace", "Electrobun desktop runtime"],
  }),
  "builtin-settings": expected({
    requireAny: ["Models & Providers", "Voice", "Appearance", "Basics"],
  }),
  "builtin-vault": expected({
    // The shared title bar is intentionally absent; verify the visible
    // credential workspace description rather than requiring a removed title.
    requireAll: ["Encrypted credentials", "references"],
  }),
  "builtin-logs": expected({
    requireAny: ["INFO", "smoke", "All levels", "Search logs", "All tags"],
  }),
  "builtin-background": expected({
    requireAll: ["Misty Forest", "Desert Dusk"],
    requireAny: ["Ocean Deep", "Alpine Dawn", "Ember Night"],
  }),
  "plugin-cloud-gui": expected({
    requireAll: ["Connected", "Credits"],
    requireAny: ["Hosted agents", "API keys"],
  }),
  // Preserve the disconnected state as a separate production-bundle capture;
  // connected account fixtures must not erase sign-in recovery coverage.
  "plugin-cloud-signed-out-gui": expected({
    requireAll: ["Connect to view credits", "Connect in Settings"],
    requireAny: [
      "credits",
      "hosted agents",
      "API keys",
      "billing",
      "Connect in Settings",
    ],
  }),
  "plugin-contacts-gui": expected({
    requireAny: ["address book", "phone, or email", "search"],
  }),
  "plugin-focus-gui": expected({
    requireAll: ["No focus session active"],
  }),
  "plugin-calendar-gui": expected({
    requireAny: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
  }),
  "plugin-family-interview-gui": expected({
    requireAny: [
      "Your update",
      "Fill missing information",
      "School and activities",
    ],
    forbid: [
      "Sources are unavailable",
      "Could not load selected correspondence",
    ],
  }),
  "plugin-family-operations-gui": expected({
    requireAny: ["Family Operations", "Private owner workspace"],
  }),
  "plugin-computer-use-sessions-gui": expected({
    requireAll: ["Computer sessions", "Linux sandbox"],
    requireAny: [
      "Research",
      "Browser",
      "Sequence 12",
      "Cursor 640, 360",
      "Open floating",
    ],
    forbid: ["Loading sessions", "unavailable"],
  }),
  "plugin-finances-gui": expected({
    requireAny: ["Balance", "Transactions", "Recurring"],
    forbid: ["Loading"],
  }),
  "plugin-goals-gui": expected({
    requireAny: ["Active", "needs a review", "paused"],
  }),
  "plugin-lifeops-live-test-gui": exempt(
    "unregistered-remote-bundle",
    "The LifeOps live-test GUI has no remote bundle in the hermetic browser audit, so the view-registry fallback is the only observable surface.",
    VIEW_REGISTRY_FALLBACK,
  ),
  "plugin-health-gui": expected({
    requireAny: ["Last sleep", "Regularity", "Baseline"],
  }),
  "plugin-inbox-gui": expected({
    requireAny: ["needs a reply", "Email", "Discord"],
  }),
  "plugin-relationships-gui": expected({
    requireAny: ["People", "Organizations", "Graph"],
  }),
  "plugin-todos-gui": expected({
    requireAny: ["Today", "Upcoming", "Someday"],
  }),
  "plugin-messages-gui": expected({
    requireAny: ["Set default SMS", "bridge-only", "compose"],
  }),
  "plugin-maps-gui": expected({
    requireAll: ["Find somewhere worth going"],
    requireAny: ["provider-neutral", "Search a place"],
    forbid: ["Google Maps", "Mapbox"],
  }),
  "plugin-phone-gui": expected({
    requireAny: ["call-blocked", "dialer", "recent"],
  }),
  "plugin-wallet-gui": expected({
    requireAny: ["Tokens", "RPC", "ETH", "SOL"],
  }),
  "plugin-views-manager-gui": expected({
    requireAll: ["Views", "Refresh"],
    requireAny: ["ready views", "gui ready"],
  }),
  "plugin-notes-gui": expected({
    requireAll: ["Launch checklist", "Follow up"],
    requireAny: ["Cloud agent", "demo recording"],
  }),
  "plugin-task-coordinator-gui": expected({
    requireAny: ["Dispatch a coding agent", "search tasks", "tasks"],
  }),
  "plugin-orchestrator-gui": expected({
    requireAll: ["Orchestrator"],
  }),
  "plugin-cockpit-gui": exempt(
    "unregistered-remote-bundle",
    "The Cockpit GUI has no remote bundle in the hermetic browser audit, so the truthful unavailable state is the only observable surface.",
    VIEW_UNAVAILABLE_FALLBACK,
  ),
  "plugin-trajectory-logger-gui": expected({
    requireAny: ["Back to apps", "HANDLE", "PLAN"],
  }),
} as const satisfies Record<string, ViewOcrPolicy>;

export function resolveViewOcrPolicy(slug: string): ViewOcrPolicy {
  if (!Object.hasOwn(VIEW_OCR_POLICIES, slug)) {
    throw new Error(`No semantic OCR policy declared for audited view ${slug}`);
  }
  return VIEW_OCR_POLICIES[slug as keyof typeof VIEW_OCR_POLICIES];
}
