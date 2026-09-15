/** Illustrative records; these fixtures never invoke the runtime. */
import type { Meta, StoryObj } from "@storybook/react";
import { TrajectoryRecordedSteps } from "./trajectory-recorded-steps";

const meta = {
  title: "Trajectories/Recorded steps",
  component: TrajectoryRecordedSteps,
  args: {
    onCopy: () => {},
    stages: [
      {
        schemaVersion: 1,
        stageId: "planner",
        kind: "planner",
        startedAt: 1,
        endedAt: 100,
        latencyMs: 99,
        payload: {
          model: {
            modelType: "ACTION_PLANNER",
            messages: [{ role: "user", content: "Open Notes." }],
            response: "Invoke the Notes view action.",
          },
        },
      },
      {
        schemaVersion: 1,
        stageId: "tool",
        kind: "tool",
        startedAt: 101,
        endedAt: 120,
        latencyMs: 19,
        payload: {
          tool: {
            name: "OPEN_NOTES",
            args: { view: "notes" },
            result: { success: true, view: "notes" },
          },
        },
      },
    ],
  },
} satisfies Meta<typeof TrajectoryRecordedSteps>;
export default meta;
export const PlannerAndAction: StoryObj<typeof meta> = {};
export const NoSteps: StoryObj<typeof meta> = { args: { stages: [] } };
