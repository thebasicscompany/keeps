-- 0018_phase7_entities.sql
-- Phase 7 (Wave 0) — entity foundation for the Context Engine.
-- ONE migration covering the new entity graph: two brand-new enum TYPEs, the `entities`
-- table, nullable FK columns on `loops`, and the `loop_entities` join table — so the
-- parallel Wave A–D agents share a single schema and never fight over migration numbers.
-- Enum-VALUE additions to EXISTING types (e.g. new loop_event_type values for
-- reconciliation provenance) live in 0019 (they cannot run inside a transaction).
-- Hand-written per the Data & Migrations section. Idempotent: DO-block guard for the new
-- types, CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS.

-- ============================================================================
-- 1. New enum TYPEs
--    Brand-new types, so it is safe to create them here and immediately reference them
--    from columns in this same file (unlike ALTER TYPE ... ADD VALUE).
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE "entity_kind" AS ENUM (
    'person',
    'company',
    'other'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "loop_entity_role" AS ENUM (
    'owner',
    'requester',
    'participant'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. entities — first-class people / companies promoted from free-text owner/requester.
--    canonical_email is the ONLY safe auto-merge key (normalized: lowercased, +tags
--    stripped) — enforced unique per user via a PARTIAL unique index (NULL emails are
--    allowed to repeat: a name-only entity has no email yet).
--    merged_into_entity_id is a self-FK tombstone for REVERSIBLE merges — resolveEntity
--    follows the pointer to the canonical row. SET NULL (not CASCADE) so deleting the
--    canonical target never destroys the merged row.
--    aliases jsonb holds the set of observed names for this entity (name is an ALIAS,
--    never a join key).
-- ============================================================================
CREATE TABLE IF NOT EXISTS "entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind" "entity_kind" NOT NULL DEFAULT 'person',
  "display_name" text NOT NULL,
  "canonical_email" text,
  "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "merged_into_entity_id" uuid REFERENCES "entities" ("id") ON DELETE SET NULL,
  "first_seen_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One canonical entity per (user, normalized email). Partial: only enforced when an email
-- is present, so multiple name-only entities can coexist.
CREATE UNIQUE INDEX IF NOT EXISTS "entities_user_canonical_email_unique"
  ON "entities" ("user_id", "canonical_email")
  WHERE "canonical_email" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "entities_user_kind_idx" ON "entities" ("user_id", "kind");
CREATE INDEX IF NOT EXISTS "entities_merged_into_idx" ON "entities" ("merged_into_entity_id");

-- ============================================================================
-- 3. loops: nullable FK columns linking a loop to its owner / requester entity.
--    ON DELETE SET NULL — KEEP owner_text/requester_text as the provenance fallback so a
--    loop is never orphaned by an entity delete/merge.
-- ============================================================================
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "owner_entity_id" uuid REFERENCES "entities" ("id") ON DELETE SET NULL;
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "requester_entity_id" uuid REFERENCES "entities" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "loops_owner_entity_idx" ON "loops" ("owner_entity_id");
CREATE INDEX IF NOT EXISTS "loops_requester_entity_idx" ON "loops" ("requester_entity_id");

-- ============================================================================
-- 4. loop_entities — the many-to-many join (a loop can have several participants).
--    Surrogate id PK + unique (loop_id, entity_id, role) so the same entity can appear in
--    distinct roles on one loop but never duplicates a (loop, entity, role) triple.
--    Both FKs CASCADE: a join row has no meaning once either side is gone.
-- ============================================================================
CREATE TABLE IF NOT EXISTS "loop_entities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "loop_id" uuid NOT NULL REFERENCES "loops" ("id") ON DELETE CASCADE,
  "entity_id" uuid NOT NULL REFERENCES "entities" ("id") ON DELETE CASCADE,
  "role" "loop_entity_role" NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "loop_entities_loop_entity_role_unique"
  ON "loop_entities" ("loop_id", "entity_id", "role");

CREATE INDEX IF NOT EXISTS "loop_entities_entity_idx" ON "loop_entities" ("entity_id");
CREATE INDEX IF NOT EXISTS "loop_entities_loop_idx" ON "loop_entities" ("loop_id");
