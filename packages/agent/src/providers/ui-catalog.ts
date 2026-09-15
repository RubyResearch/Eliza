/** Provider-owned chat references. Direct text turns receive discovery notices
 * until the model requests full syntax. Bodies stay complete for retrieval;
 * channel and role gates still apply. No historical keyword activates a guide.
 */
import {
  ChannelType,
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { getValidationKeywordTerms } from "@elizaos/shared";
import { COMPONENT_CATALOG } from "../shared/ui-catalog-prompt.ts";

// Core components to describe in detail — subset to keep context short.
const DETAIL_COMPONENTS = new Set([
  "Card",
  "Stack",
  "Grid",
  "Text",
  "Button",
  "Input",
  "Select",
  "Textarea",
  "Badge",
  "Metric",
  "Separator",
  "Progress",
  "Table",
  "Alert",
  "Tabs",
]);

/** Marker guides render inline in chat surfaces only — never on group/feed channels. */
function isAllowedChannel(message: Memory): boolean {
  const channelType = message.content.channelType;
  return (
    channelType === ChannelType.DM ||
    channelType === ChannelType.API ||
    !channelType
  );
}

/**
 * The canonical marker vocabulary. Grammar examples are load-bearing: the
 * followups/form blocks must keep matching the UI parsers exactly
 * (`ui-catalog.followups.test.ts` pins them against the parser regexes), and
 * the budget test caps this text so it cannot silently regrow.
 */
export const UI_WIDGETS_GUIDE = `## In-chat widgets — canonical markers you can emit in replies

### [CONFIG:pluginId] — plugin configuration card
Emit EXACTLY this marker whenever a plugin comes up in setup/config/status
(e.g. [CONFIG:discord], [CONFIG:openai]). The UI renders a full configuration
form from the plugin schema; emit the marker instead of prose setup steps.
### [CONNECTOR:pluginId] — compact connect-a-service card
On "connect X": confirm via [CHOICE:connector-add] (Add-it / Not-now), then on
accept emit [CONNECTOR:x] + one closing line ("Tap the card to sign in.").
The card shows icon + description + one Authorize/Add-token button. NEVER ask
for tokens or paste auth links in chat text; the card handles both masked.

### [FOLLOWUPS] — 2–4 tappable next steps (optional)
Use ONLY when a follow-up genuinely helps. Emit INLINE, one
\`<kind>:<payload>=<label>\` per line:
[FOLLOWUPS]
reply:Summarize my unread messages=Summarize unread
navigate:/apps/tasks=View tasks
prompt:Draft a reply about =Draft a reply
[/FOLLOWUPS]
Kinds: reply sends <payload>; navigate opens a "/" route or view id; prompt
prefills the composer. Labels 1–4 words. Omit when no useful next step exists.

### [CHOICE:<scope>] — pick one from concrete options
Use when 2+ explicit choices remove typing or ambiguity. Emit \`<value>=<label>\` per line; tapped value is sent as the user's next message.
Values use the actual option's stable identity; never invent IDs. Labels name each actual option (title plus distinguishing ID when needed), never generic A/B placeholders:
[CHOICE:note-selection id=note-choice-123]
Select note note_123=Travel checklist (note_123)
Select note note_456=Travel checklist (note_456)
[/CHOICE]

### [FORM] — collect several specific values at once
Render a form instead of asking in prose when a tool needs 2+ missing fields.
Emit INLINE; body is one JSON object on its own line between the markers:
[FORM]
{"title":"Schedule reminder","submitLabel":"Create","fields":[{"name":"title","type":"text","label":"Reminder","required":true},{"name":"when","type":"datetime","label":"When","required":true},{"name":"channel","type":"select","label":"Notify via","options":[{"label":"Push","value":"push"},{"label":"Email","value":"email"}]}]}
[/FORM]
Field types: text | number | select (needs options) | checkbox | date | time |
datetime (prefer temporal types for schedules; field names start with a letter).
NEVER use [FORM] for secrets or API keys. For one free-text answer, just ask.

### [CHECKLIST] — live todo list while you work through steps
[CHECKLIST]
{"title":"Migration","items":[{"content":"Back up the database","status":"completed"},{"content":"Run the migration","status":"in_progress"},{"content":"Verify downstream consumers","status":"pending"}]}
[/CHECKLIST]
Item status: pending | in_progress | completed. Re-emit the WHOLE block with
updated statuses. A coding/orchestrator task surfaces its own plan.

### [WORKFLOW] — ordered k/N step pipeline
[WORKFLOW]
{"title":"Deploy","steps":[{"label":"Build image","status":"done"},{"label":"Push to registry","status":"running"},{"label":"Roll out","status":"pending"}]}
[/WORKFLOW]
Step status: pending | running | done | failed. Re-emit to advance. [WORKFLOW]
is ordered; [CHECKLIST] is unordered.

### When to use
- Connect a service → [CONNECTOR:pluginId]; deeper setup/status → [CONFIG:pluginId]
- Pick one → [CHOICE]; several values → [FORM]; next steps → [FOLLOWUPS]
- Your own multi-step work → [CHECKLIST] (unordered) / [WORKFLOW] (ordered)
- Custom dashboards/tables/charts → separate generative-UI guide; facts → text`;

/** Complete compact marker reference; Stage 1 can read it on demand. */
export const UI_WIDGETS_CAPABILITIES = `## In-chat controls
Render standalone controls directly in replyText with contexts=["simple"] and candidateActionNames=[]; no tool, discovery or planning call is needed just to display them. A request to display a configuration card alone does not ask for a live status check, connection, or settings change. Select task contexts only for actual tool work. Longer uiWidgets examples are separately available on demand.
Canonical inline syntax:
- Plugin setup/status: [CONFIG:pluginId]. Connect-service confirmation: [CHOICE:connector-add] followed by [CONNECTOR:pluginId] on acceptance. Cards handle credentials; never request secrets or auth links in chat.
- Choices: [CHOICE:scope] then one value=Label per line, then [/CHOICE]. Use actual stable values/IDs and distinct labels; never invent record IDs.
- Optional follow-ups: [FOLLOWUPS] then kind:payload=Label per line, then [/FOLLOWUPS]. Kinds: reply (text), navigate (path), prompt (text).
- Form: [FORM] then one JSON object {"title":"Title","fields":[{"name":"field","type":"text","label":"Label","required":true}]} then [/FORM]. Field types: text, number, select (options), checkbox, date, time, datetime. Use forms for 2+ missing fields; never secrets/API keys.
- Checklist: [CHECKLIST] then {"items":[{"content":"Task","status":"pending"}]} then [/CHECKLIST]. Status: pending, in_progress, completed.
- Workflow: [WORKFLOW] then {"steps":[{"label":"Step","status":"pending"}]} then [/WORKFLOW]. Status: pending, running, done, failed.
Opening/choosing/submitting a control is not proof of a saved change; only tool results establish effects.`;

export const uiWidgetCapabilitiesProvider: Provider = {
  name: "uiWidgetCapabilities",
  description:
    "Compact syntax for direct chat controls; longer examples are supplied when planning.",
  dynamic: true,
  alwaysInResponseState: true,
  contexts: ["general"],
  cacheStable: true,
  cacheScope: "agent",
  get: async (_runtime: IAgentRuntime, message: Memory) => ({
    text: isAllowedChannel(message) ? UI_WIDGETS_CAPABILITIES : "",
    discoveryText: isAllowedChannel(message)
      ? "context_discovery: uiWidgetCapabilities\nReply-formatting reference: syntax for authoring configuration cards, choices, forms, follow-ups, checklists and workflows INSIDE a chat reply. Read only when composing one of these controls. Opening an existing app view uses its navigation action; it needs no reply-formatting reference. Ordinary prose needs none. Advertised chat controls are available regardless of the focused app view."
      : "",
  }),
};

/** Full marker grammar, selected by the existing planner context routing. */
export const uiWidgetsProvider: Provider = {
  name: "uiWidgets",
  description:
    "How to render in-chat widgets: plugin config cards, forms with native date/time pickers, follow-up chips, checklists, and step pipelines",
  dynamic: true,
  relevanceKeywords: getValidationKeywordTerms("provider.uiWidgets.relevance", {
    includeAllLocales: true,
  }),
  // The v5 planner filters dynamic providers by exact Stage-1 contexts, with
  // no ancestor expansion. A scheduling turn can select `tasks`, while plugin
  // setup selects `connectors`/`settings`; `general` alone misses the guide's
  // flagship marker use cases.
  contexts: [
    "general",
    "tasks",
    "todos",
    "productivity",
    "connectors",
    "settings",
  ],
  contextGate: {
    anyOf: [
      "general",
      "tasks",
      "todos",
      "productivity",
      "connectors",
      "settings",
    ],
  },
  cacheStable: true,
  cacheScope: "agent",

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (!isAllowedChannel(message)) {
      return { text: "" };
    }
    logger.debug(
      { src: "agent:uiWidgets", chars: UI_WIDGETS_GUIDE.length },
      "[uiWidgets] injected marker vocabulary guide",
    );
    return {
      text: UI_WIDGETS_GUIDE,
      discoveryText:
        "context_discovery: uiWidgets\nExtended canonical examples for configuration/connect cards, choices, forms, follow-ups, checklists and workflows. Read if the compact uiWidgetCapabilities syntax is insufficient; ordinary prose or navigation needs neither guide.",
    };
  },
};

