/**
 * @module evaluators/extractor
 * @description Form post-turn evaluator that runs in the
 * EvaluatorService pass. Detects form intents (submit, stash, cancel, undo,
 * skip, autofill, info) and extracts field values from the user message,
 * then mutates session state accordingly.
 *
 * The 'restore' intent is handled by FORM action=restore (a planner Action)
 * so the restored form is in scope before the agent's response is generated.
 */

import type {
  Evaluator,
  EvaluatorProcessor,
  EventPayload,
  IAgentRuntime,
  JsonValue,
  UUID,
} from "@elizaos/core";
import { EvaluatorPriority, logger } from "@elizaos/core";
import {
  buildFormExtractorPromptSection,
  buildFormExtractorSchema,
  coerceExtractionsAgainstControls,
  parseFormExtractorOutput,
} from "../extraction";
import type { FormService } from "../service";
import { buildTemplateValues, type TemplateValues } from "../template";
import type {
  ExtractionResult,
  FormDefinition,
  FormIntent,
  FormSession,
} from "../types";

interface FormExtractorOutput {
  formIntent: FormIntent;
  formExtractions: ExtractionResult[];
}

interface FormExtractorPrepared {
  formService: FormService;
  session: FormSession;
  form: FormDefinition;
  templateValues: TemplateValues;
  entityId: UUID;
}

async function emitEvent(
  runtime: IAgentRuntime,
  eventType: string,
  payload: Record<string, JsonValue>,
): Promise<void> {
  if (typeof runtime.emitEvent !== "function") return;
  const eventPayload: EventPayload = { runtime, ...payload };
  await runtime.emitEvent(eventType, eventPayload);
}

async function checkAndActivateExternalField(
  runtime: IAgentRuntime,
  formService: FormService,
  session: FormSession,
  form: FormDefinition,
  entityId: UUID,
  field: string,
): Promise<void> {
  const freshSession = await formService.getActiveSession(
    entityId,
    session.roomId,
  );
  if (!freshSession) return;

  const control = form.controls.find((c) => c.key === field);
  if (!control || !formService.isExternalType(control.type)) return;
  if (!formService.areSubFieldsFilled(freshSession, field)) return;

  const subValues = formService.getSubFieldValues(freshSession, field);
  await emitEvent(runtime, "FORM_SUBCONTROLS_FILLED", {
    sessionId: session.id,
    field,
    subValues,
  });

  const activation = await formService.activateExternalField(
    session.id,
    entityId,
    field,
  );
  const activationPayload = JSON.parse(JSON.stringify(activation)) as JsonValue;

  await emitEvent(runtime, "FORM_EXTERNAL_ACTIVATED", {
    sessionId: session.id,
    field,
    activation: activationPayload,
  });

  logger.info(
    `[FormEvaluator] Activated external field ${field}: ${activation.instructions}`,
  );
}

const formIntentProcessor: EvaluatorProcessor<
  FormExtractorOutput,
  FormExtractorPrepared
> = {
  name: "formIntent",
  priority: 100,
  async process({ output, prepared, runtime: _runtime, message: _message }) {
    const { formService, session, form, entityId } = prepared;

    switch (output.formIntent) {
      case "submit":
        await formService.submit(session.id, entityId);
        return { success: true, values: { formIntent: "submit" } };

      case "stash":
        await formService.stash(session.id, entityId);
        return { success: true, values: { formIntent: "stash" } };

      case "cancel":
        await formService.cancel(session.id, entityId);
        return { success: true, values: { formIntent: "cancel" } };

      case "undo": {
        if (!form.ux?.allowUndo) return undefined;
        const result = await formService.undoLastChange(session.id, entityId);
        return result
          ? {
              success: true,
              values: { formIntent: "undo", undid: result.field },
            }
          : undefined;
      }

      case "skip": {
        if (!form.ux?.allowSkip || !session.lastAskedField) return undefined;
        const skipped = await formService.skipField(
          session.id,
          entityId,
          session.lastAskedField,
        );
        return skipped
          ? {
              success: true,
              values: { formIntent: "skip", skipped: session.lastAskedField },
            }
          : undefined;
      }

      case "autofill":
        await formService.applyAutofill(session);
        return { success: true, values: { formIntent: "autofill" } };

      case "explain":
      case "example":
      case "progress":
        return { success: true, values: { formIntent: output.formIntent } };

      case "restore":
        // FORM action=restore owns this path; nothing to do here.
        return undefined;

      default:
        return undefined;
    }
  },
};

const formExtractionsProcessor: EvaluatorProcessor<
  FormExtractorOutput,
  FormExtractorPrepared
