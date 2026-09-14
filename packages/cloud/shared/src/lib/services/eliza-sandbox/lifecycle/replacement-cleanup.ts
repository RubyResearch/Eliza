/** Owns replacement identity, durable cleanup fences, and retirement reconciliation. Lifecycle locks and the single provider instance are supplied by the host, preserving transaction and cutover authority. */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../../../db/client";
import { dbWrite } from "../../../../db/helpers";
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import {
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  type NewAgentSandbox,
} from "../../../../db/schemas/agent-sandboxes";
import { dockerNodes } from "../../../../db/schemas/docker-nodes";
import { jobs } from "../../../../db/schemas/jobs";
import { logger } from "../../../utils/logger";
import { settleReplacementComputeInTransaction } from "../../agent-compute-provision";
import { creditsService } from "../../credits";
import { EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES } from "../../provisioning-job-types";
import { type SandboxHandle, type SandboxProvider } from "../../sandbox-provider";
import { SandboxReplacementCleanupUnresolvedError } from "../../sandbox-provider-types";
import { SandboxLifecycleAuthority } from "./authority.js";
import {
  containerBackedServiceRejection,
  PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES,
} from "./policy.js";
import { isDockerBackedMetadata, isDockerSandboxMetadata } from "./provider-metadata.js";
import {
  AdminCanaryCleanupExpectation,
  AdminCanaryCleanupExpectationError,
  ReplacementCleanupExpectation,
  ReplacementCleanupLocator,
} from "./replacement-contracts.js";

export interface SandboxReplacementCleanupHost {
  lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]>;
  getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>;
  hasActiveExclusiveLifecycleJobTx(
    ...args: Parameters<SandboxLifecycleAuthority["hasActiveExclusiveLifecycleJobTx"]>
  ): ReturnType<SandboxLifecycleAuthority["hasActiveExclusiveLifecycleJobTx"]>;
  isReplacementCleanupSweepEligibleTx(
    ...args: Parameters<SandboxLifecycleAuthority["isReplacementCleanupSweepEligibleTx"]>
  ): ReturnType<SandboxLifecycleAuthority["isReplacementCleanupSweepEligibleTx"]>;
  getProvider(): Promise<SandboxProvider>;
}

export class SandboxReplacementCleanup {
  constructor(private readonly host: SandboxReplacementCleanupHost) {}

  // Private helpers

