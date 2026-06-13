/**
 * Slack tool module (Phase 4 B1).
 *
 * The Slack connector behind a provider-shaped `SlackTransport` interface.
 * Two transports are provided:
 *   - `createComposioSlackTransport` — the real transport backed by Composio
 *     (calls SLACK_FIND_USER_BY_EMAIL_ADDRESS / SLACK_LIST_ALL_USERS /
 *     SLACK_SEND_MESSAGE via executeComposioTool from ./composio).
 *   - `createFakeSlackTransport` — an in-memory transport for tests (no network,
 *     no Composio). Records every sendMessage call for inspection.
 *
 * The two orchestrating functions:
 *   - `resolveSlackUser({ email, name }, transport)` — resolves a recipient to a
 *     Slack user id (email exact-match first, then case-insensitive name match
 *     against the first page of users).
 *   - `executeSlackDm({ slackUserId, message }, transport)` — sends a DM to an
 *     ALREADY-RESOLVED Slack user id. Resolution happens UPSTREAM and the user
 *     approves the resolved recipient before execution, so this never resolves.
 *
 * AR-7: this module NEVER checks approvals — the execute funnel (Wave D)
 * authorizes before calling executeSlackDm. Do not add approval logic here.
 *
 * Verified facts (RESEARCH-COMPOSIO.md + live schema probes):
 *   - SLACK_FIND_USER_BY_EMAIL_ADDRESS, args { email }. Response data is FLAT:
 *     { ok, user } where user.id / user.profile… (NOT nested under response_data).
 *   - SLACK_SEND_MESSAGE, args { channel, markdown_text }. Passing a Slack USER
 *     id as `channel` opens the 1:1 DM. Response data: { ok, ts, channel, message }.
 *   - SLACK_LIST_ALL_USERS — paginated; capped at the first page in V0.
 *   - execute returns { data, successful, error } and does NOT throw on action
 *     failure — branch on `successful`; try/catch only for transport errors.
 */

import { executeComposioTool } from "@/connectors/composio";

// ---------------------------------------------------------------------------
// Transport interface — provider-shaped, Composio-free
// ---------------------------------------------------------------------------

/** A Slack user as surfaced by a lookup-by-email hit. */
export interface SlackTransportUser {
  id: string;
  /** Best human name available (real_name / display_name / name). */
  name: string;
  email: string | null;
}

/** A Slack user as surfaced by the list-users fallback (name-based matching). */
export interface SlackTransportListedUser {
  id: string;
  /** real_name (or name) — the primary display label. */
  name: string;
  /** display_name from the profile — may differ from `name`. */
  displayName: string;
  email: string | null;
}

export type SlackLookupResult =
  | { status: "found"; user: SlackTransportUser }
  | { status: "not_found" };

export interface SlackSendMessageParams {
  /** Channel id, DM channel id (D…), OR a Slack user id (opens the 1:1 DM). */
  channel: string;
  /** Message body. Prefer markdown_text (text/blocks are deprecated upstream). */
  markdownText: string;
}

export interface SlackSendMessageResult {
  ok: boolean;
  ts: string;
  channel: string;
}

/**
 * Provider-shaped Slack transport. Implementations map provider responses into
 * these typed shapes; callers never see Composio types.
 */
export interface SlackTransport {
  /** Exact-match lookup by email. */
  lookupUserByEmail(email: string): Promise<SlackLookupResult>;
  /** First page of workspace users (V0 cap) for name-based fallback. */
  listUsers(): Promise<SlackTransportListedUser[]>;
  /** Send a message; passing a user id as `channel` opens the 1:1 DM. */
  sendMessage(params: SlackSendMessageParams): Promise<SlackSendMessageResult>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a Slack transport operation fails at the provider/action level
 * (not a not-found, which is modeled as a typed result). Carries the raw
 * Composio error string so Wave D can inspect it (e.g. to decide whether to
 * check the connected-account status for a possibly-revoked connection).
 */
export class SlackTransportError extends Error {
  /** The raw error string returned by Composio (`res.error`), if any. */
  readonly composioError: string | null;

