/**
 * Shared glue for the live chat-widget round-trip scenarios (#14322).
 *
 * The scenario runtime factory boots a lean plugin set that does NOT include
 * the @elizaos/agent eliza plugin, which is what normally registers the
 * model-facing `uiWidgets` marker guide (`[CONFIG:…]` / `[FORM]` /
 * `[FOLLOWUPS]` / `[CHECKLIST]` / `[WORKFLOW]`). `uiWidgetsGuideSeed` registers
 * the REAL provider (imported from the agent package, not a copy) on the
 * scenario runtime so live scenarios exercise the exact guide text production
 * ships. The provider is intentionally not role-gated; channel/context gating is
 * the production guard, and the scenarios use the same DM/API-style runtime path.
 *
 * The FORM helpers replicate exactly what the dashboard renderer does with a
 * model-emitted `[FORM]` block: parse it with the shared core parser
 * (`packages/core/src/messaging/interactions/parse.ts` — the same grammar the
 * UI accepts, including generating an id when the model omits one) and
 * re-enter the submit as the literal `[form:submit <id>] {json}` wire message
 * (`packages/ui/src/components/chat/widgets/use-inline-widget-context.ts`).
 * There is deliberately NO server-side consumer of that wire text — the round
 * trip is trusted text re-entry, which is precisely what these scenarios put
 * under live-model test.
 */

import {
  uiWidgetCapabilitiesProvider,
  uiWidgetsProvider,
} from "@elizaos/agent/providers/ui-catalog";
import type { Plugin } from "@elizaos/core";
import type {
  ScenarioContext,
  ScenarioSeedStep,
} from "@elizaos/scenario-runner/schema";
import { findInteractionRegions } from "../../../../core/src/messaging/interactions/parse.ts";
import type {
  FormInteraction,
  InteractionField,
} from "../../../../core/src/types/interactions.ts";

const GUIDE_PLUGIN_NAME = "scenario-chat-widgets-guide";

/**
 * Seed step registering the production uiWidgets guide provider on the
 * scenario runtime. Idempotent so a shared-runtime CLI invocation that runs
 * several widget scenarios back to back does not double-register.
 */
export function uiWidgetsGuideSeed(): ScenarioSeedStep {
  return {
    type: "custom",
    name: "register the production uiWidgets marker guide provider",
    apply: async (ctx: ScenarioContext) => {
      const runtime = ctx.runtime as {
        plugins?: Array<{ name?: string }>;
        registerPlugin?: (plugin: Plugin) => Promise<void>;
      } | null;
      if (!runtime?.registerPlugin) {
        return "runtime.registerPlugin unavailable";
      }
      const alreadyRegistered = (runtime.plugins ?? []).some(
        (plugin) => plugin.name === GUIDE_PLUGIN_NAME,
      );
      if (alreadyRegistered) {
        return undefined;
      }
      await runtime.registerPlugin({
        name: GUIDE_PLUGIN_NAME,
        description:
          "Scenario fixture: registers the production uiWidgets marker guide " +
          "(normally carried by the @elizaos/agent eliza plugin) so live " +
          "widget round-trip scenarios see the real model-facing guide.",
        providers: [uiWidgetCapabilitiesProvider, uiWidgetsProvider],
      });
      return undefined;
    },
  };
}

/** Every parsed `[FORM]` block in `text`, using the shared core grammar. */
export function findFormBlocks(text: string): FormInteraction[] {
  return findInteractionRegions(text)
    .map((region) => region.block)
    .filter((block): block is FormInteraction => block.kind === "form");
}

const TEMPORAL_FIELD_TYPES = new Set(["date", "time", "datetime"]);

/**
 * Canonical values the harness "types into" the model's form. Distinctive
 * tokens ("Q3", "budget", "Dana") let post-submit assertions confirm the
 * agent used the SUBMITTED values rather than something it invented.
 */
export const CANONICAL_FORM_TEXT_VALUE = "Send the Q3 budget report to Dana";
export const CANONICAL_FORM_DATE = "2026-07-14";
export const CANONICAL_FORM_TIME = "09:30";
export const CANONICAL_FORM_DATETIME = `${CANONICAL_FORM_DATE}T${CANONICAL_FORM_TIME}`;
export const CANONICAL_FORM_NUMBER = 45;

/**
 * Validate a model-emitted reply against the [FORM] contract the uiWidgets
 * guide teaches: an inline (un-fenced) block the shared parser accepts, with
 * at least two fields and at least one native temporal field (the guide
 * forbids collecting a date/time as free text — #14484). Returns the parsed
 * form on success, or a failure string.
 */
export function validateSchedulingFormReply(
  text: string,
): FormInteraction | string {
  if (text.includes("```")) {
    return "reply wraps content in a code fence; the guide requires markers to be emitted inline with no fences";
  }
  const forms = findFormBlocks(text);
  if (forms.length === 0) {
    const mentionsMarker = text.includes("[FORM]");
    return mentionsMarker
      ? "reply contains a [FORM] marker the shared parser rejects (malformed body — this is a grammar bug, quote the raw block)"
      : "reply contains no parseable [FORM] block";
  }
  if (forms.length > 1) {
    return `reply contains ${forms.length} [FORM] blocks; expected exactly one`;
  }
  const form = forms[0];
  if (form.fields.length < 2) {
    return `form has ${form.fields.length} field(s); a scheduling form needs at least a title and a time`;
  }
  const temporal = form.fields.filter((field) =>
    TEMPORAL_FIELD_TYPES.has(field.type),
  );
  if (temporal.length === 0) {
    return `form has no date/time/datetime field (types: ${form.fields
      .map((field) => `${field.name}:${field.type}`)
      .join(", ")}); the guide forbids collecting a schedule time as free text`;
  }
  return form;
}

/** The value the harness fills into one field, by declared type. */
function fillValue(field: InteractionField): string | number | boolean {
  switch (field.type) {
    case "date":
      return CANONICAL_FORM_DATE;
    case "time":
      return CANONICAL_FORM_TIME;
    case "datetime":
      return CANONICAL_FORM_DATETIME;
    case "number":
      return CANONICAL_FORM_NUMBER;
    case "checkbox":
      return true;
    case "select":
      return field.options?.[0]?.value ?? "";
    default:
      return CANONICAL_FORM_TEXT_VALUE;
  }
}

/** Fill every field of a parsed form with the canonical harness values. */
export function fillFormValues(
  form: FormInteraction,
): Record<string, string | number | boolean> {
  const values: Record<string, string | number | boolean> = {};
  for (const field of form.fields) {
    values[field.name] = fillValue(field);
  }
  return values;
}

/**
 * The exact wire message the dashboard sends when the user hits Submit —
 * byte-for-byte the `use-inline-widget-context.ts` format. The id is the
 * PARSED form id (generated client-side when the model omitted one), so the
 * model may see an id it never emitted; the round trip must tolerate that.
 */
export function buildFormSubmitText(
  form: FormInteraction,
  values: Record<string, string | number | boolean>,
): string {
  return `[form:submit ${form.id}] ${JSON.stringify(values)}`;
}
