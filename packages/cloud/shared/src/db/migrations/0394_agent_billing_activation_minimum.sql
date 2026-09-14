-- Existing records keep zero; accepted new activations carry an explicit minimum.
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "minimum_charge_amount" numeric(16,6) NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_minimum_charge_check') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_minimum_charge_check"
      CHECK (minimum_charge_amount >= 0 AND minimum_charge_amount <= amount AND minimum_charge_amount <> 'NaN'::numeric);
  END IF;
END $$;
