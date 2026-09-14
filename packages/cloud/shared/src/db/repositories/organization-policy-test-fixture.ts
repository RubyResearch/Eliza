/** Adds real subscription authority migrations to isolated legacy resource fixtures without replacing the resource under test. */
import { readFile } from "node:fs/promises";
export async function installOrganizationPolicyTestSchema(
  execute: (query: string) => Promise<unknown>,
): Promise<void> {
  await execute(`
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS credit_balance numeric(16,6) NOT NULL DEFAULT 0;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS balance_revision bigint NOT NULL DEFAULT 0;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS account_lifecycle_state text NOT NULL DEFAULT 'active';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS paid_work_fenced_at timestamptz;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS stripe_customer_id text;
    CREATE TABLE IF NOT EXISTS users(id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS credit_transactions(id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id));
    ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS amount numeric(16,6);
    ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS type text;
    ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS metadata jsonb;
    CREATE UNIQUE INDEX IF NOT EXISTS policy_fixture_credit_identity ON credit_transactions(id,organization_id);
    CREATE TABLE IF NOT EXISTS organization_config(organization_id uuid PRIMARY KEY REFERENCES organizations(id),settings jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS org_rate_limit_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid UNIQUE REFERENCES organizations(id),completions_rpm integer,embeddings_rpm integer,standard_rpm integer,strict_rpm integer,note text,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now());
    CREATE TABLE IF NOT EXISTS org_storage_quota(organization_id uuid PRIMARY KEY REFERENCES organizations(id),bytes_used bigint NOT NULL DEFAULT 0,bytes_limit bigint NOT NULL DEFAULT 5368709120,created_at timestamp DEFAULT now(),updated_at timestamp DEFAULT now(),native_catalog_reconciled_at timestamptz);
    ALTER TABLE org_storage_quota ADD COLUMN IF NOT EXISTS native_catalog_reconciled_at timestamptz;
    CREATE TABLE IF NOT EXISTS agent_sandboxes(id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id),status text,pool_status text);
  `);
  // These isolated fixtures may start from today's pushed schema; replay the
  // actual migration before any fixture rows exist.
  await execute(
    "ALTER TABLE org_storage_quota DROP COLUMN IF EXISTS limit_override_authorized; ALTER TABLE agent_sandboxes DROP COLUMN IF EXISTS quota_admission_scope;",
  );
  for (const name of [
    "0373_subscription_authority.sql",
    "0374_subscription_funding_transaction_uniqueness.sql",
    "0379_subscription_account_authority.sql",
    "0380_organization_policy_authority.sql",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint"))
      if (statement.trim()) await execute(statement);
  }
  await execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS policy_fixture_agent_identity ON agent_sandboxes(id,organization_id)",
  );
  for (const name of [
    "0387_agent_compute_funding.sql",
    "0389_agent_compute_stop_receipts.sql",
    "0390_agent_compute_runtime_readiness.sql",
    "0392_agent_compute_retirement_backup.sql",
    "0393_agent_compute_activation_minimum.sql",
  ]) {
    const migration = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    // The fixture's connection search_path owns all of its tables. Generated
    // public-qualified foreign keys must resolve there too, including self references.
    await execute(migration.replaceAll('"public".', ""));
  }
}
