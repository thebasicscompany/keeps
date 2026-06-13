import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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
  "auth.clerk_user_created",
  "auth.clerk_email_verified",
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
  "email.activation_sent",
  "email.activation_suppressed",
  "email.thread_followed",
  // Phase 3 additions
  "nudge.sent",
  "digest.sent",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "approval.executed",
  "approval.execution_failed",
  // Phase 4 additions
  "connector.account_connected",
  "connector.account_revoked",
  "connector.account_auth_error",
  "connector.action_requested",
  "connector.action_executed",
  "connector.action_failed",
  "connector.recipient_ambiguous",
  "policy.authorize_denied",
  // Phase 5 additions
  "report.requested",
  "report.generated",
  "report.viewed",
  "report.action_applied",
  // Phase 6 additions
  "email.outbound.suppressed",
  "email.outbound.reactivated",
  "email.deleted_by_user",
  "data.export_requested",
  "data.export_completed",
  "data.delete_requested",
  "data.delete_completed",
  "user.deleted",
  "failed_processing.replayed",
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
  // Phase 3 additions
  "nudged",
  "digest_summarized",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export const nudgeStatusEnum = pgEnum("nudge_status", ["pending", "sent", "skipped", "failed"]);

// Phase 4: Connector enums
export const connectorProviderEnum = pgEnum("connector_provider", ["slack", "google_calendar"]);

export const connectorAccountStatusEnum = pgEnum("connector_account_status", [
  "active",
  "revoked",
  "auth_error",
  "disabled",
]);

export const connectorActionKindEnum = pgEnum("connector_action_kind", [
  "slack_dm",
  "calendar_event",
]);

export const connectorActionStatusEnum = pgEnum("connector_action_status", [
  "pending",
  "executing",
  "completed",
  "failed",
  "cancelled",
]);

// Phase 5: Generated report enum
export const generatedReportKindEnum = pgEnum("generated_report_kind", [
  "insights",
  "waiting_on",
  "stale",
  "weekly",
  "entity",
]);

