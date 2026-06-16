-- 0020_phase_v2_automation.sql
-- Phase V2 (Wave B) — standing grants + automation run ledger.
-- NON-TRANSACTIONAL: contains ALTER TYPE ... ADD VALUE at the bottom (cannot run in a txn).
-- Apply OUTSIDE BEGIN/COMMIT (plain `psql -f`). Every statement is idempotent. Mirrors 0019.

-- ── 1. New enum TYPEs (brand new -> safe to reference in this file) ───────────
DO $$ BEGIN
  CREATE TYPE "standing_grant_status" AS ENUM ('pending','active','paused','revoked','expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "automation_run_status" AS ENUM
    ('planned','skipped','needs_approval','executing','completed','failed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "automation_run_action_status" AS ENUM
    ('planned','needs_approval','executing','completed','failed','cancelled','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "automation_trigger_kind" AS ENUM
    ('calendar_event','loop_stale','explicit_command','cron');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. standing_grants ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "standing_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "recipe_key" text NOT NULL,
  "status" "standing_grant_status" NOT NULL DEFAULT 'pending',
  "scope" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "allowed_action_kinds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "blocked_action_kinds" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "constraints" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "caps" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "quiet_hours" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_from_approval_request_id" uuid REFERENCES "approval_requests" ("id") ON DELETE SET NULL,
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "standing_grants_user_status_idx" ON "standing_grants" ("user_id","status");
CREATE INDEX IF NOT EXISTS "standing_grants_user_recipe_status_idx" ON "standing_grants" ("user_id","recipe_key","status");
CREATE INDEX IF NOT EXISTS "standing_grants_active_expiry_idx" ON "standing_grants" ("expires_at") WHERE "status" = 'active';

-- ── 3. automation_runs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "automation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "standing_grant_id" uuid REFERENCES "standing_grants" ("id") ON DELETE SET NULL,
  "recipe_key" text NOT NULL,
  "trigger_kind" "automation_trigger_kind" NOT NULL,
  "trigger_ref" text,
  "status" "automation_run_status" NOT NULL,
  "idempotency_key" text NOT NULL,
  "input_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sandbox_plan" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "policy_decision" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "provenance" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "result" jsonb,
  "error" jsonb,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "executed_at" timestamptz,
  "completed_at" timestamptz,
  "failed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "automation_runs_idempotency_key_unique" ON "automation_runs" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "automation_runs_user_created_idx" ON "automation_runs" ("user_id","created_at" DESC);
CREATE INDEX IF NOT EXISTS "automation_runs_user_status_idx" ON "automation_runs" ("user_id","status");
CREATE INDEX IF NOT EXISTS "automation_runs_recipe_status_idx" ON "automation_runs" ("recipe_key","status");
CREATE INDEX IF NOT EXISTS "automation_runs_grant_created_idx" ON "automation_runs" ("standing_grant_id","created_at" DESC);

-- ── 4. automation_run_actions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "automation_run_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "automation_run_id" uuid NOT NULL REFERENCES "automation_runs" ("id") ON DELETE CASCADE,
  "action_kind" text NOT NULL,
  "status" "automation_run_action_status" NOT NULL,
  "target" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "policy_decision" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "connector_action_id" uuid REFERENCES "connector_actions" ("id") ON DELETE SET NULL,
  "approval_request_id" uuid REFERENCES "approval_requests" ("id") ON DELETE SET NULL,
  "result" jsonb,
  "error" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "automation_run_actions_run_idx" ON "automation_run_actions" ("automation_run_id");

-- ════════════════════════════════════════════════════════════════════════════
-- 5. NON-TRANSACTIONAL: audit_action enum additions (must follow CREATE above)
-- ════════════════════════════════════════════════════════════════════════════
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.requested';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.activated';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.paused';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.revoked';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'standing_grant.expired';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.triggered';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.planned';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.skipped';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.needs_approval';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.executing';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.completed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.failed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.cancelled';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.action_executed';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'automation.action_denied';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'policy.standing_grant_denied';
