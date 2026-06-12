import { describe, expect, it } from "vitest";
import type { ApprovalRequest, ApprovalStatus, Draft } from "@/db/schema";
import {
  executeApprovedDraft,
  type ApprovalAuditWriter,
  type ApprovalDraftLoader,
  type ApprovalErrorEmailSender,
} from "@/approvals/execute";
import { registerAction } from "@/approvals/actions/registry";

const HANDLER_BOOM = new Error("connector exploded");
// A throwing handler registered under a dedicated kind exercises the handler-throw path
// without disturbing the no-op `test_action` fixture other tests rely on.
registerAction("throwing_action", async () => {
  throw HANDLER_BOOM;
});

const NOW = new Date("2026-06-12T12:00:00.000Z");
const FUTURE = new Date("2026-06-12T13:00:00.000Z");
const PAST = new Date("2026-06-12T11:00:00.000Z");

type AuditEntry = Parameters<ApprovalAuditWriter["writeAudit"]>[0];

class InMemoryAuditWriter implements ApprovalAuditWriter {
  readonly entries: AuditEntry[] = [];
  async writeAudit(input: AuditEntry): Promise<void> {
    this.entries.push(input);
  }
  get actions(): string[] {
    return this.entries.map((e) => e.action);
  }
}

class InMemoryLoader implements ApprovalDraftLoader {
  constructor(
    private readonly row: { approval: ApprovalRequest; draft: Draft } | null,
  ) {}
  async findApprovalWithDraft(): Promise<{ approval: ApprovalRequest; draft: Draft } | null> {
    return this.row;
  }
}

function makeErrorEmail() {
  const calls: Parameters<ApprovalErrorEmailSender>[0][] = [];
  const sender: ApprovalErrorEmailSender = async (input) => {
    calls.push(input);
  };
  return { sender, calls };
}

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: "draft-1",
    userId: "user-1",
    actionKind: "test_action",
    payload: {},
    sourceLoopId: null,
    requiresLogin: false,
    createdAt: NOW,
    ...overrides,
  };
}

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    userId: "user-1",
    draftId: "draft-1",
    actionKind: "test_action",
    status: "approved",
    tokenHash: "hash",
    expiresAt: FUTURE,
    decidedAt: NOW,
    decisionChannel: "email",
    decisionMetadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDeps(
  row: { approval: ApprovalRequest; draft: Draft } | null,
  now: Date = NOW,
) {
  const audit = new InMemoryAuditWriter();
  const email = makeErrorEmail();
  const loader = new InMemoryLoader(row);
  return {
    audit,
    email,
    run: () =>
      executeApprovedDraft("approval-1", {
        loader,
        audit,
        sendErrorEmail: email.sender,
        now,
      }),
  };
}

describe("executeApprovedDraft", () => {
  it("executes test_action through the full authorize path and audits approval.executed", async () => {
    const { audit, email, run } = makeDeps({
      approval: makeApproval(),
      draft: makeDraft(),
    });

    const result = await run();

    expect(result).toEqual({ status: "executed", detail: undefined });
    expect(audit.actions).toEqual(["approval.executed"]);
    expect(email.calls).toHaveLength(0);
  });

  it("returns not_found and audits failure when the approval/draft is missing", async () => {
    const { audit, email, run } = makeDeps(null);

    const result = await run();

    expect(result).toEqual({ status: "not_found" });
    expect(audit.actions).toEqual(["approval.execution_failed"]);
    expect(email.calls).toHaveLength(0);
  });

  it.each<ApprovalStatus>(["pending", "rejected", "expired", "cancelled"])(
    "refuses to execute when the approval status is %s (denied, no execution)",
    async (status) => {
      const { audit, email, run } = makeDeps({
        approval: makeApproval({ status }),
        draft: makeDraft(),
      });

      const result = await run();

      expect(result.status).toBe("denied");
      if (result.status === "denied") {
        expect(result.reason).toContain(status);
      }
      expect(audit.actions).toEqual(["approval.execution_failed"]);
      expect(email.calls).toHaveLength(0);
    },
  );

  it("refuses a replayed/stale approval (approved but expiresAt in the past)", async () => {
    const { audit, run } = makeDeps({
      approval: makeApproval({ status: "approved", expiresAt: PAST }),
      draft: makeDraft(),
    });

    const result = await run();

    expect(result.status).toBe("denied");
    if (result.status === "denied") {
      expect(result.reason).toContain("expired");
    }
    expect(audit.actions).toEqual(["approval.execution_failed"]);
  });

  it("refuses an approval expiring exactly at now (boundary is stale)", async () => {
    const { run } = makeDeps(
      { approval: makeApproval({ expiresAt: NOW }), draft: makeDraft() },
      NOW,
    );

    const result = await run();
    expect(result.status).toBe("denied");
  });

  it("audits failure, sends the error email, and does not execute an unknown action_kind", async () => {
    const { audit, email, run } = makeDeps({
      approval: makeApproval({ actionKind: "send_quantum_telegram" }),
      draft: makeDraft({ actionKind: "send_quantum_telegram" }),
    });

    const result = await run();

    expect(result).toEqual({ status: "unknown_action" });
    expect(audit.actions).toEqual(["approval.execution_failed"]);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]?.reason).toContain("send_quantum_telegram");
  });

  it("audits failure and rethrows when the handler throws", async () => {
    const { audit, email, run } = makeDeps({
      approval: makeApproval({ actionKind: "throwing_action" }),
      draft: makeDraft({ actionKind: "throwing_action" }),
    });

    await expect(run()).rejects.toThrow("connector exploded");

    expect(audit.actions).toEqual(["approval.execution_failed"]);
    expect(email.calls).toHaveLength(0);
  });
});
