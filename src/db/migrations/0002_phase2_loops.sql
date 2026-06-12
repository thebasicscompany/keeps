ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.classified';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'loops.extracted';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'loop.created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'loop.updated';

CREATE TYPE "loop_status" AS ENUM (
  'candidate',
  'open',
  'waiting_on_me',
  'waiting_on_other',
  'due_soon',
  'overdue',
  'blocked',
  'snoozed',
  'done',
  'dismissed'
);

CREATE TYPE "loop_kind" AS ENUM (
  'commitment',
  'ask',
  'waiting_on',
  'reminder',
  'customer_promise',
  'bug',
  'meeting_action',
  'personal_obligation',
  'other'
);

CREATE TYPE "loop_basis" AS ENUM ('explicit_commitment', 'inferred_next_step');

CREATE TYPE "loop_event_type" AS ENUM (
  'created',
  'confirmed',
  'corrected',
  'dismissed',
  'snoozed',
  'marked_done',
  'clarification_requested'
);

CREATE TYPE "nudge_status" AS ENUM ('pending', 'sent', 'skipped');

CREATE TABLE "source_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "inbound_email_id" uuid NOT NULL,
  "email_message_id" uuid,
  "provider_message_id" text NOT NULL,
  "source_type" text DEFAULT 'email' NOT NULL,
  "quote" text NOT NULL,
  "normalized_body" text DEFAULT '' NOT NULL,
  "start_offset" integer,
  "end_offset" integer,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "loops" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "email_thread_id" uuid NOT NULL,
  "inbound_email_id" uuid NOT NULL,
  "source_evidence_id" uuid NOT NULL,
  "status" "loop_status" DEFAULT 'candidate' NOT NULL,
  "kind" "loop_kind" DEFAULT 'other' NOT NULL,
  "basis" "loop_basis" DEFAULT 'inferred_next_step' NOT NULL,
  "summary" text NOT NULL,
  "owner_text" text,
  "requester_text" text,
  "due_date_text" text,
  "due_at" timestamp with time zone,
  "next_check_at" timestamp with time zone,
  "confidence" real NOT NULL,
  "participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ambiguity_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "loop_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "loop_id" uuid NOT NULL,
  "event_type" "loop_event_type" NOT NULL,
  "command_text" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "nudges" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "loop_id" uuid,
  "inbound_email_id" uuid,
  "nudge_type" text DEFAULT 'private_reply' NOT NULL,
  "status" "nudge_status" DEFAULT 'pending' NOT NULL,
  "channel" text DEFAULT 'email' NOT NULL,
  "subject" text,
  "body" text DEFAULT '' NOT NULL,
  "scheduled_for" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "source_evidence"
  ADD CONSTRAINT "source_evidence_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "source_evidence"
  ADD CONSTRAINT "source_evidence_inbound_email_id_inbound_emails_id_fk"
  FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "source_evidence"
  ADD CONSTRAINT "source_evidence_email_message_id_email_messages_id_fk"
  FOREIGN KEY ("email_message_id") REFERENCES "email_messages"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "loops"
  ADD CONSTRAINT "loops_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "loops"
  ADD CONSTRAINT "loops_email_thread_id_email_threads_id_fk"
  FOREIGN KEY ("email_thread_id") REFERENCES "email_threads"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "loops"
  ADD CONSTRAINT "loops_inbound_email_id_inbound_emails_id_fk"
  FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "loops"
  ADD CONSTRAINT "loops_source_evidence_id_source_evidence_id_fk"
  FOREIGN KEY ("source_evidence_id") REFERENCES "source_evidence"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "loop_events"
  ADD CONSTRAINT "loop_events_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "loop_events"
  ADD CONSTRAINT "loop_events_loop_id_loops_id_fk"
  FOREIGN KEY ("loop_id") REFERENCES "loops"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "nudges"
  ADD CONSTRAINT "nudges_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "nudges"
  ADD CONSTRAINT "nudges_loop_id_loops_id_fk"
  FOREIGN KEY ("loop_id") REFERENCES "loops"("id")
  ON DELETE set null ON UPDATE no action;

ALTER TABLE "nudges"
  ADD CONSTRAINT "nudges_inbound_email_id_inbound_emails_id_fk"
  FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id")
  ON DELETE set null ON UPDATE no action;

CREATE INDEX "source_evidence_user_idx" ON "source_evidence" ("user_id");
CREATE INDEX "source_evidence_inbound_email_idx" ON "source_evidence" ("inbound_email_id");

CREATE INDEX "loops_user_status_idx" ON "loops" ("user_id", "status");
CREATE INDEX "loops_inbound_email_idx" ON "loops" ("inbound_email_id");
CREATE INDEX "loops_source_evidence_idx" ON "loops" ("source_evidence_id");

CREATE INDEX "loop_events_loop_idx" ON "loop_events" ("loop_id");
CREATE INDEX "loop_events_user_idx" ON "loop_events" ("user_id");

CREATE INDEX "nudges_user_status_idx" ON "nudges" ("user_id", "status");
CREATE INDEX "nudges_loop_idx" ON "nudges" ("loop_id");
CREATE INDEX "nudges_inbound_email_idx" ON "nudges" ("inbound_email_id");
