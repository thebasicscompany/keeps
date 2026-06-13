import { describe, it, expect } from "vitest";
import { mintReportToken, hashReportToken, verifyReportToken } from "./token";

describe("mintReportToken", () => {
  it("returns a token and a 64-char hex tokenHash", () => {
    const { token, tokenHash } = mintReportToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("token is URL-safe base64url (no +, /, or = padding)", () => {
    const { token } = mintReportToken();
    expect(token).not.toMatch(/[+/=]/);
  });

  it("two mints produce different tokens and hashes", () => {
    const first = mintReportToken();
    const second = mintReportToken();
    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

describe("hashReportToken", () => {
  it("matches the tokenHash from mintReportToken", () => {
    const { token, tokenHash } = mintReportToken();
    expect(hashReportToken(token)).toBe(tokenHash);
  });

  it("is deterministic for the same input", () => {
    const { token } = mintReportToken();
    expect(hashReportToken(token)).toBe(hashReportToken(token));
  });
});

describe("verifyReportToken", () => {
  it("returns true for a correct token with a future expiresAt", () => {
    const { token, tokenHash } = mintReportToken();
    const now = new Date("2025-01-01T00:00:00Z");
    const expiresAt = new Date("2025-01-02T00:00:00Z");
    expect(verifyReportToken(token, { storedHash: tokenHash, expiresAt, now })).toBe(true);
  });

  it("returns false when expiresAt <= now (expired)", () => {
    const { token, tokenHash } = mintReportToken();
    const now = new Date("2025-01-02T00:00:00Z");
    const expiresAt = new Date("2025-01-01T00:00:00Z"); // in the past
    expect(verifyReportToken(token, { storedHash: tokenHash, expiresAt, now })).toBe(false);
  });

  it("returns false when expiresAt === now (boundary: not yet expired)", () => {
    const { token, tokenHash } = mintReportToken();
    const now = new Date("2025-01-01T00:00:00Z");
    const expiresAt = now; // equal → expired per spec (expiresAt <= now)
    expect(verifyReportToken(token, { storedHash: tokenHash, expiresAt, now })).toBe(false);
  });

  it("returns false for a tampered token (last char flipped)", () => {
    const { token, tokenHash } = mintReportToken();
    const lastChar = token[token.length - 1];
    const flipped = lastChar === "A" ? "B" : "A";
    const tampered = token.slice(0, -1) + flipped;
    const now = new Date("2025-01-01T00:00:00Z");
    const expiresAt = new Date("2025-01-02T00:00:00Z");
    expect(verifyReportToken(tampered, { storedHash: tokenHash, expiresAt, now })).toBe(false);
  });

  it("returns false and does not throw when storedHash is a wrong length (e.g. 'abc')", () => {
    const { token } = mintReportToken();
    const now = new Date("2025-01-01T00:00:00Z");
    const expiresAt = new Date("2025-01-02T00:00:00Z");
    expect(() =>
      verifyReportToken(token, { storedHash: "abc", expiresAt, now }),
    ).not.toThrow();
    expect(verifyReportToken(token, { storedHash: "abc", expiresAt, now })).toBe(false);
  });
});
