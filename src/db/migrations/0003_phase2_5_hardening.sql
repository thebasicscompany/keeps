-- 0003_phase2_5_hardening.sql
-- Phase 2.5 pipeline hardening.
-- Hand-written per Deliverable 12 and the Data & Migrations section; drizzle-kit
-- generate does not emit the enum rename-swap, so this file is authoritative.

-- 1. MailboxHash capture (Deliverable 7 / Data & Migrations 1).
ALTER TABLE "inbound_emails" ADD COLUMN "mailbox_hash" text;
CREATE INDEX "inbound_emails_mailbox_hash_idx" ON "inbound_emails" ("mailbox_hash");

-- 2. Lifecycle-only loop_status (Deliverable 12 / AR-6).
-- Postgres cannot drop enum values in place, so swap to a new enum that lacks
-- 'due_soon'/'overdue' and rename it back to 'loop_status'. Existing rows in the
-- removed states collapse to 'open'.
CREATE TYPE "loop_status_v2" AS ENUM (
  'candidate','open','waiting_on_me','waiting_on_other',
  'blocked','snoozed','done','dismissed'
);
ALTER TABLE "loops" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "loops"
  ALTER COLUMN "status" TYPE "loop_status_v2"
  USING (
    CASE
      WHEN "status"::text IN ('due_soon','overdue') THEN 'open'::loop_status_v2
      ELSE "status"::text::loop_status_v2
    END
  );
ALTER TABLE "loops" ALTER COLUMN "status" SET DEFAULT 'candidate'::loop_status_v2;
DROP TYPE "loop_status";
ALTER TYPE "loop_status_v2" RENAME TO "loop_status";

-- outbound_emails added in Wave B
