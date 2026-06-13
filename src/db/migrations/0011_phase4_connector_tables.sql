-- 0011_phase4_connector_tables.sql
-- Phase 4 (task A1) — connector_provider, connector_account_status,
-- connector_action_kind, connector_action_status enums; connector_accounts
-- and connector_actions tables with all indexes/uniques.
-- Hand-written per the Data & Migrations section (Composio-flavored: uses
-- composio_connected_account_id / composio_entity_id, not nango_* columns).
--
-- CREATE TYPE is not idempotent without a DO block; guard with a
-- DO $$ ... $$ block that checks pg_type before creating (mirrors 0008 style).

DO $$ BEGIN
  CREATE TYPE "connector_provider" AS ENUM (
    'slack',
    'google_calendar'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "connector_account_status" AS ENUM (
    'active',
    'revoked',
    'auth_error',
    'disabled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "connector_action_kind" AS ENUM (
    'slack_dm',
    'calendar_event'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "connector_action_status" AS ENUM (
    'pending',
    'executing',
    'completed',
    'failed',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 1. connector_accounts — one row per connected provider per user (V0: one Slack + one Calendar).
CREATE TABLE IF NOT EXISTS "connector_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "provider" "connector_provider" NOT NULL,
  "composio_connected_account_id" text NOT NULL,
  "composio_entity_id" text NOT NULL,
  "external_account_email" text,
  "external_account_label" text,
  "scopes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "status" "connector_account_status" NOT NULL DEFAULT 'active',
  "status_reason" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "disconnected_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- One Slack + one Calendar per user in V0.
CREATE UNIQUE INDEX IF NOT EXISTS "connector_accounts_user_provider_unique"
  ON "connector_accounts" ("user_id", "provider");

-- Composio connected account IDs are globally unique.
CREATE UNIQUE INDEX IF NOT EXISTS "connector_accounts_composio_connected_account_unique"
  ON "connector_accounts" ("composio_connected_account_id");

CREATE INDEX IF NOT EXISTS "connector_accounts_user_idx"
  ON "connector_accounts" ("user_id");

CREATE INDEX IF NOT EXISTS "connector_accounts_provider_status_idx"
  ON "connector_accounts" ("provider", "status");

-- 2. connector_actions — the execute-once execution record for each connector action.
CREATE TABLE IF NOT EXISTS "connector_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "connector_account_id" uuid NOT NULL REFERENCES "connector_accounts" ("id") ON DELETE RESTRICT,
  "inbound_email_id" uuid REFERENCES "inbound_emails" ("id") ON DELETE SET NULL,
  "loop_id" uuid REFERENCES "loops" ("id") ON DELETE SET NULL,
  "draft_id" uuid REFERENCES "drafts" ("id") ON DELETE SET NULL,
  "approval_request_id" uuid REFERENCES "approval_requests" ("id") ON DELETE SET NULL,
  "kind" "connector_action_kind" NOT NULL,
  "payload" jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" "connector_action_status" NOT NULL DEFAULT 'pending',
  "result" jsonb,
  "error" jsonb,
  "requested_at" timestamptz NOT NULL DEFAULT now(),
  "executed_at" timestamptz,
  "failed_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Idempotency: same key can never produce two rows.
CREATE UNIQUE INDEX IF NOT EXISTS "connector_actions_idempotency_key_unique"
  ON "connector_actions" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "connector_actions_user_status_idx"
  ON "connector_actions" ("user_id", "status");

CREATE INDEX IF NOT EXISTS "connector_actions_connector_account_idx"
  ON "connector_actions" ("connector_account_id");

CREATE INDEX IF NOT EXISTS "connector_actions_approval_request_idx"
  ON "connector_actions" ("approval_request_id");
