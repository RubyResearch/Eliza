/** Owner chat control for school-calendar and monthly packet workflow operations. */

import type {
  Action,
  ActionResult,
  Content,
  ContentValue,
  HandlerOptions,
} from "@elizaos/core";
import { z } from "zod";
import { getFamilyWorkflowRuntimeService } from "../lifeops/family-workflows/index.js";
import { CONCORD_SCHOOL_CALENDAR_SOURCE } from "../lifeops/school/calendar-workflow.js";

const operationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("configure_school"),
      schoolLevel: z.enum(["all", "elementary"]),
      updateMode: z.enum(["review", "automatic"]),
    })
    .strict(),
  z
    .object({
      operation: z.enum([
        "status",
        "run_school",
        "run_monthly",
        "generate_packet",
      ]),
    })
    .strict(),
]);

export const familyWorkflowsAction: Action = {
  name: "FAMILY_WORKFLOWS",
  similes: ["SCHOOL_CALENDAR_WORKFLOW", "FAMILY_COORDINATION_PACKET"],
  description:
    "Configure or run the school-calendar workflow and generate owner-reviewed monthly family coordination packets. Drafts are never sent automatically.",
  validate: async () => true,
  parameters: [
    {
      name: "operation",
      description:
        "configure_school, status, run_school, run_monthly, or generate_packet. Configuration creates the monthly school check and owner packet preparation; it never sends email.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "configure_school",
          "status",
          "run_school",
          "run_monthly",
          "generate_packet",
        ],
      },
    },
    {
      name: "schoolLevel",
      description:
        "Required for configure_school: elementary includes district dates; all includes every school level.",
      schema: { type: "string", enum: ["elementary", "all"] },
    },
    {
      name: "updateMode",
      description:
        "Required for configure_school: automatic applies validated school changes; review waits for an owner decision.",
      schema: { type: "string", enum: ["automatic", "review"] },
    },
  ],
  examples: [],
  handler: async (
    runtime,
    _message,
    _state,
    options,
    callback,
  ): Promise<ActionResult> => {
    const parsed = operationSchema.safeParse(
      (options as HandlerOptions | undefined)?.parameters,
    );
    if (!parsed.success) {
      const result = {
        success: false,
        text: "Choose a supported family workflow. For setup, choose the school level and whether changes apply automatically or wait for review.",
        data: { error: "FAMILY_WORKFLOW_INVALID_OPERATION" },
      };
      await callback?.(result);
      return result;
    }
    const service = getFamilyWorkflowRuntimeService(runtime);
    if (!service) {
      const result = {
        success: false,
        text: "Family workflow runtime is unavailable.",
        data: { error: "FAMILY_WORKFLOW_UNAVAILABLE" },
      };
      await callback?.(result);
      return result;
    }
    const { operation } = parsed.data;
    if (operation === "configure_school") {
      const source = await service.configureSchool({
        ...CONCORD_SCHOOL_CALENDAR_SOURCE,
        schoolLevel: parsed.data.schoolLevel,
        updateMode: parsed.data.updateMode,
      });
      const schedule = await service.ensureMonthlySchedule();
      const result = {
        success: true,
        text: "School settings saved. The family workflow checks the school calendar and prepares an owner-reviewed monthly packet. Its saved schedule is included; no email was sent.",
        data: {
          operation,
          result: JSON.parse(
            JSON.stringify({ source, schedule }),
          ) as ContentValue,
        },
      };
      await callback?.(result);
      return result;
    }
    const data =
      operation === "status"
        ? await service.schoolStatus()
        : operation === "run_school"
          ? await service.runSchool("manual")
          : operation === "run_monthly"
            ? await service.runMonthly("manual")
            : await service.generatePacket();
    // The callback contract uses ContentValue's JSON shape. This round-trip
    // preserves the complete workflow result while proving it is transportable.
    const callbackData = JSON.parse(JSON.stringify(data)) as ContentValue;
    const alreadyRunning = "state" in data && data.state === "already_running";
    const content: Content = {
      text:
        operation === "status"
          ? "School calendar workflow status loaded."
          : alreadyRunning
            ? "This family workflow is already running. No second run was started."
            : operation === "run_school" &&
                "state" in data &&
                data.state === "awaiting_approval"
              ? "School calendar changes are ready for review. They have not been applied."
              : "Family workflow completed without sending any external draft.",
      data: { operation, result: callbackData },
    };
    await callback?.(content);
    return { success: !alreadyRunning, ...content };
  },
};
