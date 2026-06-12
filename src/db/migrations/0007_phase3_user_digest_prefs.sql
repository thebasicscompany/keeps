-- 0007_phase3_user_digest_prefs.sql
-- Phase 3 (task A1) — per-user digest preference columns and an index that the hourly
-- digest sweep uses to find users due at a given send_hour.
-- Hand-written per the Data & Migrations section.

-- 1. Digest preference columns.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_enabled" boolean NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "digest_send_hour" integer NOT NULL DEFAULT 8;

-- 2. Partial index: only index rows where digest is enabled so the sweep scan stays
--    small when most users have digest off (or for future opt-out flows).
CREATE INDEX IF NOT EXISTS "users_digest_send_hour_idx"
  ON "users" ("digest_send_hour")
  WHERE digest_enabled;