> = {
  name: "formExtractions",
  priority: 200,
  async process({ output, prepared, runtime, message }) {
    const { formService, session, form, entityId } = prepared;

    // Lifecycle / UX intents shouldn't double-process extractions; only
    // fill_form and `other` may carry inline data.
    if (output.formIntent !== "fill_form" && output.formIntent !== "other") {
      // Still update last-message tracking before bailing so deduplication works.
      const refreshed = await formService.getActiveSession(
        entityId,
        session.roomId,
      );
      if (refreshed) {
        refreshed.lastMessageId = message.id;
        await formService.saveSession(refreshed);
      }
      return undefined;
    }

    const updatedParents = new Set<string>();
    const coerced = coerceExtractionsAgainstControls(
      output.formExtractions,
      form.controls,
      prepared.templateValues,
      (typeId) => formService.getControlType(typeId),
    );

    for (const extraction of coerced) {
      if (extraction.field.includes(".")) {
        const [parentKey, subKey] = extraction.field.split(".");
        await formService.updateSubField(
          session.id,
          entityId,
          parentKey,
          subKey,
          extraction.value,
          extraction.confidence,
          message.id,
        );
        await emitEvent(runtime, "FORM_SUBFIELD_UPDATED", {
          sessionId: session.id,
          parentField: parentKey,
          subField: subKey,
          value: extraction.value,
          confidence: extraction.confidence,
        });
        updatedParents.add(parentKey);
      } else {
        await formService.updateField(
          session.id,
          entityId,
          extraction.field,
          extraction.value,
          extraction.confidence,
          extraction.isCorrection ? "correction" : "extraction",
          message.id,
        );
        await emitEvent(runtime, "FORM_FIELD_EXTRACTED", {
          sessionId: session.id,
          field: extraction.field,
          value: extraction.value,
          confidence: extraction.confidence,
        });
      }
    }

    for (const parentKey of updatedParents) {
      await checkAndActivateExternalField(
        runtime,
        formService,
        session,
        form,
        entityId,
        parentKey,
      );
    }

    const refreshed = await formService.getActiveSession(
      entityId,
      session.roomId,
    );
    if (refreshed) {
      refreshed.lastMessageId = message.id;
      await formService.saveSession(refreshed);
    }

    return {
      success: true,
      values: {
        extractionCount: output.formExtractions.length,
      },
    };
  },
};

export const formEvaluator: Evaluator<
  FormExtractorOutput,
  FormExtractorPrepared
> = {
  name: "form_extractor",
  description: "Extracts form values + lifecycle/UX intent from user message.",
  similes: ["FORM_EXTRACTION", "FORM_HANDLER", "form_evaluator"],
  // Run before reflection/memory so downstream evaluators see updated form state.
  priority: EvaluatorPriority.FORM,
  providers: ["RECENT_MESSAGES"],
  schema: buildFormExtractorSchema(),

  async shouldRun({ runtime, message }) {
    const formService = runtime.getService("FORM") as FormService | null;
    if (!formService) return false;

    const entityId = message.entityId as UUID | undefined;
    const roomId = message.roomId as UUID | undefined;
    if (!entityId || !roomId) return false;

    const text = message.content?.text;
    if (!text?.trim()) return false;

    return (await formService.getActiveSession(entityId, roomId)) !== null;
  },

  async prepare({ runtime, message }) {
    const formService = runtime.getService("FORM") as FormService | null;
    if (!formService) {
      throw new Error("FormService not found in prepare()");
    }
    const entityId = message.entityId as UUID;
    const roomId = message.roomId as UUID;

    const session = await formService.getActiveSession(entityId, roomId);
    if (!session) {
      // The session can leave the active state between admission and prepare.
      // FORM action=restore owns the stashed-only path.
      throw new Error(
        "Form evaluator prepared without an active session; FORM action=restore owns the stashed-only path",
      );
    }

    const form = formService.getForm(session.formId);
    if (!form) {
      throw new Error(
        `Form definition not found for session formId=${session.formId}`,
      );
    }

    return {
      formService,
      session,
      form,
      templateValues: buildTemplateValues(session),
      entityId,
    };
  },

  prompt({ message, prepared }) {
    const text = message.content?.text ?? "";
    return buildFormExtractorPromptSection({
      text,
      form: prepared.form,
      controls: prepared.form.controls,
      templateValues: prepared.templateValues,
      resolveControlType: (typeId) =>
        prepared.formService.getControlType(typeId),
    });
  },

  parse(raw) {
    const parsed = parseFormExtractorOutput(raw);
    if (!parsed) return null;
    return {
      formIntent: parsed.intent,
      formExtractions: parsed.extractions,
    };
  },

  processors: [formIntentProcessor, formExtractionsProcessor],
};

export default formEvaluator;
