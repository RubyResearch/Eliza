/** Serializes authoritative policy admission with organization lifecycle and override publication. */
import { ElizaError } from "@elizaos/core";
import { writeTransaction } from "../../db/helpers";
import {
  lockOrganizationPolicy,
  lockOrganizationPolicyForRead,
} from "../../db/repositories/organization-policy-generation";
import { observeInferenceDependency } from "../observability/cloud-backend-observability";
import {
  isOrganizationPolicyStamp,
  sameOrganizationPolicyStamp,
} from "./organization-policy-stamp";
import {
  type OrganizationPolicyStamp,
  type OrganizationQuotaPolicy,
  readOrganizationQuotaPolicyInTransaction,
} from "./organization-quota-policy";
export async function withOrganizationPolicyAdmission<T>(
  organizationId: string,
  expected: OrganizationPolicyStamp | undefined,
  operation: (policy: OrganizationQuotaPolicy) => Promise<T>,
): Promise<T> {
  return admitUnderPolicyLock(organizationId, expected, operation, lockOrganizationPolicy);
}
/**
 * Fences read-only inference checks against policy writers without serializing readers.
 * The callback must not mutate Postgres; rate and spend transitions must have
 * their own authoritative Durable Object serialization. Resource admission
 * and cache publication retain the exclusive admission function above.
 */
export async function withOrganizationPolicyReadAdmission<T>(
  organizationId: string,
  expected: OrganizationPolicyStamp | undefined,
  operation: (policy: OrganizationQuotaPolicy) => Promise<T>,
): Promise<T> {
  return admitUnderPolicyLock(organizationId, expected, operation, lockOrganizationPolicyForRead);
}
async function admitUnderPolicyLock<T>(
  organizationId: string,
  expected: OrganizationPolicyStamp | undefined,
  operation: (policy: OrganizationQuotaPolicy) => Promise<T>,
  lock: typeof lockOrganizationPolicy,
): Promise<T> {
  return observeInferenceDependency("transaction", "policy_admission", () =>
    writeTransaction(async (tx) => {
      await observeInferenceDependency("policy_lock", "policy_admission", () =>
        lock(tx, organizationId),
      );
      const policy = await observeInferenceDependency("policy_read", "policy_admission", () =>
        readOrganizationQuotaPolicyInTransaction(tx, organizationId),
      );
      if (
        expected !== undefined &&
        (!isOrganizationPolicyStamp(expected) ||
          !sameOrganizationPolicyStamp(expected, policy.authority))
      )
        throw new ElizaError("Organization policy changed; refresh admission", {
          code: "ORGANIZATION_POLICY_STALE",
          context: { organizationId },
          severity: "ephemeral",
        });
      return operation(policy);
    }),
  );
}
