CREATE TYPE "working_style" AS ENUM ('brief', 'warm', 'direct', 'chief_of_staff');
CREATE TYPE "user_status" AS ENUM ('pending', 'verified', 'disabled');
CREATE TYPE "audit_action" AS ENUM (
  'user.created',
  'user.email_verified',
  'user.working_style_updated',
  'auth.dev_session_created',
  'email.inbound.placeholder_received',
  'policy.external_action_blocked'
);

CREATE TABLE "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "display_name" text,
  "company_name" text,
  "working_style" "working_style" DEFAULT 'direct' NOT NULL,
  "status" "user_status" DEFAULT 'pending' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "verified_at" timestamp with time zone
);

CREATE TABLE "user_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "email" text NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "action" "audit_action" NOT NULL,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "user_identities"
  ADD CONSTRAINT "user_identities_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "users_email_unique" ON "users" ("email");
CREATE INDEX "users_status_idx" ON "users" ("status");
CREATE UNIQUE INDEX "user_identities_provider_account_unique"
  ON "user_identities" ("provider", "provider_account_id");
CREATE INDEX "user_identities_user_idx" ON "user_identities" ("user_id");
CREATE INDEX "audit_log_user_idx" ON "audit_log" ("user_id");
CREATE INDEX "audit_log_action_idx" ON "audit_log" ("action");
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" ("created_at");
