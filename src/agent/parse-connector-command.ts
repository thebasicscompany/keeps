/**
 * parse-connector-command.ts
 *
 * Parses an email body that has been classified as a connector command
 * (@Slack / @Calendar) into a typed ConnectorCommandDraft.
 *
 * Two paths:
 *   - useModel: false — deterministic regex; fully offline, used by tests.
 *   - useModel: true  — generateObject via Vercel AI SDK (AR-8); resolves
 *                       relative times to ISO and handles ambiguous phrasing.
 *
 * Both paths validate output through connectorCommandDraftSchema.parse before
 * returning, so callers can always trust the shape.
 */

import { connectorCommandDraftSchema, type ConnectorCommandDraft } from "@/agent/schemas";
import { getKeepsLanguageModel } from "@/agent/model";
import {
  instrumentedGenerateObject,
  type ModelCallPurpose,
} from "@/agent/instrumented-generate-object";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type ParseConnectorCommandInput = {
  emailBody: string;
  now: Date;
  timezone?: string;
};

export type ParseConnectorCommandOptions = {
  useModel: boolean;
};

/**
 * Parse a connector command email body into a ConnectorCommandDraft.
 *
 * @param input.emailBody  The full text of the email body.
 * @param input.now        The reference timestamp (injected; never call new Date() here).
 * @param input.timezone   IANA timezone string for the user (e.g. "America/New_York").
 * @param options.useModel When false, uses deterministic regex only (safe for CI).
 *                         When true, falls back to the deterministic path if no model
 *                         is configured (OPENAI_API_KEY absent).
 */