// Phase 6: Outbound deliverability suppression state
export const outboundEmailStateEnum = pgEnum("outbound_email_state", [
  "active",
  "bounced",
  "complained",
  "suppressed",
]);

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
    // Phase 3: digest preferences
    timezone: text("timezone").notNull().default("UTC"),
    digestEnabled: boolean("digest_enabled").notNull().default(true),
    digestSendHour: integer("digest_send_hour").notNull().default(8),
    // Phase 6: deliverability + trust controls.
    // rawEmailRetentionDays is nullable on purpose: null = "until I delete" (never scrubbed).
    outboundEmailState: outboundEmailStateEnum("outbound_email_state").notNull().default("active"),
    rawEmailRetentionDays: integer("raw_email_retention_days").default(30),
    isAdmin: boolean("is_admin").notNull().default(false),
  },
  (table) => ({
    emailIdx: uniqueIndex("users_email_unique").on(table.email),
    statusIdx: index("users_status_idx").on(table.status),
    // Partial index: only digest-enabled users, used by the hourly sweep
    digestSendHourIdx: index("users_digest_send_hour_idx")
      .on(table.digestSendHour)
      .where(sql`digest_enabled`),
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
    // Phase 6: set when the retention cron scrubs the raw bodies (deliverable 10).
    scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
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
    scrubbedIdx: index("inbound_emails_scrubbed_idx").on(table.scrubbedAt, table.createdAt),
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
    // Phase 6: set when the retention cron scrubs the message bodies (deliverable 10).
    scrubbedAt: timestamp("scrubbed_at", { withTimezone: true }),
  },
  (table) => ({
    inboundEmailIdx: uniqueIndex("email_messages_inbound_email_unique").on(table.inboundEmailId),
    providerMessageIdx: uniqueIndex("email_messages_provider_message_unique").on(table.providerMessageId),
    threadIdx: index("email_messages_thread_idx").on(table.emailThreadId),
    userIdx: index("email_messages_user_idx").on(table.userId),
    scrubbedIdx: index("email_messages_scrubbed_idx").on(table.scrubbedAt, table.createdAt),
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
    activationSentAt: timestamp("activation_sent_at", { withTimezone: true }),
  },
  (table) => ({
    providerMessageIdx: uniqueIndex("pending_inbound_emails_provider_message_unique").on(
      table.provider,
      table.providerMessageId,
    ),
    senderStatusIdx: index("pending_inbound_emails_sender_status_idx").on(table.senderEmail, table.status),
    expiresAtIdx: index("pending_inbound_emails_expires_at_idx").on(table.expiresAt),
    senderActivationIdx: index("pending_inbound_sender_activation_idx").on(table.senderEmail, table.activationSentAt),
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
    // Phase 3: nudge bookkeeping
    lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
    nudgeCount: integer("nudge_count").notNull().default(0),
  },
  (table) => ({
    userStatusIdx: index("loops_user_status_idx").on(table.userId, table.status),
    inboundEmailIdx: index("loops_inbound_email_idx").on(table.inboundEmailId),
    sourceEvidenceIdx: index("loops_source_evidence_idx").on(table.sourceEvidenceId),
    // Partial index for the nudge sweep eligibility query
    nextCheckAtIdx: index("loops_next_check_at_idx")
      .on(table.status, table.nextCheckAt)
      .where(sql`status IN ('open', 'waiting_on_me', 'waiting_on_other', 'candidate')`),
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
      .references(() => users.id, { onDelete: "cascade" }),
    nudgeId: uuid("nudge_id")
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

export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actionKind: text("action_kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    sourceLoopId: uuid("source_loop_id").references(() => loops.id, { onDelete: "set null" }),
    requiresLogin: boolean("requires_login").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index("drafts_user_idx").on(table.userId),
    sourceLoopIdx: index("drafts_source_loop_idx").on(table.sourceLoopId),
  }),
);

// Phase 4: Connector tables
export const connectorAccounts = pgTable(
  "connector_accounts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: connectorProviderEnum("provider").notNull(),
    composioConnectedAccountId: text("composio_connected_account_id").notNull(),
    composioEntityId: text("composio_entity_id").notNull(),
    externalAccountEmail: text("external_account_email"),
    externalAccountLabel: text("external_account_label"),
    scopes: jsonb("scopes").notNull().default([]),
    status: connectorAccountStatusEnum("status").notNull().default("active"),
    statusReason: text("status_reason"),
    metadata: jsonb("metadata").notNull().default({}),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userProviderIdx: uniqueIndex("connector_accounts_user_provider_unique").on(
      table.userId,
      table.provider,
    ),
    composioConnectedAccountIdx: uniqueIndex("connector_accounts_composio_connected_account_unique").on(
      table.composioConnectedAccountId,
    ),
    userIdx: index("connector_accounts_user_idx").on(table.userId),
    providerStatusIdx: index("connector_accounts_provider_status_idx").on(table.provider, table.status),
  }),
);

export const connectorActions = pgTable(
  "connector_actions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectorAccountId: uuid("connector_account_id")
      .notNull()
      .references(() => connectorAccounts.id, { onDelete: "restrict" }),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, {
      onDelete: "set null",
    }),
    loopId: uuid("loop_id").references(() => loops.id, { onDelete: "set null" }),
    draftId: uuid("draft_id").references(() => drafts.id, { onDelete: "set null" }),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "set null",
    }),
    kind: connectorActionKindEnum("kind").notNull(),
    payload: jsonb("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: connectorActionStatusEnum("status").notNull().default("pending"),
    result: jsonb("result"),
    error: jsonb("error"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    idempotencyKeyIdx: uniqueIndex("connector_actions_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    userStatusIdx: index("connector_actions_user_status_idx").on(table.userId, table.status),
    connectorAccountIdx: index("connector_actions_connector_account_idx").on(
      table.connectorAccountId,
    ),
    approvalRequestIdx: index("connector_actions_approval_request_idx").on(table.approvalRequestId),
  }),
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    draftId: uuid("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    actionKind: text("action_kind").notNull(),
    status: approvalStatusEnum("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionChannel: text("decision_channel"),
    decisionMetadata: jsonb("decision_metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userStatusIdx: index("approval_requests_user_status_idx").on(table.userId, table.status),
    tokenHashIdx: uniqueIndex("approval_requests_token_hash_unique").on(table.tokenHash),
  }),
);

// Phase 5: Generated reports table
export const generatedReports = pgTable(
  "generated_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: generatedReportKindEnum("kind").notNull(),
    scope: jsonb("scope").notNull().default({}),
    summary: text("summary").notNull().default(""),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    viewCount: integer("view_count").notNull().default(0),
    requestedVia: text("requested_via").notNull(),
    requestInboundEmailId: uuid("request_inbound_email_id").references(
      () => inboundEmails.id,
      { onDelete: "set null" },
    ),
    requestNudgeId: uuid("request_nudge_id").references(() => nudges.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("generated_reports_token_hash_unique").on(table.tokenHash),
    userCreatedIdx: index("generated_reports_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    expiresIdx: index("generated_reports_expires_idx").on(table.expiresAt),
  }),
);

// ============================================================================
// Phase 6: Reliability, Evaluation & Trust Hardening tables
// ============================================================================

// One row per `pnpm eval` invocation (deliverable 1/3).
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    mode: text("mode").notNull(), // 'deterministic' | 'model'
    gitSha: text("git_sha"),
    modelId: text("model_id"),
    caseCount: integer("case_count").notNull().default(0),
    precision: real("precision"),
    recall: real("recall"),
    lowConfidenceHandlingRate: real("low_confidence_handling_rate"),
    falsePositiveRate: real("false_positive_rate"),
    summary: jsonb("summary").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    createdIdx: index("eval_runs_created_idx").on(table.createdAt),
    modeCreatedIdx: index("eval_runs_mode_created_idx").on(table.mode, table.createdAt),
  }),
);

