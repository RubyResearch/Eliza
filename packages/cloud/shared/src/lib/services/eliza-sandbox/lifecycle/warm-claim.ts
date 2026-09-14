/** Owns sandbox warm-claim operations while preserving the host’s lifecycle transactions, provider instance, and backup authority. */

import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dbWrite } from "../../../../db/helpers";
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import { agentComputeFunding } from "../../../../db/schemas/agent-compute-funding";
import {
  agentSandboxes,
  CONTAINER_BACKED_EXECUTION_TIERS,
  WARM_POOL_ORG_ID,
} from "../../../../db/schemas/agent-sandboxes";
import {
  cancelUnboundAgentComputeInTransaction,
  stopFundedAgentInTransaction,
} from "../../agent-compute-stop";
import { decryptAgentEnvVars, encryptAgentEnvVarsForStorage } from "../../agent-env-crypto";
import { apiKeysService } from "../../api-keys";
import { creditsService } from "../../credits";
import { reconcileAllocatedWorkloadsOnNodeWithDatabase } from "../../docker-node-workload-queries";
import type { SandboxProvider } from "../../sandbox-provider-types";
import {
  buildWarmClaimCharacterPayload,
  WARM_CLAIM_CHARACTER_PUSH_TIMEOUT_MS,
} from "../../warm-claim-character-push";
import {
  buildWarmClaimKeyPushBody,
  safeKeyPrefix,
  WARM_CLAIM_KEY_PUSH_TIMEOUT_MS,
  warmClaimKeyFingerprint,
} from "../../warm-claim-key-push";
import { snapshotCaptureStillCanonical } from "../backup/authority";
import { SandboxTransport } from "../bridge/transport.js";
import { SandboxLifecycleAuthority } from "./authority.js";
import { containerBackedServiceRejection } from "./policy.js";
import { BoundedSandboxStopResult } from "./stop-contracts.js";

export interface SandboxWarmClaimHost {
  fetchAgentApi(
    ...args: Parameters<SandboxTransport["fetchAgentApi"]>
  ): ReturnType<SandboxTransport["fetchAgentApi"]>;
  lockLifecycle(
    ...args: Parameters<SandboxLifecycleAuthority["lockLifecycle"]>
  ): ReturnType<SandboxLifecycleAuthority["lockLifecycle"]>;
  getAgentForLifecycleMutation(
    ...args: Parameters<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>
  ): ReturnType<SandboxLifecycleAuthority["getAgentForLifecycleMutation"]>;
  getProvider(): Promise<SandboxProvider>;
  runBoundedSandboxStopForReplacement(
    sandboxId: string,
    options?: { readonly releaseCapacity?: false },
  ): Promise<BoundedSandboxStopResult>;
}

export class SandboxWarmClaim {
  constructor(private readonly host: SandboxWarmClaimHost) {}

