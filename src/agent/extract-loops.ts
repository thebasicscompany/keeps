import { generateObject } from "ai";
import {
  loopExtractionResultSchema,
  type LoopCandidate,
  type LoopExtractionResult,
  type Participant,
} from "@/agent/schemas";
import { getKeepsLanguageModel } from "@/agent/model";
import { classifyEmailIntent } from "@/agent/classify-intent";
import { findSourceSpan, prepareEmailForExtraction, type ExtractionEmailBody } from "@/email/extraction-body";
import type { NormalizedEmail } from "@/email/normalize";

export type ExtractLoopsInput = {
  email: NormalizedEmail;
  useModel?: boolean;
};

export async function extractLoops(input: ExtractLoopsInput): Promise<LoopExtractionResult> {
  const extractionBody = prepareEmailForExtraction(input.email);

  if (input.useModel) {
    const modelResult = await extractLoopsWithModel(input.email, extractionBody);

    if (modelResult) {
      return modelResult;
    }
  }

  return extractLoopsDeterministically(input.email, extractionBody);
}

async function extractLoopsWithModel(
  email: NormalizedEmail,
  extractionBody: ExtractionEmailBody,
): Promise<LoopExtractionResult | null> {
  const model = getKeepsLanguageModel();

  if (!model) {
    return null;
  }

  const result = await generateObject({
    model,
    schema: loopExtractionResultSchema,
    schemaName: "KeepsLoopExtraction",
    system:
      "Extract private open loops from a user-provided email. Return only loops supported by source evidence. Distinguish explicit commitments from inferred next steps. Ask a clarifying question when ownership, due date, or intent is ambiguous.",
    prompt: [
      `Subject: ${email.subject}`,
      `From: ${email.from.name ?? email.from.email} <${email.from.email}>`,
      `Participants: ${extractionBody.participants
        .map((participant) => participant.name ?? participant.email)
        .join(", ")}`,
      "",
      extractionBody.normalizedBody,
    ].join("\n"),
  });

  return loopExtractionResultSchema.parse(result.object);
}

