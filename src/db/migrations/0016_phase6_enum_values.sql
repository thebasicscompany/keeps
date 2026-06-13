-- 0016_phase6_enum_values.sql
-- Phase 6 (Wave 0) — enum-VALUE additions to EXISTING types.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block and must be idempotent
-- for safe replay, so each value is added with IF NOT EXISTS in its own statement and is
-- kept in this separate, non-transactional file (mirrors 0009 / 0014 convention).

-- nudge_status: a nudge that exhausted its send retries (deliverable 13).
ALTER TYPE "nudge_status" ADD VALUE IF NOT EXISTS 'failed';

-- audit_action: trust/deliverability/dead-letter lifecycle events (Data & Migrations).
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.outbound.suppressed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.deleted_by_user';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'data.export_requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'data.export_completed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'data.delete_requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'data.delete_completed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'user.deleted';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'failed_processing.replayed';