const GENERATIVE_INTENT_KEYWORDS = getValidationKeywordTerms(
  "provider.uiGenerative.relevance",
  { includeAllLocales: true },
);

export const uiGenerativeProvider: Provider = {
  name: "uiGenerative",
  alwaysInResponseState: true,
  description:
    "How to render custom dashboards, tables, charts, and metrics views as generative UI (JSONL patches + component catalog)",
  dynamic: true,
  relevanceKeywords: GENERATIVE_INTENT_KEYWORDS,
  contexts: ["general"],
  contextGate: { anyOf: ["general"] },
  // Renders after uiWidgets (markers-first); composeState orders by
  // (position || 0) then name, and "uiGenerative" sorts before "uiWidgets".
  position: 1,
  // ADMIN-gated: the declared roleGate is enforced by applyPluginRoleGating.
  roleGate: { minRole: "ADMIN" },

  get: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (!isAllowedChannel(message)) {
      return { text: "" };
    }
    // Build component summary — detailed for core set, brief for the rest.
    const componentLines: string[] = [];
    for (const [name, meta] of Object.entries(COMPONENT_CATALOG)) {
      if (DETAIL_COMPONENTS.has(name)) {
        const props = Object.entries(meta.props)
          .map(([k, p]) => `${k}: ${p.type}${p.required ? " (required)" : ""}`)
          .join(", ");
        componentLines.push(
          `- **${name}**: ${meta.description} [props: ${props}]`,
        );
      } else {
        componentLines.push(`- ${name}: ${meta.description}`);
      }
    }

    const text = `## Generative UI — inline JSONL patches (custom dashboards, tables, visualisations)
Use this ONLY for a custom table, metrics view, dashboard, or visualisation.
Rendering or revising an in-chat visual is a direct reply: contexts=["simple"], candidateActionNames=[], replyEffectStatus="none". It needs no APP/VIEWS action and does not navigate or save records.
For plugin setup use [CONFIG:pluginId]; for a quick fixed-field form use
[FORM]; both are described in the in-chat widgets guide — never hand-build
those here.

Each reply is a separate render; it cannot patch a previous reply. For follow-ups, emit the complete updated /root and all referenced /elements again. Nested /elements/id/props paths are unsupported.
Emit these supported JSON patch lines INLINE (no code fences, no markdown):
{"op":"add","path":"/root","value":"card-1"}
{"op":"add","path":"/elements/card-1","value":{"type":"Card","props":{"title":"Weekly report"},"children":["body-1"]}}
{"op":"add","path":"/elements/body-1","value":{"type":"Text","props":{"text":"Numbers below."},"children":[]}}

Table example (complete standalone render):
{"op":"add","path":"/root","value":"comparison"}
{"op":"add","path":"/elements/comparison","value":{"type":"Table","props":{"columns":["Item","Count"],"rows":[["Example","1"]]},"children":[]}}

Rules:
- Always emit /root first, then /elements/<id>, then /state/<key>
- Each patch must be on its own line, valid JSON, no trailing text on that line
- Element IDs: unique kebab-case strings
- state binding: set statePath prop on Input/Select/Textarea to a dot-path key
- data binding in props: "$data.key.path" resolves from state at render time

### Available components (${Object.keys(COMPONENT_CATALOG).length} total)
${componentLines.join("\n")}`;

    logger.debug(
      { src: "agent:uiGenerative", chars: text.length },
      "[uiGenerative] injected generative-UI catalog guide",
    );
    return {
      text,
      discoveryText:
        'context_discovery: uiGenerative\nComplete custom dashboard, chart and table renderer reference: JSONL patch syntax and component catalog. Read before creating or changing a generative UI, including visual follow-ups without keywords. For ordinary prose, app navigation or existing Notes/Calendar views, no guide is needed. Stage 1: request contextRequests=["uiGenerative"] with an empty reply.',
    };
  },
};
