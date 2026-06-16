-- 0021_org_visibility.sql
-- Org-Visibility Re-Founding (Wave 0) — tenancy + the canView relationship graph.
--
-- ADDITIVE + NON-DESTRUCTIVE: new TYPEs / TABLEs + NULLABLE org_id/scope_id columns only.
-- No data is mutated, no column is dropped, nothing is made NOT NULL here. The personal-org
-- backfill (scripts/backfill-orgs.ts) and the later org_id NOT NULL tightening + entity
-- canonicalization (0022) are SEPARATE, review-gated steps. This file is transaction-safe
-- (no ALTER TYPE ... ADD VALUE) but is applied like the others with plain `psql -f`.
-- Every statement is idempotent (DO-block guards / IF NOT EXISTS). Mirrors 0018/0020 style.

-- ── 1. New enum TYPEs ─────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "org_member_role" AS ENUM ('owner','admin','member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "scope_kind" AS ENUM ('org_root','deal','account','team');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- The relation tuple kinds the canView resolver unions over (Zanzibar-style).
  CREATE TYPE "visibility_relation" AS ENUM ('org_admin','manager_of','scope_member','explicit_share');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "visibility_object_type" AS ENUM ('org','user','scope','loop','entity');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. organizations ──────────────────────────────────────────────────────────
-- A personal org (is_personal = true, clerk_org_id NULL) is the degenerate single-member
-- case; a real org mirrors a Clerk Organization (clerk_org_id set) already used for billing.
CREATE TABLE IF NOT EXISTS "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "clerk_org_id" text,
  "name" text NOT NULL DEFAULT '',
  "is_personal" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_clerk_org_id_unique"
  ON "organizations" ("clerk_org_id") WHERE "clerk_org_id" IS NOT NULL;

-- ── 3. org_memberships (mirrors Clerk membership + role on sync) ───────────────
CREATE TABLE IF NOT EXISTS "org_memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "role" "org_member_role" NOT NULL DEFAULT 'member',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "org_memberships_org_user_unique"
  ON "org_memberships" ("org_id","user_id");
CREATE INDEX IF NOT EXISTS "org_memberships_user_idx" ON "org_memberships" ("user_id");

-- ── 4. scopes (cross-cutting deal/account/team groups; org_root = whole org) ───
CREATE TABLE IF NOT EXISTS "scopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "kind" "scope_kind" NOT NULL DEFAULT 'team',
  "name" text NOT NULL DEFAULT '',
  -- Delegated scope owner: manages this scope's membership without full org admin. NULL = admin-only.
  "owner_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "scopes_org_idx" ON "scopes" ("org_id");

-- ── 5. visibility_edges (the relation tuples canView unions over) ──────────────
-- subject_user_id is empowered to see object_id (interpreted per object_type):
--   org_admin       → object_type='org'   : whole-org visibility
--   manager_of      → object_type='user'  : a report's resources (down the reporting line)
--   scope_member    → object_type='scope' : everything tagged to that scope
--   explicit_share  → object_type in (loop,entity) : one specific resource
-- revoked_at IS NULL = active. Revocation is immediate (the active partial index excludes it).
CREATE TABLE IF NOT EXISTS "visibility_edges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations" ("id") ON DELETE CASCADE,
  "subject_user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "relation" "visibility_relation" NOT NULL,
  "object_type" "visibility_object_type" NOT NULL,
  "object_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "visibility_edges_subject_active_idx"
  ON "visibility_edges" ("subject_user_id","org_id") WHERE "revoked_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "visibility_edges_tuple_unique"
  ON "visibility_edges" ("subject_user_id","relation","object_type","object_id");

-- ── 6. NULLABLE org_id / scope_id on resource tables ──────────────────────────
-- Additive only. Backfill (personal org per user + edges) sets these; a LATER migration
-- tightens org_id to NOT NULL once backfill is verified. Until then, NULL org_id = pre-org row.
ALTER TABLE "loops"            ADD COLUMN IF NOT EXISTS "org_id"   uuid REFERENCES "organizations" ("id") ON DELETE CASCADE;
ALTER TABLE "loops"            ADD COLUMN IF NOT EXISTS "scope_id" uuid REFERENCES "scopes" ("id")        ON DELETE SET NULL;
ALTER TABLE "entities"         ADD COLUMN IF NOT EXISTS "org_id"   uuid REFERENCES "organizations" ("id") ON DELETE CASCADE;
ALTER TABLE "entities"         ADD COLUMN IF NOT EXISTS "scope_id" uuid REFERENCES "scopes" ("id")        ON DELETE SET NULL;
ALTER TABLE "source_evidence"  ADD COLUMN IF NOT EXISTS "org_id"   uuid REFERENCES "organizations" ("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "loops_org_idx"     ON "loops" ("org_id");
CREATE INDEX IF NOT EXISTS "loops_scope_idx"   ON "loops" ("scope_id");
CREATE INDEX IF NOT EXISTS "entities_org_idx"  ON "entities" ("org_id");
CREATE INDEX IF NOT EXISTS "entities_scope_idx" ON "entities" ("scope_id");
