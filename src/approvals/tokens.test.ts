import { describe, expect, it } from "vitest";
import { hashApprovalToken, mintApprovalToken, verifyApprovalToken } from "@/approvals/tokens";

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe("mintApprovalToken", () => {
  it("returns a token and its SHA-256 hash", () => {
    const { token, hash } = mintApprovalToken();

    expect(typeof token).toBe("string");
    expect(typeof hash).toBe("string");
    // 32 random bytes → 43 base64url chars (no padding)
    expect(token).toHaveLength(43);
    // SHA-256 hex = 64 chars
    expect(hash).toHaveLength(64);
  });

  it("token is base64url — no +, /, or = characters", () => {
    const { token } = mintApprovalToken();

    expect(BASE64URL_RE.test(token)).toBe(true);
    expect(token).not.toMatch(/[+/=]/);
  });

  it("minted tokens are unique across calls", () => {
    const tokens = Array.from({ length: 20 }, () => mintApprovalToken().token);
    const unique = new Set(tokens);

    expect(unique.size).toBe(20);
  });

  it("hash matches independently computed SHA-256 of the token", () => {
    const { token, hash } = mintApprovalToken();

    expect(hash).toBe(hashApprovalToken(token));
  });
});

describe("hashApprovalToken", () => {
  it("is deterministic for the same input", () => {
    const token = "some-fixed-token";

    expect(hashApprovalToken(token)).toBe(hashApprovalToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashApprovalToken("token-a")).not.toBe(hashApprovalToken("token-b"));
  });
});

describe("verifyApprovalToken", () => {
  const now = new Date("2026-06-12T12:00:00.000Z");
  const future = new Date("2026-06-19T12:00:00.000Z"); // expiresAt well after now

  it("returns true for a valid token before expiry", () => {
    const { token, hash } = mintApprovalToken();

    expect(
      verifyApprovalToken(token, { storedHash: hash, expiresAt: future, now }),
    ).toBe(true);
  });

  it("round-trip: mint → verify succeeds", () => {
    const { token, hash } = mintApprovalToken();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    expect(verifyApprovalToken(token, { storedHash: hash, expiresAt, now })).toBe(true);
  });

  it("returns false when expired (expiresAt < now)", () => {
    const { token, hash } = mintApprovalToken();
    const past = new Date("2026-06-10T12:00:00.000Z");

    expect(verifyApprovalToken(token, { storedHash: hash, expiresAt: past, now })).toBe(false);
  });

  it("returns false exactly at the expiry boundary (expiresAt === now)", () => {
    const { token, hash } = mintApprovalToken();
    // expiresAt <= now means expired — equal counts as expired
    const exactNow = new Date(now.getTime());

    expect(verifyApprovalToken(token, { storedHash: hash, expiresAt: exactNow, now })).toBe(false);
  });

  it("returns false for a mismatched hash (wrong token)", () => {
    const { hash } = mintApprovalToken();
    const { token: otherToken } = mintApprovalToken();

    expect(verifyApprovalToken(otherToken, { storedHash: hash, expiresAt: future, now })).toBe(false);
  });

  it("returns false for a completely wrong hash string", () => {
    const { token } = mintApprovalToken();
    const wrongHash = "a".repeat(64); // valid length but wrong value

    expect(verifyApprovalToken(token, { storedHash: wrongHash, expiresAt: future, now })).toBe(false);
  });

  it("returns false for a mismatched-length storedHash without throwing", () => {
    const { token } = mintApprovalToken();
    // Truncated hash — different byte length from 32-byte (64-char hex) SHA-256 digest
    const shortHash = "deadbeef";

    expect(() =>
      verifyApprovalToken(token, { storedHash: shortHash, expiresAt: future, now }),
    ).not.toThrow();
    expect(
      verifyApprovalToken(token, { storedHash: shortHash, expiresAt: future, now }),
    ).toBe(false);
  });

  it("returns false for an empty storedHash without throwing", () => {
    const { token } = mintApprovalToken();

    expect(() =>
      verifyApprovalToken(token, { storedHash: "", expiresAt: future, now }),
    ).not.toThrow();
    expect(verifyApprovalToken(token, { storedHash: "", expiresAt: future, now })).toBe(false);
  });
});
