/**
 * Recipient resolution (Phase 4 — generic connector architecture).
 *
 * Resolving a named person ("Maya") to a verified provider destination (a Slack
 * user id) and BLOCKING on ambiguity ("two Mayas → ask") is the one piece of the
 * connector flow that is genuinely behavioral rather than plumbing. It is NOT a
 * "Slack tool module": there is no transport interface and no fake transport —
 * resolution calls the generic Composio executor directly, and tests inject a
 * fake executor.
 *
 * It runs UPSTREAM of execution: the workflow resolves a recipient, the user
 * approves the resolved destination (shown verbatim in the approval email), and
 * only the frozen destination is executed. Resolution never happens at execute
 * time — the approved payload must be exactly what runs (AR-7).
 *
 * The lookup CALL is per-provider (each provider finds people its own way), but
 * the result shape and the ambiguity POLICY (block on >1) are generic. Only
 * Slack implements lookup in V0; Calendar actions address `self` and never
 * resolve a recipient.
 */

import { executeComposioTool, type ComposioToolResult } from "@/connectors/composio";

/** The generic Composio executor, injectable so tests pass a fake (no network). */
export type ToolExecutor = (
  slug: string,
  params: {
    userId: string;
    arguments: Record<string, unknown>;
    connectedAccountId?: string;
  },
) => Promise<ComposioToolResult>;

export interface ResolveRecipientInput {
  /** Only 'slack' resolves a recipient in V0; calendar addresses self. */
  provider: "slack";
  nameText: string | null;
  emailText: string | null;
}

export interface ResolveRecipientContext {
  /** Keeps user UUID — the Composio user/entity id. */
  keepsUserId: string;
  /** The exact connected account (ca_…) approved for this user's provider. */
  connectedAccountId: string;
  /** Defaults to the real generic executor; tests inject a fake. */
  execute?: ToolExecutor;
}

/** A candidate destination surfaced during resolution. */
export interface RecipientCandidate {
  /** The provider destination — for Slack, the user id passed as `channel`. */
  destination: string;
  name: string;
  email: string | null;
}

export type ResolveRecipientResult =
  | { status: "resolved"; destination: string; name: string; email: string | null }
  | { status: "ambiguous"; candidates: RecipientCandidate[] }
  | { status: "not_found" };

/** Thrown on a provider/transport-level failure (not a not-found, which is typed). */
export class RecipientResolutionError extends Error {
  readonly composioError: string | null;
  constructor(message: string, composioError: string | null = null) {
    super(message);
    this.name = "RecipientResolutionError";
    this.composioError = composioError;
  }
}

// ---------------------------------------------------------------------------
// Slack lookup primitives (verified slugs + flat response shape — see
// RESEARCH-COMPOSIO.md). These call the generic executor; no transport layer.
// ---------------------------------------------------------------------------

const SLACK_FIND_USER_BY_EMAIL = "SLACK_FIND_USER_BY_EMAIL_ADDRESS";
const SLACK_LIST_ALL_USERS = "SLACK_LIST_ALL_USERS";

/** Loose shape of a Slack user record under Composio `data`. */
interface SlackRawUser {
  id?: string;
  name?: string;
  real_name?: string;
  email?: string;
  profile?: { real_name?: string; display_name?: string; email?: string };
}

function pickName(u: SlackRawUser): string {
  return u.real_name ?? u.profile?.real_name ?? u.profile?.display_name ?? u.name ?? u.id ?? "";
}
function pickDisplayName(u: SlackRawUser): string {
  return u.profile?.display_name ?? u.profile?.real_name ?? u.real_name ?? u.name ?? "";
}
function pickEmail(u: SlackRawUser): string | null {
  return u.profile?.email ?? u.email ?? null;
}

/** Slack `users_not_found` is a normal not-found, not a transport error. */
function isNotFoundError(error: string | null): boolean {
  if (!error) return false;
  return /users?_not_found|user_not_found|not[_ ]?found/i.test(error);
}

/**
 * Resolves a recipient to a verified provider destination.
 *
 * 1. If an email is present, look the user up by email (exact match) → resolved.
 * 2. Otherwise (or on email miss), list the first page of users and match
 *    `nameText` case-insensitively against name/display name:
 *      - exactly 1 → resolved
 *      - >1        → ambiguous (the workflow sends a clarification email and
 *                    BLOCKS approval; AR recipient-ambiguity gate)
 *      - 0         → not_found
 *
 * First-page cap on the user list is acceptable for V0.
 */
export async function resolveRecipient(
  input: ResolveRecipientInput,
  ctx: ResolveRecipientContext,
): Promise<ResolveRecipientResult> {
  const execute = ctx.execute ?? executeComposioTool;
  const base = { userId: ctx.keepsUserId, connectedAccountId: ctx.connectedAccountId };

  // 1) Email exact-match.
  if (input.emailText) {
    const res = await execute(SLACK_FIND_USER_BY_EMAIL, {
      ...base,
      arguments: { email: input.emailText },
    });
    if (res.successful) {
      const user = (res.data as { user?: SlackRawUser }).user;
      if (user?.id) {
        return {
          status: "resolved",
          destination: user.id,
          name: pickName(user),
          email: pickEmail(user),
        };
      }
    } else if (!isNotFoundError(res.error)) {
      throw new RecipientResolutionError(
        `Slack user lookup by email failed: ${res.error ?? "unknown error"}`,
        res.error,
      );
    }
    // not found by email → fall through to name match.
  }

  // 2) Name-based fallback against the first page of users.
  const name = input.nameText?.trim();
  if (!name) return { status: "not_found" };

  const res = await execute(SLACK_LIST_ALL_USERS, { ...base, arguments: {} });
  if (!res.successful) {
    throw new RecipientResolutionError(
      `Slack list users failed: ${res.error ?? "unknown error"}`,
      res.error,
    );
  }

  const target = name.toLowerCase();
  const members = ((res.data as { members?: SlackRawUser[] }).members ?? []).filter(
    (m): m is SlackRawUser & { id: string } => Boolean(m?.id),
  );
  const matches = members.filter(
    (m) =>
      pickName(m).trim().toLowerCase() === target ||
      pickDisplayName(m).trim().toLowerCase() === target,
  );

  if (matches.length === 1) {
    const m = matches[0];
    return { status: "resolved", destination: m.id, name: pickName(m), email: pickEmail(m) };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches.map((m) => ({
        destination: m.id,
        name: pickName(m),
        email: pickEmail(m),
      })),
    };
  }
  return { status: "not_found" };
}