function extractLoopsDeterministically(
  email: NormalizedEmail,
  extractionBody: ExtractionEmailBody,
): LoopExtractionResult {
  const body = extractionBody.normalizedBody;
  const participants = toParticipants(extractionBody.participants);
  const baseDate = parseBaseDate(email.receivedAt);
  const loops: LoopCandidate[] = [];
  const seenQuotes = new Set<string>();

  const addLoop = (candidate: BuildLoopCandidateInput) => {
    const quote = candidate.quote.trim();

    if (!quote || seenQuotes.has(`${quote}:${candidate.summary}`)) {
      return;
    }

    seenQuotes.add(`${quote}:${candidate.summary}`);
    loops.push(buildLoopCandidate({ ...candidate, body, baseDate, participants }));
  };

  for (const match of body.matchAll(/\bI(?:'ll| will)\s+([^.\n]+?)\s+by\s+([^.\n]+?)(?=[.\n])/gi)) {
    const action = cleanAction(match[1] ?? "");
    const dueDateText = match[2]?.trim() ?? null;

    addLoop({
      quote: match[0],
      summary: `You will ${action} by ${dueDateText}.`,
      kind: "commitment",
      basis: "explicit_commitment",
      ownerText: email.from.name || email.from.email,
      requesterText: firstRecipientText(email),
      dueDateText,
      confidence: 0.84,
      explicitness: "explicit",
      ambiguityFlags: [],
    });
  }

  for (const match of body.matchAll(/\bI(?:'ll| will)\s+([^.\n]+?)(?=[.\n])/gi)) {
    if (/\sby\s/i.test(match[0])) {
      continue;
    }

    const action = cleanAction(match[1] ?? "");
    addLoop({
      quote: match[0],
      summary: `You will ${action}.`,
      kind: "commitment",
      basis: "explicit_commitment",
      ownerText: email.from.name || email.from.email,
      requesterText: firstRecipientText(email),
      dueDateText: null,
      confidence: 0.72,
      explicitness: "explicit",
      ambiguityFlags: ["missing_due_date"],
    });
  }

  for (const match of body.matchAll(/\bI can approve\s+([^.\n]+?)\s+after\s+([^.\n]+?)(?=[.\n])/gi)) {
    const decision = cleanAction(match[1] ?? "");
    const condition = cleanAction(match[2] ?? "");

    addLoop({
      quote: match[0],
      summary: `You can approve ${decision} after ${condition}.`,
      kind: "commitment",
      basis: "inferred_next_step",
      ownerText: email.from.name || email.from.email,
      requesterText: firstRecipientText(email),
      dueDateText: null,
      confidence: 0.74,
      explicitness: "inferred",
      ambiguityFlags: ["conditional"],
    });
  }

  for (const match of body.matchAll(/\bWe need to\s+([^.\n]+?)(?=[.\n])/gi)) {
    const actionText = cleanAction(match[1] ?? "");
    const parts = splitCompoundAction(actionText);

    for (const part of parts) {
      const dueDateText = extractDueDateText(part);
      const actionWithoutDue = dueDateText ? part.replace(new RegExp(`\\s+by\\s+${escapeRegExp(dueDateText)}$`, "i"), "") : part;

      addLoop({
        quote: match[0],
        summary: sentenceCase(actionWithoutDue),
        kind: "meeting_action",
        basis: "inferred_next_step",
        ownerText: "We",
        requesterText: forwardedSenderText(extractionBody.rawBody) ?? email.from.name ?? email.from.email,
        dueDateText,
        confidence: dueDateText ? 0.8 : 0.7,
        explicitness: "inferred",
        ambiguityFlags: dueDateText ? ["owner_unclear"] : ["owner_unclear", "missing_due_date"],
      });
    }
  }

  for (const match of body.matchAll(/\b([A-Z][A-Za-z0-9& ]{1,40})\s+is waiting on\s+([^.\n]+?)(?:\s+before\s+([^.\n]+?))?(?=[.\n])/g)) {
    const requesterText = cleanAction(match[1] ?? "");
    const action = cleanAction(match[2] ?? "");
    const beforeText = match[3]?.trim() ?? null;

    addLoop({
      quote: match[0],
      summary: `${requesterText} is waiting on ${action}${beforeText ? ` before ${beforeText}` : ""}.`,
      kind: "waiting_on",
      basis: "inferred_next_step",
      ownerText: null,
      requesterText,
      dueDateText: beforeText ? `before ${beforeText}` : null,
      confidence: 0.78,
      explicitness: "inferred",
      ambiguityFlags: beforeText ? ["relative_due_date"] : ["missing_due_date"],
    });
  }

  for (const match of body.matchAll(/\bPlease keep track of\s+([^.\n]+?)(?=[.\n])/gi)) {
    const actionText = cleanAction(match[1] ?? "");

    for (const part of splitCompoundAction(actionText)) {
      addLoop({
        quote: match[0],
        summary: `Track ${part}.`,
        kind: "reminder",
        basis: "inferred_next_step",
        ownerText: email.from.name || email.from.email,
        requesterText: null,
        dueDateText: null,
        confidence: 0.62,
        explicitness: "inferred",
        ambiguityFlags: ["missing_due_date"],
      });
    }
  }

  for (const match of body.matchAll(/\b(?:can you|could you|please)\s+([^.?]+)[.?]/gi)) {
    const request = cleanAction(match[1] ?? "");

    if (/keep this from slipping|track this/i.test(request)) {
      continue;
    }

    addLoop({
      quote: match[0],
      summary: `Follow up on request: ${request}.`,
      kind: "ask",
      basis: "explicit_commitment",
      ownerText: firstRecipientText(email),
      requesterText: email.from.name || email.from.email,
      dueDateText: null,
      confidence: 0.66,
      explicitness: "explicit",
      ambiguityFlags: ["owner_unclear", "missing_due_date"],
    });
  }

  if (loops.length === 0 && /keep this from slipping|track this|follow this/i.test(body)) {
    addLoop({
      quote: firstMeaningfulSentence(body),
      summary: "Track the referenced follow-up.",
      kind: "reminder",
      basis: "inferred_next_step",
      ownerText: email.from.name || email.from.email,
      requesterText: null,
      dueDateText: null,
      confidence: 0.42,
      explicitness: "inferred",
      ambiguityFlags: ["referent_unclear", "missing_due_date", "owner_unclear"],
    });
  }

  const lowConfidenceOnly = loops.length > 0 && loops.every((loop) => loop.confidence < highConfidenceThreshold);
  const clarifyingQuestion =
    loops.length === 0
      ? "I did not find a clear loop. What should I keep an eye on?"
      : lowConfidenceOnly
        ? `I may be reading this wrong. Should I track this?\n\n"${loops[0]?.source.quote}"`
        : null;

  const result = {
    intent: classifyEmailIntent({ body }).intent,
    emailSummary: body.slice(0, 220) || "Empty email body.",
    loops,
    clarifyingQuestion,
    suggestedPrivateReply:
      loops.length > 0
        ? `I found ${loops.length} loop${loops.length === 1 ? "" : "s"}.`
        : "I did not find a clear loop.",
  };

  return loopExtractionResultSchema.parse(result);
}

const highConfidenceThreshold = 0.7;

type BuildLoopCandidateInput = {
  quote: string;
  summary: string;
  kind: LoopCandidate["kind"];
  basis: LoopCandidate["basis"];
  ownerText: string | null;
  requesterText: string | null;
  dueDateText: string | null;
  confidence: number;
  explicitness: LoopCandidate["explicitness"];
  ambiguityFlags: string[];
};

function buildLoopCandidate(
  input: BuildLoopCandidateInput & {
    body: string;
    baseDate: Date;
    participants: Participant[];
  },
): LoopCandidate {
  const due = inferDueDate(input.dueDateText, input.baseDate);
  const sourceSpan = findSourceSpan(input.body, input.quote.trim());

  return {
    summary: input.summary,
    kind: input.kind,
    status: "candidate",
    basis: input.basis,
    ownerText: input.ownerText,
    requesterText: input.requesterText,
    dueDateText: input.dueDateText,
    dueAt: due.dueAt,
    nextCheckAt: due.nextCheckAt,
    dueDateUncertainty: due.uncertainty,
    confidence: input.confidence,
    explicitness: input.explicitness,
    participants: input.participants,
    source: {
      quote: input.quote.trim(),
      startOffset: sourceSpan.startOffset,
      endOffset: sourceSpan.endOffset,
    },
    ambiguityFlags: [...new Set([...input.ambiguityFlags, ...due.ambiguityFlags])],
  };
}

function inferDueDate(
  dueDateText: string | null,
  baseDate: Date,
): {
  dueAt: string | null;
  nextCheckAt: string | null;
  uncertainty: LoopCandidate["dueDateUncertainty"];
  ambiguityFlags: string[];
} {
  if (!dueDateText) {
    return {
      dueAt: null,
      nextCheckAt: null,
      uncertainty: "missing",
      ambiguityFlags: [],
    };
  }

  const weekday = weekdayIndex(dueDateText);

  if (weekday !== null) {
    const dueAt = nextWeekday(baseDate, weekday);
    const nextCheckAt = new Date(dueAt);
    nextCheckAt.setUTCDate(nextCheckAt.getUTCDate() - 1);

    return {
      dueAt: dueAt.toISOString(),
      nextCheckAt: nextCheckAt.toISOString(),
      uncertainty: "relative",
      ambiguityFlags: ["relative_due_date"],
    };
  }

  return {
    dueAt: null,
    nextCheckAt: null,
    uncertainty: "ambiguous",
    ambiguityFlags: ["ambiguous_due_date"],
  };
}

function nextWeekday(baseDate: Date, weekday: number): Date {
  const date = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 17));
  const currentWeekday = date.getUTCDay();
  const daysUntil = (weekday - currentWeekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() + daysUntil);
  return date;
}

function weekdayIndex(value: string): number | null {
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const lower = value.toLowerCase();
  const index = weekdays.findIndex((weekday) => lower.includes(weekday));

  return index >= 0 ? index : null;
}

function parseBaseDate(value: string | null): Date {
  if (!value) {
    return new Date("2026-01-01T09:00:00.000Z");
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date("2026-01-01T09:00:00.000Z") : date;
}

function firstRecipientText(email: NormalizedEmail): string | null {
  const firstRecipient = email.to[0];
  return firstRecipient ? (firstRecipient.name ?? firstRecipient.email) : null;
}

function forwardedSenderText(rawBody: string): string | null {
  const match = rawBody.match(/^From:\s*([^<\n]+?)(?:\s*<[^>\n]+>)?\s*$/im);
  return match?.[1]?.trim() ?? null;
}

function toParticipants(participants: ExtractionEmailBody["participants"]): Participant[] {
  return participants.map((participant) => ({
    name: participant.name,
    email: participant.email,
  }));
}

function splitCompoundAction(value: string): string[] {
  return value
    .split(/\s+and\s+(?:the\s+)?/i)
    .map((part) => cleanAction(part))
    .filter(Boolean);
}

function extractDueDateText(value: string): string | null {
  const match = value.match(/\bby\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function cleanAction(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/[.?!]+$/g, "");
}

function sentenceCase(value: string): string {
  const cleaned = cleanAction(value);

  if (!cleaned) {
    return "";
  }

  return `${cleaned[0]?.toUpperCase()}${cleaned.slice(1)}.`;
}

function firstMeaningfulSentence(value: string): string {
  return value.split(/\n{2,}|(?<=[.?])\s+/).find((part) => part.trim().length > 0)?.trim() ?? value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
