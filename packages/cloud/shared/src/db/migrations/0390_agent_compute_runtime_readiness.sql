-- A host start/health response does not prove application restore completed.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "runtime_ready_at" timestamp with time zone;
