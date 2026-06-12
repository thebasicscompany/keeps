-- 0009_phase3_audit_actions.sql
-- Phase 3 (task A1) — new audit_action enum values for nudge, digest, and approval
-- lifecycle events.
-- Hand-written per the Data & Migrations section.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres and
-- must be idempotent for safe replay, so each value is added with IF NOT EXISTS in its
-- own statement.

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'nudge.sent';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'digest.sent';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'approval.requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'approval.decided';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'approval.expired';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'approval.executed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'approval.execution_failed';
