/**
 * Composio client wrapper for Keeps.
 *
 * Thin adapter layer: all downstream transports (Wave B) and the webhook
 * route (Wave C) import from here and never touch @composio/core directly.
 *
 * Verified against:
 *   - SDK declarations: node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts
 *   - SDK declarations: node_modules/@composio/core/dist/customTool.types-CMOMgxoM.d.mts
 *   - Official docs: https://docs.composio.dev/docs/migration-guide/new-sdk
 *   - Webhook verification: https://docs.composio.dev/docs/webhook-verification
 *   - @composio/core version 0.10.0
 */

import crypto from "node:crypto";
import { Composio } from "@composio/core";
import type {
  ConnectedAccountListResponse,
  ConnectedAccountRetrieveResponse,
  ConnectionRequest,
} from "@composio/core";
import { getEnv } from "@/config/env";

// ---------------------------------------------------------------------------
// Provider → Composio toolkit slug mapping
// Keeps uses 'slack' and 'google_calendar' as provider keys internally.
// These map to the Composio toolkit slugs registered in the dashboard.
// Verified against: https://docs.composio.dev (toolkit slugs are lowercase)
// ---------------------------------------------------------------------------

/** Keeps-internal provider names used in ConnectorCommandDraft.provider */
export type KeepsProvider = "slack" | "google_calendar";

/**
 * Maps Keeps provider names to Composio toolkit slugs.
 * Downstream agents (B1, B2) use this to call composio.tools.get / execute.
 *
 * @see https://docs.composio.dev — toolkit slugs are lowercase strings
 */