  replacementCleanupCallbacks(
    agentId: string,
    orgId: string,
    expected: ReplacementCleanupExpectation,
  ) {
    return {
      onReplacementCreateIntent: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "intent");
      },
      onReplacementCreated: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "created");
      },
      onReplacementVpnRegistered: async (handle: SandboxHandle) => {
        await this.persistReplacementCleanupStage(agentId, orgId, handle, expected, "vpn");
      },
    };
  }

  getReplacementCleanupLocator(
    rec: Pick<
      AgentSandbox,
      | "replacement_cleanup_sandbox_id"
      | "replacement_cleanup_node_id"
      | "replacement_cleanup_container_name"
      | "replacement_cleanup_attempt_id"
      | "replacement_cleanup_container_id"
      | "replacement_cleanup_vpn_node_id"
      | "replacement_cleanup_vpn_node_name"
      | "replacement_cleanup_preserved_vpn_node_id"
      | "replacement_cleanup_vpn_registration_started_at"
      | "replacement_cleanup_allocation_counted"
      | "replacement_cleanup_created_at"
    >,
  ): ReplacementCleanupLocator | null {
    const core = [
      rec.replacement_cleanup_sandbox_id,
      rec.replacement_cleanup_node_id,
      rec.replacement_cleanup_container_name,
      rec.replacement_cleanup_allocation_counted,
      rec.replacement_cleanup_created_at,
    ];
    const optional = [
      rec.replacement_cleanup_attempt_id,
      rec.replacement_cleanup_container_id,
      rec.replacement_cleanup_vpn_node_id,
      rec.replacement_cleanup_vpn_node_name,
      rec.replacement_cleanup_preserved_vpn_node_id,
      rec.replacement_cleanup_vpn_registration_started_at,
    ];
    if (core.every((value) => value === null)) {
      if (optional.some((value) => value !== null)) {
        throw new Error("Replacement cleanup locator contains unowned identity fields");
      }
      return null;
    }
    if (core.some((value) => value === null)) {
      throw new Error("Replacement cleanup locator is incomplete");
    }
    if (
      (rec.replacement_cleanup_vpn_node_name === null) !==
      (rec.replacement_cleanup_vpn_registration_started_at === null)
    ) {
      throw new Error("Replacement cleanup VPN correlation is incomplete");
    }
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      rec.replacement_cleanup_vpn_registration_started_at,
    );
    const createdAt = this.parseReplacementCreatedAt(rec.replacement_cleanup_created_at);
    return {
      sandboxId: rec.replacement_cleanup_sandbox_id!,
      nodeId: rec.replacement_cleanup_node_id!,
      containerName: rec.replacement_cleanup_container_name!,
      replacementAttemptId: rec.replacement_cleanup_attempt_id,
      containerId: rec.replacement_cleanup_container_id,
      vpnNodeId: rec.replacement_cleanup_vpn_node_id,
      vpnNodeName: rec.replacement_cleanup_vpn_node_name,
      previousVpnNodeId: rec.replacement_cleanup_preserved_vpn_node_id,
      vpnRegistrationStartedAt,
      allocationCounted: rec.replacement_cleanup_allocation_counted!,
      createdAt,
    };
  }

  parseReplacementVpnStartedAt(value: Date | string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Replacement cleanup VPN registration timestamp is invalid");
    }
    return parsed;
  }

  parseReplacementCreatedAt(value: Date | string | null | undefined): Date {
    if (!value) {
      throw new Error("Replacement cleanup creation timestamp is missing");
    }
    const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new Error("Replacement cleanup creation timestamp is invalid");
    }
    return parsed;
  }

  /**
   * PostgreSQL retains microseconds that JavaScript Date cannot round-trip.
   * The durable placement fields fence identity; this one-millisecond window
   * preserves the timestamp generation check without making valid CAS writes
   * miss solely because the database carried sub-millisecond precision.
   */
  replacementCleanupCreatedAtMatches(createdAt: Date) {
    const nextMillisecond = new Date(createdAt.getTime() + 1);
    return sql`${agentSandboxes.replacement_cleanup_created_at} >= ${createdAt}
      AND ${agentSandboxes.replacement_cleanup_created_at} < ${nextMillisecond}`;
  }

  replacementLocatorFromHandle(
    handle: SandboxHandle,
  ): Omit<ReplacementCleanupLocator, "createdAt"> {
    const metadata = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;
    if (
      !metadata?.nodeId ||
      !metadata.containerName ||
      !metadata.replacementAttemptId ||
      typeof metadata.allocationCounted !== "boolean"
    ) {
      throw new Error(
        `Replacement sandbox ${handle.sandboxId} has no durable Docker placement metadata`,
      );
    }
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      metadata.vpnRegistrationStartedAt,
    );
    const vpnNodeName = metadata.vpnNodeName ?? null;
    if ((vpnNodeName === null) !== (vpnRegistrationStartedAt === null)) {
      throw new Error("Replacement sandbox has incomplete VPN correlation metadata");
    }
    return {
      sandboxId: handle.sandboxId,
      nodeId: metadata.nodeId,
      containerName: metadata.containerName,
      replacementAttemptId: metadata.replacementAttemptId,
      containerId: metadata.containerId ?? null,
      vpnNodeId: metadata.vpnNodeId ?? null,
      vpnNodeName,
      previousVpnNodeId: metadata.previousVpnNodeId ?? null,
      vpnRegistrationStartedAt,
      allocationCounted: metadata.allocationCounted,
    };
  }

  replacementLocatorFromCleanupError(
    cleanupError: SandboxReplacementCleanupUnresolvedError,
  ): Omit<ReplacementCleanupLocator, "createdAt"> {
    const vpnRegistrationStartedAt = this.parseReplacementVpnStartedAt(
      cleanupError.vpnRegistrationStartedAt,
    );
    if ((cleanupError.vpnNodeName === null) !== (vpnRegistrationStartedAt === null)) {
      throw new Error("Unresolved replacement has incomplete VPN correlation metadata");
    }
    if (!cleanupError.replacementAttemptId) {
      throw new Error("Unresolved replacement has no durable attempt identity");
    }
    if (cleanupError.allocationCounted === null) {
      throw new Error("Unresolved replacement has no capacity ownership marker");
    }
    return {
      sandboxId: cleanupError.sandboxId,
      nodeId: cleanupError.nodeId,
      containerName: cleanupError.containerName,
      replacementAttemptId: cleanupError.replacementAttemptId,
      containerId: cleanupError.containerId,
      vpnNodeId: cleanupError.vpnNodeId,
      vpnNodeName: cleanupError.vpnNodeName,
      previousVpnNodeId: cleanupError.previousVpnNodeId,
      vpnRegistrationStartedAt,
      allocationCounted: cleanupError.allocationCounted,
    };
  }

  assertSameReplacementIdentity(
    existing: ReplacementCleanupLocator,
    incoming: Omit<ReplacementCleanupLocator, "createdAt">,
  ): void {
    const same =
      existing.sandboxId === incoming.sandboxId &&
      existing.nodeId === incoming.nodeId &&
      existing.containerName === incoming.containerName &&
      existing.replacementAttemptId === incoming.replacementAttemptId &&
      existing.vpnNodeName === incoming.vpnNodeName &&
      existing.previousVpnNodeId === incoming.previousVpnNodeId &&
      existing.vpnRegistrationStartedAt?.getTime() ===
        incoming.vpnRegistrationStartedAt?.getTime() &&
      existing.allocationCounted === incoming.allocationCounted;
    if (!same) {
      throw new Error(
        `Agent already owns a different unresolved replacement ${existing.sandboxId} on ${existing.nodeId}`,
      );
    }
    if (
      existing.containerId !== null &&
      incoming.containerId !== null &&
      existing.containerId !== incoming.containerId
    ) {
      throw new Error("Replacement Docker identity changed during enrichment");
    }
    if (
      existing.vpnNodeId !== null &&
      incoming.vpnNodeId !== null &&
      existing.vpnNodeId !== incoming.vpnNodeId
    ) {
      throw new Error("Replacement VPN identity changed during enrichment");
    }
  }

  replacementCleanupMatchesHandle(
    existing: ReplacementCleanupLocator,
    handle: SandboxHandle,
  ): boolean {
    try {
      const incoming = this.replacementLocatorFromHandle(handle);
      this.assertSameReplacementIdentity(existing, incoming);
      return (
        existing.containerId === incoming.containerId && existing.vpnNodeId === incoming.vpnNodeId
      );
    } catch {
      // error-policy:J3 replacement identity validation — a mismatch is the
      // explicit invalid signal consumed by the lifecycle CAS.
      return false;
    }
  }

  replacementCleanupLocatorsEqual(
    left: ReplacementCleanupLocator,
    right: ReplacementCleanupLocator,
  ): boolean {
    try {
      this.assertSameReplacementIdentity(left, right);
      return (
        left.containerId === right.containerId &&
        left.vpnNodeId === right.vpnNodeId &&
        left.createdAt.getTime() === right.createdAt.getTime()
      );
    } catch {
      // error-policy:J3 replacement identity validation — unequal or malformed
      // locators fail closed as an explicit false comparison.
      return false;
    }
  }

  async persistReplacementCleanupStage(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expected: ReplacementCleanupExpectation,
    stage: "intent" | "created" | "vpn",
  ): Promise<void> {
    const incoming = this.replacementLocatorFromHandle(handle);
    if (stage === "intent" && (incoming.containerId !== null || incoming.vpnNodeId !== null)) {
      throw new Error("Replacement intent already contains a committed remote identity");
    }
    if (stage === "created" && incoming.containerId === null) {
      throw new Error("Replacement Docker enrichment is missing the container id");
    }
    if (stage === "vpn" && incoming.vpnNodeId === null) {
      throw new Error("Replacement VPN enrichment is missing the node id");
    }
    if (expected.status === "running" && !incoming.allocationCounted) {
      throw new Error("Blue/green replacement requires durable node capacity ownership");
    }
    await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) throw new Error("Agent disappeared before replacement ownership");
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.deletion_attempt_id !== null ||
        current.status === "deletion_pending" ||
        current.status === "deletion_failed"
      ) {
        throw new Error("Agent deletion owns the lifecycle before replacement ownership");
      }
      const existing = this.getReplacementCleanupLocator(current);
      if (existing) {
        this.assertSameReplacementIdentity(existing, incoming);
        const containerId = existing.containerId ?? incoming.containerId;
        const vpnNodeId = existing.vpnNodeId ?? incoming.vpnNodeId;
        if (containerId === existing.containerId && vpnNodeId === existing.vpnNodeId) return;
        const enriched = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            replacement_cleanup_container_id = ${containerId},
            replacement_cleanup_vpn_node_id = ${vpnNodeId},
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
            AND replacement_cleanup_sandbox_id = ${existing.sandboxId}
            AND replacement_cleanup_node_id = ${existing.nodeId}
            AND replacement_cleanup_container_name = ${existing.containerName}
            AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${existing.replacementAttemptId}
            AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${existing.containerId}
            AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${existing.vpnNodeId}
            AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${existing.vpnNodeName}
            AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${existing.previousVpnNodeId}
            AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${existing.vpnRegistrationStartedAt}
            AND replacement_cleanup_allocation_counted = ${existing.allocationCounted}
            AND ${this.replacementCleanupCreatedAtMatches(existing.createdAt)}
            AND lifecycle_revision = ${current.lifecycle_revision}
          RETURNING id
        `);
        if (enriched.rows.length !== 1) {
          throw new Error("Replacement cleanup enrichment CAS failed");
        }
        return;
      }
      if (stage !== "intent") {
        throw new Error("Replacement enrichment arrived before durable intent ownership");
      }
      if (
        current.status !== expected.status ||
        current.environment_revision !== expected.environmentRevision ||
        current.sandbox_id !== expected.sandboxId ||
        current.node_id !== expected.nodeId ||
        current.container_name !== expected.containerName
      ) {
        throw new Error("Agent generation changed before replacement ownership");
      }
      if (incoming.allocationCounted) {
        const reserved = await tx.execute<{ node_id: string }>(sql`
          UPDATE ${dockerNodes}
          SET
            allocated_count = allocated_count + 1,
            updated_at = NOW()
          WHERE node_id = ${incoming.nodeId}
            AND enabled = TRUE
            AND placement_state = 'open'
            AND status = 'healthy'
            AND allocated_count < capacity
          RETURNING node_id
        `);
        if (reserved.rows.length !== 1) {
          throw new Error(`Replacement node ${incoming.nodeId} has no reservable capacity`);
        }
      }
      const persisted = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_sandbox_id = ${incoming.sandboxId},
          replacement_cleanup_node_id = ${incoming.nodeId},
          replacement_cleanup_container_name = ${incoming.containerName},
          replacement_cleanup_attempt_id = ${incoming.replacementAttemptId},
          replacement_cleanup_container_id = ${incoming.containerId},
          replacement_cleanup_vpn_node_id = ${incoming.vpnNodeId},
          replacement_cleanup_vpn_node_name = ${incoming.vpnNodeName},
          replacement_cleanup_preserved_vpn_node_id = ${incoming.previousVpnNodeId},
          replacement_cleanup_vpn_registration_started_at = ${incoming.vpnRegistrationStartedAt},
          replacement_cleanup_allocation_counted = ${incoming.allocationCounted},
          replacement_cleanup_created_at = date_trunc('milliseconds', NOW()),
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND status = ${expected.status}
          AND environment_revision = ${expected.environmentRevision}
          AND sandbox_id IS NOT DISTINCT FROM ${expected.sandboxId}
          AND node_id IS NOT DISTINCT FROM ${expected.nodeId}
          AND container_name IS NOT DISTINCT FROM ${expected.containerName}
          AND deletion_attempt_id IS NULL
          AND replacement_cleanup_sandbox_id IS NULL
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (persisted.rows.length !== 1) {
        throw new Error("Replacement cleanup ownership CAS failed");
      }
    });
  }

  async persistUnresolvedReplacementCleanupFence(
    agentId: string,
    orgId: string,
    cleanupError: SandboxReplacementCleanupUnresolvedError,
  ): Promise<void> {
    const incoming = this.replacementLocatorFromCleanupError(cleanupError);
    await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        throw new Error("Agent disappeared before unresolved replacement could be fenced");
      }
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const existing = this.getReplacementCleanupLocator(current);
      if (!existing) {
        throw new Error("Unresolved replacement escaped without durable intent ownership");
      }
      this.assertSameReplacementIdentity(existing, incoming);
      const containerId = existing.containerId ?? incoming.containerId;
      const vpnNodeId = existing.vpnNodeId ?? incoming.vpnNodeId;
      if (containerId === existing.containerId && vpnNodeId === existing.vpnNodeId) return;
      const persisted = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_container_id = ${containerId},
          replacement_cleanup_vpn_node_id = ${vpnNodeId},
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND replacement_cleanup_sandbox_id = ${existing.sandboxId}
          AND replacement_cleanup_node_id = ${existing.nodeId}
          AND replacement_cleanup_container_name = ${existing.containerName}
          AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${existing.replacementAttemptId}
          AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${existing.containerId}
          AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${existing.vpnNodeId}
          AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${existing.vpnNodeName}
          AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${existing.previousVpnNodeId}
          AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${existing.vpnRegistrationStartedAt}
          AND replacement_cleanup_allocation_counted = ${existing.allocationCounted}
          AND ${this.replacementCleanupCreatedAtMatches(existing.createdAt)}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (persisted.rows.length !== 1) {
        throw new Error("Unresolved replacement cleanup enrichment CAS failed");
      }
    });
  }

  async transferReplacementToPrimary(
    agentId: string,
    orgId: string,
    handle: SandboxHandle,
    expectedEnvironmentRevision: number,
    updateData: Partial<NewAgentSandbox>,
  ): Promise<AgentSandbox> {
    return dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) throw new Error("Agent disappeared before replacement adoption");
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.status !== "provisioning" ||
        current.environment_revision !== expectedEnvironmentRevision
      ) {
        throw new Error("Agent generation changed before replacement adoption");
      }

      const locator = this.getReplacementCleanupLocator(current);
      if (locator) {
        // A preserved retry handle has no replacement metadata because its
        // identity already lives on the primary row. Construct the replacement
        // locator only when a durable replacement fence exists to compare it to.
        const incoming = this.replacementLocatorFromHandle(handle);
        this.assertSameReplacementIdentity(locator, incoming);
        if (
          locator.containerId !== incoming.containerId ||
          locator.vpnNodeId !== incoming.vpnNodeId
        ) {
          throw new Error("Replacement cleanup ownership changed before adoption");
        }
      } else if (isDockerBackedMetadata(handle.metadata)) {
        const dockerMeta = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;
        if (
          !dockerMeta?.nodeId ||
          !dockerMeta.containerName ||
          current.sandbox_id !== handle.sandboxId ||
          current.node_id !== dockerMeta.nodeId ||
          current.container_name !== dockerMeta.containerName
        ) {
          throw new Error("Docker replacement has no durable cleanup ownership");
        }
      }

      const [adopted] = await tx
        .update(agentSandboxes)
        .set({
          ...updateData,
          replacement_cleanup_sandbox_id: null,
          replacement_cleanup_node_id: null,
          replacement_cleanup_container_name: null,
          replacement_cleanup_attempt_id: null,
          replacement_cleanup_container_id: null,
          replacement_cleanup_vpn_node_id: null,
          replacement_cleanup_vpn_node_name: null,
          replacement_cleanup_preserved_vpn_node_id: null,
          replacement_cleanup_vpn_registration_started_at: null,
          replacement_cleanup_allocation_counted: null,
          replacement_cleanup_created_at: null,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(agentSandboxes.id, agentId),
            eq(agentSandboxes.organization_id, orgId),
            inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS]),
            eq(agentSandboxes.status, "provisioning"),
            eq(agentSandboxes.environment_revision, expectedEnvironmentRevision),
            eq(agentSandboxes.lifecycle_revision, current.lifecycle_revision),
            sql`${agentSandboxes.deletion_attempt_id} IS NULL`,
          ),
        )
        .returning();
      if (!adopted) throw new Error("Replacement adoption CAS failed");
      return adopted;
    });
  }

  /**
   * Snapshot the cleanup identity, prove the exact remote resources absent
   * without holding a database transaction open, then re-lock and atomically
   * release its node allocation and fence. A changed identity invalidates the
   * remote proof, so retries cannot decrement another live agent's slot.
   */
  assertAdminCanaryCleanupExpectation(
    current: AgentSandbox,
    locator: ReplacementCleanupLocator | null,
    expectation: AdminCanaryCleanupExpectation,
  ): void {
    if (
      current.status !== "running" ||
      current.deleted_at !== null ||
      current.user_id !== expectation.targetOwnerUserId ||
      current.docker_image !== expectation.targetImage ||
      current.image_digest !== expectation.targetDigest ||
      current.node_id !== expectation.newNodeId ||
      current.container_name !== expectation.newContainerName
    ) {
      throw new AdminCanaryCleanupExpectationError(
        "Admin canary serving generation changed before cleanup convergence",
      );
    }
    if (
      locator &&
      (locator.nodeId !== expectation.oldNodeId ||
        locator.containerName !== expectation.oldContainerName)
    ) {
      throw new AdminCanaryCleanupExpectationError(
        "Admin canary cleanup locator does not match the committed audit",
      );
    }
  }

  async retirePersistedReplacementCleanup(
    agentId: string,
    orgId: string,
    expectation?: AdminCanaryCleanupExpectation,
    onConvergedInTx?: (tx: DbTransaction) => Promise<void>,
    source: "lifecycle" | "background-reconcile" | "admin-converge" = "lifecycle",
    expectedReplacement?: SandboxHandle,
  ): Promise<"missing" | "clean" | "deferred" | "retired"> {
    const startedAt = Date.now();
    logger.info("[agent-sandbox] Replacement cleanup started", {
      agentId,
      organizationId: orgId,
      source,
    });
    const provider = await this.host.getProvider();
    const snapshot = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) return { state: "missing" as const };
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const locator = this.getReplacementCleanupLocator(current);
      if (expectedReplacement) {
        if (!locator) throw new Error("Failed provision replacement ownership changed");
        const expected = this.replacementLocatorFromHandle(expectedReplacement);
        this.assertSameReplacementIdentity(locator, expected);
        if (locator.containerId !== expected.containerId)
          throw new Error("Failed provision container identity changed");
      }
      if (expectation) {
        this.assertAdminCanaryCleanupExpectation(current, locator, expectation);
      }
      if (
        source === "background-reconcile" &&
        (await this.host.hasActiveExclusiveLifecycleJobTx(tx, agentId, orgId))
      ) {
        return { state: "deferred" as const };
      }
      if (
        source === "background-reconcile" &&
        locator?.replacementAttemptId !== null &&
        !(await this.host.isReplacementCleanupSweepEligibleTx(tx, agentId, orgId))
      ) {
        return { state: "deferred" as const };
      }
      if (locator) {
        const funding =
          provider.computeFundingCapability === "host-lease-v1"
            ? await settleReplacementComputeInTransaction(tx, current, locator)
            : null;
        return { state: "pending" as const, locator, funding };
      }
      if (onConvergedInTx) await onConvergedInTx(tx);
      return { state: "clean" as const };
    });
    if (snapshot.state !== "pending") return snapshot.state;
    if (snapshot.funding?.purchasedCreditRefunded)
      await creditsService.invalidateCreditCaches(orgId);

    if (!provider.stopOnSpecificNodeForReplacement) {
      throw new Error("Sandbox provider cannot prove a persisted replacement absent");
    }
    const stopOnSpecificNodeForReplacement =
      provider.stopOnSpecificNodeForReplacement.bind(provider);
    const { locator } = snapshot;
    logger.info("[agent-sandbox] Replacement cleanup remote retirement started", {
      agentId,
      organizationId: orgId,
      source,
      nodeId: locator.nodeId,
      containerName: locator.containerName,
      preCutover: locator.replacementAttemptId !== null,
      elapsedMs: Date.now() - startedAt,
    });

    await stopOnSpecificNodeForReplacement(
      locator.nodeId,
      locator.containerName,
      locator.vpnNodeId,
      {
        replacementAttemptId: locator.replacementAttemptId,
        containerId: locator.containerId,
        vpnNodeName: locator.vpnNodeName,
        previousVpnNodeId: locator.previousVpnNodeId,
        vpnRegistrationStartedAt: locator.vpnRegistrationStartedAt?.toISOString() ?? null,
        allocationCounted: locator.allocationCounted,
      },
    );
    logger.info("[agent-sandbox] Replacement cleanup remote absence proven", {
      agentId,
      organizationId: orgId,
      source,
      elapsedMs: Date.now() - startedAt,
    });

    const outcome = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, orgId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!current) {
        throw expectation
          ? new AdminCanaryCleanupExpectationError(
              "Admin canary serving generation disappeared after cleanup proof",
            )
          : new Error("Agent disappeared after replacement cleanup proof");
      }
      const tierRejection = containerBackedServiceRejection(current, "replacement");
      if (tierRejection) throw new Error(tierRejection);
      const currentLocator = this.getReplacementCleanupLocator(current);
      if (expectation) {
        this.assertAdminCanaryCleanupExpectation(current, currentLocator, expectation);
      }
      if (!currentLocator || !this.replacementCleanupLocatorsEqual(currentLocator, locator)) {
        throw new Error("Replacement cleanup fence changed after remote absence proof");
      }
      const cleared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          replacement_cleanup_sandbox_id = NULL,
          replacement_cleanup_node_id = NULL,
          replacement_cleanup_container_name = NULL,
          replacement_cleanup_attempt_id = NULL,
          replacement_cleanup_container_id = NULL,
          replacement_cleanup_vpn_node_id = NULL,
          replacement_cleanup_vpn_node_name = NULL,
          replacement_cleanup_preserved_vpn_node_id = NULL,
          replacement_cleanup_vpn_registration_started_at = NULL,
          replacement_cleanup_allocation_counted = NULL,
          replacement_cleanup_created_at = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND replacement_cleanup_sandbox_id = ${locator.sandboxId}
          AND replacement_cleanup_node_id = ${locator.nodeId}
          AND replacement_cleanup_container_name = ${locator.containerName}
          AND replacement_cleanup_attempt_id IS NOT DISTINCT FROM ${locator.replacementAttemptId}
          AND replacement_cleanup_container_id IS NOT DISTINCT FROM ${locator.containerId}
          AND replacement_cleanup_vpn_node_id IS NOT DISTINCT FROM ${locator.vpnNodeId}
          AND replacement_cleanup_vpn_node_name IS NOT DISTINCT FROM ${locator.vpnNodeName}
          AND replacement_cleanup_preserved_vpn_node_id IS NOT DISTINCT FROM ${locator.previousVpnNodeId}
          AND replacement_cleanup_vpn_registration_started_at IS NOT DISTINCT FROM ${locator.vpnRegistrationStartedAt}
          AND replacement_cleanup_allocation_counted = ${locator.allocationCounted}
          AND ${this.replacementCleanupCreatedAtMatches(locator.createdAt)}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (cleared.rows.length !== 1) {
        throw new Error("Replacement cleanup fence changed before durable release");
      }
      if (locator.allocationCounted) {
        const released = await tx.execute<{ node_id: string }>(sql`
          UPDATE ${dockerNodes}
          SET
            allocated_count = allocated_count - 1,
            updated_at = NOW()
          WHERE node_id = ${locator.nodeId}
            AND allocated_count > 0
          RETURNING node_id
        `);
        if (released.rows.length !== 1) {
          throw new Error(`Replacement cleanup node ${locator.nodeId} disappeared before release`);
        }
      }
      if (onConvergedInTx) await onConvergedInTx(tx);
      return "retired" as const;
    });
    logger.info("[agent-sandbox] Replacement cleanup fence retired", {
      agentId,
      organizationId: orgId,
      source,
      elapsedMs: Date.now() - startedAt,
    });
    return outcome;
  }

  /**
   * Low-cadence daemon backstop for cleanup interrupted after a process crash or
   * an unreachable node. Each row is independently fenced; failures remain
   * durable for the next sweep and cannot authorize another replacement.
   */
  async reconcileReplacementCleanupFences(limit = 25): Promise<{
    total: number;
    retired: number;
    failed: number;
  }> {
    const pending = await dbWrite.execute<{ id: string; organization_id: string }>(sql`
      SELECT id, organization_id
      FROM ${agentSandboxes}
      WHERE replacement_cleanup_sandbox_id IS NOT NULL
        AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
        AND (
          replacement_cleanup_attempt_id IS NULL
          OR replacement_cleanup_created_at <=
            NOW() - (${PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES} * INTERVAL '1 minute')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${jobs}
          WHERE ${jobs.organization_id} = ${agentSandboxes.organization_id}
            AND ${jobs.agent_id} = ${agentSandboxes.id}::text
            AND ${jobs.status} IN ('pending', 'in_progress')
            AND ${inArray(jobs.type, EXCLUSIVE_AGENT_LIFECYCLE_JOB_TYPES)}
        )
      ORDER BY replacement_cleanup_created_at ASC
      LIMIT ${limit}
    `);
    let retired = 0;
    let failed = 0;
    for (const row of pending.rows) {
      try {
        if (
          (await this.retirePersistedReplacementCleanup(
            row.id,
            row.organization_id,
            undefined,
            undefined,
            "background-reconcile",
          )) === "retired"
        ) {
          retired += 1;
        }
      } catch (error) {
        // error-policy:J7 reconciliation must not kill the sweep — the durable
        // fence remains for retry and the per-row failure is counted and logged.
        failed += 1;
        logger.warn("[agent-sandbox] Replacement cleanup remains pending", {
          agentId: row.id,
          organizationId: row.organization_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { total: pending.rows.length, retired, failed };
  }

  /**
   * Completes the durable retirement owned by one agent. Admin canary jobs use
   * this after a cutover audit was committed but the old placement could not be
   * proven absent during the original worker execution.
   */
  async convergeReplacementCleanupFence(
    agentId: string,
    orgId: string,
    expectation?: AdminCanaryCleanupExpectation,
    onConvergedInTx?: (tx: DbTransaction) => Promise<void>,
  ): Promise<void> {
    const outcome = await this.retirePersistedReplacementCleanup(
      agentId,
      orgId,
      expectation,
      onConvergedInTx,
      "admin-converge",
    );
    if (outcome === "missing") {
      throw expectation
        ? new AdminCanaryCleanupExpectationError(
            "Admin canary serving generation is missing during cleanup convergence",
          )
        : new Error("Agent not found while converging replacement cleanup");
    }
  }
}
