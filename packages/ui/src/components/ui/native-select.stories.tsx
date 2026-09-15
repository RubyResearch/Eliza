/** Demonstrates native select semantics for platform-owned option pickers. */

import type { Meta, StoryObj } from "@storybook/react";
import { NativeSelect } from "./native-select";

const meta = {
  title: "Primitives/NativeSelect",
  component: NativeSelect,
  tags: ["autodocs"],
  args: {
    "aria-label": "Country",
    children: (
      <>
        <option value="in">India</option>
        <option value="us">United States</option>
        <option value="gb">United Kingdom</option>
      </>
    ),
  },
} satisfies Meta<typeof NativeSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Touch: Story = {
  args: { presentation: "touch" },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const Toolbar: Story = {
  args: { presentation: "toolbar" },
};
