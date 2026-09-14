CREATE TABLE IF NOT EXISTS "agent_compute_subjects" (
  "agent_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "retired_at" timestamptz,
  CONSTRAINT "agent_compute_subjects_tenant_unique" UNIQUE ("agent_id", "organization_id")
);
--> statement-breakpoint
-- Hold both writers while backfilling and moving the retained financial FK.
LOCK TABLE "agent_sandboxes", "agent_compute_funding" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
INSERT INTO "agent_compute_subjects" ("agent_id", "organization_id", "created_at")
SELECT "agent_id", "organization_id", min("created_at") FROM "agent_compute_funding"
GROUP BY "agent_id", "organization_id" ON CONFLICT ("agent_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_compute_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.agent_id, NEW.organization_id) IS DISTINCT FROM (OLD.agent_id, OLD.organization_id) THEN
      RAISE EXCEPTION 'Compute funding identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM agent_sandboxes WHERE id = NEW.agent_id
    AND organization_id = NEW.organization_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute funding requires a live tenant agent'; END IF;
  INSERT INTO agent_compute_subjects (agent_id, organization_id)
    VALUES (NEW.agent_id, NEW.organization_id) ON CONFLICT (agent_id) DO NOTHING;
  PERFORM 1 FROM agent_compute_subjects WHERE agent_id = NEW.agent_id
    AND organization_id = NEW.organization_id AND retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute billing identity is retired or belongs to another tenant'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "guard_agent_compute_subject" ON "agent_compute_funding";
--> statement-breakpoint
CREATE TRIGGER "guard_agent_compute_subject" BEFORE INSERT OR UPDATE ON "agent_compute_funding"
  FOR EACH ROW EXECUTE FUNCTION guard_agent_compute_subject();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_compute_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM agent_compute_subjects WHERE agent_id = NEW.id) THEN
      RAISE EXCEPTION 'A retained compute billing identity cannot be reused';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id) IS DISTINCT FROM (OLD.id, OLD.organization_id)
      AND EXISTS (SELECT 1 FROM agent_compute_subjects WHERE agent_id = OLD.id) THEN
      RAISE EXCEPTION 'A funded agent identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM agent_compute_funding WHERE agent_id = OLD.id AND settled_at IS NULL) THEN
    RAISE EXCEPTION 'Unsettled compute must be stopped before agent deletion';
  END IF;
  UPDATE agent_compute_subjects SET retired_at = COALESCE(retired_at, clock_timestamp())
    WHERE agent_id = OLD.id AND organization_id = OLD.organization_id;
  RETURN OLD;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "guard_agent_compute_retirement" ON "agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER "guard_agent_compute_retirement" BEFORE INSERT OR DELETE OR UPDATE OF id, organization_id ON "agent_sandboxes"
  FOR EACH ROW EXECUTE FUNCTION guard_agent_compute_retirement();
--> statement-breakpoint
ALTER TABLE "agent_compute_funding" DROP CONSTRAINT IF EXISTS "agent_compute_funding_agent_tenant_fk";
--> statement-breakpoint
ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_agent_tenant_fk"
  FOREIGN KEY ("agent_id", "organization_id") REFERENCES "agent_compute_subjects"("agent_id", "organization_id") ON DELETE RESTRICT;