  constructor(message: string, composioError: string | null = null) {
    super(message);
    this.name = "SlackTransportError";
    this.composioError = composioError;
  }
}

// ---------------------------------------------------------------------------
// Real transport — backed by Composio
// ---------------------------------------------------------------------------

export interface ComposioSlackTransportConfig {
  /** Keeps user UUID — the Composio user/entity id. */
  keepsUserId: string;
  /** The exact connected account (ca_…) approved for this user's Slack. */
  connectedAccountId: string;
}

/** Slugs the Slack transport calls (verified live). */
const SLUG = {
  findUserByEmail: "SLACK_FIND_USER_BY_EMAIL_ADDRESS",
  listAllUsers: "SLACK_LIST_ALL_USERS",
  sendMessage: "SLACK_SEND_MESSAGE",
} as const;

/** Slack `users_not_found` is a normal not-found, not a transport error. */
function isNotFoundError(error: string | null): boolean {
  if (!error) return false;
  return /users?_not_found|user_not_found|not[_ ]?found/i.test(error);
}

/** Picks the best human-readable name from a Slack user record. */
function pickName(user: SlackRawUser): string {
  return (
    user.real_name ??
    user.profile?.real_name ??
    user.profile?.display_name ??
    user.name ??
    user.id ??
    ""
  );
}

/** Picks the display name (profile.display_name) with sensible fallbacks. */
function pickDisplayName(user: SlackRawUser): string {
  return (
    user.profile?.display_name ??
    user.profile?.real_name ??
    user.real_name ??
    user.name ??
    ""
  );
}

/** Extracts an email from a Slack user record (lives under profile.email). */
function pickEmail(user: SlackRawUser): string | null {
  return user.profile?.email ?? user.email ?? null;
}

/** Loose shape of a Slack user record as returned under Composio `data`. */
interface SlackRawUser {
  id?: string;
  name?: string;
  real_name?: string;
  email?: string;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
  };
}

/**
 * The real Slack transport. Calls the Composio slugs above via
 * executeComposioTool, always pinning `connectedAccountId`, and maps the
 * universal `{ data, successful, error }` wrapper into typed results/errors.
 *
 * Detecting a possibly-revoked connection is NOT done here: on a send failure
 * we surface a clean `SlackTransportError`; the caller (Wave D) inspects the
 * connected-account status to decide reconnect vs. retry.
 */
