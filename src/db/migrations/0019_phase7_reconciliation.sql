-- 0019_phase7_reconciliation.sql
-- Phase 7 (Wave B) — reconciliation foundation: trigram/phonetic extensions + fuzzy
-- candidate indexes, plus enum-VALUE additions for the suppressed-duplicate state and
-- reconciliation provenance.
--
-- NON-TRANSACTIONAL: this file contains `ALTER TYPE ... ADD VALUE`, which cannot run inside
-- a transaction block (and a newly-added value cannot be USED in the same transaction).
-- Apply it OUTSIDE a BEGIN/COMMIT (plain `psql -f`). Every statement is idempotent
-- (IF NOT EXISTS), so re-running is safe. Mirrors the 0016 enum-value convention.

-- ============================================================================
-- 1. Trigram + phonetic extensions — drive name/summary similarity SUGGESTIONS only
--    (the B3 candidate generator), NEVER an auto-merge. Bought, not built (plan §3).
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- ============================================================================
-- 2. GIN trigram indexes powering the B3 context loader's fuzzy candidate generator —
--    similarity() over a loop's summary + free-text counterparty. Retrieval is cheap and
--    loose by design (it can never cause a false merge; only the decider can), so a fast
--    trigram scan is exactly right. (Index only — schema.ts keeps drizzle-kit disabled.)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "loops_summary_trgm_idx" ON "loops" USING gin ("summary" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "loops_owner_text_trgm_idx" ON "loops" USING gin ("owner_text" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "loops_requester_text_trgm_idx" ON "loops" USING gin ("requester_text" gin_trgm_ops);

-- ============================================================================
-- 3. loop_status: 'suppressed' — a created-but-hidden duplicate produced by the
--    uncertain-middle reconciliation band (Arav's decision, plan §6b). A suppressed loop is
--    NOT nudged and NOT surfaced as open; it exists only so no commitment is ever lost while
--    we ask the user "same as your loop about X?". On "different" → promote to 'open'; on
--    "same" → dismiss it and apply the update to the original (both via mutateLoopState).
-- ============================================================================
ALTER TYPE "loop_status" ADD VALUE IF NOT EXISTS 'suppressed';

-- ============================================================================
-- 4. loop_event_type: reconciliation provenance (AR-9). Every reconciliation decision —
--    auto, ask, or user-confirmation — writes exactly one of these, explainable in one
--    sentence.
-- ============================================================================
ALTER TYPE "loop_event_type" ADD VALUE IF NOT EXISTS 'reconciled';           -- auto advance/close of an existing loop
ALTER TYPE "loop_event_type" ADD VALUE IF NOT EXISTS 'reconcile_suggested';  -- uncertain middle: ask sent + suppressed dup created
ALTER TYPE "loop_event_type" ADD VALUE IF NOT EXISTS 'superseded';           -- suppressed dup dismissed; update applied to the original
