ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "provider_stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "provider_stop_receipt" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_stop_receipt_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_stop_receipt_check" CHECK (num_nonnulls("agent_compute_funding"."provider_stopped_at", "agent_compute_funding"."provider_stop_receipt") IN (0, 2)
        AND ("agent_compute_funding"."provider_stopped_at" IS NULL OR ("agent_compute_funding"."settled_at" IS NOT NULL
          AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt") = 'object'
          AND (("agent_compute_funding"."provider_stop_receipt"->>'fundingId' = "agent_compute_funding"."id"::text
            AND "agent_compute_funding"."provider_stop_receipt"->>'containerId' = "agent_compute_funding"."provider_container_id"
            AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt"->'stoppedAtMs') = 'number'
            AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt"->'bootId') = 'string') IS TRUE))));
  END IF;
END $$;