export async function parseConnectorCommand(
  input: ParseConnectorCommandInput,
  options: ParseConnectorCommandOptions,
): Promise<ConnectorCommandDraft> {
  if (options.useModel) {
    const modelResult = await parseWithModel(input);
    if (modelResult) {
      return connectorCommandDraftSchema.parse(modelResult);
    }
  }

  return parseConnectorCommandDeterministically(input);
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------

async function parseWithModel(
  input: ParseConnectorCommandInput,
): Promise<ConnectorCommandDraft | null> {
  const model = getKeepsLanguageModel();

  if (!model) {
    return null;
  }

  const nowIso = input.now.toISOString();
  const tz = input.timezone ?? "UTC";

  // Pick the purpose by the command provider on the first non-empty line: a
  // @Calendar command is a calendar draft, everything else (incl. @Slack and
  // unparseable) is a Slack draft. The model schema itself is unchanged.
  const firstLine = getFirstNonEmptyLine(input.emailBody) ?? "";
  const purpose: ModelCallPurpose = /^\s*@calendar\b/i.test(firstLine)
    ? "draft_calendar"
    : "draft_slack";

  const result = await instrumentedGenerateObject({
    purpose,
    model,
    schema: connectorCommandDraftSchema,
    schemaName: "ConnectorCommandDraft",
    system: [
      "You are the Keeps agent connector-command parser.",
      "Parse the user's @Slack or @Calendar command into a structured ConnectorCommandDraft.",
      "",
      "Rules:",
      "- provider: 'slack' for @Slack commands, 'google_calendar' for @Calendar commands.",
      "- kind: 'slack_dm' for @Slack, 'calendar_event' for @Calendar.",
      "- destination: for Slack 'tell/ping/dm/message <Name>' use kind='person', nameText=<Name>.",
      "  For 'me'/'myself' use kind='self'. For @Calendar 'remind me' use kind='self'.",
      "- message: the body of the Slack DM; null for Calendar.",
      "- eventTitle: the calendar event title derived from the command; null for Slack.",
      "- whenText: the raw time expression from the command, or null if absent.",
      `- whenAt: resolve relative time expressions (like 'Friday', 'tomorrow 3pm') against`,
      `  the reference time ${nowIso} in timezone ${tz} to an ISO 8601 string.`,
      "  If the time cannot be resolved, set whenAt to null.",
      "- durationMinutes: null unless the command specifies a duration.",
      "- reminderMinutesBefore: null unless the command specifies a reminder offset.",
      "- linkedLoopId: always null (resolved downstream).",
      "- ambiguity: list open questions (e.g. 'missing_message', 'missing_when', 'recipient_unclear').",
      "  Empty array when the command is unambiguous.",
      "",
      "NEVER invent recipient names or email addresses not present in the command.",
      "NEVER call new Date() — use the reference time provided above.",
    ].join("\n"),
    prompt: input.emailBody,
  });

  return connectorCommandDraftSchema.parse(result.object);
}

// ---------------------------------------------------------------------------
// Deterministic path
// ---------------------------------------------------------------------------

/**
 * Regex-based parser. Handles:
 *
 * SLACK (@slack / @Slack, case-insensitive):
 *   @Slack tell <Name> <message>
 *   @Slack ping <Name> <message>
 *   @Slack dm <Name> <message>
 *   @Slack message <Name> <message>
 *   @Slack <Name>: <message>           (bare name: colon form)
 *   (Name may be multi-word; email addresses in angle-brackets or inline)
 *
 * CALENDAR (@calendar / @Calendar, case-insensitive):
 *   @Calendar remind me [before] <event>
 *   @Calendar <command text>
 */
export function parseConnectorCommandDeterministically(
  input: ParseConnectorCommandInput,
): ConnectorCommandDraft {
  const { emailBody } = input;

  // Find the first non-empty line — this is where the @command lives.
  const firstLine = getFirstNonEmptyLine(emailBody);

  if (!firstLine) {
    return connectorCommandDraftSchema.parse(buildUnknownDraft());
  }

  // Match @slack or @calendar prefix (case-insensitive).
  const prefixMatch = firstLine.match(/^\s*@(slack|calendar)\b(.*)/i);

  if (!prefixMatch) {
    return connectorCommandDraftSchema.parse(buildUnknownDraft());
  }

  const provider = prefixMatch[1]!.toLowerCase() as "slack" | "calendar";
  // The remainder of the first line after @slack/@calendar.
  const firstLineRemainder = (prefixMatch[2] ?? "").trim();

  // Collect continuation lines (the rest of the email body after the first line)
  // and fold them into the message/title for multi-line commands.
  const continuationText = getContinuationText(emailBody);

  if (provider === "slack") {
    return parseSlackCommand(firstLineRemainder, continuationText);
  } else {
    return parseCalendarCommand(firstLineRemainder, continuationText);
  }
}

// ---------------------------------------------------------------------------
// Slack command parser
// ---------------------------------------------------------------------------

/**
 * Verb + name patterns:
 *   tell <Name> <message>
 *   ping <Name> <message>
 *   dm <Name> <message>
 *   message <Name> <message>
 */
const SLACK_VERB_RE =
  /^(?:tell|ping|dm|message)\s+(.+)/i;

/**
 * Bare name-colon form:
 *   <Name>: <message>
 */
const SLACK_BARE_COLON_RE =
  /^([^:]+?):\s*(.+)/;

/**
 * "me" / "myself" as recipient (self-DM).
 */
const SELF_WORDS_RE = /^(?:me|myself)$/i;

/**
 * Inline or angle-bracket email extraction from a name token.
 * Handles: "Maya <maya@x.com>", "maya@x.com"
 */
const EMAIL_ANGLE_RE = /^(.*?)\s*<([^>]+@[^>]+)>$/;
const EMAIL_INLINE_RE = /^([^@\s]+@[^\s]+)$/;

function parseSlackCommand(remainder: string, continuation: string): ConnectorCommandDraft {
  const ambiguity: string[] = [];

  // Combine continuation lines into the remainder for message extraction.
  const fullText = continuation ? `${remainder} ${continuation}`.trim() : remainder;

  // 1. Try verb form: tell/ping/dm/message <Name> <message>
  const verbMatch = remainder.match(SLACK_VERB_RE);
  if (verbMatch) {
    const afterVerb = verbMatch[1]!.trim();
    const { nameText, emailText, messageStart } = extractNameAndMessage(afterVerb);

    // Combine what's left in the first line with continuation
    const messageRest = continuation
      ? `${messageStart} ${continuation}`.trim()
      : messageStart;

    const message = messageRest || null;

    if (!message) {
      ambiguity.push("missing_message");
    }

    if (!nameText && !emailText) {
      ambiguity.push("recipient_unclear");
    }

    const destination = buildDestination(nameText, emailText);

    return connectorCommandDraftSchema.parse({
      provider: "slack",
      kind: "slack_dm",
      destination,
      message,
      eventTitle: null,
      whenText: null,
      whenAt: null,
      durationMinutes: null,
      reminderMinutesBefore: null,
      linkedLoopId: null,
      ambiguity,
    });
  }

  // 2. Try bare name-colon form: <Name>: <message>
  const colonMatch = fullText.match(SLACK_BARE_COLON_RE);
  if (colonMatch) {
    const rawName = colonMatch[1]!.trim();
    const messageText = colonMatch[2]!.trim() || null;
    const { nameText, emailText } = parseNameToken(rawName);

    if (!messageText) {
      ambiguity.push("missing_message");
    }
    if (!nameText && !emailText) {
      ambiguity.push("recipient_unclear");
    }

    const destination = buildDestination(nameText, emailText);

    return connectorCommandDraftSchema.parse({
      provider: "slack",
      kind: "slack_dm",
      destination,
      message: messageText,
      eventTitle: null,
      whenText: null,
      whenAt: null,
      durationMinutes: null,
      reminderMinutesBefore: null,
      linkedLoopId: null,
      ambiguity,
    });
  }

  // 3. Could not parse — return with ambiguity.
  if (!fullText) {
    ambiguity.push("missing_message", "recipient_unclear");
  } else {
    ambiguity.push("recipient_unclear");
  }

  return connectorCommandDraftSchema.parse({
    provider: "slack",
    kind: "slack_dm",
    destination: { kind: "self", nameText: null, emailText: null },
    message: fullText || null,
    eventTitle: null,
    whenText: null,
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity,
  });
}

/**
 * Extract name token and message start from the text that follows the verb.
 *
 * Strategy: walk word-by-word. The name ends when:
 *   - an email-like token is seen (treated as email, next tokens are message)
 *   - an angle-bracket email finishes ("Name <email>"), next tokens are message
 *   - we reach the second word and the remaining text looks like a message
 *     (the canonical single-word name like "Maya" is most common)
 *
 * Returns { nameText, emailText, messageStart }.
 */
function extractNameAndMessage(text: string): {
  nameText: string | null;
  emailText: string | null;
  messageStart: string;
} {
  // Handle angle-bracket email spanning the whole first token: "Maya <maya@x.com> ..."
  const angleAtStart = text.match(/^(.*?)\s*<([^>]+@[^>]+)>\s*(.*)/);
  if (angleAtStart) {
    const rawName = angleAtStart[1]!.trim() || null;
    const email = angleAtStart[2]!.trim();
    const rest = angleAtStart[3]!.trim();
    return { nameText: rawName, emailText: email, messageStart: rest };
  }

  // Tokenize
  const tokens = text.split(/\s+/);
  const nameParts: string[] = [];
  let emailText: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    // Inline email token (no angle brackets)
    if (EMAIL_INLINE_RE.test(token)) {
      emailText = token;
      const rest = tokens.slice(i + 1).join(" ");
      return {
        nameText: nameParts.length > 0 ? nameParts.join(" ") : null,
        emailText,
        messageStart: rest,
      };
    }

    // If this looks like message content (starts with I'll/I will/the/a or is
    // more than one word in already + starts lowercase), stop the name scan.
    if (nameParts.length >= 1) {
      const looksLikeMessage =
        /^(?:i(?:'ll| will| can| am)\b|the\b|a\b|an\b|about\b|that\b|to\b)/i.test(token) ||
        (token[0] === token[0]?.toLowerCase() && /^[a-z]/.test(token) && nameParts.length >= 1);

      if (looksLikeMessage) {
        const rest = tokens.slice(i).join(" ");
        return {
          nameText: nameParts.join(" ") || null,
          emailText,
          messageStart: rest,
        };
      }
    }

    nameParts.push(token);
  }

  // All tokens consumed — no message found.
  return {
    nameText: nameParts.join(" ") || null,
    emailText,
    messageStart: "",
  };
}

/**
 * Parse a raw name token (may contain an inline email or angle-bracket email).
 */
function parseNameToken(raw: string): { nameText: string | null; emailText: string | null } {
  const angle = raw.match(EMAIL_ANGLE_RE);
  if (angle) {
    return { nameText: angle[1]!.trim() || null, emailText: angle[2]!.trim() };
  }

  if (EMAIL_INLINE_RE.test(raw)) {
    return { nameText: null, emailText: raw };
  }

  return { nameText: raw || null, emailText: null };
}

function buildDestination(
  nameText: string | null,
  emailText: string | null,
): ConnectorCommandDraft["destination"] {
  if (nameText && SELF_WORDS_RE.test(nameText) && !emailText) {
    return { kind: "self", nameText: null, emailText: null };
  }
  return { kind: "person", nameText, emailText };
}

// ---------------------------------------------------------------------------
// Calendar command parser
// ---------------------------------------------------------------------------

/**
 * Strips scaffolding phrases from the calendar command text to derive a title.
 * "remind me before the renewal call" -> "the renewal call"
 * "remind me to review the contract" -> "review the contract"
 * "schedule the renewal call" -> "the renewal call"
 */
const CALENDAR_SCAFFOLD_RE =
  /^(?:remind\s+me\s+(?:before\s+|about\s+|to\s+|for\s+)?|schedule\s+(?:a\s+|an\s+|the\s+)?|add\s+(?:a\s+|an\s+|the\s+)?|set\s+(?:a\s+|an\s+|the\s+)?(?:reminder\s+for\s+)?)/i;

/**
 * Cheap time-expression detector.
 * Matches trailing time phrases like "Friday", "tomorrow", "tomorrow 3pm",
 * "at 4", "at 4pm", "on Monday", "next week", etc.
 *
 * Returns { title, whenText } — whenText is null if no time expression found.
 */
const WHEN_TRAILER_RE =
  /\s+(?:(?:on\s+|next\s+|this\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow(?:\s+at\s+\d+(?::\d+)?(?:\s*(?:am|pm))?)?|today(?:\s+at\s+\d+(?::\d+)?(?:\s*(?:am|pm))?)?|at\s+\d+(?::\d+)?(?:\s*(?:am|pm))?)$/i;

function parseCalendarCommand(remainder: string, continuation: string): ConnectorCommandDraft {
  const ambiguity: string[] = [];

  // Combine continuation into the full command text.
  const fullText = continuation ? `${remainder} ${continuation}`.trim() : remainder;

  if (!fullText) {
    ambiguity.push("missing_when");
    return connectorCommandDraftSchema.parse({
      provider: "google_calendar",
      kind: "calendar_event",
      destination: { kind: "self", nameText: null, emailText: null },
      message: null,
      eventTitle: null,
      whenText: null,
      whenAt: null,
      durationMinutes: null,
      reminderMinutesBefore: null,
      linkedLoopId: null,
      ambiguity,
    });
  }

  // Strip scaffold phrases to isolate the event description.
  const withoutScaffold = fullText.replace(CALENDAR_SCAFFOLD_RE, "").trim();

  // Extract trailing time expression.
  const whenMatch = withoutScaffold.match(WHEN_TRAILER_RE);
  const whenText = whenMatch ? whenMatch[0].trim() : null;
  const titleRaw = whenMatch
    ? withoutScaffold.slice(0, whenMatch.index).trim()
    : withoutScaffold;

  // Derive a clean event title (sentence-case, strip trailing "before/about").
  const eventTitle = deriveEventTitle(titleRaw) || deriveEventTitle(withoutScaffold) || null;

  if (!eventTitle) {
    ambiguity.push("missing_when");
  }

  return connectorCommandDraftSchema.parse({
    provider: "google_calendar",
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    message: null,
    eventTitle,
    whenText,
    // Deterministic path never resolves to an absolute timestamp — leave to model.
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity,
  });
}

/**
 * Produce a clean event title from raw text.
 * Capitalizes the first letter; trims trailing filler like "before" or "about".
 */
function deriveEventTitle(raw: string): string | null {
  const cleaned = raw
    .replace(/\s+before\s*$/i, "")
    .replace(/\s+about\s*$/i, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function getFirstNonEmptyLine(body: string): string | null {
  for (const line of body.split("\n")) {
    if (line.trim()) {
      return line.trim();
    }
  }
  return null;
}

/**
 * Return all lines after the first non-empty one, joined with a space.
 * This lets multi-line commands fold continuation text into the message.
 */
function getContinuationText(body: string): string {
  const lines = body.split("\n");
  let foundFirst = false;
  const rest: string[] = [];

  for (const line of lines) {
    if (!foundFirst) {
      if (line.trim()) {
        foundFirst = true;
      }
      continue;
    }
    const trimmed = line.trim();
    if (trimmed) {
      rest.push(trimmed);
    }
  }

  return rest.join(" ").trim();
}

function buildUnknownDraft(): ConnectorCommandDraft {
  return {
    provider: "slack",
    kind: "slack_dm",
    destination: { kind: "self", nameText: null, emailText: null },
    message: null,
    eventTitle: null,
    whenText: null,
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity: ["missing_message", "recipient_unclear"],
  };
}