  /**
   * Post-claim character apply (warm pool). A pool container boots GENERIC
   * (no ELIZA_AGENT_CHARACTER_JSON — agent-warm-pool-creator provisions with
   * empty env), so after `claimWarmContainer` transfers the DB row the RUNNING
   * container would still answer as the default Eliza. This pushes the user's
   * character onto the live runtime via the container's own
   * `PUT /api/character` route (which applies it in-memory, persists it to the
   * agent DB so it survives restarts, and journals character history) — no
   * container restart, no cold boot.
   *
   * Bounded and non-fatal by contract: the CALLER treats a failure as
   * "claim still succeeds, character applies on next container restart"
   * (the row's agent_config feeds ensureRuntimeAgentStarted / the env path on
   * any subsequent boot). Throws on failure so the caller can log the
   * `warm_pool.character_push_failed` event with context.
   */
  async pushClaimedWarmContainerCharacter(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "execution_tier"
    >,
  ): Promise<{ pushed: boolean; agentName?: string }> {
    const tierRejection = containerBackedServiceRejection(rec, "character push");
    if (tierRejection) throw new Error(tierRejection);
    const payload = buildWarmClaimCharacterPayload(rec.agent_config, rec.agent_name);
    if (!payload) return { pushed: false };

    const res = await this.host.fetchAgentApi(rec, "/api/character", {
      method: "PUT",
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WARM_CLAIM_CHARACTER_PUSH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Warm-claim character push failed: HTTP ${res.status}`);
    }
    return { pushed: true, agentName: String(payload.name) };
  }

  /**
   * Post-claim inference-credential re-key (warm pool, F0). A pool container
   * boots under the sentinel pool org with a managed cloud inference key
   * scoped to THAT org, so after `claimWarmContainer` transfers the row the
   * RUNNING container still holds the pool-org key and every inference reply is
   * the "key isn't authorized" fallback. This:
   *
   *   1. mints a NEW `agent-sandbox:<claimed-row-id>` inference key scoped to
   *      the claiming user's org;
   *   2. persists that key onto the claimed row's env (`ELIZAOS_CLOUD_API_KEY`)
   *      so restart recovery is always possible;
   *   3. revokes the old `agent-sandbox:<pool-row-id>` credential;
   *   4. pushes the replacement onto the live container via its authenticated
   *      `POST /api/cloud/login/persist` route with `forceInferenceEnabled`,
   *      and requires a fingerprint attestation from runtime-resolved state.
   *
   * Secret handling: the plaintext key rides only in the authed TLS-internal
   * (tailnet) PUT body `fetchAgentApi` uses; it is NEVER logged — the return
   * carries only booleans + a short safe prefix, and the fingerprint exchange
   * carries a sha-256 prefix, never key material.
   *
   * A transport or attestation failure throws. The caller must enqueue restart
   * recovery and must not report the claimed agent as ready.
   */
  async pushClaimedWarmContainerInferenceKey(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "organization_id"
      | "user_id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    > & { warm_pool_row_id: string },
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    // Guard: never re-key a row that is (still) owned by the sentinel pool org.
    // The caller invokes this ONLY after a successful claim, when the row is
    // the user's, but a defensive check here means a pool-org row can never be
    // handed a fresh user-billable key by mistake.
    if (rec.organization_id === WARM_POOL_ORG_ID) {
      throw new Error("Refusing warm-claim key push for a sentinel-pool-org row (not claimed)");
    }
    if (!rec.warm_pool_row_id) {
      throw new Error("Warm-claim key push requires the source agent-sandbox pool row id");
    }

    return await this.completeWarmClaimCredentialHandoff(
      rec.id,
      rec.organization_id,
      rec.warm_pool_row_id,
    );
  }

  /**
   * Retry a durable warm-claim credential handoff after a route/worker crash.
   * The source pool id and target fingerprint live on the sandbox row, so no
   * plaintext credential or request-local state is required for recovery.
   */
  async recoverPendingWarmClaimInferenceKey(
    agentId: string,
    organizationId: string,
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    return await this.completeWarmClaimCredentialHandoff(agentId, organizationId);
  }

  /**
   * Upgrade a pre-fence claimed row into the durable handoff protocol before
   * restart tears down its live container. The row is never declared ready
   * from legacy metadata: the subsequent provision resolves a fresh immutable
   * image digest and recovery remints, pushes, and live-attests a user-org key.
   */
  async prepareLegacyWarmClaimCredentialRecovery(
    agentId: string,
    organizationId: string,
  ): Promise<void> {
    await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (!current.claimed_at) return;
      if (current.warm_claim_credential_state !== null) return;
      if (!["running", "provisioning", "stopped", "error"].includes(current.status)) {
        throw new Error(
          `Legacy warm-claim credential recovery cannot start from ${current.status}`,
        );
      }
      const prepared = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'provisioning',
          warm_claim_credential_state = 'pending',
          warm_claim_source_pool_id = NULL,
          warm_claim_key_fingerprint = NULL,
          warm_claim_attested_at = NULL,
          warm_claim_attested_environment_revision = NULL,
          warm_claim_cleanup_completed_at = NULL,
          error_message = 'Legacy warm claim requires credential and image re-attestation',
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status IN ('running', 'provisioning', 'stopped', 'error')
          AND claimed_at IS NOT NULL
          AND warm_claim_credential_state IS NULL
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
      if (prepared.rows.length !== 1) {
        throw new Error("Legacy warm-claim preparation lost its state CAS");
      }
    });
  }

  /**
   * An explicit provision after durable failed-handoff cleanup starts a cold
   * retry. Clearing the claim fence happens under the lifecycle lock only after
   * both retained credential owners were revoked, so cleanup can never revoke a
   * newly minted retry key.
   */
  async retireFailedWarmClaimForRetry(
    agentId: string,
    organizationId: string,
  ): Promise<{ success: true } | { success: false; error: string }> {
    const prepaid = (await this.host.getProvider()).computeFundingCapability === "host-lease-v1";
    const retire = (expectedStopped?: AgentSandbox) =>
      dbWrite.transaction(async (tx) => {
        await this.host.lockLifecycle(tx, agentId, organizationId);
        const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
        if (current) {
          const tierRejection = containerBackedServiceRejection(current, "credential");
          if (tierRejection) throw new Error(tierRejection);
        }
        if (
          !current?.claimed_at ||
          current.warm_claim_credential_state !== "failed" ||
          !current.warm_claim_cleanup_completed_at
        ) {
          return {
            success: false as const,
            error: "Warm-claim retry ownership changed before teardown",
          };
        }
        if (
          current.deleted_at ||
          current.deletion_attempt_id ||
          (expectedStopped &&
            (!snapshotCaptureStillCanonical(current, expectedStopped) ||
              current.lifecycle_job_id !== expectedStopped.lifecycle_job_id ||
              current.lifecycle_execution_generation !==
                expectedStopped.lifecycle_execution_generation))
        ) {
          return {
            success: false as const,
            error: "Warm-claim retry ownership changed before teardown",
          };
        }
        if (!current.sandbox_id && (current.node_id || current.container_name)) {
          return {
            success: false as const,
            error: "Previous warm-claim container locator is incomplete",
          };
        }
        if (prepaid) {
          const [window] = await tx
            .select()
            .from(agentComputeFunding)
            .where(
              and(
                eq(agentComputeFunding.agent_id, agentId),
                eq(agentComputeFunding.organization_id, organizationId),
                isNull(agentComputeFunding.settled_at),
              ),
            )
            .for("update");
          if (window) {
            const identity = {
              agentId,
              organizationId,
              lifecycleRevision: current.lifecycle_revision,
              fundingId: window.id,
            };
            const funding =
              window.provider_container_id === null
                ? await cancelUnboundAgentComputeInTransaction(tx, identity)
                : await stopFundedAgentInTransaction(tx, identity);
            if (!funding) throw new Error("Warm-claim retry lost its paid stop authority");
            const [stopped] = await tx
              .update(agentSandboxes)
              .set({ status: "stopped", updated_at: new Date() })
              .where(
                and(
                  eq(agentSandboxes.id, agentId),
                  eq(agentSandboxes.organization_id, organizationId),
                ),
              )
              .returning();
            if (!stopped) throw new Error("Warm-claim retry lost its stopped generation");
            if (current.node_id)
              await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, current.node_id);
            return { success: true as const, fundedRetirement: stopped, funding };
          }
        }
        if (current.sandbox_id) {
          const stop = prepaid
            ? await this.host.runBoundedSandboxStopForReplacement(current.sandbox_id, {
                releaseCapacity: false,
              })
            : await this.host.runBoundedSandboxStopForReplacement(current.sandbox_id);
          if (stop) {
            return {
              success: false as const,
              error: "Failed to retire the previous warm-claim container",
            };
          }
        }
        const reset = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          claimed_at = NULL,
          warm_claim_credential_state = NULL,
          warm_claim_source_pool_id = NULL,
          warm_claim_key_fingerprint = NULL,
          warm_claim_attested_at = NULL,
          warm_claim_attested_environment_revision = NULL,
          warm_claim_cleanup_completed_at = NULL,
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          node_id = NULL,
          container_name = NULL,
          headscale_ip = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND claimed_at IS NOT NULL
          AND warm_claim_credential_state = 'failed'
          AND warm_claim_cleanup_completed_at IS NOT NULL
          AND sandbox_id IS NOT DISTINCT FROM ${current.sandbox_id}
          AND node_id IS NOT DISTINCT FROM ${current.node_id}
          AND container_name IS NOT DISTINCT FROM ${current.container_name}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING id
      `);
        if (reset.rows.length !== 1) {
          throw new Error("Failed warm-claim retry lost its cleanup CAS");
        }
        if (prepaid && current.node_id)
          await reconcileAllocatedWorkloadsOnNodeWithDatabase(tx, current.node_id);
        return { success: true as const };
      });
    const first = await retire();
    if (!first.success || !("fundedRetirement" in first)) return first;
    if (!first.funding || !first.fundedRetirement)
      throw new Error("Warm-claim retry lost its committed funding result");
    if (first.funding.purchasedCreditRefunded)
      await creditsService.invalidateCreditCaches(organizationId);
    const second = await retire(first.fundedRetirement);
    if (second.success && "fundedRetirement" in second)
      throw new Error("Warm-claim retry gained funding during teardown");
    return second;
  }

  /**
   * Revoke every credential owner retained by an exhausted handoff. The row
   * remains the durable retry record until both revocations succeed and a
   * lifecycle-locked CAS records cleanup completion.
   */
  async cleanupFailedWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
  ): Promise<boolean> {
    const prepared = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current || current.warm_claim_credential_state !== "failed") {
        return null;
      }
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (current.warm_claim_cleanup_completed_at) {
        return {
          alreadyComplete: true,
          sourcePoolId: null,
          lifecycleRevision: current.lifecycle_revision,
          revoked: [] as Array<{ ownerId: string; hashes: string[] }>,
        };
      }
      const credentialOwners = new Set(
        [agentId, current.warm_claim_source_pool_id].filter((id): id is string => Boolean(id)),
      );
      const revoked: Array<{ ownerId: string; hashes: string[] }> = [];
      for (const credentialOwnerId of credentialOwners) {
        revoked.push({
          ownerId: credentialOwnerId,
          hashes: await apiKeysService.revokeForAgent(credentialOwnerId, tx),
        });
      }
      return {
        alreadyComplete: false,
        sourcePoolId: current.warm_claim_source_pool_id,
        lifecycleRevision: current.lifecycle_revision,
        revoked,
      };
    });
    if (!prepared) return false;
    if (prepared.alreadyComplete) return true;

    for (const { ownerId, hashes } of prepared.revoked) {
      if (hashes.length === 0) continue;
      await apiKeysService.confirmRevocationAfterCommit(hashes);
      await apiKeysService.purgeConfirmedRevokedAgentKeys(ownerId, hashes);
    }

    return await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return false;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (
        current.warm_claim_credential_state !== "failed" ||
        current.warm_claim_source_pool_id !== prepared.sourcePoolId ||
        current.lifecycle_revision !== prepared.lifecycleRevision
      ) {
        return Boolean(
          current.warm_claim_credential_state === "failed" &&
            current.warm_claim_cleanup_completed_at,
        );
      }
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          warm_claim_source_pool_id = NULL,
          warm_claim_cleanup_completed_at = NOW(),
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND warm_claim_credential_state = 'failed'
          AND warm_claim_cleanup_completed_at IS NULL
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${prepared.sourcePoolId}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${prepared.lifecycleRevision}
        RETURNING id
      `);
      if (result.rows.length === 1) return true;
      throw new Error("Failed warm-claim credential cleanup lost its state CAS");
    });
  }

  async completeWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
    expectedSourcePoolId?: string,
  ): Promise<{ pushed: boolean; keyPrefix?: string }> {
    // Every re-key below runs on `tx` for the same reason the managed-launch
    // path does, and the hashes it revokes are collected here so the
    // invalidation can be repeated once the rotation is durable. Only ever
    // read after the transaction resolves.
    const rotatedKeyHashes: string[] = [];
    const prepared = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) {
        throw new Error("Warm-claim key push requires a claimed sandbox row");
      }
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (!current.claimed_at) {
        throw new Error("Warm-claim key push requires a claimed sandbox row");
      }
      if (
        current.warm_claim_credential_state === "ready" &&
        current.status === "running" &&
        current.warm_claim_source_pool_id === null
      ) {
        return { current, plainKey: null, fingerprint: current.warm_claim_key_fingerprint };
      }
      if (current.status !== "provisioning") {
        throw new Error(`Warm-claim credential handoff cannot run from ${current.status}`);
      }
      if (expectedSourcePoolId && current.warm_claim_source_pool_id !== expectedSourcePoolId) {
        throw new Error("Warm-claim source pool row changed before credential handoff");
      }

      const materialized = await decryptAgentEnvVars(current.environment_vars);
      const persistedKey = materialized.ELIZAOS_CLOUD_API_KEY;
      if (current.warm_claim_credential_state === "attested") {
        if (!persistedKey) {
          throw new Error("Attested warm-claim target credential is missing");
        }
        const persistedFingerprint = await warmClaimKeyFingerprint(persistedKey);
        if (
          current.warm_claim_key_fingerprint !== persistedFingerprint ||
          current.warm_claim_attested_environment_revision !== current.environment_revision
        ) {
          // Every raw transition carries the database generation loaded under
          // the lifecycle lock; the trigger advances the returned generation.
          const rows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              warm_claim_credential_state = 'pending',
              warm_claim_key_fingerprint = NULL,
              warm_claim_attested_at = NULL,
              warm_claim_attested_environment_revision = NULL,
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'attested'
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                current.warm_claim_source_pool_id
              }
              AND environment_revision = ${current.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${current.lifecycle_revision}
            RETURNING *
          `);
          const rearmed = rows.rows[0];
          if (!rearmed) {
            throw new Error("Warm-claim re-attestation lost its state CAS");
          }
          const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
            organizationId,
            userId: rearmed.user_id,
            agentSandboxId: rearmed.id,
            tx,
          });
          rotatedKeyHashes.push(...revokedKeyHashes);
          const fingerprint = await warmClaimKeyFingerprint(plainKey);
          const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
            ELIZAOS_CLOUD_API_KEY: plainKey,
            ELIZAOS_CLOUD_ENABLED: "true",
          });
          const remintedRows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
              environment_revision = environment_revision + 1,
              warm_claim_key_fingerprint = ${fingerprint},
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint IS NULL
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                rearmed.warm_claim_source_pool_id
              }
              AND environment_revision = ${rearmed.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${rearmed.lifecycle_revision}
            RETURNING *
          `);
          const reminted = remintedRows.rows[0];
          if (!reminted) {
            throw new Error("Warm-claim credential remint lost its state CAS");
          }
          return {
            current: reminted,
            plainKey,
            fingerprint,
          };
        }
        return { current, plainKey: null, fingerprint: current.warm_claim_key_fingerprint };
      }
      if (
        current.warm_claim_credential_state !== "pending" &&
        current.warm_claim_credential_state !== null
      ) {
        throw new Error(`Warm-claim credential handoff is ${current.warm_claim_credential_state}`);
      }
      if (current.warm_claim_key_fingerprint) {
        if (
          !persistedKey ||
          (await warmClaimKeyFingerprint(persistedKey)) !== current.warm_claim_key_fingerprint
        ) {
          const rows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              warm_claim_key_fingerprint = NULL,
              warm_claim_attested_at = NULL,
              warm_claim_attested_environment_revision = NULL,
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint = ${current.warm_claim_key_fingerprint}
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                current.warm_claim_source_pool_id
              }
              AND environment_revision = ${current.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${current.lifecycle_revision}
            RETURNING *
          `);
          const rearmed = rows.rows[0];
          if (!rearmed) {
            throw new Error("Warm-claim pending credential re-arm lost its state CAS");
          }
          const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
            organizationId,
            userId: rearmed.user_id,
            agentSandboxId: rearmed.id,
            tx,
          });
          rotatedKeyHashes.push(...revokedKeyHashes);
          const fingerprint = await warmClaimKeyFingerprint(plainKey);
          const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
            ELIZAOS_CLOUD_API_KEY: plainKey,
            ELIZAOS_CLOUD_ENABLED: "true",
          });
          const remintedRows = await tx.execute<AgentSandbox>(sql`
            UPDATE ${agentSandboxes}
            SET
              environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
              environment_revision = environment_revision + 1,
              warm_claim_key_fingerprint = ${fingerprint},
              updated_at = NOW()
            WHERE id = ${agentId}
              AND organization_id = ${organizationId}
              AND status = 'provisioning'
              AND warm_claim_credential_state = 'pending'
              AND warm_claim_key_fingerprint IS NULL
              AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
                rearmed.warm_claim_source_pool_id
              }
              AND environment_revision = ${rearmed.environment_revision}
              AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
              AND lifecycle_revision = ${rearmed.lifecycle_revision}
            RETURNING *
          `);
          const reminted = remintedRows.rows[0];
          if (!reminted) {
            throw new Error("Warm-claim pending credential remint lost its state CAS");
          }
          return { current: reminted, plainKey, fingerprint };
        }
        return {
          current,
          plainKey: persistedKey,
          fingerprint: current.warm_claim_key_fingerprint,
        };
      }

      const { plainKey, revokedKeyHashes } = await apiKeysService.createForAgent({
        organizationId,
        userId: current.user_id,
        agentSandboxId: current.id,
        tx,
      });
      rotatedKeyHashes.push(...revokedKeyHashes);
      const fingerprint = await warmClaimKeyFingerprint(plainKey);
      const encryptedPatch = await encryptAgentEnvVarsForStorage(organizationId, {
        ELIZAOS_CLOUD_API_KEY: plainKey,
        ELIZAOS_CLOUD_ENABLED: "true",
      });
      const rows = await tx.execute<AgentSandbox>(sql`
        UPDATE ${agentSandboxes}
        SET
          environment_vars = environment_vars || ${JSON.stringify(encryptedPatch)}::jsonb,
          environment_revision = environment_revision + 1,
          warm_claim_key_fingerprint = ${fingerprint},
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND claimed_at IS NOT NULL
          AND (
            warm_claim_credential_state = 'pending'
            OR warm_claim_credential_state IS NULL
          )
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING *
      `);
      const updated = rows.rows[0];
      if (!updated) {
        throw new Error("Warm-claim credential persistence lost its state CAS");
      }
      return { current: updated, plainKey, fingerprint };
    });

    // Durable now. Repeat the invalidation the transaction ran while the
    // revoked rows were still visible, so a request that re-cached one in that
    // gap cannot keep authenticating on it. Outstanding carriers are swept in
    // UNCONDITIONALLY: the attested/pending re-use branches above return a
    // persisted key without re-minting, so `rotatedKeyHashes` alone would be
    // empty there and a carrier from a failed earlier attempt would never be
    // re-offered (codex round-4 P1#1).
    {
      const outstandingCarrierHashes = [
        ...new Set([
          ...rotatedKeyHashes,
          ...(await apiKeysService.collectOutstandingRevokedKeyHashes(agentId)),
        ]),
      ];
      if (outstandingCarrierHashes.length > 0) {
        try {
          await apiKeysService.confirmRevocationAfterCommit(outstandingCarrierHashes);
          // Reap EXACTLY what this attempt confirmed — nothing broader.
          await apiKeysService.purgeConfirmedRevokedAgentKeys(agentId, outstandingCarrierHashes);
        } catch (cause) {
          // error-policy:J2 context-adding rethrow — the re-key is committed, so
          // an unconfirmed invalidation leaves a superseded credential possibly
          // live in cache. Surface it rather than report a clean handoff.
          throw new ElizaError(
            "Warm-claim credential handoff could not confirm revocation of the superseded credential",
            {
              code: "WARM_CLAIM_REVOCATION_UNCONFIRMED",
              cause,
              context: {
                agentId,
                organizationId,
                revokedKeyCount: outstandingCarrierHashes.length,
              },
              severity: "fatal",
            },
          );
        }
      }
    }

    if (
      prepared.current.warm_claim_credential_state === "ready" &&
      prepared.current.status === "running"
    ) {
      return {
        pushed: false,
        keyPrefix: prepared.plainKey ? safeKeyPrefix(prepared.plainKey) : undefined,
      };
    }
    if (prepared.current.warm_claim_credential_state === "attested") {
      await this.finalizeWarmClaimCredentialHandoff(
        agentId,
        organizationId,
        prepared.current.warm_claim_source_pool_id,
        prepared.current.warm_claim_key_fingerprint,
        prepared.current.warm_claim_attested_environment_revision,
      );
      return { pushed: false };
    }
    if (!prepared.plainKey || !prepared.fingerprint) {
      throw new Error("Warm-claim target credential is unavailable");
    }

    const body = buildWarmClaimKeyPushBody({
      apiKey: prepared.plainKey,
      organizationId,
      userId: prepared.current.user_id,
    });
    if (!body) {
      // A blank minted key or missing org is a broken mint pipeline. Reporting
      // `pushed: false` here would let the caller advertise an un-re-keyed
      // container as ready — the exact failure class this handoff exists to
      // prevent — so it fails closed like every other handoff fault.
      throw new Error("Warm-claim key push has no usable minted key/org for the claimed row");
    }

    const attestedRevision = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (!current) return null;
      const tierRejection = containerBackedServiceRejection(current, "credential");
      if (tierRejection) throw new Error(tierRejection);
      if (current.warm_claim_credential_state === "attested") {
        return current.warm_claim_attested_environment_revision;
      }
      if (
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "pending" ||
        current.warm_claim_key_fingerprint !== prepared.fingerprint ||
        current.warm_claim_source_pool_id !== prepared.current.warm_claim_source_pool_id
      ) {
        return null;
      }
      const currentEnv = await decryptAgentEnvVars(current.environment_vars);
      const currentKey = currentEnv.ELIZAOS_CLOUD_API_KEY;
      if (!currentKey || (await warmClaimKeyFingerprint(currentKey)) !== prepared.fingerprint) {
        return null;
      }
      // Keep the authoritative row lock across the bounded runtime write. A
      // tier transition therefore cannot race the credential PUT and later
      // turn a container-free row into the owner of the runtime side effect.
      const res = await this.host.fetchAgentApi(
        { ...current, environment_vars: currentEnv },
        "/api/cloud/login/persist",
        {
          method: "POST",
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(WARM_CLAIM_KEY_PUSH_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        throw new Error(`Warm-claim key push failed: HTTP ${res.status}`);
      }
      const responseBody = (await res.json()) as {
        ok?: unknown;
        appliedKeyFingerprint?: unknown;
      };
      const echoedFingerprint =
        typeof responseBody.appliedKeyFingerprint === "string"
          ? responseBody.appliedKeyFingerprint
          : undefined;
      if (responseBody.ok !== true || echoedFingerprint !== prepared.fingerprint) {
        throw new Error("Warm-claim key push was not attested by the running runtime");
      }

      const attestedAt = new Date();
      const result = await tx.execute<{ environment_revision: number }>(sql`
        UPDATE ${agentSandboxes}
        SET
          warm_claim_credential_state = 'attested',
          warm_claim_attested_at = ${attestedAt},
          warm_claim_attested_environment_revision = environment_revision,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND warm_claim_credential_state = 'pending'
          AND warm_claim_key_fingerprint = ${prepared.fingerprint}
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${
            prepared.current.warm_claim_source_pool_id
          }
          AND environment_revision = ${current.environment_revision}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${current.lifecycle_revision}
        RETURNING environment_revision
      `);
      return result.rows[0]?.environment_revision ?? null;
    });
    if (attestedRevision === null) {
      throw new Error("Warm-claim credential attestation lost its state CAS");
    }
    await this.finalizeWarmClaimCredentialHandoff(
      agentId,
      organizationId,
      prepared.current.warm_claim_source_pool_id,
      prepared.fingerprint,
      attestedRevision,
    );

    return { pushed: true, keyPrefix: safeKeyPrefix(prepared.plainKey) };
  }

  async finalizeWarmClaimCredentialHandoff(
    agentId: string,
    organizationId: string,
    expectedSourcePoolId: string | null,
    expectedFingerprint: string | null,
    expectedEnvironmentRevision: number | null,
  ): Promise<void> {
    if (!expectedFingerprint || expectedEnvironmentRevision === null) {
      throw new Error("Warm-claim attestation metadata is incomplete");
    }
    const revocation = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (current) {
        const tierRejection = containerBackedServiceRejection(current, "credential");
        if (tierRejection) throw new Error(tierRejection);
      }
      if (
        !current ||
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "attested" ||
        current.warm_claim_source_pool_id !== expectedSourcePoolId ||
        current.warm_claim_key_fingerprint !== expectedFingerprint ||
        current.environment_revision !== expectedEnvironmentRevision ||
        current.warm_claim_attested_environment_revision !== expectedEnvironmentRevision
      ) {
        return null;
      }
      const revokedKeyHashes = expectedSourcePoolId
        ? await apiKeysService.revokeForAgent(expectedSourcePoolId, tx)
        : [];
      return {
        lifecycleRevision: current.lifecycle_revision,
        revokedKeyHashes,
      };
    });
    if (!revocation) {
      throw new Error("Warm-claim source revocation lost its state CAS");
    }

    if (expectedSourcePoolId && revocation.revokedKeyHashes.length > 0) {
      await apiKeysService.confirmRevocationAfterCommit(revocation.revokedKeyHashes);
      await apiKeysService.purgeConfirmedRevokedAgentKeys(
        expectedSourcePoolId,
        revocation.revokedKeyHashes,
      );
    }

    const finalized = await dbWrite.transaction(async (tx) => {
      await this.host.lockLifecycle(tx, agentId, organizationId);
      const current = await this.host.getAgentForLifecycleMutation(tx, agentId, organizationId);
      if (current) {
        const tierRejection = containerBackedServiceRejection(current, "credential");
        if (tierRejection) throw new Error(tierRejection);
      }
      if (
        current?.status === "running" &&
        current.warm_claim_credential_state === "ready" &&
        current.warm_claim_source_pool_id === null
      ) {
        return true;
      }
      if (
        !current ||
        current.status !== "provisioning" ||
        current.warm_claim_credential_state !== "attested" ||
        current.warm_claim_source_pool_id !== expectedSourcePoolId ||
        current.warm_claim_key_fingerprint !== expectedFingerprint ||
        current.environment_revision !== expectedEnvironmentRevision ||
        current.warm_claim_attested_environment_revision !== expectedEnvironmentRevision ||
        current.lifecycle_revision !== revocation.lifecycleRevision
      ) {
        return false;
      }
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'running',
          warm_claim_credential_state = 'ready',
          warm_claim_source_pool_id = NULL,
          error_message = NULL,
          updated_at = NOW()
        WHERE id = ${agentId}
          AND organization_id = ${organizationId}
          AND status = 'provisioning'
          AND warm_claim_credential_state = 'attested'
          AND warm_claim_source_pool_id IS NOT DISTINCT FROM ${expectedSourcePoolId}
          AND warm_claim_key_fingerprint = ${expectedFingerprint}
          AND environment_revision = ${expectedEnvironmentRevision}
          AND warm_claim_attested_environment_revision = ${expectedEnvironmentRevision}
          AND ${inArray(agentSandboxes.execution_tier, [...CONTAINER_BACKED_EXECUTION_TIERS])}
          AND lifecycle_revision = ${revocation.lifecycleRevision}
        RETURNING id
      `);
      return result.rows.length === 1;
    });
    if (!finalized) {
      throw new Error("Warm-claim credential finalization lost its state CAS");
    }
  }
}
