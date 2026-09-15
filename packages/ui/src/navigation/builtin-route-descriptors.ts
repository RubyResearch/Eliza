/**
 * Defines the ordered, React-free route contract for every host-owned tab.
 * Navigation paths and shell metadata derive from this table; aliases name a
 * canonical route and cannot redeclare its layout or surface policy.
 */

import {
  IMMERSIVE_WALLPAPER_SURFACE,
  type PageLayoutManifest,
  type SurfaceManifest,
} from "@elizaos/core";

/** A route-sensitive surface policy used by launcher roots with opaque children. */
export interface BuiltinRouteConditionalSurface {
  readonly shared: (trimmedNavigationPath: string) => boolean;
}

/** Surface policy declared by a host-owned route. */
export type BuiltinRouteSurfaceDeclaration =
  | SurfaceManifest
  | BuiltinRouteConditionalSurface;

interface CanonicalBuiltinRouteDescriptor {
  readonly path: string;
  readonly layout: PageLayoutManifest;
  /** Retired browser paths that redirect to this canonical route. */
  readonly legacyPaths?: readonly string[];
  readonly surface?: BuiltinRouteSurfaceDeclaration;
  /** Dynamic children composed by this builtin's host-owned renderer. */
  readonly dynamicChildren?: readonly BuiltinDynamicViewDescriptor[];
}

interface BuiltinDynamicViewDescriptor {
  readonly viewId: string;
  readonly bundleUrl: string;
  readonly componentExport: string;
}

export const DATABASE_VECTOR_VIEW = Object.freeze({
  viewId: "vector-browser",
  bundleUrl: "/api/views/vector-browser/bundle.js",
  componentExport: "VectorBrowserView",
});

interface BuiltinRouteAliasDescriptor {
  readonly aliasOf: string;
}

type BuiltinRouteDescriptorSeed =
  | CanonicalBuiltinRouteDescriptor
  | BuiltinRouteAliasDescriptor;

type InvalidAliasIds<
  Routes extends Record<string, BuiltinRouteDescriptorSeed>,
> = {
  [Id in keyof Routes]: Routes[Id] extends {
    readonly aliasOf: infer Target;
  }
    ? Target extends Exclude<keyof Routes, Id>
      ? Routes[Target] extends BuiltinRouteAliasDescriptor
        ? Id
        : never
      : Id
    : never;
}[keyof Routes];

function defineBuiltinRoutes<
  const Routes extends Record<string, BuiltinRouteDescriptorSeed>,
>(
  routes: Routes,
  ...invalidAliases: InvalidAliasIds<Routes> extends never
    ? []
    : ["Invalid builtin route aliases", InvalidAliasIds<Routes>]
): Routes {
  if (invalidAliases.length > 0) {
    throw new Error("Invalid builtin route alias declaration");
  }
  return routes;
}

const CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "view",
  gutter: "standard",
});

const SHELL_CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "shell",
  gutter: "standard",
});

const SHELL_WIDE_CONTENT_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "wide",
  scroll: "shell",
  gutter: "standard",
});

const WORKSPACE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "workspace",
  width: "wide",
  scroll: "view",
  gutter: "standard",
});

/** Routes whose rendered view owns its canonical FramedPage width and gutter. */
const FRAMED_PAGE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "content",
  width: "standard",
  scroll: "view",
  gutter: "none",
});

const FULL_WORKSPACE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "workspace",
  width: "full",
  scroll: "view",
  gutter: "none",
});

const IMMERSIVE_LAYOUT: PageLayoutManifest = Object.freeze({
  kind: "immersive",
  width: "full",
  scroll: "view",
  gutter: "none",
});

const AMBIENT_IMMERSIVE_LAYOUT: PageLayoutManifest = Object.freeze({
  ...IMMERSIVE_LAYOUT,
  topology: "ambient",
});

/**
 * Ordered route descriptors for built-in tabs. Order is retained for callers
 * that enumerate {@link TAB_PATHS}; it matches the historical navigation map.
 */
