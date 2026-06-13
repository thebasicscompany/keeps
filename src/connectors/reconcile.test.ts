/**
 * Unit tests for reconcileConnectorAccounts — pure, no network, no DB.
 *
 * All Composio and DB I/O is replaced with in-memory fakes via the injectable
 * seams (client, fetchDetail, accountsRepo). These tests verify the filtering,
 * upsert, idempotency, error-skipping, and provider-restriction logic.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectedAccountListResponse, ConnectedAccountRetrieveResponse } from "@composio/core";
import type { ConnectorAccount } from "@/db/schema";
import {
  FakeConnectorAccountsRepository,
  makeAccountRow,
} from "@/connectors/accounts-repository.test";
import { reconcileConnectorAccounts, type ReconcileComposioClient } from "@/connectors/reconcile";

// ---------------------------------------------------------------------------
// Fake builders
// ---------------------------------------------------------------------------

/** Builds a minimal ConnectedAccountListResponse with the given items. */
function fakeListResponse(
  items: Array<{
    id: string;
    status: string;
    toolkit: { slug: string };
    statusReason?: string | null;
  }>,
): ConnectedAccountListResponse {
  return {
    items: items as unknown as ConnectedAccountListResponse["items"],
    totalPages: 1,
    nextCursor: null,
  };
}

/** Builds a minimal ConnectedAccountRetrieveResponse for a given account. */
function fakeDetail(overrides: {
  id: string;
  status?: string;
  toolkit?: { slug: string };
  email?: string | null;
  label?: string | null;
  scopes?: string[];
}): ConnectedAccountRetrieveResponse {
  return {
    id: overrides.id,
    status: (overrides.status ?? "ACTIVE") as ConnectedAccountRetrieveResponse["status"],
    statusReason: null,
    toolkit: overrides.toolkit ?? { slug: "slack" },
    isDisabled: false,
    createdAt: "2026-06-13T12:00:00.000Z",
    updatedAt: "2026-06-13T12:00:00.000Z",
    state: overrides.email
      ? ({ email: overrides.email, label: overrides.label ?? null } as Record<string, unknown>)
      : undefined,
    authConfig: {} as ConnectedAccountRetrieveResponse["authConfig"],
    experimental: undefined,
  } as unknown as ConnectedAccountRetrieveResponse;
}

/** Builds a fake Composio client that returns a fixed list. */
function fakeClient(
  items: Array<{
    id: string;
    status: string;
    toolkit: { slug: string };
    statusReason?: string | null;
  }>,
): ReconcileComposioClient {
  return {
    listConnectedAccounts: async () => fakeListResponse(items),
  };
}

// ---------------------------------------------------------------------------
// Tests: basic reconcile — lists + upserts ACTIVE accounts
// ---------------------------------------------------------------------------

