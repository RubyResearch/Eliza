/** Verifies complete, fail-closed user and organization FK deletion policy. */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256,
  type AccountDeletionForeignKeyDescriptor,
  classifyAccountDeletionForeignKey,
  listAccountDeletionForeignKeys,
} from "./account-deletion-foreign-key-policy";

function serializeDescriptor(descriptor: AccountDeletionForeignKeyDescriptor): string {
  return [
    descriptor.sourceTable,
    descriptor.sourceColumns,
    descriptor.targetTable,
    descriptor.targetColumns,
    descriptor.onDelete,
  ].join("|");
}

describe("account deletion full-schema foreign-key policy", () => {
  test("pins the exact direct user and organization FK inventory", () => {
    const descriptors = listAccountDeletionForeignKeys();
    const digest = createHash("sha256")
      .update(descriptors.map(serializeDescriptor).join("\n"))
      .digest("hex");

    expect(descriptors).toHaveLength(256);
    expect(digest).toBe(ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256);
  });

  test("classifies every FK without an implicit destructive fallback", () => {
    const classified = listAccountDeletionForeignKeys().map((descriptor) => ({
      descriptor,
      action: classifyAccountDeletionForeignKey(descriptor),
    }));

    expect(classified).toHaveLength(256);
    expect(classified.every(({ action }) => Boolean(action))).toBe(true);
    expect(classified.filter(({ action }) => action === "reconcile_external_resource").length).toBe(
      75,
    );
    expect(classified.filter(({ action }) => action === "transfer_shared_resource").length).toBe(
      11,
    );
  });

  test("requires provider reconciliation before deleting sandbox replacement attempts", () => {
    const replacementAttempt = listAccountDeletionForeignKeys().find(
      ({ sourceTable, sourceColumns }) =>
        sourceTable === "agent_sandbox_replacement_attempts" && sourceColumns === "organization_id",
    );

    expect(replacementAttempt).toEqual({
      sourceTable: "agent_sandbox_replacement_attempts",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    });
    expect(classifyAccountDeletionForeignKey(replacementAttempt!)).toBe(
      "reconcile_external_resource",
    );
  });

  test("requires reconciliation before deleting backup admission work", () => {
    const admissionWork = listAccountDeletionForeignKeys().find(
      ({ sourceTable, sourceColumns }) =>
        sourceTable === "agent_backup_admission_work" && sourceColumns === "organization_id",
    );

    expect(admissionWork).toEqual({
      sourceTable: "agent_backup_admission_work",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    });
    expect(classifyAccountDeletionForeignKey(admissionWork!)).toBe("reconcile_external_resource");
  });

  test("requires reconciliation before deleting restore-v3 candidates and cleanup work", () => {
    const restoreV3Relationships = listAccountDeletionForeignKeys().filter(
      ({ sourceTable, sourceColumns }) =>
        [
          "agent_backup_restore_v3_candidate_cleanup_outbox",
          "agent_backup_restore_v3_candidates",
        ].includes(sourceTable) && sourceColumns === "organization_id",
    );

    expect(restoreV3Relationships).toEqual([
      {
        sourceTable: "agent_backup_restore_v3_candidate_cleanup_outbox",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "restrict",
      },
      {
        sourceTable: "agent_backup_restore_v3_candidates",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "restrict",
      },
    ]);
    expect(
      restoreV3Relationships.map((descriptor) => classifyAccountDeletionForeignKey(descriptor)),
    ).toEqual(["reconcile_external_resource", "reconcile_external_resource"]);
  });

  test("deletes terminal restore-v3 GC proof with its owning organization", () => {
    const gcTombstone = listAccountDeletionForeignKeys().find(
      ({ sourceTable, sourceColumns }) =>
        sourceTable === "agent_backup_restore_v3_candidate_gc_tombstones" &&
        sourceColumns === "organization_id",
    );

    expect(gcTombstone).toEqual({
      sourceTable: "agent_backup_restore_v3_candidate_gc_tombstones",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "cascade",
    });
    expect(classifyAccountDeletionForeignKey(gcTombstone!)).toBe("delete_private_data");
  });

  test("anonymizes all four billing-cancel subject relationships", () => {
    const billingCancelRelationships = listAccountDeletionForeignKeys().filter(({ sourceTable }) =>
      ["billing_cancel_commands", "billing_cancel_command_keys"].includes(sourceTable),
    );

    expect(billingCancelRelationships).toHaveLength(4);
    expect(
      billingCancelRelationships.map((descriptor) => ({
        sourceTable: descriptor.sourceTable,
        sourceColumns: descriptor.sourceColumns,
        targetTable: descriptor.targetTable,
        action: classifyAccountDeletionForeignKey(descriptor),
      })),
    ).toEqual([
      {
        sourceTable: "billing_cancel_command_keys",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        action: "anonymize_retained_record",
      },
      {
        sourceTable: "billing_cancel_command_keys",
        sourceColumns: "requested_by_user_id",
        targetTable: "users",
        action: "anonymize_retained_record",
      },
      {
        sourceTable: "billing_cancel_commands",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        action: "anonymize_retained_record",
      },
      {
        sourceTable: "billing_cancel_commands",
        sourceColumns: "requested_by_user_id",
        targetTable: "users",
        action: "anonymize_retained_record",
      },
    ]);
  });

  test("retains the billing identity obligation after an operational agent is deleted", () => {
    const subject = listAccountDeletionForeignKeys().find(
      ({ sourceTable }) => sourceTable === "agent_compute_subjects",
    );
    expect(subject).toEqual({
      sourceTable: "agent_compute_subjects",
      sourceColumns: "organization_id",
      targetTable: "organizations",
      targetColumns: "id",
      onDelete: "restrict",
    });
    expect(classifyAccountDeletionForeignKey(subject!)).toBe("anonymize_retained_record");
  });

  test("rejects an unknown restrictive relationship", () => {
    let failure: unknown;
    try {
      classifyAccountDeletionForeignKey({
        sourceTable: "new_provider_grants",
        sourceColumns: "organization_id",
        targetTable: "organizations",
        targetColumns: "id",
        onDelete: "restrict",
      });
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(ElizaError);
    expect(failure).toMatchObject({
      code: "ACCOUNT_DELETION_FOREIGN_KEY_UNCLASSIFIED",
      severity: "fatal",
    });
  });
});
