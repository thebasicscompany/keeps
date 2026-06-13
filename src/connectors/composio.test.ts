/**
 * Unit tests for src/connectors/composio.ts
 *
 * No network calls. The @composio/core SDK is vi.mock'd so no real client is
 * ever constructed. Tests cover:
 *   - verifyComposioWebhookSignature: happy path, tampered payload, missing secret
 *   - PROVIDER_TO_TOOLKIT: mapping correctness
 *   - getComposioClient: missing-API-key error
 */

import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @composio/core before importing the module under test.
// We only need the constructor — no methods are exercised in unit tests.
// ---------------------------------------------------------------------------
vi.mock("@composio/core", () => {
  class Composio {
    connectedAccounts = {
      link: vi.fn(),
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    };
    triggers = {
      verifyWebhook: vi.fn(),
    };
  }
  return { Composio };
});

// Import after mock is set up.
import {
  MissingComposioConfigError,
  PROVIDER_TO_TOOLKIT,
  _resetComposioClientForTests,
  getComposioClient,
  verifyComposioWebhookSignature,
} from "@/connectors/composio";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-webhook-secret-32-bytes-long!";

/** Produce a valid webhook-signature header value for the given inputs. */
function makeSignature(
  webhookId: string,
  timestamp: string,
  payload: string,
  secret = TEST_SECRET,
): string {
  const signingInput = `${webhookId}.${timestamp}.${payload}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(signingInput, "utf8")
    .digest("base64");
  return `v1,${hmac}`;
}

// ---------------------------------------------------------------------------
// verifyComposioWebhookSignature
// ---------------------------------------------------------------------------

describe("verifyComposioWebhookSignature", () => {
  const WEBHOOK_ID = "msg_abc123";
  const TIMESTAMP = String(Math.floor(Date.now() / 1000));
  const PAYLOAD = JSON.stringify({ type: "composio.connected_account.expired" });

  it("returns { valid: true } for a correct signature", () => {
    const signature = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
    const result = verifyComposioWebhookSignature({
      payload: PAYLOAD,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": TIMESTAMP,
        "webhook-signature": signature,
      },
      secret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("returns { valid: false } when payload is tampered", () => {
    const signature = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
    const tamperedPayload = JSON.stringify({ type: "composio.connected_account.expired", injected: true });
    const result = verifyComposioWebhookSignature({
      payload: tamperedPayload,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": TIMESTAMP,
        "webhook-signature": signature,
      },
      secret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/mismatch/i);
  });

  it("returns { valid: false } when secret is missing", () => {
    const signature = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
    const result = verifyComposioWebhookSignature({
      payload: PAYLOAD,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": TIMESTAMP,
        "webhook-signature": signature,
      },
      // no secret, no env var
      secret: undefined,
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/COMPOSIO_WEBHOOK_SECRET/);
  });

  it("returns { valid: false } when webhook-id header is missing", () => {
    const signature = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
    const result = verifyComposioWebhookSignature({
      payload: PAYLOAD,
      headers: {
        "webhook-timestamp": TIMESTAMP,
        "webhook-signature": signature,
      },
      secret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/webhook-id/);
  });

  it("returns { valid: false } when webhook-signature header is missing", () => {
    const result = verifyComposioWebhookSignature({
      payload: PAYLOAD,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": TIMESTAMP,
      },
      secret: TEST_SECRET,
    });
    expect(result.valid).toBe(false);
    expect((result as { valid: false; reason: string }).reason).toMatch(/webhook-signature/);
  });

  it("accepts a space-separated multi-signature header (first valid sig wins)", () => {
    // Some Composio rotations emit two signatures in the header
    const correctSig = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
    const otherSig = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const multiSig = `${otherSig} ${correctSig}`;
    const result = verifyComposioWebhookSignature({
      payload: PAYLOAD,
      headers: {
        "webhook-id": WEBHOOK_ID,
        "webhook-timestamp": TIMESTAMP,
        "webhook-signature": multiSig,
      },
      secret: TEST_SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("falls back to COMPOSIO_WEBHOOK_SECRET env var when no explicit secret", () => {
    const originalEnv = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = TEST_SECRET;
    try {
      const signature = makeSignature(WEBHOOK_ID, TIMESTAMP, PAYLOAD);
      const result = verifyComposioWebhookSignature({
        payload: PAYLOAD,
        headers: {
          "webhook-id": WEBHOOK_ID,
          "webhook-timestamp": TIMESTAMP,
          "webhook-signature": signature,
        },
        // no explicit secret
      });
      expect(result.valid).toBe(true);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.COMPOSIO_WEBHOOK_SECRET;
      } else {
        process.env.COMPOSIO_WEBHOOK_SECRET = originalEnv;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PROVIDER_TO_TOOLKIT mapping
// ---------------------------------------------------------------------------

describe("PROVIDER_TO_TOOLKIT", () => {
  it("maps 'slack' to the Composio toolkit slug 'slack'", () => {
    expect(PROVIDER_TO_TOOLKIT["slack"]).toBe("slack");
  });

  it("maps 'google_calendar' to the Composio toolkit slug 'googlecalendar'", () => {
    expect(PROVIDER_TO_TOOLKIT["google_calendar"]).toBe("googlecalendar");
  });

  it("covers both Keeps provider keys", () => {
    const keys = Object.keys(PROVIDER_TO_TOOLKIT);
    expect(keys).toContain("slack");
    expect(keys).toContain("google_calendar");
    expect(keys).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getComposioClient — missing-API-key error
// ---------------------------------------------------------------------------

describe("getComposioClient", () => {
  let originalKey: string | undefined;

  beforeEach(() => {
    // Reset the singleton before each test so constructor is re-evaluated.
    _resetComposioClientForTests();
    originalKey = process.env.COMPOSIO_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    _resetComposioClientForTests();
    if (originalKey !== undefined) {
      process.env.COMPOSIO_API_KEY = originalKey;
    } else {
      delete process.env.COMPOSIO_API_KEY;
    }
  });

  it("throws MissingComposioConfigError when COMPOSIO_API_KEY is absent", () => {
    expect(() => getComposioClient()).toThrow(MissingComposioConfigError);
  });

  it("thrown error message references COMPOSIO_API_KEY", () => {
    expect(() => getComposioClient()).toThrow(/COMPOSIO_API_KEY/);
  });

  it("returns a client (mocked Composio instance) when key is present", () => {
    process.env.COMPOSIO_API_KEY = "test-key-value";
    const client = getComposioClient();
    expect(client).toBeDefined();
  });

  it("returns the same singleton on repeated calls", () => {
    process.env.COMPOSIO_API_KEY = "test-key-value";
    const a = getComposioClient();
    const b = getComposioClient();
    expect(a).toBe(b);
  });
});