export const BUILTIN_ROUTE_DESCRIPTORS = defineBuiltinRoutes({
  chat: {
    path: "/chat",
    legacyPaths: ["/home"],
    layout: AMBIENT_IMMERSIVE_LAYOUT,
    surface: IMMERSIVE_WALLPAPER_SURFACE,
  },
  phone: { path: "/phone", layout: FULL_WORKSPACE_LAYOUT },
  messages: { path: "/messages", layout: FULL_WORKSPACE_LAYOUT },
  contacts: { path: "/contacts", layout: WORKSPACE_LAYOUT },
  camera: { path: "/camera", layout: FULL_WORKSPACE_LAYOUT },
  tasks: { path: "/apps/tasks", layout: FRAMED_PAGE_LAYOUT },
  browser: {
    path: "/browser",
    layout: FULL_WORKSPACE_LAYOUT,
    surface: {
      isolation: "native-webview",
      background: "opaque",
      header: "fullscreen",
    },
  },
  stream: { path: "/stream", layout: CONTENT_LAYOUT },
  "pendant-transcript": {
    path: "/pendant/transcript",
    layout: CONTENT_LAYOUT,
  },
  apps: {
    path: "/apps",
    layout: IMMERSIVE_LAYOUT,
    surface: { shared: (path) => path === "/apps" },
  },
  views: {
    path: "/views",
    layout: IMMERSIVE_LAYOUT,
    surface: { shared: (path) => path === "/views" },
  },
  character: { path: "/character", layout: FRAMED_PAGE_LAYOUT },
  "character-select": {
    path: "/character/select",
    layout: FRAMED_PAGE_LAYOUT,
  },
  automations: { path: "/automations", layout: FRAMED_PAGE_LAYOUT },
  triggers: { aliasOf: "automations" },
  inventory: { path: "/wallet", layout: SHELL_WIDE_CONTENT_LAYOUT },
  documents: {
    path: "/character/documents",
    layout: WORKSPACE_LAYOUT,
    legacyPaths: ["/documents", "/knowledge"],
  },
  files: { path: "/apps/files", layout: SHELL_CONTENT_LAYOUT },
  plugins: { path: "/apps/plugins", layout: WORKSPACE_LAYOUT },
  skills: { path: "/apps/skills", layout: WORKSPACE_LAYOUT },
  trajectories: { path: "/apps/trajectories", layout: WORKSPACE_LAYOUT },
  transcripts: { path: "/apps/transcripts", layout: CONTENT_LAYOUT },
  relationships: {
    path: "/apps/relationships",
    layout: WORKSPACE_LAYOUT,
    legacyPaths: ["/rolodex"],
  },
  experience: { path: "/character/experience", layout: FRAMED_PAGE_LAYOUT },
  "character-skills": {
    path: "/character/skills",
    layout: FRAMED_PAGE_LAYOUT,
  },
  memories: {
    path: "/apps/memories",
    layout: FRAMED_PAGE_LAYOUT,
    surface: { background: "opaque" },
  },
  rolodex: { aliasOf: "relationships" },
  runtime: { path: "/apps/runtime", layout: WORKSPACE_LAYOUT },
  database: {
    path: "/apps/database",
    layout: FRAMED_PAGE_LAYOUT,
    dynamicChildren: [DATABASE_VECTOR_VIEW],
  },
  desktop: { path: "/desktop", layout: FULL_WORKSPACE_LAYOUT },
  settings: { path: "/settings", layout: FULL_WORKSPACE_LAYOUT },
  vault: { path: "/vault", layout: FRAMED_PAGE_LAYOUT },
  logs: { path: "/apps/logs", layout: CONTENT_LAYOUT },
  background: {
    path: "/background",
    layout: IMMERSIVE_LAYOUT,
    surface: IMMERSIVE_WALLPAPER_SURFACE,
  },
} as const);

/** Built-in tab identifiers derived from the route authority. */
export type BuiltinTab = keyof typeof BUILTIN_ROUTE_DESCRIPTORS;

/** Built-in ids that own renderers rather than inheriting one through an alias. */
export type CanonicalBuiltinTab = {
  [Id in BuiltinTab]: (typeof BUILTIN_ROUTE_DESCRIPTORS)[Id] extends BuiltinRouteAliasDescriptor
    ? never
    : Id;
}[BuiltinTab];

/** A canonical descriptor after alias inheritance has been applied. */
export interface ResolvedBuiltinRouteDescriptor
  extends CanonicalBuiltinRouteDescriptor {
  readonly id: BuiltinTab;
  readonly canonicalId: CanonicalBuiltinTab;
}

const BUILTIN_ROUTE_BY_ID: Readonly<
  Record<string, BuiltinRouteDescriptorSeed>
> = BUILTIN_ROUTE_DESCRIPTORS;

/** Built-in ids in stable declaration order, including compatibility aliases. */
export const BUILTIN_ROUTE_IDS = Object.freeze(
  Object.keys(BUILTIN_ROUTE_DESCRIPTORS) as BuiltinTab[],
);

/** Resolve a built-in route and inherit every classified field through aliases. */
export function resolveBuiltinRouteDescriptor(
  id: string,
): ResolvedBuiltinRouteDescriptor | null {
  const descriptor = BUILTIN_ROUTE_BY_ID[id];
  if (!descriptor) return null;

  if ("aliasOf" in descriptor) {
    const canonical = BUILTIN_ROUTE_BY_ID[descriptor.aliasOf];
    if (!canonical || "aliasOf" in canonical) {
      throw new Error(
        `Builtin route alias "${id}" has invalid target "${descriptor.aliasOf}"`,
      );
    }
    return {
      id: id as BuiltinTab,
      canonicalId: descriptor.aliasOf as CanonicalBuiltinTab,
      ...canonical,
    };
  }

  return {
    id: id as BuiltinTab,
    canonicalId: id as CanonicalBuiltinTab,
    ...descriptor,
  };
}

/** Map every built-in id without introducing another hand-maintained key list. */
export function mapBuiltinRoutes<Value>(
  select: (descriptor: ResolvedBuiltinRouteDescriptor) => Value,
): Record<BuiltinTab, Value> {
  return Object.fromEntries(
    BUILTIN_ROUTE_IDS.map((id) => {
      const descriptor = resolveBuiltinRouteDescriptor(id);
      if (!descriptor) {
        throw new Error(`Builtin route "${id}" has no descriptor`);
      }
      return [id, select(descriptor)];
    }),
  ) as Record<BuiltinTab, Value>;
}
