/**
 * Classifies every direct user/organization foreign key for account erasure.
 *
 * The companion schema test pins the exact foreign-key inventory. A schema
 * change must therefore update both the snapshot and this policy deliberately;
 * falling through is never treated as permission to cascade or retain data.
 */

import { ElizaError } from "@elizaos/core";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "./schemas";

export type AccountDeletionForeignKeyAction =
  | "anonymize_retained_record"
  | "delete_private_data"
  | "reconcile_external_resource"
  | "transfer_shared_resource";

export interface AccountDeletionForeignKeyDescriptor {
  sourceTable: string;
  sourceColumns: string;
  targetTable: "organizations" | "users";
  targetColumns: string;
  onDelete: string;
}
/** SHA-256 of the 256 sorted direct user/organization FK descriptors. */
export const ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256 =
  "86c047604bfc369d65192892c90f0572213c549bbce5a0a3fa8b0ddb0132b373";

function serializeDescriptor(descriptor: AccountDeletionForeignKeyDescriptor): string {
  return [
    descriptor.sourceTable,
    descriptor.sourceColumns,
    descriptor.targetTable,
    descriptor.targetColumns,
    descriptor.onDelete,
  ].join("|");
}

/** Runtime inventory shared by export, erasure, and the schema ratchet test. */
export function listAccountDeletionForeignKeys(): AccountDeletionForeignKeyDescriptor[] {
  const tableNames = new Set<string>();
  const descriptors: AccountDeletionForeignKeyDescriptor[] = [];
  for (const value of Object.values(schema)) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(value as Parameters<typeof getTableConfig>[0]);
    } catch {
      // error-policy:J3 schema barrels also export non-table values; only
      // successfully introspected PostgreSQL tables enter the FK authority.
      continue;
    }
    if (!config.name || tableNames.has(config.name)) continue;
    tableNames.add(config.name);
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const targetTable = getTableConfig(reference.foreignTable).name;
      if (targetTable !== "organizations" && targetTable !== "users") continue;
      descriptors.push({
        sourceTable: config.name,
        sourceColumns: reference.columns.map((column) => column.name).join(","),
        targetTable,
        targetColumns: reference.foreignColumns.map((column) => column.name).join(","),
        onDelete: foreignKey.onDelete ?? "no action",
      });
    }
  }
  return descriptors.sort((left, right) =>
    serializeDescriptor(left).localeCompare(serializeDescriptor(right)),
  );
}

/**
 * Rows whose removal is only safe after the corresponding provider, object,
 * credential, key, or durable lifecycle operation has a terminal receipt.
 */
const EXTERNAL_RESOURCE_TABLES = new Set([
  "ad_accounts",
  "agent_activation_publications",
  "agent_backup_admission_work",
  "agent_backup_catalog_authorities",
  "agent_backup_gc_outbox",
  "agent_backup_objects",
  "agent_backup_restore_leases",
  "agent_backup_restore_operations",
  "agent_backup_restore_receipts",
  "agent_backup_restore_v3_candidate_cleanup_outbox",
  "agent_backup_restore_v3_candidates",
  "agent_compute_stop_intents",
  "agent_sandbox_backups",
  "agent_sandbox_replacement_attempts",
  "agent_sandboxes",
  "agent_server_wallets",
  "agent_vault_key_authorities",
  "agent_vault_key_backup_bindings",
  "agent_vault_key_generations",
  "agent_vault_key_seed_receipts",
  "api_keys",
  "apps",
  "billing_subscriptions",
  "subscription_billing_fences",
  "cloud_files",
  "container_compute_stop_intents",
  "containers",
  "discord_connections",
  "managed_domains",
  "mobile_app_auth_grants",
  "oauth_sessions",
  "org_storage_delete_operations",
  "org_storage_gc_outbox",
  "org_storage_objects",
  "org_storage_put_operations",
  "org_storage_read_operations",
  "organization_encryption_keys",
  "platform_credential_sessions",
  "platform_credentials",
  "pooled_credentials",
  "remote_sessions",
  "secret_bindings",
  "secrets",
  "stripe_connect_accounts",
  "telegram_chats",
  "user_mcps",
  "user_sessions",
  "user_voices",
  "vendor_connections",
  "vertex_model_assignments",
  "vertex_tuned_models",
  "vertex_tuning_jobs",
  "voice_cloning_jobs",
  "voice_imprint_clusters",
  "voice_imprint_observations",
  "voice_samples",
  "web_push_subscriptions",
]);

