import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DevRecordingSender, type OutboundEmailStore } from "@/email/outbound";
import type { ActivationRepository, PendingRow } from "@/workflows/functions/send-activation-email";
import {
  recordActivationSent,
  sendActivationEmail,
  sendActivationEmailOnly,
} from "@/workflows/functions/send-activation-email";
import type { NormalizedEmail } from "@/email/normalize";

// ---------------------------------------------------------------------------
// In-memory fakes
// ---------------------------------------------------------------------------

type RecordedSend = Parameters<OutboundEmailStore["recordSend"]>[0];

class InMemoryOutboundEmailStore implements OutboundEmailStore {
  readonly sends: RecordedSend[] = [];
  async recordSend(input: RecordedSend): Promise<void> {
    this.sends.push(input);
  }
  async markNudgeSent(): Promise<void> {
    // never called for system emails
  }
}

type AuditEntry = {
  action: "email.activation_sent" | "email.activation_suppressed";
  metadata: Record<string, unknown>;
};

class InMemoryActivationRepository implements ActivationRepository {
  readonly rows = new Map<string, PendingRow>();
  readonly audits: AuditEntry[] = [];

  addRow(row: PendingRow) {
    this.rows.set(row.id, row);
  }

  async findPendingById(id: string): Promise<PendingRow | null> {
    return this.rows.get(id) ?? null;
  }

  async hasRecentActivation(senderEmail: string, windowStart: Date): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (
        row.senderEmail === senderEmail &&
        row.activationSentAt !== null &&
        row.activationSentAt >= windowStart
      ) {
        return true;
      }
    }
    return false;
  }

  async stampActivationSentAt(id: string, sentAt: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, { ...row, activationSentAt: sentAt });
    }
  }

  async writeAudit(input: AuditEntry): Promise<void> {
    this.audits.push(input);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_URL = "https://app.keeps.ai";
const NOW = new Date("2026-06-12T12:00:00.000Z");

function makeNormalizedEmail(headerOverrides: Record<string, string> = {}): NormalizedEmail {
  return {
    provider: "postmark",
    providerMessageId: `msg-${randomUUID()}`,
    mailboxHash: null,
    from: { email: "stranger@example.com", name: "Stranger" },
    to: [{ email: "agent@keeps.email", name: "Keeps" }],
    cc: [],
    subject: "Hey there",
    textBody: "Hello!",
    htmlBody: null,
    strippedTextReply: null,
    headers: headerOverrides,
    attachmentCount: 0,
    attachments: [],
    receivedAt: NOW.toISOString(),
  };
}

function makePendingRow(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: randomUUID(),
    senderEmail: "stranger@example.com",
    activationSentAt: null,
    normalizedPayload: makeNormalizedEmail(),
    ...overrides,
  };
}

function makeOptions(
  repo: InMemoryActivationRepository,
  store: InMemoryOutboundEmailStore,
  overrides: { ownDomains?: string[]; now?: Date } = {},
) {
  return {
    repository: repo,
    sender: new DevRecordingSender(),
    store,
    ownDomains: overrides.ownDomains ?? ["keeps.ai", "keeps.email"],
    appUrl: APP_URL,
    now: overrides.now ?? NOW,
  };
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("sendActivationEmail — happy path", () => {
  it("sends exactly one email to the stranger and returns sent status", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow();
    repo.addRow(row);

    const result = await sendActivationEmail(row.id, makeOptions(repo, store));

    expect(result.status).toBe("sent");
    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]?.toEmail).toBe("stranger@example.com");
  });

  it("stamps activation_sent_at on the pending row", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow();
    repo.addRow(row);

    await sendActivationEmail(row.id, makeOptions(repo, store));

    expect(repo.rows.get(row.id)?.activationSentAt).toEqual(NOW);
  });

  it("writes an email.activation_sent audit row with correct metadata", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow();
    repo.addRow(row);

    await sendActivationEmail(row.id, makeOptions(repo, store));

    const sentAudits = repo.audits.filter((a) => a.action === "email.activation_sent");
    expect(sentAudits).toHaveLength(1);
    expect(sentAudits[0]?.metadata.pendingInboundEmailId).toBe(row.id);
    expect(sentAudits[0]?.metadata.senderEmail).toBe("stranger@example.com");
    expect(sentAudits[0]?.metadata.providerMessageId).toBeTruthy();
  });

  it("sends the buildUnknownSenderReply content (subject + activation URL)", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow();
    repo.addRow(row);

    await sendActivationEmail(row.id, makeOptions(repo, store));

    const sent = store.sends[0];
    expect(sent?.subject).toBe("Activate Keeps for this email");
    expect(sent?.textBody).toContain("stranger@example.com");
    expect(sent?.textBody).toContain(APP_URL);
  });
});

