/** Storybook fixtures for ready, partial-unavailable, and mobile Family Operations states. */

import { withMockApp } from "@elizaos/ui/storybook/mock-providers.helpers";
import type { Meta, StoryObj } from "@storybook/react";
import { FamilyOperationsView } from "./FamilyOperationsView.js";
import type { FamilyOperationsAdapter } from "./types.js";

const adapter = {
  listRecipientContacts: async () => [],
  confirmEmailRecipient: async () => {
    throw new Error("This preview does not save contacts.");
  },
  load: async () => ({
    agreements: { status: "ready", data: [] },
    calendarLinks: { status: "ready", data: [] },
    school: {
      status: "unavailable",
      message: "School workflow API has not been installed on this runtime.",
    },
    packets: { status: "ready", data: [] },
    emailOptions: { status: "ready", data: { accounts: [], recipients: [] } },
  }),
  readAgreementReview: async () => null,
  addAgreementProposal: async () => {
    throw new Error("Owner correction is unavailable in this fixture");
  },
  prepareAgreementReview: async () => {
    throw new Error("Review generation is not available in this story");
  },
  downloadWorkspace: async () => {
    throw new Error("This preview has no stored workspace to export.");
  },
  decideObligation: async (obligation: never) => obligation,
  listPinTargets: async () => ({
    agent: { id: "fixture-agent", name: "Family assistant" },
    chats: [{ id: "fixture-chat", name: "Family planning", source: "test" }],
  }),
  listPins: async () => [],
  pin: async () => null,
  unpin: async () => null,
  listGuestAccessOptions: async () => ({ candidates: [], grants: [] }),
  previewGrant: async () => null,
  issueGrant: async () => null,
  revokeGrant: async () => null,
  resolveCalendarConflict: async () => undefined,
  disconnectCalendar: async () => undefined,
  runSchoolWorkflow: async () => undefined,
  configureSchool: async () => undefined,
  approveSchoolDiff: async () => undefined,
  generatePacket: async () => undefined,
} as unknown as FamilyOperationsAdapter;

const meta = {
  title: "Pages/FamilyOperationsView",
  component: FamilyOperationsView,
  tags: ["autodocs"],
  decorators: [
    withMockApp,
    (Story) => (
      <div style={{ height: "52rem", background: "var(--bg)" }}>
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
  args: { adapter },
} satisfies Meta<typeof FamilyOperationsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PartialUnavailable: Story = {};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
