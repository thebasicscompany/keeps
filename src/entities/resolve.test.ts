/**
 * Pure-function unit tests for the entity resolver utilities.
 *
 * These tests do NOT require a database and always run (no skipIf guard).
 * Covers: normalizeEmail, companyDomainFromEmail, FREEMAIL_DOMAINS membership.
 */

import { describe, expect, it } from "vitest";
import {
  FREEMAIL_DOMAINS,
  companyDomainFromEmail,
  isPunycodeDomain,
  isRoleMailbox,
  normalizeEmail,
} from "@/entities/resolve";

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

  // --- Hardening (audit findings C1/C2/H3): un-normalizable forms must return null so the
  //     caller routes them away from name-matching, never collapsing distinct addresses. ---

  it("returns null for quoted local parts that would mis-split on an embedded @ (C1)", () => {
    // Both of these RFC-valid-but-exotic addresses previously collapsed to the same canonical.
    expect(normalizeEmail('"foo+bar@corp"@example.com')).toBeNull();
    expect(normalizeEmail('"foo@corp"@example.com')).toBeNull();
  });

  it("returns null when the local part is empty after +strip (C2: +sales@acme.com)", () => {
    expect(normalizeEmail("+sales@acme.com")).toBeNull();
    expect(normalizeEmail("+support@acme.com")).toBeNull();
  });

  it("unwraps a display-name form to the addr-spec (H3)", () => {
    expect(normalizeEmail("Jane <jane@acme.com>")).toBe("jane@acme.com");
    expect(normalizeEmail("Jane Doe <Jane.Doe@ACME.com>")).toBe("jane.doe@acme.com");
  });

  it("does not let a display-name wrapper smuggle junk into the domain (H3)", () => {
    // Previously "...@gmail.com>" bypassed the freemail blocklist; now it normalizes cleanly.
    expect(normalizeEmail("Jane <jane@gmail.com>")).toBe("jane@gmail.com");
    expect(companyDomainFromEmail(normalizeEmail("Jane <jane@gmail.com>"))).toBeNull();
  });

  it("returns null for more than one @ or embedded whitespace/commas", () => {
    expect(normalizeEmail("a@b@acme.com")).toBeNull();
    expect(normalizeEmail("jane doe@acme.com")).toBeNull();
    expect(normalizeEmail("jane@acme.com, john@acme.com")).toBeNull();
  });

  it("returns null for malformed domains (leading/trailing/double dots)", () => {
    expect(normalizeEmail("jane@.acme.com")).toBeNull();
    expect(normalizeEmail("jane@acme.com.")).toBeNull();
    expect(normalizeEmail("jane@acme..com")).toBeNull();
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

// ---------------------------------------------------------------------------
// isRoleMailbox (audit R2 — role/shared mailboxes are not people)
// ---------------------------------------------------------------------------

describe("isRoleMailbox", () => {
  it("flags common role/shared mailboxes", () => {
    expect(isRoleMailbox("sales@acme.com")).toBe(true);
    expect(isRoleMailbox("founders@acme.com")).toBe(true);
    expect(isRoleMailbox("support@acme.com")).toBe(true);
    expect(isRoleMailbox("info@acme.com")).toBe(true);
    expect(isRoleMailbox("no-reply@acme.com")).toBe(true);
    expect(isRoleMailbox("postmaster@acme.com")).toBe(true);
  });

  it("does NOT flag real personal addresses", () => {
    expect(isRoleMailbox("jane@acme.com")).toBe(false);
    expect(isRoleMailbox("jane.doe@acme.com")).toBe(false);
    expect(isRoleMailbox("salesperson@acme.com")).toBe(false); // not an exact role match
  });

  it("returns false for null", () => {
    expect(isRoleMailbox(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPunycodeDomain (audit R3 — IDN/homoglyph guard)
// ---------------------------------------------------------------------------

describe("isPunycodeDomain", () => {
  it("flags punycode/IDN domains", () => {
    expect(isPunycodeDomain("xn--80ak6aa92e.com")).toBe(true);
    expect(isPunycodeDomain("xn--e1afmkfd.xn--p1ai")).toBe(true);
  });

  it("does NOT flag normal ASCII domains", () => {
    expect(isPunycodeDomain("acme.com")).toBe(false);
    expect(isPunycodeDomain("mail.acme.co.uk")).toBe(false);
  });

  it("non-ASCII (raw Unicode) domains are already rejected by normalizeEmail upstream", () => {
    // The Cyrillic-homoglyph "аcme.com" never reaches company resolution — it fails the
    // ASCII-only domain guard in normalizeEmail.
    expect(normalizeEmail("jane@аcme.com")).toBeNull();
  });
});
