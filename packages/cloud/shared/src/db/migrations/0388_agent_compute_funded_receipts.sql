ALTER TABLE "agent_billing_records" ALTER COLUMN "credit_transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "compute_funding_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_compute_funding_tenant_fk') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_compute_funding_tenant_fk" FOREIGN KEY ("compute_funding_id","sandbox_id","organization_id") REFERENCES "public"."agent_compute_funding"("id","agent_id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_records_compute_funding_idx" ON "agent_billing_records" USING btree ("compute_funding_id") WHERE "agent_billing_records"."compute_funding_id" IS NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_source_check') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_funding_source_check" CHECK (num_nonnulls("agent_billing_records"."credit_transaction_id", "agent_billing_records"."compute_funding_id") = 1);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_funded_billing_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.compute_funding_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_compute_funding f
    JOIN billing_funding_reservations r ON r.id=f.funding_reservation_id AND r.organization_id=f.organization_id
    WHERE f.id=NEW.compute_funding_id AND f.organization_id=NEW.organization_id AND f.agent_id=NEW.sandbox_id
      AND f.settled_at IS NOT NULL AND f.settled_through=NEW.billing_period_end
      AND date_trunc('milliseconds',f.period_start)=NEW.billing_period_start
      AND r.status='finalized' AND r.uncollected_overage_amount=0
      AND NEW.amount=(SELECT sum(a.finalized_amount) FROM billing_funding_allocations a
        WHERE a.reservation_id=r.id AND a.organization_id=r.organization_id)
  ) THEN
    RAISE EXCEPTION 'agent billing receipt must match its finalized funding and metered period'
      USING ERRCODE='23514', CONSTRAINT='agent_billing_records_funding_evidence_guard';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='agent_billing_records'::regclass AND tgname='agent_billing_records_funding_evidence_guard') THEN
    CREATE TRIGGER agent_billing_records_funding_evidence_guard BEFORE INSERT ON agent_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_agent_funded_billing_receipt();
  END IF;
END $$;