export const PROVIDER_TO_TOOLKIT: Record<KeepsProvider, string> = {
  slack: "slack",
  google_calendar: "googlecalendar",
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when COMPOSIO_API_KEY is absent and a network-bound helper is called.
 */
export class MissingComposioConfigError extends Error {
  constructor(message = "COMPOSIO_API_KEY is not set in environment") {
    super(message);
    this.name = "MissingComposioConfigError";
  }
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: Composio | null = null;

/**
 * Returns the lazily-constructed Composio singleton.
 * Throws MissingComposioConfigError if COMPOSIO_API_KEY is absent.
 *
 * Verified against: @composio/core 0.10.0 — `new Composio({ apiKey })`
 * @see node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 5372
 */
export function getComposioClient(): Composio {
  if (_client) return _client;

  const env = getEnv();
  if (!env.COMPOSIO_API_KEY) {
    throw new MissingComposioConfigError();
  }

  _client = new Composio({ apiKey: env.COMPOSIO_API_KEY });
  return _client;
}

/** Resets the singleton — for testing only, not exported to public API. */
export function _resetComposioClientForTests(): void {
  _client = null;
}

// ---------------------------------------------------------------------------
// Connect session
// ---------------------------------------------------------------------------

export interface CreateConnectSessionParams {
  /** Keeps user UUID — becomes the Composio entity/user ID. */
  userId: string;
  /** Keeps-internal provider name. */
  provider: KeepsProvider;
  /** Optional URL to redirect the user to after OAuth completes. */
  callbackUrl?: string;
}

export interface ConnectSessionResult {
  /** OAuth redirect URL the user must visit to complete authentication. */
  redirectUrl: string;
  /** Composio connected account nano-ID (e.g. "ca_xxxx"). */
  connectedAccountId: string;
}

/**
 * Initiates a Composio OAuth connect flow for the given provider.
 *
 * Uses `composio.connectedAccounts.link()` — the recommended method for
 * Composio-managed OAuth configs as of 2026-04-24. The older `initiate()`
 * method is deprecated for Composio-managed auth configs and will throw
 * after 2026-07-03. `link()` works for both managed and custom configs.
 *
 * Returns the redirectUrl the user must visit plus the connectedAccountId
 * for storage in connector_accounts (future migration A1).
 *
 * Verified against:
 *   - @composio/core 0.10.0 ConnectedAccounts.link() signature
 *   - node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 3936
 *   - https://docs.composio.dev/docs/changelog/2026/04/24 (link() preferred over initiate())
 *
 * NOTE: `authConfigId` is the Composio auth config nano-ID (e.g. "ac_xxxx")
 * configured in the Composio dashboard for the Keeps project. This must be
 * set up by Arav in the dashboard before Wave C goes live. The Wave C connect
 * server action (C1) will need to pass the correct auth config ID for each
 * provider; for now this wrapper accepts it via an optional override or
 * reads it from env (COMPOSIO_SLACK_AUTH_CONFIG_ID / COMPOSIO_GCAL_AUTH_CONFIG_ID).
 * Reviewer: confirm auth config IDs are wired correctly in C1.
 *
 * @param params.userId - Keeps user UUID used as the Composio user ID
 * @param params.provider - 'slack' | 'google_calendar'
 * @param params.callbackUrl - Optional post-auth redirect URL
 */
export async function createConnectSession(
  params: CreateConnectSessionParams,
): Promise<ConnectSessionResult> {
  const client = getComposioClient();
  const env = getEnv();

  // Resolve the auth config ID for the requested provider.
  // Wave C (C1) should pass this explicitly; we read from env as a fallback.
  const authConfigId = resolveAuthConfigId(params.provider, env);

  const connectionRequest: ConnectionRequest =
    await client.connectedAccounts.link(params.userId, authConfigId, {
      callbackUrl: params.callbackUrl,
    });

  const redirectUrl = connectionRequest.redirectUrl ?? "";
  const connectedAccountId = connectionRequest.id;

  return { redirectUrl, connectedAccountId };
}

/** Resolves the Composio auth config nano-ID for a given provider. */
function resolveAuthConfigId(
  provider: KeepsProvider,
  env: ReturnType<typeof getEnv>,
): string {
  const value =
    provider === "slack"
      ? env.COMPOSIO_SLACK_AUTH_CONFIG_ID
      : env.COMPOSIO_GCAL_AUTH_CONFIG_ID;
  if (!value) {
    const key =
      provider === "slack"
        ? "COMPOSIO_SLACK_AUTH_CONFIG_ID"
        : "COMPOSIO_GCAL_AUTH_CONFIG_ID";
    throw new MissingComposioConfigError(
      `${key} is not set — set it in Vercel env (Composio dashboard → Auth Configs → copy nano-ID)`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Connected account helpers
// ---------------------------------------------------------------------------

/**
 * Fetches the current status and details of a Composio connected account.
 *
 * Verified against: ConnectedAccounts.get(nanoid) in @composio/core 0.10.0
 * @see node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 3978
 */
export async function getConnectedAccount(
  connectedAccountId: string,
): Promise<ConnectedAccountRetrieveResponse> {
  return getComposioClient().connectedAccounts.get(connectedAccountId);
}

/**
 * Lists all Composio connected accounts for a given Keeps user UUID.
 *
 * Verified against: ConnectedAccounts.list({ userIds }) in @composio/core 0.10.0
 * @see node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 3832
 */
export async function listConnectedAccounts(params: {
  userId: string;
}): Promise<ConnectedAccountListResponse> {
  return getComposioClient().connectedAccounts.list({
    userIds: [params.userId],
  });
}

/**
 * Deletes (disconnects) a Composio connected account.
 * This revokes any stored OAuth tokens for that connection.
 *
 * Verified against: ConnectedAccounts.delete(nanoid) in @composio/core 0.10.0
 * @see node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 3995
 */
export async function deleteConnectedAccount(
  connectedAccountId: string,
): Promise<void> {
  await getComposioClient().connectedAccounts.delete(connectedAccountId);
}

// ---------------------------------------------------------------------------
// Raw tool execution pass-through
// ---------------------------------------------------------------------------

/** Parameters for executeComposioTool — the subset of ToolExecuteParams Keeps uses. */
export interface ExecuteComposioToolParams {
  /** Keeps user UUID used as the Composio user/entity ID. */
  userId: string;
  /** Action-specific arguments (snake_case keys, per the Composio tool schema). */
  arguments: Record<string, unknown>;
  /**
   * The exact connected account (ca_…) to execute through. RECOMMENDED — pins
   * execution to the account Keeps approved instead of letting Composio resolve
   * by (userId, toolkit) and possibly firing through a stale account.
   */
  connectedAccountId?: string;
}

/**
 * Universal Composio response wrapper. Every tool resolves to this shape.
 * `successful` is the gate; the upstream provider payload lives under `data`;
 * `error` is a human string when the action failed.
 *
 * NOTE: tools.execute does NOT throw on action failure — it resolves with
 * `successful: false`. It throws only for transport/client errors (network,
 * 401 bad key, malformed request). Callers branch on `successful` and wrap the
 * call in try/catch for transport errors.
 *
 * @see RESEARCH-COMPOSIO.md Q5/Q7
 */
export interface ComposioToolResult {
  data: Record<string, unknown>;
  error: string | null;
  successful: boolean;
}

/**
 * Thin pass-through to `composio.tools.execute(slug, { userId, arguments, connectedAccountId })`.
 *
 * Wave B transports (Slack, Calendar) call this instead of touching
 * @composio/core directly. It does no error mapping or branching — it returns
 * the universal `{ data, error, successful }` wrapper verbatim so callers can
 * apply their own typed result mapping. Transport/client errors propagate
 * (this does not catch them).
 *
 * Verified against: @composio/core 0.10.0 Tools.execute signature
 * @see node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 412
 * @see RESEARCH-COMPOSIO.md Q5
 */
export async function executeComposioTool(
  slug: string,
  params: ExecuteComposioToolParams,
): Promise<ComposioToolResult> {
  const result = await getComposioClient().tools.execute(slug, {
    userId: params.userId,
    arguments: params.arguments,
    connectedAccountId: params.connectedAccountId,
  });
  return {
    data: result.data,
    error: result.error,
    successful: result.successful,
  };
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/**
 * Input shape for webhook signature verification.
 * Headers are the raw HTTP request headers object (or a subset of it).
 */
export interface VerifyComposioWebhookParams {
  /** Raw request body as a UTF-8 string (before JSON.parse). */
  payload: string;
  /** Raw HTTP headers from the request — must include the three Composio headers. */
  headers: {
    "webhook-id"?: string | string[] | null;
    "webhook-signature"?: string | string[] | null;
    "webhook-timestamp"?: string | string[] | null;
    [key: string]: string | string[] | null | undefined;
  };
  /**
   * Optional webhook secret override for testing.
   * In production the secret is read from COMPOSIO_WEBHOOK_SECRET.
   */
  secret?: string;
  /**
   * Clock for timestamp-tolerance enforcement (replay protection). Injectable
   * for tests, mirroring the repo-wide injected-`now` convention.
   */
  now?: Date;
  /** Max allowed |now - webhook-timestamp| in seconds. Svix default: 300. */
  toleranceSeconds?: number;
}

export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: string };

/**
 * Verifies a Composio webhook signature without making any network calls.
 *
 * Composio signs every webhook with HMAC-SHA256 in the svix-style format:
 *   - signing input: `${webhook-id}.${webhook-timestamp}.${raw-body}`
 *   - header `webhook-signature`: `v1,<base64(HMAC-SHA256(secret, input))>`
 *   - header `webhook-id`: unique message ID
 *   - header `webhook-timestamp`: Unix timestamp in seconds (string)
 *
 * Uses timingSafeEqual to prevent timing attacks.
 *
 * Verified against:
 *   - https://docs.composio.dev/docs/webhook-verification
 *   - @composio/core 0.10.0 internal verifyWebhookSignature comment:
 *     "The signing input is: `${msgId}.${timestamp}.${payload}`"
 *   - node_modules/@composio/core/dist/composio-DRl6WCI9.d.mts line 3595-3598
 *
 * @returns { valid: true } on success, { valid: false, reason } on failure.
 *
 * NOTE FOR REVIEWER: Composio also exposes `composio.triggers.verifyWebhook()`
 * which does the same verification plus payload parsing (and requires an
 * async call). We implement the pure HMAC check here for the webhook route
 * (Wave C, C2) so it can guard the handler before any async work. C2 can
 * optionally call triggers.verifyWebhook for full payload parsing after this
 * guard passes, or just call this and parse the body directly.
 */
export function verifyComposioWebhookSignature(
  params: VerifyComposioWebhookParams,
): WebhookVerificationResult {
  const secret =
    params.secret ?? process.env.COMPOSIO_WEBHOOK_SECRET ?? undefined;

  if (!secret) {
    return {
      valid: false,
      reason: "COMPOSIO_WEBHOOK_SECRET is not configured",
    };
  }

  const webhookId = extractHeader(params.headers, "webhook-id");
  const webhookTimestamp = extractHeader(params.headers, "webhook-timestamp");
  const webhookSignature = extractHeader(params.headers, "webhook-signature");

  if (!webhookId) {
    return { valid: false, reason: "Missing webhook-id header" };
  }
  if (!webhookTimestamp) {
    return { valid: false, reason: "Missing webhook-timestamp header" };
  }
  if (!webhookSignature) {
    return { valid: false, reason: "Missing webhook-signature header" };
  }

  // Replay protection (svix scheme): reject timestamps outside the tolerance
  // window BEFORE doing any HMAC work.
  const timestampSeconds = Number(webhookTimestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return { valid: false, reason: "Malformed webhook-timestamp header" };
  }
  const nowSeconds = (params.now ?? new Date()).getTime() / 1000;
  const tolerance = params.toleranceSeconds ?? 300;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return { valid: false, reason: "webhook-timestamp outside tolerance window" };
  }

  // Svix-style secrets ship as "whsec_<base64-key>" — the HMAC key is the
  // DECODED bytes, not the prefixed string. A raw (unprefixed) secret is used
  // verbatim. Getting this wrong fails verification on every real webhook.
  const hmacKey = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  // Signing input: `${msgId}.${timestamp}.${rawBody}`
  const signingInput = `${webhookId}.${webhookTimestamp}.${params.payload}`;

  const expectedHmac = crypto
    .createHmac("sha256", hmacKey)
    .update(signingInput, "utf8")
    .digest("base64");

  // Signature header format: "v1,<base64>" — strip the "v1," prefix.
  // Multiple signatures may be space-separated; check each.
  const signaturesToCheck = webhookSignature
    .split(" ")
    .map((s) => s.replace(/^v1,/, "").trim())
    .filter(Boolean);

  const expectedBuf = Buffer.from(expectedHmac);

  for (const sig of signaturesToCheck) {
    try {
      const sigBuf = Buffer.from(sig);
      if (
        sigBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(sigBuf, expectedBuf)
      ) {
        return { valid: true };
      }
    } catch {
      // Buffer.from may throw on invalid base64 — treat as mismatch
    }
  }

  return { valid: false, reason: "Signature mismatch" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extracts a single header value (handles string | string[] | null | undefined). */
function extractHeader(
  headers: VerifyComposioWebhookParams["headers"],
  name: string,
): string | undefined {
  const val = headers[name];
  if (!val) return undefined;
  return Array.isArray(val) ? val[0] : val;
}
