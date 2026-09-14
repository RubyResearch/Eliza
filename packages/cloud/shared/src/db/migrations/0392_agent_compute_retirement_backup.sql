-- A stopped container can be reclaimed only from its transaction-bound current backup.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "retirement_backup_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_retirement_backup_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_retirement_backup_check"
      CHECK ("retirement_backup_id" IS NULL OR ("settled_at" IS NOT NULL AND "provider_stopped_at" IS NOT NULL));
  END IF;
END $$;
