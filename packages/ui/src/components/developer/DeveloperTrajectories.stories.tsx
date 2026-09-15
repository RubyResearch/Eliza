/** No provider/model requests: a message without recorded trajectories. */
import type { Meta, StoryObj } from "@storybook/react";
import { DeveloperTrajectories } from "./DeveloperTrajectories";

const meta = {
  title: "Developer/Message trajectories",
  component: DeveloperTrajectories,
  args: { runs: [], loading: false, error: false, retry: () => {} },
} satisfies Meta<typeof DeveloperTrajectories>;
export default meta;
export const NoRecordedRuns: StoryObj<typeof meta> = {};
export const LoadingRuns: StoryObj<typeof meta> = {
  args: { loading: true },
};
export const UnavailableRuns: StoryObj<typeof meta> = {
  args: { error: true },
};