/** Shared tenant assets must be transferred or explicitly revoked, never cascaded. */
const SHARED_RESOURCE_TABLES = new Set([
  "agent_budgets",
  "organization_invites",
  "personal_shared_group_bindings",
  "personal_shared_group_claims",
  "personal_shared_group_participants",
  "pooled_credentials",
]);

/**
 * Financial, abuse, settlement, and security tables need explicit handling
 * when a restrictive identifier cannot cascade. The provider inventory may
 * erase privacy-bearing history instead of retaining and anonymizing it.
 */
const RETAINED_AUDIT_TABLES = new Set([
  "admin_users",
  "affiliate_payout_outbox",
  "agent_billing_records",
  "agent_compute_subjects",
  "ai_billing_records",
  "app_earnings_transactions",
  "app_requests",
  "app_reservation_settlement_quarantines",
  "app_reservation_settlements",
  "app_reviews",
  "app_secret_requirements",
  "billing_cancel_command_keys",
  "billing_cancel_commands",
  "billing_funding_reservations",
  "billing_subscription_commands",
  "billing_subscription_event_receipts",
  "billing_subscription_incidents",
  "billing_subscription_revisions",
  "cloud_files",
  "compute_billing_rate_segments",
  "container_billing_legacy_ledger_bindings",
  "container_billing_records",
  "conversation_speaker_attributions",
  "credit_transactions",
  "generations",
  "inference_pending_charges",
  "jobs",
  "llm_trajectories",
  "mcp_usage",
  "moderation_violations",
  "org_storage_read_operations",
  "payment_request_receipts",
  "payment_requests",
  "platform_credential_sessions",
  "press_media_contacts",
  "press_releases",
  "referral_signups",
  "secret_bindings",
  "seo_requests",
  "stripe_checkout_legacy_quarantine",
  "stripe_checkout_orders",
  "stripe_customer_attempts",
  "stripe_customer_legacy_quarantines",
  "subscription_allowance_periods",
  "subscription_allowance_transactions",
  "token_redemptions",
  "usage_records",
  "user_mcps",
  "user_moderation_status",
  "vertex_model_assignments",
  "vertex_tuning_jobs",
  "voice_imprint_clusters",
  "voice_imprint_observations",
]);

/**
 * Classifies the handling obligation imposed by an FK, not the final row operation.
 * Provider adapters may satisfy retained-record obligations by erasing privacy-bearing rows.
 */
export function classifyAccountDeletionForeignKey(
  descriptor: AccountDeletionForeignKeyDescriptor,
): AccountDeletionForeignKeyAction {
  const { sourceTable, targetTable, onDelete } = descriptor;

  if (RETAINED_AUDIT_TABLES.has(sourceTable) && onDelete !== "cascade") {
    return "anonymize_retained_record";
  }
  if (SHARED_RESOURCE_TABLES.has(sourceTable)) {
    return "transfer_shared_resource";
  }
  if (EXTERNAL_RESOURCE_TABLES.has(sourceTable)) {
    return "reconcile_external_resource";
  }
  if (onDelete === "set null") {
    return "anonymize_retained_record";
  }
  if (onDelete === "cascade") {
    return "delete_private_data";
  }

  throw new ElizaError(
    `Unclassified account-deletion foreign key: ${sourceTable}.${descriptor.sourceColumns} -> ${targetTable}.${descriptor.targetColumns} (${onDelete})`,
    {
      code: "ACCOUNT_DELETION_FOREIGN_KEY_UNCLASSIFIED",
      context: {
        sourceTable,
        sourceColumns: descriptor.sourceColumns,
        targetTable,
        targetColumns: descriptor.targetColumns,
        onDelete,
      },
      severity: "fatal",
    },
  );
}
