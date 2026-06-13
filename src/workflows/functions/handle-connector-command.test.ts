/**
 * Unit tests for the handle-connector-command PURE CORES (D1).
 *
 * These exercise the load-bearing decision logic of the workflow without the
 * Inngest wrapper or a live DB — exactly the handle-approval.test.ts pattern
 * (in-memory fakes, no Postgres, no Inngest). The Inngest wrapper is thin glue;
 * the behavior lives in the cores tested here.
 */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ConnectorAccountsRepository,
  ConnectorProvider,
} from "@/connectors/accounts-repository";
import type { ConnectorAccount } from "@/db/schema";
import type { ApprovalRepository } from "@/approvals/repository";
import type { ApprovalRequest, Draft, NewDraft } from "@/db/schema";
import type {
  ConnectorActionsRepository,
  CreateConnectorActionInput,
} from "@/connectors/execute";
import type { ConnectorAction } from "@/db/schema";
import type { ToolExecutor } from "@/connectors/recipient";
import type { ComposioToolResult } from "@/connectors/composio";
import type { EventMap } from "@/workflows/events";
import type { ConnectorCommandDraft } from "@/agent/schemas";
import {
  buildFrozenPayload,
  createApprovalAndAction,
  loadConnectorAccount,
  providerForKind,
  resolveCommandRecipient,
  summarizeCommand,
  executedConfirmationLine,
} from "@/workflows/functions/handle-connector-command";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeAccountsRepo implements ConnectorAccountsRepository {
  account: ConnectorAccount | null = null;
  async findActiveByUserAndProvider(): Promise<ConnectorAccount | null> {
    return this.account;
  }
  // unused in these tests
  async upsertByComposioAccount(): Promise<ConnectorAccount> {
    throw new Error("unused");
  }
  async markStatus(): Promise<ConnectorAccount | null> {
    return null;
  }
  async hydrate(): Promise<ConnectorAccount | null> {
    return null;
  }
  async listActive(): Promise<ConnectorAccount[]> {
    return [];
  }
  async findByComposioAccount(): Promise<ConnectorAccount | null> {
    return null;
  }
  async findById(): Promise<ConnectorAccount | null> {
    return null;
  }
}

