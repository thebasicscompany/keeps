/**
 * src/audit/list-for-user.test.ts
 *
 * Tests for the audit log service.
 *
 * Section A (DB-gated): requires TEST_DATABASE_URL. Seeds two users with audit
 * rows and verifies:
 *   - only the caller's rows are returned
 *   - rows are ordered newest-first
 *   - the limit cap is respected
 *   - the other user's rows never appear
 *
 * Section B (pure unit): tests the presentational helpers (summarizeMetadata,
 * labelForAction, isSensitiveEmailAction) and a renderToStaticMarkup smoke of
 * AuditTable — no DB needed.
 *
 * Run DB tests:
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55433/keeps \
 *     pnpm exec vitest run src/audit
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@/db/schema";
import { listAuditForUser } from "./list-for-user";
import {
  labelForAction,
  summarizeMetadata,
  isSensitiveEmailAction,
} from "./summarize-row";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { AuditTable } from "../../app/settings/audit/page";
import type { AuditLogEntry } from "@/db/schema";

// ---------------------------------------------------------------------------
// Section A — DB-gated integration tests
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)(
  "listAuditForUser (DB integration)",
  () => {
    // biome-ignore lint: non-null assertion is safe inside skipIf guard
    const sql = postgres(TEST_DATABASE_URL!, { prepare: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = drizzle(sql, { schema }) as any;

    let userIdA: string;
    let userIdB: string;

    beforeAll(async () => {
      const suffix = Date.now();

      // Create two isolated test users.
      const [uA] = await db
        .insert(schema.users)
        .values({ email: `audit-test-A-${suffix}@test.invalid`, timezone: "UTC" })
        .returning({ id: schema.users.id });
      const [uB] = await db
        .insert(schema.users)
        .values({ email: `audit-test-B-${suffix}@test.invalid`, timezone: "UTC" })
        .returning({ id: schema.users.id });

      userIdA = uA.id;
      userIdB = uB.id;

      const now = new Date();
      const older = new Date(now.getTime() - 60_000); // 1 min ago
      const newest = new Date(now.getTime() + 60_000); // 1 min from now

      // Seed 3 rows for user A (different timestamps to verify ordering).
      await db.insert(schema.auditLog).values([
        {
          userId: userIdA,
          action: "user.created",
          actorType: "system",
          metadata: { phase: "test", ts: "oldest" },
          createdAt: older,
        },
        {
          userId: userIdA,
          action: "email.inbound.received",
          actorType: "system",
          metadata: {
            subject: "Hello from test",
            senderEmail: "sender@example.com",
            // body fields intentionally omitted — mirrors real production data
          },
          createdAt: now,
        },
        {
          userId: userIdA,
          action: "connector.account_connected",
          actorType: "user",
          metadata: { provider: "slack" },
          createdAt: newest,
        },
      ]);

      // Seed 2 rows for user B — must never appear in user A's results.
      await db.insert(schema.auditLog).values([
        {
          userId: userIdB,
          action: "user.created",
          actorType: "system",
          metadata: { phase: "test", user: "B" },
          createdAt: now,
        },
        {
          userId: userIdB,
          action: "digest.sent",
          actorType: "system",
          metadata: { count: 5 },
          createdAt: newest,
        },
      ]);
    });

    afterAll(async () => {
      if (userIdA) {
        await db
          .delete(schema.auditLog)
          .where(eq(schema.auditLog.userId, userIdA));
      }
      if (userIdB) {
        await db
          .delete(schema.auditLog)
          .where(eq(schema.auditLog.userId, userIdB));
      }
      const ids = [userIdA, userIdB].filter(Boolean);
      if (ids.length > 0) {
        await db.delete(schema.users).where(inArray(schema.users.id, ids));
      }
      await sql.end();
    });

    it("returns only the caller's rows — other user's rows never appear", async () => {
      const rows = await listAuditForUser({ userId: userIdA }, db);
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        expect(row.userId).toBe(userIdA);
      }

      // User B's rows must be absent
      const rowsB = rows.filter((r) => r.userId === userIdB);
      expect(rowsB).toHaveLength(0);
    });

    it("returns rows newest-first", async () => {
      const rows = await listAuditForUser({ userId: userIdA }, db);
      expect(rows.length).toBeGreaterThanOrEqual(2);

      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1]!.createdAt.getTime()).toBeGreaterThanOrEqual(
          rows[i]!.createdAt.getTime(),
        );
      }
    });

    it("respects the limit cap — returns at most `limit` rows", async () => {
      const rows = await listAuditForUser({ userId: userIdA, limit: 2 }, db);
      expect(rows).toHaveLength(2);
      // The first returned row must be the newest (connector.account_connected)
      expect(rows[0]!.action).toBe("connector.account_connected");
    });

    it("default limit=200 returns all rows when fewer than 200 exist", async () => {
      // User A has 3 rows; default limit is 200 → all 3 should come back.
      const rows = await listAuditForUser({ userId: userIdA }, db);
      expect(rows.length).toBe(3);
    });

    it("returns empty array for a user with no audit rows", async () => {
      const [uC] = await db
        .insert(schema.users)
        .values({ email: `audit-test-C-${Date.now()}@test.invalid`, timezone: "UTC" })
        .returning({ id: schema.users.id });

      try {
        const rows = await listAuditForUser({ userId: uC.id }, db);
        expect(rows).toHaveLength(0);
      } finally {
        await db.delete(schema.users).where(eq(schema.users.id, uC.id));
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Section B — Pure unit tests (no DB, no React DOM jsdom)
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "test-id",
    userId: "user-id",
    action: "user.created",
    actorType: "system",
    metadata: {},
    createdAt: new Date("2026-06-13T14:00:00.000Z"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// labelForAction
// ---------------------------------------------------------------------------

describe("labelForAction", () => {
  it("maps known actions to human-readable labels", () => {
    expect(labelForAction("user.created")).toBe("Account created");
    expect(labelForAction("connector.account_connected")).toBe(
      "Connector account connected",
    );
    expect(labelForAction("email.inbound.received")).toBe("Email received");
    expect(labelForAction("data.export_requested")).toBe("Data export requested");
  });

  it("falls back to the raw action string for unknown values", () => {
    expect(labelForAction("unknown.future.action")).toBe("unknown.future.action");
  });
});

// ---------------------------------------------------------------------------
// isSensitiveEmailAction
// ---------------------------------------------------------------------------

describe("isSensitiveEmailAction", () => {
  it("flags inbound email actions as sensitive", () => {
    expect(isSensitiveEmailAction("email.inbound.received")).toBe(true);
    expect(isSensitiveEmailAction("email.inbound.pending_created")).toBe(true);
    expect(isSensitiveEmailAction("email.inbound.duplicate")).toBe(true);
  });

  it("does not flag non-email actions", () => {
    expect(isSensitiveEmailAction("user.created")).toBe(false);
    expect(isSensitiveEmailAction("connector.account_connected")).toBe(false);
    expect(isSensitiveEmailAction("digest.sent")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// summarizeMetadata — sensitive email actions NEVER render body content
// ---------------------------------------------------------------------------

describe("summarizeMetadata — email.inbound.received (sensitive)", () => {
  it("renders subject and sender", () => {
    const row = makeRow({
      action: "email.inbound.received",
      metadata: {
        subject: "Hello world",
        senderEmail: "sender@example.com",
        textBody: "SECRET BODY TEXT",
        htmlBody: "<p>SECRET HTML</p>",
        rawPayload: { everything: "secret" },
      },
    });
    const summary = summarizeMetadata(row);
    expect(summary).toContain("Hello world");
    expect(summary).toContain("sender@example.com");
    expect(summary).not.toContain("SECRET");
    expect(summary).not.toContain("secret");
  });

  it("omits body even when metadata has textBody and htmlBody", () => {
    const row = makeRow({
      action: "email.inbound.received",
      metadata: {
        textBody: "This is the body, do not show",
        htmlBody: "<p>HTML body, do not show</p>",
        subject: "Safe subject",
      },
    });
    const summary = summarizeMetadata(row);
    expect(summary).not.toContain("body");
    expect(summary).not.toContain("do not show");
    expect(summary).toContain("Safe subject");
  });

  it("handles missing subject and sender gracefully (returns empty string)", () => {
    const row = makeRow({
      action: "email.inbound.received",
      metadata: { textBody: "SECRET" },
    });
    const summary = summarizeMetadata(row);
    expect(summary).toBe("");
    expect(summary).not.toContain("SECRET");
  });
});

describe("summarizeMetadata — non-sensitive actions", () => {
  it("renders connector action fields", () => {
    const row = makeRow({
      action: "connector.account_connected",
      metadata: { provider: "slack", externalAccountEmail: "me@slack.com" },
    });
    expect(summarizeMetadata(row)).toContain("slack");
    expect(summarizeMetadata(row)).toContain("me@slack.com");
  });

  it("renders approval action fields", () => {
    const row = makeRow({
      action: "approval.decided",
      metadata: { actionKind: "slack_dm", status: "approved" },
    });
    const summary = summarizeMetadata(row);
    expect(summary).toContain("slack_dm");
    expect(summary).toContain("approved");
  });

  it("returns empty string for null metadata", () => {
    const row = makeRow({ metadata: null as unknown as Record<string, unknown> });
    expect(summarizeMetadata(row)).toBe("");
  });

  it("never renders body-like keys in generic fallback", () => {
    const row = makeRow({
      action: "user.created",
      metadata: {
        email: "safe@example.com",
        body: "SHOULD NOT APPEAR",
        textBody: "ALSO SECRET",
        normalizedPayload: { raw: "HIDDEN" },
      },
    });
    const summary = summarizeMetadata(row);
    expect(summary).not.toContain("SHOULD NOT APPEAR");
    expect(summary).not.toContain("ALSO SECRET");
    expect(summary).not.toContain("HIDDEN");
    expect(summary).toContain("safe@example.com");
  });
});

// ---------------------------------------------------------------------------
// AuditTable — renderToStaticMarkup smoke test (no jsdom needed)
// ---------------------------------------------------------------------------

describe("AuditTable — renderToStaticMarkup smoke", () => {
  it("renders without throwing for an empty row list", () => {
    expect(() =>
      renderToStaticMarkup(React.createElement(AuditTable, { rows: [] })),
    ).not.toThrow();
    const html = renderToStaticMarkup(
      React.createElement(AuditTable, { rows: [] }),
    );
    expect(html).toContain("No audit events yet");
  });

  it("renders a row per audit entry with human labels", () => {
    const rows: AuditLogEntry[] = [
      makeRow({ id: "r1", action: "user.created" }),
      makeRow({ id: "r2", action: "digest.sent" }),
    ];
    const html = renderToStaticMarkup(React.createElement(AuditTable, { rows }));
    expect(html).toContain("Account created");
    expect(html).toContain("Digest sent");
  });

  it("renders the timestamp in ISO-like UTC format", () => {
    const rows: AuditLogEntry[] = [
      makeRow({ id: "r1", createdAt: new Date("2026-06-13T14:32:00.000Z") }),
    ];
    const html = renderToStaticMarkup(React.createElement(AuditTable, { rows }));
    expect(html).toContain("2026-06-13");
  });

  it("does NOT render body content for sensitive email actions", () => {
    const rows: AuditLogEntry[] = [
      makeRow({
        id: "r1",
        action: "email.inbound.received",
        metadata: {
          subject: "Safe subject line",
          senderEmail: "ok@example.com",
          textBody: "THIS MUST NOT APPEAR IN RENDER",
        },
      }),
    ];
    const html = renderToStaticMarkup(React.createElement(AuditTable, { rows }));
    expect(html).toContain("Safe subject line");
    expect(html).toContain("ok@example.com");
    expect(html).not.toContain("THIS MUST NOT APPEAR IN RENDER");
  });
});
