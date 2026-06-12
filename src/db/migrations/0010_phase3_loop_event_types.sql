-- 0010_phase3_loop_event_types.sql
-- Phase 3 (task A1) — new loop_event_type enum values for nudge and digest traceability.
-- Hand-written per the Data & Migrations section.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older Postgres and
-- must be idempotent for safe replay, so each value is added with IF NOT EXISTS in its
-- own statement.

ALTER TYPE "loop_event_type" ADD VALUE IF NOT EXISTS 'nudged';
ALTER TYPE "loop_event_type" ADD VALUE IF NOT EXISTS 'digest_summarized';