class FakeApprovalRepo implements ApprovalRepository {
  readonly drafts = new Map<string, Draft>();
  readonly requests = new Map<string, ApprovalRequest>();
  async insertDraft(input: NewDraft): Promise<Draft> {
    const draft: Draft = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      actionKind: input.actionKind,
      payload: (input.payload ?? {}) as Record<string, unknown>,
      sourceLoopId: input.sourceLoopId ?? null,
      requiresLogin: input.requiresLogin ?? false,
      createdAt: new Date(),
    };
    this.drafts.set(draft.id, draft);
    return draft;
  }
  async insertApprovalRequest(input: {
    id: string;
    userId: string;
    draftId: string;
    actionKind: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<ApprovalRequest> {
    const req: ApprovalRequest = {
      id: input.id,
      userId: input.userId,
      draftId: input.draftId,
      actionKind: input.actionKind,
      status: "pending",
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      decidedAt: null,
      decisionChannel: null,
      decisionMetadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.requests.set(req.id, req);
    return req;
  }
  async findApprovalById() {
    return null;
  }
  async findApprovalByTokenHash() {
    return null;
  }
  async updateApprovalDecision() {
    return null;
  }
  async findPendingExpired() {
    return [];
  }
  async updateApprovalTokenHash() {
    return null;
  }
}

class FakeActionsRepo implements ConnectorActionsRepository {
  readonly actions: ConnectorAction[] = [];
  async createAction(input: CreateConnectorActionInput): Promise<ConnectorAction> {
    const row = {
      id: randomUUID(),
      userId: input.userId,
      connectorAccountId: input.connectorAccountId,
      inboundEmailId: input.inboundEmailId ?? null,
      loopId: input.loopId ?? null,
      draftId: input.draftId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      kind: input.kind,
      payload: input.payload as unknown as Record<string, unknown>,
      idempotencyKey: input.idempotencyKey,
      status: "pending",
      result: null,
      error: null,
      requestedAt: input.now ?? new Date(),
      executedAt: null,
      failedAt: null,
      updatedAt: input.now ?? new Date(),
    } as unknown as ConnectorAction;
    this.actions.push(row);
    return row;
  }
  async findById(): Promise<ConnectorAction | null> {
    return null;
  }
  async markCancelled(): Promise<ConnectorAction | null> {
    return null;
  }
}

function makeAccount(overrides: Partial<ConnectorAccount> = {}): ConnectorAccount {
  return {
    id: "acct-1",
    userId: "user-1",
    provider: "slack",
    composioConnectedAccountId: "ca_1",
    composioEntityId: "user-1",
    externalAccountEmail: null,
    externalAccountLabel: null,
    scopes: [],
    status: "active",
    statusReason: null,
    metadata: {},
    connectedAt: new Date(),
    lastUsedAt: null,
    disconnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ConnectorAccount;
}

function slackCommand(overrides: Partial<ConnectorCommandDraft> = {}): ConnectorCommandDraft {
  return {
    provider: "slack",
    kind: "slack_dm",
    destination: { kind: "person", nameText: "Maya", emailText: null },
    message: "ping",
    eventTitle: null,
    whenText: null,
    whenAt: null,
    durationMinutes: null,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity: [],
    ...overrides,
  };
}

function calendarCommand(overrides: Partial<ConnectorCommandDraft> = {}): ConnectorCommandDraft {
  return {
    provider: "google_calendar",
    kind: "calendar_event",
    destination: { kind: "self", nameText: null, emailText: null },
    message: null,
    eventTitle: "Standup",
    whenText: "tomorrow 9am",
    whenAt: "2026-06-14T09:00:00.000Z",
    durationMinutes: 30,
    reminderMinutesBefore: null,
    linkedLoopId: null,
    ambiguity: [],
    ...overrides,
  };
}

const slackUser = (id: string, name: string, email: string | null) => ({
  id,
  real_name: name,
  profile: { real_name: name, display_name: name, email },
});

// ---------------------------------------------------------------------------
// providerForKind + summarizeCommand
// ---------------------------------------------------------------------------

describe("providerForKind", () => {
  it("maps kinds to connector_accounts providers", () => {
    expect(providerForKind("slack_dm")).toBe<ConnectorProvider>("slack");
    expect(providerForKind("calendar_event")).toBe<ConnectorProvider>("google_calendar");
  });
});

describe("summarizeCommand", () => {
  it("summarizes a slack command by recipient", () => {
    expect(summarizeCommand(slackCommand())).toContain("Maya");
  });
  it("summarizes a calendar command by title", () => {
    expect(summarizeCommand(calendarCommand())).toContain("Standup");
  });
});

// ---------------------------------------------------------------------------
// (a) loadConnectorAccount
// ---------------------------------------------------------------------------

describe("loadConnectorAccount", () => {
  it("returns missing when no active account exists", async () => {
    const repo = new FakeAccountsRepo();
    const result = await loadConnectorAccount({ userId: "user-1", provider: "slack", accounts: repo });
    expect(result.status).toBe("missing");
  });
  it("returns the account when one is active", async () => {
    const repo = new FakeAccountsRepo();
    repo.account = makeAccount();
    const result = await loadConnectorAccount({ userId: "user-1", provider: "slack", accounts: repo });
    expect(result.status).toBe("found");
  });
});

// ---------------------------------------------------------------------------
// (b) resolveCommandRecipient
// ---------------------------------------------------------------------------

describe("resolveCommandRecipient", () => {
  it("returns 'self' for calendar commands (no recipient resolution)", async () => {
    const outcome = await resolveCommandRecipient({
      command: calendarCommand(),
      keepsUserId: "user-1",
      connectedAccountId: "ca_1",
    });
    expect(outcome.status).toBe("self");
  });

  it("resolves a unique Slack match to a frozen destination", async () => {
    const execute: ToolExecutor = async (slug): Promise<ComposioToolResult> => {
      if (slug === "SLACK_LIST_ALL_USERS") {
        return { successful: true, data: { members: [slackUser("U_MAYA", "Maya", "maya@x.com")] }, error: null };
      }
      return { successful: false, data: {}, error: "users_not_found" };
    };
    const outcome = await resolveCommandRecipient({
      command: slackCommand(),
      keepsUserId: "user-1",
      connectedAccountId: "ca_1",
      execute,
    });
    expect(outcome.status).toBe("resolved");
    expect(outcome.status === "resolved" && outcome.destination).toBe("U_MAYA");
  });

  it("returns 'ambiguous' when two Slack users match (blocks approval)", async () => {
    const execute: ToolExecutor = async (slug): Promise<ComposioToolResult> => {
      if (slug === "SLACK_LIST_ALL_USERS") {
        return {
          successful: true,
          data: { members: [slackUser("U1", "Maya", "a@x.com"), slackUser("U2", "Maya", "b@x.com")] },
          error: null,
        };
      }
      return { successful: false, data: {}, error: "users_not_found" };
    };
    const outcome = await resolveCommandRecipient({
      command: slackCommand(),
      keepsUserId: "user-1",
      connectedAccountId: "ca_1",
      execute,
    });
    expect(outcome.status).toBe("ambiguous");
    expect(outcome.status === "ambiguous" && outcome.result.candidates).toHaveLength(2);
  });

  it("returns 'not_found' when the destination has neither name nor email", async () => {
    const outcome = await resolveCommandRecipient({
      command: slackCommand({ destination: { kind: "person", nameText: null, emailText: null } }),
      keepsUserId: "user-1",
      connectedAccountId: "ca_1",
    });
    expect(outcome.status).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// (c) buildFrozenPayload
// ---------------------------------------------------------------------------

describe("buildFrozenPayload", () => {
  it("freezes the resolved Slack destination into the payload channel", () => {
    const result = buildFrozenPayload({
      command: slackCommand(),
      recipient: { status: "resolved", destination: "U_MAYA", name: "Maya", email: "maya@x.com" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.payload.kind === "slack_dm") {
      expect(result.payload.channel).toBe("U_MAYA");
      expect(result.payload.recipientName).toBe("Maya");
      expect(result.payload.message).toBe("ping");
    }
  });

  it("GUARD: a calendar command with whenAt === null is rejected (needs_when)", () => {
    const result = buildFrozenPayload({
      command: calendarCommand({ whenAt: null }),
      recipient: { status: "self" },
    });
    expect(result.status).toBe("needs_when");
  });

  it("builds a calendar payload when whenAt is resolved", () => {
    const result = buildFrozenPayload({
      command: calendarCommand(),
      recipient: { status: "self" },
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.payload.kind === "calendar_event") {
      expect(result.payload.whenAt).toBe("2026-06-14T09:00:00.000Z");
      expect(result.payload.eventTitle).toBe("Standup");
      // self-event → no attendees → reversible downstream.
      expect(result.payload.attendees).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) createApprovalAndAction
// ---------------------------------------------------------------------------

describe("createApprovalAndAction", () => {
  it("creates the approval + a pending connector_actions row with the approval-keyed idempotency key", async () => {
    const approvals = new FakeApprovalRepo();
    const actions = new FakeActionsRepo();
    const emitted: { name: keyof EventMap; data: unknown }[] = [];
    const emitEvent = async <K extends keyof EventMap>(name: K, data: EventMap[K]) => {
      emitted.push({ name, data });
    };

    const payloadResult = buildFrozenPayload({
      command: slackCommand(),
      recipient: { status: "resolved", destination: "U_MAYA", name: "Maya", email: null },
    });
    if (payloadResult.status !== "ok") throw new Error("expected ok");

    const result = await createApprovalAndAction({
      command: slackCommand(),
      payload: payloadResult.payload,
      account: makeAccount(),
      inboundEmailId: "inbound-1",
      provider: "slack",
      approvals,
      actions,
      now: new Date("2026-06-13T12:00:00.000Z"),
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      emitEvent,
    });

    // Approval row created + approval.requested emitted (Phase 3 reuse).
    expect(approvals.requests.size).toBe(1);
    expect(emitted.some((e) => e.name === "approval.requested")).toBe(true);

    // Connector action row created, pending, keyed by the approval id.
    expect(actions.actions).toHaveLength(1);
    const action = actions.actions[0];
    expect(action.status).toBe("pending");
    expect(action.idempotencyKey).toBe(`connector:slack:${result.approvalId}`);
    expect(action.approvalRequestId).toBe(result.approvalId);
    expect(action.inboundEmailId).toBe("inbound-1");

    // Plaintext token handed back for the email link (never persisted).
    expect(result.token).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// executedConfirmationLine
// ---------------------------------------------------------------------------

describe("executedConfirmationLine", () => {
  it("maps execute outcomes to user-facing lines", () => {
    expect(executedConfirmationLine({ status: "completed", result: {}, cached: false })).toContain("done");
    expect(
      executedConfirmationLine({ status: "denied", error: { code: "x", message: "m", retryable: false } }),
    ).toContain("policy");
    expect(
      executedConfirmationLine({ status: "failed", error: { code: "x", message: "m", retryable: true } }),
    ).toContain("failed");
  });
});