// Pilot-submitted candidate eval cases awaiting human labeling (the labeled cases live
// in src/agent/eval/cases/ as code; this is just the review backlog).
export const evalCases = pgTable(
  "eval_cases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    normalizedPayload: jsonb("normalized_payload").notNull().default({}),
    status: text("status").notNull().default("pending_label"), // pending_label | labeled | rejected
    notes: text("notes"),
  },
  (table) => ({
    statusIdx: index("eval_cases_status_idx").on(table.status, table.submittedAt),
  }),
);

// One row per instrumented generateObject call (deliverable 5). `purpose` is text so a new
// model caller never needs a migration; promptPreview is null unless KEEPS_MODEL_LOG_PROMPT_PREVIEW=1.
export const modelCalls = pgTable(
  "model_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    inboundEmailId: uuid("inbound_email_id").references(() => inboundEmails.id, {
      onDelete: "set null",
    }),
    purpose: text("purpose").notNull(),
    modelId: text("model_id").notNull(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    structuredOutput: jsonb("structured_output"),
    promptPreview: text("prompt_preview"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCreatedIdx: index("model_calls_user_created_idx").on(table.userId, table.createdAt),
    purposeCreatedIdx: index("model_calls_purpose_created_idx").on(table.purpose, table.createdAt),
    inboundIdx: index("model_calls_inbound_idx").on(table.inboundEmailId),
  }),
);

// Aggregate metric series (deliverables 3/6/15). Aggregate-only; never user-deleted.
export const qualityMetricsDaily = pgTable(
  "quality_metrics_daily",
  {
    date: date("date").notNull(), // SQL `date`; read/written as an ISO 'YYYY-MM-DD' string
    metric: text("metric").notNull(),
    value: real("value").notNull(),
    denominator: real("denominator"),
    metadata: jsonb("metadata").notNull().default({}),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.date, table.metric] }),
  }),
);

// Lifecycle record for account-wide deletion (deliverable 7). user_id has no FK so the row
// outlives the user; email is captured before delete for the audit window.
export const dataDeletionRequests = pgTable(
  "data_deletion_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id"),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"), // pending | in_progress | completed | failed
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failureMessage: text("failure_message"),
  },
  (table) => ({
    statusIdx: index("data_deletion_requests_status_idx").on(table.status, table.requestedAt),
  }),
);

// Dead-letter queue for inbound/workflow processing failures (deliverable 14). inbound_email_id
// is a plain nullable uuid with NO FK: a failure may pre-date persistence, so a FK would reject the row.
export const failedProcessing = pgTable(
  "failed_processing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inboundEmailId: uuid("inbound_email_id"),
    eventName: text("event_name").notNull(),
    eventPayload: jsonb("event_payload").notNull().default({}),
    errorMessage: text("error_message"),
    errorStack: text("error_stack"),
    failedAt: timestamp("failed_at", { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp("replayed_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => ({
    openIdx: index("failed_processing_open_idx").on(table.resolvedAt, table.failedAt),
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
// Phase 3 additions
export type Draft = typeof drafts.$inferSelect;
export type NewDraft = typeof drafts.$inferInsert;
export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;
export type ApprovalStatus = typeof approvalStatusEnum.enumValues[number];
// Phase 4 additions
export type ConnectorAccount = typeof connectorAccounts.$inferSelect;
export type NewConnectorAccount = typeof connectorAccounts.$inferInsert;
export type ConnectorAction = typeof connectorActions.$inferSelect;
export type NewConnectorAction = typeof connectorActions.$inferInsert;
// Phase 5 additions
export type GeneratedReport = typeof generatedReports.$inferSelect;
export type NewGeneratedReport = typeof generatedReports.$inferInsert;
// Phase 6 additions
export type OutboundEmailState = typeof outboundEmailStateEnum.enumValues[number];
export type EvalRun = typeof evalRuns.$inferSelect;
export type NewEvalRun = typeof evalRuns.$inferInsert;
// EvalCaseRow (not EvalCase) to avoid colliding with the eval-suite fixture type in
// src/agent/eval/types.ts; this is the DB backlog row, that is the code fixture shape.
export type EvalCaseRow = typeof evalCases.$inferSelect;
export type NewEvalCaseRow = typeof evalCases.$inferInsert;
export type ModelCall = typeof modelCalls.$inferSelect;
export type NewModelCall = typeof modelCalls.$inferInsert;
export type QualityMetricDaily = typeof qualityMetricsDaily.$inferSelect;
export type NewQualityMetricDaily = typeof qualityMetricsDaily.$inferInsert;
export type DataDeletionRequest = typeof dataDeletionRequests.$inferSelect;
export type NewDataDeletionRequest = typeof dataDeletionRequests.$inferInsert;
export type FailedProcessing = typeof failedProcessing.$inferSelect;
export type NewFailedProcessing = typeof failedProcessing.$inferInsert;
