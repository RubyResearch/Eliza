-- Heartbeats report liveness without replacing the agent lifecycle or runtime.
-- A heartbeat during capture must not invalidate the backup revision fence.
-- Keep all other columns protected by default, including lifecycle_revision
-- itself, so mixed lifecycle writes and caller-supplied revisions still advance.

DROP TRIGGER IF EXISTS agent_sandboxes_lifecycle_revision_trigger ON "agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER agent_sandboxes_lifecycle_revision_trigger
BEFORE UPDATE ON "agent_sandboxes" FOR EACH ROW WHEN (
  to_jsonb(OLD) - ARRAY[
    'billing_status', 'last_billed_at', 'hourly_rate', 'total_billed',
    'shutdown_warning_sent_at', 'scheduled_shutdown_at', 'updated_at', 'last_heartbeat_at',
    'next_backup_at', 'backup_schedule_operation_id', 'backup_schedule_retry_at',
    'backup_schedule_claim_owner', 'backup_schedule_claim_generation',
    'backup_schedule_claim_expires_at', 'backup_schedule_attempts',
    'backup_schedule_last_error_code', 'backup_schedule_last_protected_at'
  ]::text[] IS DISTINCT FROM to_jsonb(NEW) - ARRAY[
    'billing_status', 'last_billed_at', 'hourly_rate', 'total_billed',
    'shutdown_warning_sent_at', 'scheduled_shutdown_at', 'updated_at', 'last_heartbeat_at',
    'next_backup_at', 'backup_schedule_operation_id', 'backup_schedule_retry_at',
    'backup_schedule_claim_owner', 'backup_schedule_claim_generation',
    'backup_schedule_claim_expires_at', 'backup_schedule_attempts',
    'backup_schedule_last_error_code', 'backup_schedule_last_protected_at'
  ]::text[]
)
EXECUTE FUNCTION advance_agent_sandbox_lifecycle_revision();
