-- 0017_phase6_reactivate_audit_action.sql
-- Phase 6 (Wave D) — audit_action value for the deliverability "manually reactivate"
-- action (/admin/deliverability resets a suppressed user's outbound_email_state to
-- 'active'). ALTER TYPE ... ADD VALUE cannot run in a transaction; kept in its own
-- non-transactional file with IF NOT EXISTS for safe replay (mirrors 0016).

ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.outbound.reactivated';
