-- 0004_add_clerk_audit_actions.sql
-- Phase 2.6 (task A6) — add Clerk auth audit actions.
-- Hand-written per the Data & Migrations section: drizzle-kit/db:migrate do not run in
-- this repo (no journal, pre-existing), so this file is authoritative and is applied by
-- hand via `psql` (see plan Wave D / D2).
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres and
-- must be idempotent for safe replay, so each value is added with IF NOT EXISTS.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'auth.clerk_user_created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'auth.clerk_email_verified';
