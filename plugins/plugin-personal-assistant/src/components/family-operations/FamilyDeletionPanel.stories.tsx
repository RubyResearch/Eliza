/** Interactive deletion review and interrupted-cleanup stories using explicit synthetic adapter state. */
import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within } from "storybook/test";
import type { FamilyDeletionJob } from "../../lifeops/family-workflows/deletion-contracts.js";
import type { FamilyDeletionAdapter } from "./deletion-adapter.js";
import { FamilyDeletionPanel } from "./FamilyDeletionPanel.js";

const pending: FamilyDeletionJob = {
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "story-agent",
  reviewedSha256: "a".repeat(64),
  startedAt: "2026-09-13T12:00:00.000Z",
  state: "purge_pending",
  backupRetention: "7-days",
  backupGeneration: "22222222-2222-4222-8222-222222222222",
  backupOperationId: "story-deletion",
  files: [],
  databaseRowsRemoved: 12,
  retained: [{ kind: "providerCalendar", count: 1 }],
};
const adapter: FamilyDeletionAdapter = {
  previewBackups: async () => ({
    jobId: pending.id,
    generation: pending.backupGeneration,
    notBefore: "2026-09-20T12:00:00.000Z",
    sha256: "d".repeat(64),
    archives: [],
  }),
  admitBackups: async () => ({
    ...pending,
    state: "backup_pending",
    backupCleanup: await adapter.previewBackups(),
  }),
  resumeBackups: async () => {
    throw new Error("Synthetic retained backups are not due yet");
  },
  status: async () => null,
  preview: async () => ({
    agentId: "story-agent",
    sha256: "a".repeat(64),
    unavailable: [],
    records: [
      {
        kind: "agreement",
        classification: "owned",
        unsettled: false,
        sha256: "b".repeat(64),
        identity: { title: "Parenting plan", id: "agreement-story" },
      },
      {
        kind: "providerCalendar",
        classification: "referenced",
        unsettled: false,
        sha256: "c".repeat(64),
        identity: { id: "calendar-story" },
      },
    ],
  }),
  begin: async () => ({ ...pending, state: "backup_pending" }),
  resume: async () => ({ ...pending, state: "backup_pending" }),
};
const meta = {
  title: "Pages/FamilyDeletionPanel",
  component: FamilyDeletionPanel,
  args: { adapter, onChange: async () => undefined },
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 800,
          padding: 20,
          background: "var(--bg)",
          color: "var(--txt)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", {
        name: "Review workspace deletion",
      }),
    );
  },
} satisfies Meta<typeof FamilyDeletionPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Review: Story = {};
export const Interrupted: Story = {
  args: { adapter: { ...adapter, status: async () => pending } },
};
export const BackupPending: Story = {
  args: {
    adapter: {
      ...adapter,
      status: async () => ({ ...pending, state: "backup_pending" }),
    },
  },
};
export const Unavailable: Story = {
  args: {
    adapter: {
      ...adapter,
      status: async () => {
        throw new Error("Only the owner may review workspace deletion.");
      },
    },
  },
};
