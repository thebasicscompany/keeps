import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const workingStyleEnum = pgEnum("working_style", [
  "brief",
  "warm",
  "direct",
  "chief_of_staff",
]);

export const userStatusEnum = pgEnum("user_status", ["pending", "verified", "disabled"]);

export const auditActionEnum = pgEnum("audit_action", [
  "user.created",
  "user.email_verified",
  "user.working_style_updated",
  "auth.dev_session_created",
  "email.inbound.placeholder_received",
  "email.inbound.pending_created",
  "email.inbound.received",
  "email.inbound.duplicate",
  "email.inbound.claimed",
  "email.classified",
  "loops.extracted",
  "loop.created",
  "loop.updated",
  "policy.external_action_blocked",
]);

export const pendingInboundStatusEnum = pgEnum("pending_inbound_status", ["pending", "claimed"]);

export const emailMessageDirectionEnum = pgEnum("email_message_direction", ["inbound"]);

export const loopStatusEnum = pgEnum("loop_status", [
  "candidate",
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "blocked",
  "snoozed",
  "done",
  "dismissed",
]);

export const loopKindEnum = pgEnum("loop_kind", [
  "commitment",
  "ask",
  "waiting_on",
  "reminder",
  "customer_promise",
  "bug",
  "meeting_action",
  "personal_obligation",
  "other",
]);

export const loopBasisEnum = pgEnum("loop_basis", ["explicit_commitment", "inferred_next_step"]);

export const loopEventTypeEnum = pgEnum("loop_event_type", [
  "created",
  "confirmed",
  "corrected",
  "dismissed",
  "snoozed",
  "marked_done",
  "clarification_requested",
]);

export const nudgeStatusEnum = pgEnum("nudge_status", ["pending", "sent", "skipped"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    companyName: text("company_name"),
    workingStyle: workingStyleEnum("working_style").notNull().default("direct"),
    status: userStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
  },
  (table) => ({
    emailIdx: uniqueIndex("users_email_unique").on(table.email),
    statusIdx: index("users_status_idx").on(table.status),
  }),
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    email: text("email").notNull(),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerAccountIdx: uniqueIndex("user_identities_provider_account_unique").on(
      table.provider,
      table.providerAccountId,
    ),
    userIdx: index("user_identities_user_idx").on(table.userId),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: auditActionEnum("action").notNull(),
    actorType: text("actor_type").notNull().default("system"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("audit_log_user_idx").on(table.userId),
    actionIdx: index("audit_log_action_idx").on(table.action),
    createdAtIdx: index("audit_log_created_at_idx").on(table.createdAt),
  }),
);

export const emailThreads = pgTable(
  "email_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    threadKey: text("thread_key").notNull(),
    subject: text("subject").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userThreadKeyIdx: uniqueIndex("email_threads_user_thread_key_unique").on(table.userId, table.threadKey),
    userIdx: index("email_threads_user_idx").on(table.userId),
  }),
);

export const inboundEmails = pgTable(
  "inbound_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailThreadId: uuid("email_thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    mailboxHash: text("mailbox_hash"),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name"),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body").notNull().default(""),
    htmlBody: text("html_body"),
    strippedTextReply: text("stripped_text_reply"),
    recipients: jsonb("recipients").notNull().default([]),
    ccRecipients: jsonb("cc_recipients").notNull().default([]),
    headers: jsonb("headers").notNull().default({}),
    attachmentMetadata: jsonb("attachment_metadata").notNull().default([]),
    normalizedPayload: jsonb("normalized_payload").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    providerReceivedAt: timestamp("provider_received_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex("inbound_emails_provider_message_unique").on(
      table.provider,
      table.providerMessageId,
    ),
    userIdx: index("inbound_emails_user_idx").on(table.userId),
    threadIdx: index("inbound_emails_thread_idx").on(table.emailThreadId),
    senderIdx: index("inbound_emails_sender_idx").on(table.senderEmail),
    mailboxHashIdx: index("inbound_emails_mailbox_hash_idx").on(table.mailboxHash),
  }),
);

export const emailMessages = pgTable(
  "email_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailThreadId: uuid("email_thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    inboundEmailId: uuid("inbound_email_id")
      .notNull()
      .references(() => inboundEmails.id, { onDelete: "cascade" }),
    direction: emailMessageDirectionEnum("direction").notNull().default("inbound"),
    providerMessageId: text("provider_message_id").notNull(),
    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    toRecipients: jsonb("to_recipients").notNull().default([]),
    ccRecipients: jsonb("cc_recipients").notNull().default([]),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body").notNull().default(""),
    htmlBody: text("html_body"),
    strippedTextReply: text("stripped_text_reply"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    inboundEmailIdx: uniqueIndex("email_messages_inbound_email_unique").on(table.inboundEmailId),
    providerMessageIdx: uniqueIndex("email_messages_provider_message_unique").on(table.providerMessageId),
    threadIdx: index("email_messages_thread_idx").on(table.emailThreadId),
    userIdx: index("email_messages_user_idx").on(table.userId),
  }),
);

