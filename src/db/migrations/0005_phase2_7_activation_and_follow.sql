-- 0005_phase2_7_activation_and_follow.sql
-- Phase 2.7 (task A2) — activation-sent tracking, thread-follow audit action, and relax
-- outbound_emails nullability for system (non-nudge) sends.
-- Hand-written per the Data & Migrations section: drizzle-kit/db:migrate do not run in
-- this repo (no journal, pre-existing), so this file is authoritative and is applied by
-- hand via `psql` (see plan Wave A / A2).
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres and
-- must be idempotent for safe replay, so each value is added with IF NOT EXISTS in its
-- own statement.

-- 1. Track when an activation email was last sent to a pending sender.
ALTER TABLE "pending_inbound_emails" ADD COLUMN IF NOT EXISTS "activation_sent_at" timestamptz;

-- 2. Index for the activation throttle check: look up the most-recent send for a given
--    sender efficiently.
CREATE INDEX IF NOT EXISTS "pending_inbound_sender_activation_idx"
  ON "pending_inbound_emails" ("sender_email", "activation_sent_at");

-- 3. New audit action values.
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.activation_sent';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.activation_suppressed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.thread_followed';

-- 4. Relax outbound_emails for system (non-nudge) sends.
--    Phase 2.7 sends activation emails to unknown senders — they have no nudge row and
--    no user row yet — but we still want a full audit trail in outbound_emails.
--    Dropping NOT NULL here makes both columns optional; existing nudge-driven rows are
--    unaffected (they always carry both ids).
ALTER TABLE "outbound_emails" ALTER COLUMN "nudge_id" DROP NOT NULL;
ALTER TABLE "outbound_emails" ALTER COLUMN "user_id" DROP NOT NULL;
