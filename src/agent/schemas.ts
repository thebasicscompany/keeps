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

export const loopCandidateSchema = z.object({
  summary: z.string().min(1),
  kind: loopKindSchema,
  status: loopStatusSchema.default("candidate"),
  basis: z.enum(["explicit_commitment", "inferred_next_step"]).default("inferred_next_step"),
  ownerText: z.string().nullable(),
  requesterText: z.string().nullable(),
  dueDateText: z.string().nullable(),
  dueAt: z.string().datetime().nullable(),
  nextCheckAt: z.string().datetime().nullable(),
  dueDateUncertainty: z.enum(["known", "relative", "ambiguous", "missing"]).default("missing"),
  confidence: z.number().min(0).max(1),
  explicitness: z.enum(["explicit", "inferred"]),
  participants: z.array(participantSchema).default([]),
  source: sourceEvidenceSchema,
  ambiguityFlags: z.array(z.string()).default([]),
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
