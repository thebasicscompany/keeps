export type ApprovalReplyCommand =
  | {
      type: "approve";
      rawText: string;
    }
  | {
      type: "approve_all";
      rawText: string;
    }
  | {
      type: "reject";
      rawText: string;
      loopOrdinal: number | null;
    }
  | {
      type: "cancel";
      rawText: string;
    }
  | {
      type: "edit";
      rawText: string;
      payloadText: string | null;
    }
  | {
      type: "unknown";
      rawText: string;
    };

// Separate parser from src/loops/commands.ts — the loop command surface is kept focused on
// loop lifecycle commands; approval commands live here and are selected by the intent router
// when the inbound email's MailboxHash resolves to a nudge of nudge_type = 'approval'.
export function parseApprovalReplyCommand(
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: { now?: Date } = {},
): ApprovalReplyCommand {
  const rawText = text.trim();
  const normalized = rawText.toLowerCase();

  // "approve all" — must be checked before plain "approve" to avoid partial match
  if (/^approve\s+all\b/.test(normalized)) {
    return {
      type: "approve_all",
      rawText,
    };
  }

  // "approve" (bare, no ordinal or qualifier)
  if (/^approve\b/.test(normalized)) {
    return {
      type: "approve",
      rawText,
    };
  }

  // "reject <ordinal>" or bare "reject"
  const rejectOrdinalMatch = normalized.match(/^reject\s+(\d+)\b/);
  if (rejectOrdinalMatch?.[1]) {
    return {
      type: "reject",
      rawText,
      loopOrdinal: Number.parseInt(rejectOrdinalMatch[1], 10),
    };
  }

  if (/^reject\b/.test(normalized)) {
    return {
      type: "reject",
      rawText,
      loopOrdinal: null,
    };
  }

  // "cancel"
  if (/^cancel\b/.test(normalized)) {
    return {
      type: "cancel",
      rawText,
    };
  }

  // "edit: <payload>" — colon required; payload is everything after the colon, trimmed
  const editMatch = rawText.match(/^edit\s*:\s*([\s\S]*)$/i);
  if (editMatch !== null) {
    const payloadText = editMatch[1]?.trim() ?? "";
    return {
      type: "edit",
      rawText,
      payloadText: payloadText || null,
    };
  }

  return {
    type: "unknown",
    rawText,
  };
}