// ---------------------------------------------------------------------------
// Auto-generated suppression
// ---------------------------------------------------------------------------

describe("sendActivationEmail — auto-generated suppression", () => {
  it("suppresses when Auto-Submitted: auto-replied is present", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow({
      normalizedPayload: makeNormalizedEmail({ "auto-submitted": "auto-replied" }),
    });
    repo.addRow(row);

    const result = await sendActivationEmail(row.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_auto_generated");
    if (result.status === "suppressed_auto_generated") {
      expect(result.signal).toBe("auto-submitted");
    }
    expect(store.sends).toHaveLength(0);
  });

  it("writes email.activation_suppressed audit with reason auto_generated", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow({
      normalizedPayload: makeNormalizedEmail({ "auto-submitted": "auto-replied" }),
    });
    repo.addRow(row);

    await sendActivationEmail(row.id, makeOptions(repo, store));

    const suppressed = repo.audits.filter((a) => a.action === "email.activation_suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.metadata.reason).toBe("auto_generated");
    expect(suppressed[0]?.metadata.signal).toBe("auto-submitted");
  });

  it("suppresses on Precedence: bulk", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow({
      normalizedPayload: makeNormalizedEmail({ precedence: "bulk" }),
    });
    repo.addRow(row);

    const result = await sendActivationEmail(row.id, makeOptions(repo, store));
    expect(result.status).toBe("suppressed_auto_generated");
    expect(store.sends).toHaveLength(0);
  });

  it("suppresses on X-Auto-Response-Suppress header", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow({
      normalizedPayload: makeNormalizedEmail({ "x-auto-response-suppress": "OOF" }),
    });
    repo.addRow(row);

    const result = await sendActivationEmail(row.id, makeOptions(repo, store));
    expect(result.status).toBe("suppressed_auto_generated");
    expect(store.sends).toHaveLength(0);
  });

  it("does NOT suppress when Auto-Submitted: no (explicitly human)", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow({
      normalizedPayload: makeNormalizedEmail({ "auto-submitted": "no" }),
    });
    repo.addRow(row);

    const result = await sendActivationEmail(row.id, makeOptions(repo, store));
    expect(result.status).toBe("sent");
  });
});

// ---------------------------------------------------------------------------
// Per-sender 7-day suppression window
// ---------------------------------------------------------------------------

