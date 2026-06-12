-- 0008_phase3_approval_tables.sql
-- Phase 3 (task A1) — approval_status enum, drafts table, approval_requests table, and
-- supporting indexes.
-- Hand-written per the Data & Migrations section.
--
-- CREATE TYPE is not idempotent in older Postgres without a DO block; guard with a
-- DO $$ ... $$ block that checks pg_type before creating (mirrors 0000 style for enums
-- that must be idempotent).

DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 1. Drafts — the pending action payload awaiting user approval.
CREATE TABLE IF NOT EXISTS "drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "action_kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "source_loop_id" uuid REFERENCES "loops" ("id") ON DELETE SET NULL,
  "requires_login" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "drafts_user_idx" ON "drafts" ("user_id");
CREATE INDEX IF NOT EXISTS "drafts_source_loop_idx" ON "drafts" ("source_loop_id");

-- 2. Approval requests — the lifecycle record for each approval ask.
CREATE TABLE IF NOT EXISTS "approval_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "draft_id" uuid NOT NULL REFERENCES "drafts" ("id") ON DELETE CASCADE,
  "action_kind" text NOT NULL,
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "decided_at" timestamptz,
  "decision_channel" text,
  "decision_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "approval_requests_user_status_idx"
  ON "approval_requests" ("user_id", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_token_hash_unique"
  ON "approval_requests" ("token_hash");
