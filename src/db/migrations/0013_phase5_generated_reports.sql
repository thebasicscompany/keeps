-- 0013_phase5_generated_reports.sql
-- Phase 5 (task A1) — generated_report_kind enum and generated_reports table with
-- supporting indexes.
-- Hand-written per the Data & Migrations section.
--
-- CREATE TYPE is not idempotent without a DO block; guard with duplicate_object
-- exception handling (mirrors 0008 style for idempotent enum creation).

DO $$ BEGIN
  CREATE TYPE "generated_report_kind" AS ENUM (
    'insights',
    'waiting_on',
    'stale',
    'weekly',
    'entity'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "generated_reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "kind" "generated_report_kind" NOT NULL,
  "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "summary" text NOT NULL DEFAULT '',
  "token_hash" text NOT NULL,
  "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_viewed_at" timestamptz,
  "view_count" integer NOT NULL DEFAULT 0,
  "requested_via" text NOT NULL,
  "request_inbound_email_id" uuid REFERENCES "inbound_emails" ("id") ON DELETE SET NULL,
  "request_nudge_id" uuid REFERENCES "nudges" ("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "generated_reports_token_hash_unique"
  ON "generated_reports" ("token_hash");

CREATE INDEX IF NOT EXISTS "generated_reports_user_created_idx"
  ON "generated_reports" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "generated_reports_expires_idx"
  ON "generated_reports" ("expires_at");
