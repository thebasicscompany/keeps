import type { NormalizedEmail, NormalizedEmailAddress } from "@/email/normalize";

export type ExtractionEmailBody = {
  rawBody: string;
  normalizedBody: string;
  participants: NormalizedEmailAddress[];
};

export function prepareEmailForExtraction(email: NormalizedEmail): ExtractionEmailBody {
  const rawBody = normalizeLineEndings(email.textBody || stripHtml(email.htmlBody ?? ""));
  const bodyForExtraction =
    email.strippedTextReply && !containsForwardedContent(rawBody)
      ? normalizeLineEndings(email.strippedTextReply)
      : rawBody;

  return {
    rawBody,
    normalizedBody: stripQuotedAndSignatureNoise(bodyForExtraction),
    participants: detectParticipants(email, rawBody),
  };
}

export function findSourceSpan(body: string, quote: string): { startOffset: number | null; endOffset: number | null } {
  const startOffset = body.indexOf(quote);

  if (startOffset < 0) {
    return {
      startOffset: null,
      endOffset: null,
    };
  }

  return {
    startOffset,
    endOffset: startOffset + quote.length,
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function containsForwardedContent(value: string): boolean {
  return /-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:/i.test(value);
}

function stripQuotedAndSignatureNoise(value: string): string {
  const lines = value.split("\n");
  const kept: string[] = [];
  let skippingForwardHeaders = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^--\s*$/.test(trimmed) || /^Sent from my /i.test(trimmed)) {
      break;
    }

    if (/^On .+wrote:$/i.test(trimmed)) {
      break;
    }

    if (/^>/.test(trimmed)) {
      continue;
    }

    if (/-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:/i.test(trimmed)) {
      skippingForwardHeaders = true;
      continue;
    }

    if (skippingForwardHeaders) {
      if (trimmed === "") {
        skippingForwardHeaders = false;
      }

      if (/^(from|date|subject|to|cc|bcc):/i.test(trimmed) || trimmed === "") {
        continue;
      }
    }

    kept.push(line);
  }

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function detectParticipants(email: NormalizedEmail, rawBody: string): NormalizedEmailAddress[] {
  const participants = new Map<string, NormalizedEmailAddress>();

  for (const participant of [email.from, ...email.to, ...email.cc]) {
    addParticipant(participants, participant);
  }

  for (const match of rawBody.matchAll(/^(?:From|To|Cc):\s*([^<\n]+?)(?:\s*<([^>\n]+)>)?\s*$/gim)) {
    const name = match[1]?.trim().replace(/^"|"$/g, "") || null;
    const emailAddress = match[2]?.trim().toLowerCase() ?? null;

    addParticipant(participants, {
      email: emailAddress ?? name?.toLowerCase() ?? "unknown",
      name: name && name.includes("@") ? null : name,
    });
  }

  return [...participants.values()];
}

function addParticipant(participants: Map<string, NormalizedEmailAddress>, participant: NormalizedEmailAddress) {
  const email = participant.email.toLowerCase();

  if (!participants.has(email)) {
    participants.set(email, {
      email,
      name: participant.name,
    });
  }
}
