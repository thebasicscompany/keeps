/**
 * Pure unit tests for link.ts helpers (no DB required).
 *
 * Run with:
 *   pnpm exec vitest run src/entities/link.test.ts
 */

import { describe, expect, it } from "vitest";
import { isSelf } from "@/entities/link";

describe("isSelf", () => {
  describe("email-based detection", () => {
    it("returns true when participant email matches selfEmail (normalized)", () => {
      expect(isSelf({ name: "Arav", email: "arav@company.com" }, "arav@company.com")).toBe(true);
    });

    it("returns true with +tag variant matching (both normalize to the same)", () => {
      expect(isSelf({ name: "Arav", email: "arav+work@company.com" }, "arav@company.com")).toBe(true);
    });

    it("returns true with case differences", () => {
      expect(isSelf({ name: "Arav", email: "ARAV@COMPANY.COM" }, "arav@company.com")).toBe(true);
    });

    it("returns false when participant email does NOT match selfEmail", () => {
      expect(isSelf({ name: "Jane", email: "jane@acme.com" }, "arav@company.com")).toBe(false);
    });

    it("returns false when selfEmail is null and participant has an email", () => {
      // No selfEmail to compare against — cannot determine self, be conservative
      expect(isSelf({ name: "Me", email: "anyone@acme.com" }, null)).toBe(false);
    });

    it("returns false when selfEmail is undefined and participant has an email", () => {
      expect(isSelf({ name: "Myself", email: "anyone@acme.com" }, undefined)).toBe(false);
    });
  });

  describe("pronoun-based detection (no email on participant)", () => {
    it('returns true for "me"', () => {
      expect(isSelf({ name: "me", email: null }, null)).toBe(true);
    });

    it('returns true for "I"', () => {
      expect(isSelf({ name: "I", email: null }, null)).toBe(true);
    });

    it('returns true for "myself"', () => {
      expect(isSelf({ name: "myself", email: null }, null)).toBe(true);
    });

    it('returns true for "self"', () => {
      expect(isSelf({ name: "self", email: null }, null)).toBe(true);
    });

    it("is case-insensitive for pronouns", () => {
      expect(isSelf({ name: "ME", email: null }, null)).toBe(true);
      expect(isSelf({ name: "Myself", email: null }, null)).toBe(true);
      expect(isSelf({ name: "SELF", email: null }, null)).toBe(true);
    });

    it("returns false for ordinary names with no email", () => {
      expect(isSelf({ name: "Alice", email: null }, null)).toBe(false);
      expect(isSelf({ name: "John Doe", email: null }, null)).toBe(false);
    });

    it("returns false for null name and null email", () => {
      expect(isSelf({ name: null, email: null }, null)).toBe(false);
    });
  });

  describe("email presence takes precedence over pronouns", () => {
    it("does NOT treat participant as self based on pronoun name when they have an email and selfEmail is null", () => {
      // The participant says their name is "me" but has an email — without selfEmail we cannot
      // confirm they are the user; remain conservative (return false).
      expect(isSelf({ name: "me", email: "someoneelse@acme.com" }, null)).toBe(false);
    });

    it("correctly identifies self when both email matches AND name is a pronoun", () => {
      expect(isSelf({ name: "me", email: "arav@company.com" }, "arav@company.com")).toBe(true);
    });
  });
});
