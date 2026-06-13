-- 0015_phase6_foundation.sql
-- Phase 6 (Wave 0) — foundation schema for Reliability, Evaluation & Trust Hardening.
-- ONE migration covering ALL Phase 6 tables, column additions, and the one brand-new
-- enum TYPE up front, so parallel Wave A–E agents share a single schema and never fight
-- over migration numbers. Enum-VALUE additions to EXISTING types live in 0016 (they
-- cannot run in a transaction).
-- Hand-written per the Data & Migrations section. Idempotent: DO-block guard for the new
-- type, CREATE TABLE/INDEX IF NOT EXISTS, ALTER TABLE ADD COLUMN IF NOT EXISTS.

-- ============================================================================
-- 1. New enum TYPE: outbound_email_state (deliverable 6)
--    Brand-new type, so it is safe to create here and immediately reference from a
--    column in this same file (unlike ALTER TYPE ... ADD VALUE).
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE "outbound_email_state" AS ENUM (
    'active',
    'bounced',
    'complained',
    'suppressed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================================
-- 2. Column additions to existing tables
-- ============================================================================
-- users: deliverability suppression state, raw-email retention window, admin flag.
-- raw_email_retention_days is NULLABLE on purpose: NULL means the "until I delete"
-- opt-out (the retention cron never scrubs these users). Default 30 (alpha default).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "outbound_email_state" "outbound_email_state" NOT NULL DEFAULT 'active';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "raw_email_retention_days" integer DEFAULT 30;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_admin" boolean NOT NULL DEFAULT false;

-- inbound_emails / email_messages: retention scrub bookkeeping (deliverable 10).
ALTER TABLE "inbound_emails" ADD COLUMN IF NOT EXISTS "scrubbed_at" timestamptz;
ALTER TABLE "email_messages" ADD COLUMN IF NOT EXISTS "scrubbed_at" timestamptz;

-- Index supporting the daily cron's "find rows past retention not yet scrubbed" query.
CREATE INDEX IF NOT EXISTS "inbound_emails_scrubbed_idx"
  ON "inbound_emails" ("scrubbed_at", "created_at");
CREATE INDEX IF NOT EXISTS "email_messages_scrubbed_idx"
  ON "email_messages" ("scrubbed_at", "created_at");

-- ============================================================================
-- 3. New tables
-- ============================================================================

-- 3a. eval_runs — one row per `pnpm eval` invocation (deliverable 1/3).
CREATE TABLE IF NOT EXISTS "eval_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "mode" text NOT NULL,                       -- 'deterministic' | 'model'
  "git_sha" text,
  "model_id" text,
  "case_count" integer NOT NULL DEFAULT 0,
  "precision" real,
  "recall" real,
  "low_confidence_handling_rate" real,
  "false_positive_rate" real,
  "summary" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "eval_runs_created_idx" ON "eval_runs" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "eval_runs_mode_created_idx" ON "eval_runs" ("mode", "created_at" DESC);

-- 3b. eval_cases — small DB-backed backlog of pilot-submitted candidate cases awaiting
--     human labeling. The actual labeled cases live in src/agent/eval/cases/ as code.
--     user_id has no hard FK requirement (admin-created rows are null); use SET NULL so
--     a case outlives the submitting user.
CREATE TABLE IF NOT EXISTS "eval_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "normalized_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'pending_label',  -- 'pending_label' | 'labeled' | 'rejected'
  "notes" text
);

CREATE INDEX IF NOT EXISTS "eval_cases_status_idx" ON "eval_cases" ("status", "submitted_at");

-- 3c. model_calls — one row per instrumented generateObject call (deliverable 5).
--     purpose is text (not an enum) so adding a new model caller never needs a migration;
--     the application layer constrains it to:
--       extract_loops | classify_intent | draft_nudge | draft_slack | draft_calendar | summarize_report
--     user_id cascades on user deletion (trust: delete-all-data removes model logs too);
--     inbound_email_id SET NULL so a per-email delete keeps the debug row but drops the link.
--     prompt_preview is NULL by default and only populated under KEEPS_MODEL_LOG_PROMPT_PREVIEW=1.
CREATE TABLE IF NOT EXISTS "model_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid REFERENCES "users" ("id") ON DELETE CASCADE,
  "inbound_email_id" uuid REFERENCES "inbound_emails" ("id") ON DELETE SET NULL,
  "purpose" text NOT NULL,
  "model_id" text NOT NULL,
  "latency_ms" integer,
  "input_tokens" integer,
  "output_tokens" integer,
  "structured_output" jsonb,
  "prompt_preview" text,
  "error_message" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "model_calls_user_created_idx" ON "model_calls" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "model_calls_purpose_created_idx" ON "model_calls" ("purpose", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "model_calls_inbound_idx" ON "model_calls" ("inbound_email_id");

-- 3d. quality_metrics_daily — aggregate metric series (deliverables 3/6/15). Aggregate-only;
--     NOT deleted on user deletion.
CREATE TABLE IF NOT EXISTS "quality_metrics_daily" (
  "date" date NOT NULL,
  "metric" text NOT NULL,
  "value" real NOT NULL,
  "denominator" real,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("date", "metric")
);

-- 3e. data_deletion_requests — lifecycle record for account-wide deletion (deliverable 7).
--     user_id has NO FK so the row can outlive the user during/after deletion; email is
--     captured before delete for the audit window.
CREATE TABLE IF NOT EXISTS "data_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "email" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',   -- 'pending' | 'in_progress' | 'completed' | 'failed'
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "failure_message" text
);

CREATE INDEX IF NOT EXISTS "data_deletion_requests_status_idx"
  ON "data_deletion_requests" ("status", "requested_at");

-- 3f. failed_processing — dead-letter queue for inbound/workflow processing failures
--     (deliverable 14). inbound_email_id is a plain nullable uuid with NO FK: a failure may
--     pre-date persistence (no inbound row exists yet), so a FK would reject the insert.
CREATE TABLE IF NOT EXISTS "failed_processing" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "inbound_email_id" uuid,
  "event_name" text NOT NULL,
  "event_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error_message" text,
  "error_stack" text,
  "failed_at" timestamptz NOT NULL DEFAULT now(),
  "replayed_at" timestamptz,
  "resolved_at" timestamptz,
  "notes" text
);

-- Admin "open rows" query: WHERE resolved_at IS NULL ORDER BY failed_at DESC.
CREATE INDEX IF NOT EXISTS "failed_processing_open_idx"
  ON "failed_processing" ("resolved_at", "failed_at" DESC);
