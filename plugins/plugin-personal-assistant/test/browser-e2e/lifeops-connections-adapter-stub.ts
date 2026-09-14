/** Browser-fixture stub that prevents production API imports from entering the bundle. */

export const defaultLifeOpsConnectionsAdapter = {};
export const defaultFamilyOperationsAdapter = {};

export async function familyOperationsRequest(): Promise<never> {
  throw new Error("Browser fixture requires an explicit intake adapter.");
}

async function unavailableHandoff(): Promise<never> {
  throw new Error(
    "Account handoff mutations are outside this browser fixture.",
  );
}
export const defaultAccountHandoffAdapter = {
  getActiveLifeOpsAccountHandoff: async () => ({ handoff: null }),
  getLifeOpsFamilyEmailOptions: unavailableHandoff,
  getLifeOpsHandoffRetirementCandidates: unavailableHandoff,
  getLifeOpsHandoffCalendarEntries: unavailableHandoff,
  createLifeOpsAccountHandoff: unavailableHandoff,
  getLifeOpsAccountHandoff: unavailableHandoff,
  cancelLifeOpsAccountHandoff: unavailableHandoff,
  advanceLifeOpsAccountHandoff: unavailableHandoff,
};
export const defaultFamilyDeletionAdapter = {};
