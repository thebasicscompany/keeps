ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.inbound.pending_created';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.inbound.received';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.inbound.duplicate';
ALTER TYPE "audit_action" ADD VALUE IF NOT EXISTS 'email.inbound.claimed';

CREATE TYPE "pending_inbound_status" AS ENUM ('pending', 'claimed');
CREATE TYPE "email_message_direction" AS ENUM ('inbound');

CREATE TABLE "email_threads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "thread_key" text NOT NULL,
  "subject" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "inbound_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "email_thread_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "provider_message_id" text NOT NULL,
  "sender_email" text NOT NULL,
  "sender_name" text,
  "subject" text DEFAULT '' NOT NULL,
  "text_body" text DEFAULT '' NOT NULL,
  "html_body" text,
  "stripped_text_reply" text,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attachment_metadata" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "normalized_payload" jsonb NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "provider_received_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "email_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "email_thread_id" uuid NOT NULL,
  "inbound_email_id" uuid NOT NULL,
  "direction" "email_message_direction" DEFAULT 'inbound' NOT NULL,
  "provider_message_id" text NOT NULL,
  "from_email" text NOT NULL,
  "from_name" text,
  "to_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "subject" text DEFAULT '' NOT NULL,
  "text_body" text DEFAULT '' NOT NULL,
  "html_body" text,
  "stripped_text_reply" text,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "pending_inbound_emails" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "provider_message_id" text NOT NULL,
  "sender_email" text NOT NULL,
  "sender_name" text,
  "subject" text DEFAULT '' NOT NULL,
  "text_body" text DEFAULT '' NOT NULL,
  "html_body" text,
  "stripped_text_reply" text,
  "recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "cc_recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attachment_metadata" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "normalized_payload" jsonb NOT NULL,
  "raw_payload" jsonb NOT NULL,
  "status" "pending_inbound_status" DEFAULT 'pending' NOT NULL,
  "inbound_email_id" uuid,
  "provider_received_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "email_threads"
  ADD CONSTRAINT "email_threads_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "inbound_emails"
  ADD CONSTRAINT "inbound_emails_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "inbound_emails"
  ADD CONSTRAINT "inbound_emails_email_thread_id_email_threads_id_fk"
  FOREIGN KEY ("email_thread_id") REFERENCES "email_threads"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_email_thread_id_email_threads_id_fk"
  FOREIGN KEY ("email_thread_id") REFERENCES "email_threads"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_inbound_email_id_inbound_emails_id_fk"
  FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "pending_inbound_emails"
  ADD CONSTRAINT "pending_inbound_emails_inbound_email_id_inbound_emails_id_fk"
  FOREIGN KEY ("inbound_email_id") REFERENCES "inbound_emails"("id")
  ON DELETE set null ON UPDATE no action;

CREATE UNIQUE INDEX "email_threads_user_thread_key_unique" ON "email_threads" ("user_id", "thread_key");
CREATE INDEX "email_threads_user_idx" ON "email_threads" ("user_id");

CREATE UNIQUE INDEX "inbound_emails_provider_message_unique" ON "inbound_emails" ("provider", "provider_message_id");
CREATE INDEX "inbound_emails_user_idx" ON "inbound_emails" ("user_id");
CREATE INDEX "inbound_emails_thread_idx" ON "inbound_emails" ("email_thread_id");
CREATE INDEX "inbound_emails_sender_idx" ON "inbound_emails" ("sender_email");

CREATE UNIQUE INDEX "email_messages_inbound_email_unique" ON "email_messages" ("inbound_email_id");
CREATE UNIQUE INDEX "email_messages_provider_message_unique" ON "email_messages" ("provider_message_id");
CREATE INDEX "email_messages_thread_idx" ON "email_messages" ("email_thread_id");
CREATE INDEX "email_messages_user_idx" ON "email_messages" ("user_id");

CREATE UNIQUE INDEX "pending_inbound_emails_provider_message_unique"
  ON "pending_inbound_emails" ("provider", "provider_message_id");
CREATE INDEX "pending_inbound_emails_sender_status_idx"
  ON "pending_inbound_emails" ("sender_email", "status");
CREATE INDEX "pending_inbound_emails_expires_at_idx" ON "pending_inbound_emails" ("expires_at");
