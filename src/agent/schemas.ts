import { z } from "zod";

export const loopStatusSchema = z.enum([
  "candidate",
  "open",
  "waiting_on_me",
  "waiting_on_other",
  "blocked",
  "snoozed",
  "done",
  "dismissed",
]);

export const loopKindSchema = z.enum([
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

export const sourceEvidenceSchema = z.object({
  quote: z.string().min(1),
  startOffset: z.number().int().nonnegative().nullable(),
  endOffset: z.number().int().nonnegative().nullable(),
});

export const participantSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
});

// Every field is required (no `.default()`/`.optional()`): OpenAI strict Structured
// Outputs rejects a schema whose `required` array omits any key in `properties`
// (error: "'required' ... must include every key in properties. Missing 'status'").
// Optionality is expressed with `.nullable()`. Both the model (strict mode forces it
// to emit every field) and the deterministic extractor supply all fields, so dropping
// the input-side defaults is behavior-safe — the inferred output types are unchanged.
export const loopCandidateSchema = z.object({
  summary: z.string().min(1),
  kind: loopKindSchema,
  status: loopStatusSchema,
  basis: z.enum(["explicit_commitment", "inferred_next_step"]),
  ownerText: z.string().nullable(),
  requesterText: z.string().nullable(),
  dueDateText: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  nextCheckAt: z.string().datetime().nullable(),
  dueDateUncertainty: z.enum(["known", "relative", "ambiguous", "missing"]),
  confidence: z.number().min(0).max(1),
  explicitness: z.enum(["explicit", "inferred"]),
  participants: z.array(participantSchema),
  source: sourceEvidenceSchema,
  ambiguityFlags: z.array(z.string()),
});

export const extractionIntentSchema = z.enum(["capture", "command", "approval", "question", "correction", "unknown"]);

export const loopExtractionResultSchema = z.object({
  intent: extractionIntentSchema,
  emailSummary: z.string().min(1),
  loops: z.array(loopCandidateSchema),
  clarifyingQuestion: z.string().nullable(),
  suggestedPrivateReply: z.string().min(1),
});

export type LoopStatus = z.infer<typeof loopStatusSchema>;
export type LoopKind = z.infer<typeof loopKindSchema>;
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type Participant = z.infer<typeof participantSchema>;
export type LoopCandidate = z.infer<typeof loopCandidateSchema>;
export type LoopExtractionResult = z.infer<typeof loopExtractionResultSchema>;

// ---------------------------------------------------------------------------
// Connector command schemas (Phase 4)
// ---------------------------------------------------------------------------
//
// STRICT-MODE INVARIANT (OpenAI structured outputs, commit 77717a3):
//   - No .optional() — every field must appear in JSON Schema `required`.
//   - No .default() — strict mode rejects schemas that carry defaults.
//   - Optionality is expressed exclusively via .nullable().
//
// DESTINATION SHAPE DECISION — flat object (not discriminatedUnion):
//   z.discriminatedUnion emits a JSON Schema `oneOf` which OpenAI strict mode
//   does not support (it requires every field to be present and uses `required`
//   at the top level — oneOf/anyOf/allOf composition is rejected).
//   We therefore represent the destination as a flat object:
//     { kind: 'person' | 'self', nameText: string | null, emailText: string | null }
//   When kind === 'self' the model emits null for nameText/emailText.
//   This is safe and unambiguous; parsers that need the discriminated shape
//   can narrow on `kind` after parsing.
// ---------------------------------------------------------------------------

export const connectorProviderSchema = z.enum(["slack", "google_calendar"]);

export const connectorActionKindSchema = z.enum(["slack_dm", "calendar_event"]);

/**
 * Flat destination object — see DESTINATION SHAPE DECISION above.
 * kind 'self' means send to the authenticated user's own Slack account.
 * kind 'person' means send to the named/emailed person.
 * nameText and emailText are null when kind is 'self'.
 */
export const connectorDestinationSchema = z.object({
  kind: z.enum(["person", "self"]),
  nameText: z.string().nullable(),
  emailText: z.string().nullable(),
});

/**
 * connectorCommandDraftSchema — output of the connector-command parser.
 *
 * All fields required (no .optional()/.default()); optional semantics via .nullable().
 * ambiguity is an empty array when there are no open questions — NOT nullable,
 * because an empty array is the unambiguous "all clear" signal downstream.
 */
export const connectorCommandDraftSchema = z.object({
  provider: connectorProviderSchema,
  kind: connectorActionKindSchema,
  destination: connectorDestinationSchema,
  message: z.string().nullable(),
  eventTitle: z.string().nullable(),
  whenText: z.string().nullable(),
  /** ISO 8601 timestamp resolved from whenText, or null if not yet resolved */
  whenAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  reminderMinutesBefore: z.number().nullable(),
  linkedLoopId: z.string().nullable(),
  /** Open questions the agent must resolve before execution. Empty array = no ambiguity. */
  ambiguity: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// connectorActionPayloadSchema — execute-time typed payload per kind.
//
// This is stored in connector_actions.payload (jsonb) and passed to the tool
// modules. Fields deliberately dropped vs the draft:
//   - whenText: resolved to whenAt before execution; raw text not needed at
//     execute time.
//   - linkedLoopId: stored as a top-level FK on connector_actions, not
//     duplicated inside the payload.
//   - ambiguity: resolved before execution reaches this schema.
//   - provider: implicit in the kind discriminant (slack_dm → slack,
//     calendar_event → google_calendar).
//
// Fields added vs the draft:
//   - slack_dm: none.
//   - calendar_event: description (string | null) — allows the workflow to
//     embed a back-link to the source loop before handing off to the calendar
//     tool.
// ---------------------------------------------------------------------------

export const slackDmPayloadSchema = z.object({
  kind: z.literal("slack_dm"),
  destination: connectorDestinationSchema,
  message: z.string().nullable(),
});

export const calendarEventPayloadSchema = z.object({
  kind: z.literal("calendar_event"),
  destination: connectorDestinationSchema,
  eventTitle: z.string().nullable(),
  /** ISO 8601 timestamp; required to be non-null at execution time */
  whenAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  reminderMinutesBefore: z.number().nullable(),
  /** Optional back-link to the source loop embedded in the Calendar event description */
  description: z.string().nullable(),
});

export const connectorActionPayloadSchema = z.discriminatedUnion("kind", [
  slackDmPayloadSchema,
  calendarEventPayloadSchema,
]);

// ---------------------------------------------------------------------------
// Exported TypeScript types
// ---------------------------------------------------------------------------

export type ConnectorProvider = z.infer<typeof connectorProviderSchema>;
export type ConnectorActionKind = z.infer<typeof connectorActionKindSchema>;
export type ConnectorDestination = z.infer<typeof connectorDestinationSchema>;
export type ConnectorCommandDraft = z.infer<typeof connectorCommandDraftSchema>;
export type SlackDmPayload = z.infer<typeof slackDmPayloadSchema>;
export type CalendarEventPayload = z.infer<typeof calendarEventPayloadSchema>;
export type ConnectorActionPayload = z.infer<typeof connectorActionPayloadSchema>;