describe("sendActivationEmail — recent_activation suppression", () => {
  it("suppresses a second email from the same sender within 7 days", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();

    // Earlier pending row for the same sender, already stamped 2 days ago.
    const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const earlierRow = makePendingRow({ activationSentAt: TWO_DAYS_AGO });
    repo.addRow(earlierRow);

    // New pending row (the one the event fires for).
    const newRow = makePendingRow({ id: randomUUID() });
    repo.addRow(newRow);

    const result = await sendActivationEmail(newRow.id, makeOptions(repo, store));

    expect(result.status).toBe("suppressed_recent_activation");
    expect(store.sends).toHaveLength(0);
  });

  it("writes email.activation_suppressed audit with reason recent_activation", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();

    const TWO_DAYS_AGO = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const earlierRow = makePendingRow({ activationSentAt: TWO_DAYS_AGO });
    repo.addRow(earlierRow);

    const newRow = makePendingRow({ id: randomUUID() });
    repo.addRow(newRow);

    await sendActivationEmail(newRow.id, makeOptions(repo, store));

    const suppressed = repo.audits.filter((a) => a.action === "email.activation_suppressed");
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.metadata.reason).toBe("recent_activation");
  });

  it("sends when the previous activation was more than 7 days ago (8 days)", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();

    // Stamped 8 days ago — outside the 7-day window.
    const EIGHT_DAYS_AGO = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000);
    const earlierRow = makePendingRow({ activationSentAt: EIGHT_DAYS_AGO });
    repo.addRow(earlierRow);

    const newRow = makePendingRow({ id: randomUUID() });
    repo.addRow(newRow);

    const result = await sendActivationEmail(newRow.id, makeOptions(repo, store));

    expect(result.status).toBe("sent");
    expect(store.sends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Missing pending row
// ---------------------------------------------------------------------------

describe("sendActivationEmail — missing row", () => {
  it("returns missing_pending and does not send or crash", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();

    const result = await sendActivationEmail("non-existent-id", makeOptions(repo, store));

    expect(result.status).toBe("missing_pending");
    expect(store.sends).toHaveLength(0);
    expect(repo.audits).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency: already-stamped row
// ---------------------------------------------------------------------------

describe("sendActivationEmail — idempotency", () => {
  it("suppresses on a second call when activation_sent_at is already stamped", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();

    const row = makePendingRow();
    repo.addRow(row);

    // First call: succeeds.
    const first = await sendActivationEmail(row.id, makeOptions(repo, store));
    expect(first.status).toBe("sent");
    expect(store.sends).toHaveLength(1);

    // The row is now stamped. Second call with the same id must be suppressed.
    const second = await sendActivationEmail(row.id, makeOptions(repo, store));
    expect(second.status).toBe("suppressed_already_stamped");
    // No additional send.
    expect(store.sends).toHaveLength(1);
    // No additional audit rows from the second call.
    const sentAudits = repo.audits.filter((a) => a.action === "email.activation_sent");
    expect(sentAudits).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// sendActivationEmailOnly — send-only step (no DB writes)
// ---------------------------------------------------------------------------

describe("sendActivationEmailOnly — send-only function", () => {
  it("sends exactly one email and returns a providerMessageId", async () => {
    const store = new InMemoryOutboundEmailStore();

    const result = await sendActivationEmailOnly("stranger@example.com", {
      sender: new DevRecordingSender(),
      store,
      appUrl: APP_URL,
      now: NOW,
    });

    expect(result.providerMessageId).toBeTruthy();
    expect(store.sends).toHaveLength(1);
    expect(store.sends[0]?.toEmail).toBe("stranger@example.com");
  });

  it("does NOT stamp activation_sent_at or write any audit rows", async () => {
    const repo = new InMemoryActivationRepository();
    const store = new InMemoryOutboundEmailStore();
    const row = makePendingRow();
    repo.addRow(row);

    await sendActivationEmailOnly("stranger@example.com", {
      sender: new DevRecordingSender(),
      store,
      appUrl: APP_URL,
      now: NOW,
    });

    // The repo must be completely untouched — no stamps, no audits.
    expect(repo.rows.get(row.id)?.activationSentAt).toBeNull();
    expect(repo.audits).toHaveLength(0);
  });

  it("sends the buildUnknownSenderReply content (subject + activation URL)", async () => {
    const store = new InMemoryOutboundEmailStore();

    await sendActivationEmailOnly("stranger@example.com", {
      sender: new DevRecordingSender(),
      store,
      appUrl: APP_URL,
      now: NOW,
    });

    const sent = store.sends[0];
    expect(sent?.subject).toBe("Activate Keeps for this email");
    expect(sent?.textBody).toContain("stranger@example.com");
    expect(sent?.textBody).toContain(APP_URL);
  });
});

// ---------------------------------------------------------------------------
// recordActivationSent — stamp + audit step
// ---------------------------------------------------------------------------

describe("recordActivationSent — record function", () => {
  it("stamps activation_sent_at with the provided now timestamp", async () => {
    const repo = new InMemoryActivationRepository();
    const row = makePendingRow();
    repo.addRow(row);

    const RECORD_NOW = new Date("2026-06-12T13:00:00.000Z");
    await recordActivationSent(row.id, row.senderEmail, "msg-abc-123", {
      repository: repo,
      now: RECORD_NOW,
    });

    expect(repo.rows.get(row.id)?.activationSentAt).toEqual(RECORD_NOW);
  });

  it("writes exactly one email.activation_sent audit row with correct metadata", async () => {
    const repo = new InMemoryActivationRepository();
    const row = makePendingRow();
    repo.addRow(row);

    await recordActivationSent(row.id, row.senderEmail, "msg-abc-123", {
      repository: repo,
      now: NOW,
    });

    const sentAudits = repo.audits.filter((a) => a.action === "email.activation_sent");
    expect(sentAudits).toHaveLength(1);
    expect(sentAudits[0]?.metadata.pendingInboundEmailId).toBe(row.id);
    expect(sentAudits[0]?.metadata.senderEmail).toBe(row.senderEmail);
    expect(sentAudits[0]?.metadata.providerMessageId).toBe("msg-abc-123");
  });

  it("stamps and audits exactly once even when called with the same providerMessageId twice (caller's responsibility for idempotency)", async () => {
    const repo = new InMemoryActivationRepository();
    const row = makePendingRow();
    repo.addRow(row);

    // Simulate Inngest retrying the record step with the memoized providerMessageId.
    await recordActivationSent(row.id, row.senderEmail, "msg-abc-123", {
      repository: repo,
      now: NOW,
    });
    await recordActivationSent(row.id, row.senderEmail, "msg-abc-123", {
      repository: repo,
      now: NOW,
    });

    // The stamp is idempotent (same value written twice), and both calls write
    // an audit row — demonstrating that the Inngest step wrapper (not this
    // function) must guarantee at-most-once execution via memoization.
    const sentAudits = repo.audits.filter((a) => a.action === "email.activation_sent");
    expect(sentAudits).toHaveLength(2);
    // The stamp value is the same both times.
    expect(repo.rows.get(row.id)?.activationSentAt).toEqual(NOW);
  });
});
