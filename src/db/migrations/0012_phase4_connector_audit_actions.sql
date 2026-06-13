-- 0012_phase4_connector_audit_actions.sql
-- Phase 4 (task A1) — new audit_action enum values for connector lifecycle
-- and policy gate events.
-- Hand-written per the Data & Migrations section.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- Postgres and must be idempotent for safe replay, so each value is added
-- with IF NOT EXISTS in its own statement (mirrors 0009 style).

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.account_connected';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.account_revoked';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.account_auth_error';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.action_requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.action_executed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.action_failed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'connector.recipient_ambiguous';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'policy.authorize_denied';
