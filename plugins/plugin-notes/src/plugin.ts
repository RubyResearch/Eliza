/**
 * Runtime declaration for the managed Cloud Notes view: one agent-drivable
 * view backed by a durable per-agent service, delegating navigation and
 * interaction transport to the shared VIEWS system.
 */

import {
  type ContextDefinition,
  type Plugin,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { notesAction } from "./action.js";
import { NOTES_CAPABILITIES } from "./capabilities.js";
import { serverInteract } from "./interact.js";
import { notesProvider } from "./provider.js";
import { notesRoutes } from "./routes.js";
import { NotesService } from "./service.js";
import { NOTES_SURFACE } from "./surface.js";

/**
 * Stage 1 classifies a turn into registered CONTEXTS, not actions: a context
 * the taxonomy lacks is a request Stage 1 cannot name, however well the action
 * itself advertises. Without this entry, "what notes do i have?" classified
 * into documents/contacts/memory and the NOTES action was never a candidate —
 * the read then honestly reported an absence from the wrong store.
 */
const NOTES_CONTEXT: ContextDefinition = {
  id: "notes",
  label: "Notes",
  description:
    "The user's saved Notes records, including temporary or titled notes. All Notes record operations use context notes and a promoted action candidate: create -> NOTES_CREATE; read an exact ID -> NOTES_GET; search, list, or count -> NOTES_LIST; edit or replace -> NOTES_UPDATE; remove -> NOTES_DELETE. Name the matching child instead of the NOTES umbrella so its required fields reach the planner. Explicit Notes records belong here; generic requests to remember durable facts or preferences use memory, and document/file work uses documents. A note is not a todo or calendar event. Add a navigation candidate only when opening the view is also requested: prefer VIEWS_SHOW when available; use VIEWS for layouts or discovery.",
  descriptionCompressed:
    "User's saved notes: write down, read back, search, update, delete",
  sensitivity: "personal",
  cacheScope: "agent",
  roleGate: { minRole: "OWNER" },
};

export const notesPlugin: Plugin = {
  name: "@elizaos/plugin-notes",
  description:
    "Managed Cloud Notes view with durable agent-driven CRUD and view switching.",
  contexts: ["notes"],
  async init(_config, runtime) {
    runtime.contexts.tryRegister(NOTES_CONTEXT);
  },
  actions: [
    ...promoteSubactionsToActions(notesAction, {
      overrides: { get: { similes: ["NOTES_GET_NOTE"] } },
    }),
  ],
  providers: [notesProvider],
  services: [NotesService],
  routes: notesRoutes,
  views: [
    {
      id: "notes",
      label: "Notes",
      roleGate: { minRole: "OWNER" },
      description:
        "Durable notes that the user and agent can create, read, update, and delete.",
      icon: "StickyNote",
      path: "/notes",
      order: 920,
      viewKind: "release",
      modalities: ["gui"],
      tags: [
        "notes",
        "notepad",
        "sticky notes",
        "scratchpad",
        "view switching",
      ],
      responseContext: { primaryContext: "notes" },
      bundlePath: "dist/views/bundle.js",
      componentExport: "NotesView",
      surface: NOTES_SURFACE,
      capabilities: NOTES_CAPABILITIES,
      relatedActions: ["NOTES"],
      serverInteract,
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
  async dispose(runtime) {
    await runtime.getService<NotesService>(NotesService.serviceType)?.stop();
  },
};

export default notesPlugin;
