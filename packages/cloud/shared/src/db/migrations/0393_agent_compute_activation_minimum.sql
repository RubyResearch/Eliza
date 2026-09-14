-- Existing records keep zero; accepted new activations carry an explicit minimum.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "minimum_charge_remaining" numeric(16,6) NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_minimum_charge_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_minimum_charge_check"
      CHECK (minimum_charge_remaining >= 0 AND minimum_charge_remaining <> 'NaN'::numeric);
  END IF;
END $$;
