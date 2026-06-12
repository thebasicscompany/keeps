/**
 * decide-web.ts
 *
 * Pure-ish service shared by the approval page (server component) and the
 * decide route handler. It sits above the repository layer and below the HTTP
 * layer so neither the page nor the route needs to repeat token-verification
 * logic.
 *
 * Security invariant:
 *   - The plaintext token is verified against THIS approvalId's row ONLY.
 *     A token minted for approval A cannot open approval B because we first
 *     look up the row by approvalId, then confirm the token hash matches that
 *     specific row. Token hash lookup (findApprovalByTokenHash) could in
 *     theory return a row from another approval, so we explicitly compare the
 *     looked-up row's id against the path approvalId.
 */

import { hashApprovalToken } from "@/approvals/tokens";
import {
  decideApproval,
  type DecisionChannel,
  type DecisionKind,
} from "@/approvals/service";
import type { ApprovalRepository, ApprovalRequestWithDraft } from "@/approvals/repository";
import type { EventMap } from "@/workflows/events";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadApprovalResult =
  | { state: "valid"; request: ApprovalRequestWithDraft["draft"] extends never ? never : ApprovalRequestWithDraft; draft: ApprovalRequestWithDraft["draft"] }
  | { state: "invalid_token" }
  | { state: "expired" }
  | { state: "already_decided"; status: string }
  | { state: "not_found" };

// Unwrap the joined type into something more ergonomic for callers
export type LoadApprovalValid = {
  state: "valid";
  request: ApprovalRequestWithDraft;
  draft: ApprovalRequestWithDraft["draft"];
};

export type LoadApprovalForWebInput = {
  approvalId: string;
  token: string;
  now: Date;
  repository: ApprovalRepository;
};

type EmitEvent = <K extends keyof EventMap>(name: K, data: EventMap[K]) => Promise<void>;

export type DecideFromWebInput = {
  approvalId: string;
  token: string;
  action: "approve" | "cancel";
  now: Date;
  repository: ApprovalRepository;
  emitEvent?: EmitEvent;
};

export type DecideFromWebResult =
  | { outcome: "decided"; decision: DecisionKind }
  | { outcome: "already_decided"; status: string }
  | { outcome: "invalid_token" }
  | { outcome: "expired" }
  | { outcome: "not_found" };

// ---------------------------------------------------------------------------
// loadApprovalForWeb
// ---------------------------------------------------------------------------

/**
 * Load an approval request and verify the plaintext token against it.
 *
 * The token-for-wrong-approval attack is prevented by:
 *   1. Looking up the row by approvalId (the path parameter).
 *   2. Hashing the provided token and comparing it against the stored
 *      token_hash on THAT row — not via a global token-hash lookup.
 *
 * This means a valid token minted for approval A is rejected when the
 * path says /approvals/B because the hash comparison against B's row fails.
 */
export async function loadApprovalForWeb(
  input: LoadApprovalForWebInput,
): Promise<LoadApprovalResult> {
  const { approvalId, token, now, repository } = input;

  // Look up by approvalId first (not by token hash).
  const row = await repository.findApprovalById(approvalId);

  if (!row) {
    return { state: "not_found" };
  }

  // Verify the token hash matches THIS row.
  const computedHash = hashApprovalToken(token);

  // Use a constant-time-safe comparison by re-using the tokens module helper.
  // We import verifyApprovalToken from tokens.ts for timing-safe compare.
  const { verifyApprovalToken } = await import("@/approvals/tokens");
  const tokenValid = verifyApprovalToken(token, {
    storedHash: row.tokenHash,
    expiresAt: row.expiresAt,
    now,
  });

  // If the token expired the clock check inside verifyApprovalToken returns
  // false; we need to distinguish expired from wrong-token.
  if (!tokenValid) {
    // Did the hash match but the clock expired?
    // Recompute without clock to test this.
    const hashMatches = computedHash === row.tokenHash;
    if (hashMatches && row.expiresAt <= now) {
      return { state: "expired" };
    }
    return { state: "invalid_token" };
  }

  // Token is valid and unexpired — check decision status.
  if (row.status !== "pending") {
    return { state: "already_decided", status: row.status };
  }

  return { state: "valid", request: row, draft: row.draft };
}

// ---------------------------------------------------------------------------
// decideFromWeb
// ---------------------------------------------------------------------------

/**
 * Apply an approve or cancel decision from a web link click.
 *
 * Re-verifies the token before deciding so the route handler is stateless —
 * the token is the only credential.
 *
 * Maps UI action strings to DecisionKind:
 *   approve → 'approved'
 *   cancel  → 'cancelled'
 */
export async function decideFromWeb(
  input: DecideFromWebInput,
): Promise<DecideFromWebResult> {
  const { approvalId, token, action, now, repository, emitEvent } = input;

  // Map action to decision kind — reject invalid action strings early.
  let decision: DecisionKind;
  if (action === "approve") {
    decision = "approved";
  } else if (action === "cancel") {
    decision = "cancelled";
  } else {
    // Bogus action string — treat as invalid (caller should never hit this
    // with a typed action, but raw HTTP can send anything).
    return { outcome: "invalid_token" };
  }

  const channel: DecisionChannel = "web_link";

  // Re-verify the token (same logic as loadApprovalForWeb).
  const loaded = await loadApprovalForWeb({ approvalId, token, now, repository });

  if (loaded.state === "invalid_token") {
    return { outcome: "invalid_token" };
  }
  if (loaded.state === "expired") {
    return { outcome: "expired" };
  }
  if (loaded.state === "not_found") {
    return { outcome: "not_found" };
  }
  if (loaded.state === "already_decided") {
    return { outcome: "already_decided", status: loaded.status };
  }

  // Delegate to the canonical decideApproval state machine.
  const result = await decideApproval({
    approvalId,
    decision,
    channel,
    now,
    repository,
    emitEvent,
  });

  if (result.status === "decided") {
    return { outcome: "decided", decision };
  }
  if (result.status === "already_decided") {
    return { outcome: "already_decided", status: result.request.status };
  }
  if (result.status === "expired") {
    return { outcome: "expired" };
  }
  // not_found
  return { outcome: "not_found" };
}