export function createComposioSlackTransport(
  config: ComposioSlackTransportConfig,
): SlackTransport {
  const base = {
    userId: config.keepsUserId,
    connectedAccountId: config.connectedAccountId,
  };

  return {
    async lookupUserByEmail(email: string): Promise<SlackLookupResult> {
      const res = await executeComposioTool(SLUG.findUserByEmail, {
        ...base,
        arguments: { email },
      });

      if (!res.successful) {
        // users_not_found (and similar) → typed not_found, not an error.
        if (isNotFoundError(res.error)) return { status: "not_found" };
        throw new SlackTransportError(
          `Slack user lookup by email failed: ${res.error ?? "unknown error"}`,
          res.error,
        );
      }

      // FLAT payload: data = { ok, user }. user.id, user.profile…
      const user = (res.data as { user?: SlackRawUser }).user;
      if (!user?.id) return { status: "not_found" };

      return {
        status: "found",
        user: { id: user.id, name: pickName(user), email: pickEmail(user) },
      };
    },

    async listUsers(): Promise<SlackTransportListedUser[]> {
      const res = await executeComposioTool(SLUG.listAllUsers, {
        ...base,
        arguments: {},
      });

      if (!res.successful) {
        throw new SlackTransportError(
          `Slack list users failed: ${res.error ?? "unknown error"}`,
          res.error,
        );
      }

      // Slack users.list returns `members` (first page in V0 — no pagination).
      const members =
        (res.data as { members?: SlackRawUser[] }).members ?? [];
      return members
        .filter((m): m is SlackRawUser & { id: string } => Boolean(m?.id))
        .map((m) => ({
          id: m.id,
          name: pickName(m),
          displayName: pickDisplayName(m),
          email: pickEmail(m),
        }));
    },

    async sendMessage(
      params: SlackSendMessageParams,
    ): Promise<SlackSendMessageResult> {
      const res = await executeComposioTool(SLUG.sendMessage, {
        ...base,
        arguments: {
          channel: params.channel,
          markdown_text: params.markdownText,
        },
      });

      if (!res.successful) {
        throw new SlackTransportError(
          `Slack send message failed: ${res.error ?? "unknown error"}`,
          res.error,
        );
      }

      // FLAT payload: data = { ok, ts, channel, message }.
      const data = res.data as { ok?: boolean; ts?: string; channel?: string };
      return {
        ok: data.ok ?? true,
        ts: data.ts ?? "",
        channel: data.channel ?? params.channel,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Fake transport — for tests (no network, no Composio)
// ---------------------------------------------------------------------------

/** A user seeded into the fake transport. */
export interface FakeSlackUser {
  id: string;
  name: string;
  /** Defaults to `name` when omitted. */
  displayName?: string;
  email?: string | null;
}

export interface FakeSlackTransportConfig {
  /** Users seeded into the fake workspace (lookup + list). */
  users?: FakeSlackUser[];
  /**
   * When true, sendMessage throws a SlackTransportError (simulating a send
   * failure / possibly-revoked connection).
   */
  failSends?: boolean;
  /** Error string surfaced when failSends is true. */
  sendError?: string;
}

/** A recorded sendMessage call, for test inspection. */
export interface RecordedSend {
  channel: string;
  markdownText: string;
}

export interface FakeSlackTransport extends SlackTransport {
  /** Every sendMessage call, in order. Inspectable in tests. */
  readonly sends: RecordedSend[];
}

/**
 * In-memory Slack transport for tests.
 *
 * - `lookupUserByEmail` returns the first seeded user whose email matches
 *   (case-insensitively); else not_found.
 * - `listUsers` returns all seeded users (the "first page").
 * - `sendMessage` records the call and returns ok; or throws when failSends.
 *
 * To exercise resolveSlackUser ambiguity, seed two users with the SAME name and
 * NO matching email so resolution falls through to the name-based list match.
 */
export function createFakeSlackTransport(
  config: FakeSlackTransportConfig = {},
): FakeSlackTransport {
  const users = config.users ?? [];
  const sends: RecordedSend[] = [];

  return {
    sends,

    async lookupUserByEmail(email: string): Promise<SlackLookupResult> {
      const match = users.find(
        (u) =>
          u.email != null && u.email.toLowerCase() === email.toLowerCase(),
      );
      if (!match) return { status: "not_found" };
      return {
        status: "found",
        user: { id: match.id, name: match.name, email: match.email ?? null },
      };
    },

    async listUsers(): Promise<SlackTransportListedUser[]> {
      return users.map((u) => ({
        id: u.id,
        name: u.name,
        displayName: u.displayName ?? u.name,
        email: u.email ?? null,
      }));
    },

    async sendMessage(
      params: SlackSendMessageParams,
    ): Promise<SlackSendMessageResult> {
      sends.push({ channel: params.channel, markdownText: params.markdownText });
      if (config.failSends) {
        const err = config.sendError ?? "channel_not_found";
        throw new SlackTransportError(
          `Slack send message failed: ${err}`,
          err,
        );
      }
      return { ok: true, ts: "1700000000.000100", channel: params.channel };
    },
  };
}

// ---------------------------------------------------------------------------
// resolveSlackUser — recipient resolution (UPSTREAM of execute)
// ---------------------------------------------------------------------------

export interface ResolveSlackUserInput {
  email: string | null;
  name: string | null;
}

export interface ResolvedSlackCandidate {
  userId: string;
  name: string;
  email: string | null;
}

export type ResolveSlackUserResult =
  | { status: "resolved"; userId: string; name: string; email: string | null }
  | { status: "ambiguous"; candidates: ResolvedSlackCandidate[] }
  | { status: "not_found" };

/**
 * Resolves a recipient to a Slack user.
 *
 * Logic:
 *   1. If `email` is present, lookupUserByEmail. Found → resolved.
 *   2. If not found (or no email), listUsers and case-insensitively match
 *      `name` against name/displayName:
 *        - exactly 1 match → resolved
 *        - >1 match        → ambiguous (with candidates)
 *        - 0 matches       → not_found
 *
 * First-page cap on listUsers is acceptable for V0.
 *
 * Resolution happens UPSTREAM of execution: the workflow resolves, the user
 * approves the resolved recipient, and only then does executeSlackDm run with
 * the already-resolved id. Do not call this inside executeSlackDm.
 */
export async function resolveSlackUser(
  input: ResolveSlackUserInput,
  transport: SlackTransport,
): Promise<ResolveSlackUserResult> {
  // 1) Email exact-match.
  if (input.email) {
    const lookup = await transport.lookupUserByEmail(input.email);
    if (lookup.status === "found") {
      return {
        status: "resolved",
        userId: lookup.user.id,
        name: lookup.user.name,
        email: lookup.user.email,
      };
    }
  }

  // 2) Name-based fallback against the first page of users.
  const name = input.name?.trim();
  if (!name) return { status: "not_found" };

  const target = name.toLowerCase();
  const users = await transport.listUsers();
  const matches = users.filter(
    (u) =>
      u.name.trim().toLowerCase() === target ||
      u.displayName.trim().toLowerCase() === target,
  );

  if (matches.length === 1) {
    const m = matches[0];
    return { status: "resolved", userId: m.id, name: m.name, email: m.email };
  }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      candidates: matches.map((m) => ({
        userId: m.id,
        name: m.name,
        email: m.email,
      })),
    };
  }
  return { status: "not_found" };
}

// ---------------------------------------------------------------------------
// executeSlackDm — send to an ALREADY-RESOLVED user id
// ---------------------------------------------------------------------------

export interface ExecuteSlackDmInput {
  /** Already-resolved Slack user id (passed as `channel` to open the 1:1 DM). */
  slackUserId: string;
  /** The exact message body the user approved. */
  message: string;
}

export type ExecuteSlackDmResult = SlackSendMessageResult;

/**
 * Sends a DM to an already-resolved Slack user id.
 *
 * Passes `slackUserId` as the `channel` (Slack opens the 1:1 DM). Returns the
 * typed send result, or throws a SlackTransportError on failure (the caller —
 * Wave D — then checks the connected-account status for a possibly-revoked
 * connection).
 *
 * IMPORTANT: recipient resolution happens UPSTREAM (resolveSlackUser + user
 * approval). This function does NOT resolve — the approved draft must be
 * exactly what executes.
 */
export async function executeSlackDm(
  input: ExecuteSlackDmInput,
  transport: SlackTransport,
): Promise<ExecuteSlackDmResult> {
  return transport.sendMessage({
    channel: input.slackUserId,
    markdownText: input.message,
  });
}