export const pendingInboundEmails = pgTable(
  "pending_inbound_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name"),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body").notNull().default(""),
    htmlBody: text("html_body"),
    strippedTextReply: text("stripped_text_reply"),
    recipients: jsonb("recipients").notNull().default([]),
    ccRecipients: jsonb("cc_recipients").notNull().default([]),
    headers: jsonb("headers").notNull().default({}),
    attachmentMetadata: jsonb("attachment_metadata").notNull().default([]),
    normalizedPayload: jsonb("normalized_payload").notNull(),
    rawPayload: jsonb("raw_payload").notNull(),
    status: pendingInboundStatusEnum("status").notNull().default("pending"),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, { onDelete: "set null" }),
    providerReceivedAt: timestamp("provider_received_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex("pending_inbound_emails_provider_message_unique").on(
      table.provider,
      table.providerMessageId,
    ),
    senderStatusIdx: index("pending_inbound_emails_sender_status_idx").on(table.senderEmail, table.status),
    expiresAtIdx: index("pending_inbound_emails_expires_at_idx").on(table.expiresAt),
  }),
);

export const sourceEvidence = pgTable(
  "source_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inboundEmailId: uuid("inbound_email_id")
      .notNull()
      .references(() => inboundEmails.id, { onDelete: "cascade" }),
    emailMessageId: uuid("email_message_id").references(() => emailMessages.id, { onDelete: "set null" }),
    providerMessageId: text("provider_message_id").notNull(),
    sourceType: text("source_type").notNull().default("email"),
    quote: text("quote").notNull(),
    normalizedBody: text("normalized_body").notNull().default(""),
    startOffset: integer("start_offset"),
    endOffset: integer("end_offset"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("source_evidence_user_idx").on(table.userId),
    inboundEmailIdx: index("source_evidence_inbound_email_idx").on(table.inboundEmailId),
  }),
);

export const loops = pgTable(
  "loops",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emailThreadId: uuid("email_thread_id")
      .notNull()
      .references(() => emailThreads.id, { onDelete: "cascade" }),
    inboundEmailId: uuid("inbound_email_id")
      .notNull()
      .references(() => inboundEmails.id, { onDelete: "cascade" }),
    sourceEvidenceId: uuid("source_evidence_id")
      .notNull()
      .references(() => sourceEvidence.id, { onDelete: "cascade" }),
    status: loopStatusEnum("status").notNull().default("candidate"),
    kind: loopKindEnum("kind").notNull().default("other"),
    basis: loopBasisEnum("basis").notNull().default("inferred_next_step"),
    summary: text("summary").notNull(),
    ownerText: text("owner_text"),
    requesterText: text("requester_text"),
    dueDateText: text("due_date_text"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
    confidence: real("confidence").notNull(),
    participants: jsonb("participants").notNull().default([]),
    ambiguityFlags: jsonb("ambiguity_flags").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("loops_user_status_idx").on(table.userId, table.status),
    inboundEmailIdx: index("loops_inbound_email_idx").on(table.inboundEmailId),
    sourceEvidenceIdx: index("loops_source_evidence_idx").on(table.sourceEvidenceId),
  }),
);

export const loopEvents = pgTable(
  "loop_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    loopId: uuid("loop_id")
      .notNull()
      .references(() => loops.id, { onDelete: "cascade" }),
    eventType: loopEventTypeEnum("event_type").notNull(),
    commandText: text("command_text"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    loopIdx: index("loop_events_loop_idx").on(table.loopId),
    userIdx: index("loop_events_user_idx").on(table.userId),
  }),
);

export const nudges = pgTable(
  "nudges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    loopId: uuid("loop_id").references(() => loops.id, { onDelete: "set null" }),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, { onDelete: "set null" }),
    nudgeType: text("nudge_type").notNull().default("private_reply"),
    status: nudgeStatusEnum("status").notNull().default("pending"),
    channel: text("channel").notNull().default("email"),
    subject: text("subject"),
    body: text("body").notNull().default(""),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("nudges_user_status_idx").on(table.userId, table.status),
    loopIdx: index("nudges_loop_idx").on(table.loopId),
    inboundEmailIdx: index("nudges_inbound_email_idx").on(table.inboundEmailId),
  }),
);

export const outboundEmails = pgTable(
  "outbound_emails",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    nudgeId: uuid("nudge_id")
      .notNull()
      .references(() => nudges.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull().default(""),
    textBody: text("text_body").notNull().default(""),
    headers: jsonb("headers").notNull().default({}),
    replyTo: text("reply_to"),
    inReplyTo: text("in_reply_to"),
    referencesHeader: text("references_header"),
    mailboxHash: text("mailbox_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex("outbound_emails_provider_message_unique").on(
      table.provider,
      table.providerMessageId,
    ),
    userIdx: index("outbound_emails_user_idx").on(table.userId),
    nudgeIdx: index("outbound_emails_nudge_idx").on(table.nudgeId),
    inReplyToIdx: index("outbound_emails_in_reply_to_idx").on(table.inReplyTo),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserIdentity = typeof userIdentities.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type EmailThread = typeof emailThreads.$inferSelect;
export type InboundEmail = typeof inboundEmails.$inferSelect;
export type EmailMessage = typeof emailMessages.$inferSelect;
export type PendingInboundEmail = typeof pendingInboundEmails.$inferSelect;
export type SourceEvidence = typeof sourceEvidence.$inferSelect;
export type Loop = typeof loops.$inferSelect;
export type LoopEvent = typeof loopEvents.$inferSelect;
export type Nudge = typeof nudges.$inferSelect;
export type OutboundEmail = typeof outboundEmails.$inferSelect;
export type NewOutboundEmail = typeof outboundEmails.$inferInsert;
