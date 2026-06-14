/**
 * Pure-function unit tests for the entity resolver utilities.
 *
 * These tests do NOT require a database and always run (no skipIf guard).
 * Covers: normalizeEmail, companyDomainFromEmail, FREEMAIL_DOMAINS membership.
 */

import { describe, expect, it } from "vitest";
import { FREEMAIL_DOMAINS, companyDomainFromEmail, normalizeEmail } from "@/entities/resolve";

// ---------------------------------------------------------------------------
// normalizeEmail
// ---------------------------------------------------------------------------

describe("normalizeEmail", () => {
  it("returns null for null/undefined/empty", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
    expect(normalizeEmail("")).toBeNull();
    expect(normalizeEmail("   ")).toBeNull();
  });

  it("returns null if there is no @ character", () => {
    expect(normalizeEmail("notanemail")).toBeNull();
    expect(normalizeEmail("alsonotanemail.com")).toBeNull();
  });

  it("returns null if @ is at the start (empty local part)", () => {
    expect(normalizeEmail("@domain.com")).toBeNull();
  });

  it("returns null if domain has no dot", () => {
    expect(normalizeEmail("user@localhost")).toBeNull();
  });

  it("lowercases the entire address", () => {
    expect(normalizeEmail("Jane.DOE@ACME.COM")).toBe("jane.doe@acme.com");
  });

  it("strips +tags from the local part only", () => {
    expect(normalizeEmail("jane+newsletter@acme.com")).toBe("jane@acme.com");
    expect(normalizeEmail("jane+foo+bar@acme.com")).toBe("jane@acme.com");
  });

  it("does NOT alter the domain", () => {
    expect(normalizeEmail("user@Sub.ACME.com")).toBe("user@sub.acme.com");
  });

  it("trims whitespace before processing", () => {
    expect(normalizeEmail("  jane@acme.com  ")).toBe("jane@acme.com");
  });

  it("strips +tag and lowercases in combination", () => {
    expect(normalizeEmail("JANE+Newsletter@Acme.COM")).toBe("jane@acme.com");
  });

  it("returns the address unchanged if local has no +tag", () => {
    expect(normalizeEmail("jane@acme.com")).toBe("jane@acme.com");
  });

  it("returns null if local part becomes empty after stripping (edge case: +@domain.com)", () => {
    // "+" before the @ means local = "" after split
    expect(normalizeEmail("+@domain.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FREEMAIL_DOMAINS membership
// ---------------------------------------------------------------------------

describe("FREEMAIL_DOMAINS", () => {
  it("contains common freemail providers", () => {
    expect(FREEMAIL_DOMAINS.has("gmail.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("googlemail.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("outlook.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("hotmail.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("yahoo.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("icloud.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("proton.me")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("protonmail.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("hey.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("qq.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("yandex.com")).toBe(true);
    expect(FREEMAIL_DOMAINS.has("yandex.ru")).toBe(true);
  });

  it("does NOT contain corporate / custom domains", () => {
    expect(FREEMAIL_DOMAINS.has("acme.com")).toBe(false);
    expect(FREEMAIL_DOMAINS.has("example.org")).toBe(false);
    expect(FREEMAIL_DOMAINS.has("mycompany.io")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// companyDomainFromEmail
// ---------------------------------------------------------------------------

describe("companyDomainFromEmail", () => {
  it("returns null for null email", () => {
    expect(companyDomainFromEmail(null)).toBeNull();
  });

  it("returns null for freemail domains", () => {
    expect(companyDomainFromEmail("jane@gmail.com")).toBeNull();
    expect(companyDomainFromEmail("jane@outlook.com")).toBeNull();
    expect(companyDomainFromEmail("jane@yahoo.com")).toBeNull();
    expect(companyDomainFromEmail("jane@icloud.com")).toBeNull();
    expect(companyDomainFromEmail("jane@proton.me")).toBeNull();
  });

  it("returns the domain for a corporate email", () => {
    expect(companyDomainFromEmail("jane@acme.com")).toBe("acme.com");
    expect(companyDomainFromEmail("john@stripe.com")).toBe("stripe.com");
  });

  it("returns the domain in lowercase", () => {
    expect(companyDomainFromEmail("jane@ACME.COM")).toBe("acme.com");
  });

  it("returns null for malformed email (no @)", () => {
    expect(companyDomainFromEmail("notanemail")).toBeNull();
  });

  it("works with subdomains", () => {
    expect(companyDomainFromEmail("jane@mail.acme.com")).toBe("mail.acme.com");
  });
});
