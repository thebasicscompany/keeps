-- 0014_phase5_report_audit_actions.sql
-- Phase 5 (task A1) — new audit_action enum values for report lifecycle events.
-- Hand-written per the Data & Migrations section.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres
-- and must be idempotent for safe replay, so each value is added with IF NOT EXISTS
-- in its own statement (mirrors 0009/0012 style).

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'report.requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'report.generated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'report.viewed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'report.action_applied';