describe("reconcileConnectorAccounts", () => {
  it("upserts ACTIVE slack + gcal accounts and returns both rows", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: repo,
      client: fakeClient([
        { id: "ca_slack1", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
        {
          id: "ca_gcal1",
          status: "ACTIVE",
          toolkit: { slug: "googlecalendar" },
          statusReason: null,
        },
      ]),
      fetchDetail: async (id) =>
        fakeDetail({
          id,
          toolkit: { slug: id === "ca_slack1" ? "slack" : "googlecalendar" },
          email: id === "ca_slack1" ? "user@slack.com" : "user@gmail.com",
        }),
    });

    expect(result).toHaveLength(2);

    const slackRow = result.find((r) => r.provider === "slack");
    const gcalRow = result.find((r) => r.provider === "google_calendar");
    expect(slackRow).toBeDefined();
    expect(slackRow?.status).toBe("active");
    expect(slackRow?.composioConnectedAccountId).toBe("ca_slack1");
    expect(slackRow?.externalAccountEmail).toBe("user@slack.com");

    expect(gcalRow).toBeDefined();
    expect(gcalRow?.status).toBe("active");
    expect(gcalRow?.composioConnectedAccountId).toBe("ca_gcal1");
    expect(gcalRow?.externalAccountEmail).toBe("user@gmail.com");

    // Exactly two rows in DB.
    expect(repo.rows.size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Non-ACTIVE accounts are skipped
  // ---------------------------------------------------------------------------

  it("skips non-ACTIVE accounts (EXPIRED, REVOKED, INITIATED, etc.)", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: repo,
      client: fakeClient([
        { id: "ca_active", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
        { id: "ca_expired", status: "EXPIRED", toolkit: { slug: "slack" }, statusReason: null },
        { id: "ca_revoked", status: "REVOKED", toolkit: { slug: "slack" }, statusReason: null },
        { id: "ca_init", status: "INITIATED", toolkit: { slug: "slack" }, statusReason: null },
      ]),
      fetchDetail: async (id) => fakeDetail({ id, toolkit: { slug: "slack" } }),
    });

    // Only the ACTIVE one is upserted.
    expect(result).toHaveLength(1);
    expect(result[0].composioConnectedAccountId).toBe("ca_active");
    expect(repo.rows.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Provider filter restricts to one toolkit
  // ---------------------------------------------------------------------------

  it("restricts to the specified provider when `provider` is given", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      provider: "slack",
      accountsRepo: repo,
      client: fakeClient([
        { id: "ca_slack1", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
        {
          id: "ca_gcal1",
          status: "ACTIVE",
          toolkit: { slug: "googlecalendar" },
          statusReason: null,
        },
      ]),
      fetchDetail: async (id) => fakeDetail({ id, toolkit: { slug: "slack" } }),
    });

    // Only slack is upserted.
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("slack");
    expect(repo.rows.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Idempotency — running twice produces no duplicates
  // ---------------------------------------------------------------------------

  it("is idempotent: running twice keeps exactly one row per provider", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const items = fakeClient([
      { id: "ca_slack1", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
    ]);
    const fetchDetail = async (id: string) => fakeDetail({ id, toolkit: { slug: "slack" } });

    await reconcileConnectorAccounts({ userId, accountsRepo: repo, client: items, fetchDetail });
    await reconcileConnectorAccounts({ userId, accountsRepo: repo, client: items, fetchDetail });

    // Still exactly one row — the fake upserts on composio id.
    expect(repo.rows.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Per-account error is skipped — not fatal
  // ---------------------------------------------------------------------------

  it("skips a failing account's detail fetch and continues with the rest", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: repo,
      client: fakeClient([
        { id: "ca_bad", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
        {
          id: "ca_good",
          status: "ACTIVE",
          toolkit: { slug: "googlecalendar" },
          statusReason: null,
        },
      ]),
      fetchDetail: async (id) => {
        if (id === "ca_bad") throw new Error("Composio 500");
        return fakeDetail({ id, toolkit: { slug: "googlecalendar" } });
      },
    });

    // ca_bad skipped; ca_good succeeds.
    expect(result).toHaveLength(1);
    expect(result[0].composioConnectedAccountId).toBe("ca_good");
  });

  // ---------------------------------------------------------------------------
  // listConnectedAccounts error returns empty array — not fatal
  // ---------------------------------------------------------------------------

  it("returns [] when listConnectedAccounts throws (Composio outage)", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: repo,
      client: {
        listConnectedAccounts: async () => {
          throw new Error("network error");
        },
      },
      fetchDetail: async (id) => fakeDetail({ id }),
    });

    expect(result).toEqual([]);
    expect(repo.rows.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Unknown toolkit slugs are skipped
  // ---------------------------------------------------------------------------

  it("ignores toolkit slugs that Keeps does not recognise", async () => {
    const userId = randomUUID();
    const repo = new FakeConnectorAccountsRepository();

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: repo,
      client: fakeClient([
        { id: "ca_gh", status: "ACTIVE", toolkit: { slug: "github" }, statusReason: null },
        { id: "ca_slack", status: "ACTIVE", toolkit: { slug: "slack" }, statusReason: null },
      ]),
      fetchDetail: async (id) =>
        fakeDetail({ id, toolkit: { slug: id === "ca_gh" ? "github" : "slack" } }),
    });

    // github is not a Keeps provider — only slack is reconciled.
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("slack");
  });

  // ---------------------------------------------------------------------------
  // DB upsert error on one account is skipped
  // ---------------------------------------------------------------------------

  it("skips an account when the DB upsert throws and continues", async () => {
    const userId = randomUUID();
    let callCount = 0;

    const badRepo: FakeConnectorAccountsRepository = new FakeConnectorAccountsRepository();
    const origUpsert = badRepo.upsertByComposioAccount.bind(badRepo);
    badRepo.upsertByComposioAccount = async (input) => {
      callCount++;
      if (input.composioConnectedAccountId === "ca_bad_upsert") {
        throw new Error("DB constraint violation");
      }
      return origUpsert(input);
    };

    const result = await reconcileConnectorAccounts({
      userId,
      accountsRepo: badRepo,
      client: fakeClient([
        {
          id: "ca_bad_upsert",
          status: "ACTIVE",
          toolkit: { slug: "slack" },
          statusReason: null,
        },
        {
          id: "ca_gcal_ok",
          status: "ACTIVE",
          toolkit: { slug: "googlecalendar" },
          statusReason: null,
        },
      ]),
      fetchDetail: async (id) =>
        fakeDetail({
          id,
          toolkit: { slug: id === "ca_bad_upsert" ? "slack" : "googlecalendar" },
        }),
    });

    // The slack upsert failed; gcal succeeds.
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("google_calendar");
  });
});
