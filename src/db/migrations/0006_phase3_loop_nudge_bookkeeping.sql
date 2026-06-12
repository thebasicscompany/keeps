-- 0006_phase3_loop_nudge_bookkeeping.sql
-- Phase 3 (task A1) — nudge bookkeeping columns on loops and a covering index for
-- the cron sweep.  The sweep queries loops by (status, next_check_at); the partial
-- index limits it to active statuses so it stays small as done/dismissed/snoozed rows
-- accumulate.
-- Hand-written per the Data & Migrations section.

-- 1. Nudge bookkeeping columns.
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "last_nudged_at" timestamptz;
ALTER TABLE "loops" ADD COLUMN IF NOT EXISTS "nudge_count" integer NOT NULL DEFAULT 0;

-- 2. Partial index for the sweep eligibility query.
CREATE INDEX IF NOT EXISTS "loops_next_check_at_idx"
  ON "loops" ("status", "next_check_at")
  WHERE status IN ('open', 'waiting_on_me', 'waiting_on_other', 'candidate');
