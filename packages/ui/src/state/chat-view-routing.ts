/**
 * Derives response-context metadata from the currently visible UI surface.
 * The send pipeline consumes this pure routing description so view names,
 * context scopes, and capability hints stay independent of transport state.
 */

import { asRecord } from "@elizaos/shared";
import { readSettingsHashSectionId } from "../components/settings/settings-route";
import { getWindowNavigationPath, type Tab } from "../navigation";
import { getClientBrowserSurface } from "../platform/browser-surface";

const CONTEXT_ROUTING_METADATA_KEY = "__responseContext";

interface ChatViewRouting {
  view: string;
  primaryContext: string;
  secondaryContexts: string[];
  capabilities: string[];
}

function uniq(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value.split(/[\n,;]/);
  }
  return [];
}

function normalizeViewPath(path: string | null | undefined): string {
  const trimmed = path?.trim() ?? "";
  if (!trimmed) return "/";
  const withoutQuery = trimmed.split("?")[0]?.split("#")[0] ?? "/";
  const normalized = withoutQuery.startsWith("/")
    ? withoutQuery
    : `/${withoutQuery}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function dynamicViewNameFromPath(path: string): string {
  const slug = normalizeViewPath(path).split("/").filter(Boolean)[0];
  return slug || "views";
}

export function resolveChatViewRouting(
  tab: Tab,
  navigationPath: string,
): ChatViewRouting {
  const viewPath = normalizeViewPath(navigationPath).toLowerCase();
  // Fullscreen plugin pages keep the shell's generic `views` tab selected.
  // Resolve their real domain from the rendered route before the tab switch so
  // chat and voice turns carry the focused context instead of the broad Apps
  // catalog. This is also the transport-independent path used by deep links,
  // reloads, command navigation, and agent-driven navigation.
  if (viewPath === "/notes" || viewPath.startsWith("/notes/")) {
    return {
      view: "notes",
      primaryContext: "notes",
      secondaryContexts: [],
      capabilities: [],
    };
  }
  if (viewPath === "/calendar" || viewPath.startsWith("/calendar/")) {
    return {
      view: "calendar",
      primaryContext: "calendar",
      secondaryContexts: [],
      capabilities: [],
    };
  }
  if (viewPath === "/wallet" || viewPath.startsWith("/wallet/")) {
    return {
      view: "wallet",
      primaryContext: "wallet",
      secondaryContexts: [],
      capabilities: [],
    };
  }
  if (viewPath === "/apps/tasks" || viewPath.startsWith("/apps/tasks/")) {
    return {
      view: "projects",
      primaryContext: "code",
      secondaryContexts: ["automation"],
      capabilities: [],
    };
  }
  if (viewPath === "/apps/memories" || viewPath.startsWith("/apps/memories/")) {
    return {
      view: "memories",
      primaryContext: "memory",
      secondaryContexts: [],
      capabilities: [],
    };
  }
  if (viewPath === "/orchestrator" || viewPath.startsWith("/orchestrator/")) {
    return {
      view: "orchestrator",
      primaryContext: "code",
      secondaryContexts: ["admin", "documents"],
      capabilities: [
        "orchestrator-task",
        "coding-agent",
        "task-history",
        "workspace-control",
      ],
    };
  }

  switch (tab) {
    case "apps":
      return {
        view: "apps",
        primaryContext: "apps",
        secondaryContexts: ["admin"],
        capabilities: ["launch-app", "stop-app"],
      };
    case "character":
    case "character-select":
      return {
        view: "character",
        primaryContext: "character",
        secondaryContexts: ["documents", "admin"],
        capabilities: ["modify-character", "edit-character-documents"],
      };
    case "documents":
      return {
        view: "character",
        primaryContext: "documents",
        secondaryContexts: ["character"],
        capabilities: ["search-documents", "add-documents", "modify-character"],
      };
    case "automations":
    case "triggers":
      return {
        view: "automations",
        primaryContext: "automation",
        secondaryContexts: ["code", "admin"],
        capabilities: ["manage-cron", "manage-workflow", "run-automation"],
      };
    case "browser":
      return {
        view: "browser",
        primaryContext: "browser",
        secondaryContexts: ["documents"],
        capabilities: ["browser-session", "browse", "extract-page"],
      };
    case "inventory":
      return {
        view: "wallet",
        primaryContext: "wallet",
        secondaryContexts: [],
        capabilities: [],
      };
    case "plugins":
    case "runtime":
    case "database":
    case "logs":
    case "settings":
    case "voice":
      return {
        view: "system",
        primaryContext: "system",
        secondaryContexts: ["documents"],
        capabilities: ["configure-runtime", "inspect-system"],
      };
    case "skills":
    case "trajectories":
    case "relationships":
    case "memories":
      return {
        view: "documents",
        primaryContext: "documents",
        secondaryContexts: ["admin", "social_posting"],
        capabilities: ["documents", "memory", "relationships"],
      };
    case "views":
      return {
        view: dynamicViewNameFromPath(viewPath),
        primaryContext: "apps",
        secondaryContexts: ["admin", "documents"],
        capabilities: [],
      };
    default:
      return {
        view: "chat",
        primaryContext: "general",
        secondaryContexts: [],
        capabilities: ["general-chat"],
      };
  }
}

export function buildChatViewMetadata(
  tab: Tab,
  metadata?: Record<string, unknown>,
  navigationPath = typeof window === "undefined"
    ? "/"
    : getWindowNavigationPath(),
): Record<string, unknown> {
  const normalizedViewPath = normalizeViewPath(navigationPath);
  const viewRouting = resolveChatViewRouting(tab, normalizedViewPath);
  const existingRouting = asRecord(metadata?.[CONTEXT_ROUTING_METADATA_KEY]);
  const secondaryContexts = uniq([
    ...viewRouting.secondaryContexts,
    ...asStringList(existingRouting?.secondaryContexts),
    viewRouting.primaryContext,
  ]);

  const subview = tab === "settings" ? readSettingsHashSectionId() : null;

  return {
    ...(metadata ?? {}),
    uiView: viewRouting.view,
    ...(subview ? { uiViewSubview: subview } : {}),
    uiTab: tab,
    uiViewPath: normalizedViewPath,
    uiBrowserSurface: getClientBrowserSurface(),
    uiViewCapabilities: viewRouting.capabilities,
    uiTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    [CONTEXT_ROUTING_METADATA_KEY]: {
      ...(existingRouting ?? {}),
      primaryContext: viewRouting.primaryContext,
      secondaryContexts,
    },
  };
}
