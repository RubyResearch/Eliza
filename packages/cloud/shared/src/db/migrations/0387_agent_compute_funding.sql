-- Dedicated funding intervals use the existing per-source reservation ledger.
CREATE TABLE IF NOT EXISTS "agent_compute_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"funding_reservation_id" uuid NOT NULL,
	"previous_funding_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"hourly_rate" numeric(16, 6) NOT NULL,
	"provider_node_id" text,
	"provider_container_id" text,
	"provider_bound_at" timestamp with time zone,
	"host_lease_confirmed_at" timestamp with time zone,
	"settled_through" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_compute_funding_identity_unique" UNIQUE("id","agent_id","organization_id"),
	CONSTRAINT "agent_compute_funding_period_check" CHECK ("agent_compute_funding"."period_end" > "agent_compute_funding"."period_start" AND "agent_compute_funding"."hourly_rate" > 0
        AND "agent_compute_funding"."hourly_rate" <> 'NaN'::numeric),
	CONSTRAINT "agent_compute_funding_provider_check" CHECK (num_nonnulls("agent_compute_funding"."provider_node_id", "agent_compute_funding"."provider_container_id", "agent_compute_funding"."provider_bound_at") IN (0, 3)
        AND ("agent_compute_funding"."provider_container_id" IS NULL OR "agent_compute_funding"."provider_container_id" ~ '^[0-9a-f]{64}$')
        AND ("agent_compute_funding"."provider_node_id" IS NULL OR length("agent_compute_funding"."provider_node_id") > 0)),
	CONSTRAINT "agent_compute_funding_host_confirmation_check" CHECK ("agent_compute_funding"."host_lease_confirmed_at" IS NULL OR
        ("agent_compute_funding"."provider_bound_at" IS NOT NULL
          AND "agent_compute_funding"."host_lease_confirmed_at" >= "agent_compute_funding"."provider_bound_at"
          AND "agent_compute_funding"."host_lease_confirmed_at" < "agent_compute_funding"."period_end")),
	CONSTRAINT "agent_compute_funding_settlement_check" CHECK (("agent_compute_funding"."settled_at" IS NULL AND "agent_compute_funding"."settled_through" IS NULL)
        OR ("agent_compute_funding"."settled_at" IS NOT NULL AND "agent_compute_funding"."settled_through" IS NOT NULL
          AND "agent_compute_funding"."settled_through" BETWEEN "agent_compute_funding"."period_start" AND "agent_compute_funding"."period_end")),
	CONSTRAINT "agent_compute_funding_predecessor_fk" FOREIGN KEY ("previous_funding_id","agent_id","organization_id") REFERENCES "public"."agent_compute_funding"("id","agent_id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_compute_funding_agent_tenant_fk" FOREIGN KEY ("agent_id","organization_id") REFERENCES "public"."agent_sandboxes"("id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_compute_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_predecessor_idx" ON "agent_compute_funding" USING btree ("previous_funding_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_reservation_idx" ON "agent_compute_funding" USING btree ("funding_reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_open_agent_idx" ON "agent_compute_funding" USING btree ("agent_id") WHERE "agent_compute_funding"."settled_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_compute_funding_expiry_idx" ON "agent_compute_funding" USING btree ("period_end") WHERE "agent_compute_funding"."settled_at" IS NULL;
