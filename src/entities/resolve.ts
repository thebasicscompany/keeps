/**
 * entities/resolve — conservative entity resolver (Phase 7 A1)
 *
 * THE CARDINAL SIN IS A FALSE MERGE. A false merge silently destroys data and
 * is unrecoverable without audit logs. A duplicate entity is visible and
 * recoverable. We optimize hard for PRECISION: when in doubt, CREATE NEW.
 *
 * Email-exact is the ONLY safe auto-merge key.
 * NAME IS AN ALIAS, NEVER A JOIN KEY.
 */

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { entities } from "@/db/schema";
import type { Entity, NewEntity } from "@/db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolveEntityInput = {
  userId: string;
  name: string | null;
  email: string | null;
};

type Db = ReturnType<typeof getDb>;

// ---------------------------------------------------------------------------
// Email normalization
// ---------------------------------------------------------------------------

/**
 * Freemail / ISP domains that must NEVER become company entities.
 * When a sender uses one of these, companyDomainFromEmail returns null.
 */
export const FREEMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "yahoo.ca",
  "yahoo.com.au",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "fastmail.com",
  "fastmail.fm",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
  "yandex.com",
  "yandex.ru",
  "inbox.com",
  "rocketmail.com",
  "sbcglobal.net",
  "verizon.net",
  "comcast.net",
  "bellsouth.net",
  "att.net",
  "earthlink.net",
  "cox.net",
  "charter.net",
]);

/**
 * Role / shared / functional mailbox local-parts (RFC 2142 + common extensions). An address
 * like sales@acme.com or founders@acme.com is NOT a single person — resolving it as a
 * `person` entity pollutes the people graph and invites name-collision false-merges. We still
 * find-or-create it (so it dedupes and its company still resolves), but as kind `other`.
 */
export const ROLE_MAILBOX_LOCAL_PARTS = new Set<string>([
  // RFC 2142
  "postmaster", "hostmaster", "webmaster", "abuse", "noc", "security",
  "info", "marketing", "sales", "support",
  // Common functional/shared accounts
  "admin", "administrator", "contact", "hello", "help", "team", "founders", "founder",
  "billing", "accounts", "accounting", "finance", "ar", "ap", "invoices",
  "careers", "jobs", "recruiting", "hr", "people", "press", "media", "pr",
  "legal", "privacy", "compliance", "dpo", "gdpr",
  "noreply", "no-reply", "donotreply", "do-not-reply", "no_reply",
  "mailer-daemon", "bounce", "bounces", "notifications", "notification", "alerts",
  "service", "services", "office", "mail", "email", "newsletter", "news", "updates",
]);

/**
 * True when a normalized email's local part is a known role/shared mailbox (not a person).
 */
export function isRoleMailbox(normalizedEmail: string | null): boolean {
  if (!normalizedEmail) return false;
  const atIdx = normalizedEmail.indexOf("@");
  if (atIdx <= 0) return false;
  return ROLE_MAILBOX_LOCAL_PARTS.has(normalizedEmail.slice(0, atIdx));
}

/**
 * True when any label of a domain is an IDNA/punycode label (xn--). Such domains can be
 * homoglyph spoofs of a real company (e.g. xn--80ak6aa92e.com rendering as "аpple.com"),
 * so we flag them on the company entity for human review rather than trusting them as a
 * confident company key. (Raw non-ASCII domains are already rejected by normalizeEmail.)
 */
export function isPunycodeDomain(domain: string): boolean {
  return domain.split(".").some((label) => label.startsWith("xn--"));
}

/**
 * Normalize an email address for use as the canonical merge key:
 * - Trim whitespace
 * - Lowercase the entire address
 * - Strip +tags from the local part ONLY (jane+newsletter@acme.com → jane@acme.com)
 * - Return null if empty, no @, or otherwise malformed
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let s = raw.trim();
  if (!s) return null;

  // Unwrap a display-name form: "Jane <jane@acme.com>" → "jane@acme.com".
  // Take the LAST <...> group (the addr-spec) so "A <B> <real@x.com>" still works.
  const lt = s.lastIndexOf("<");
  const gt = s.lastIndexOf(">");
  if (lt >= 0 && gt > lt) {
    s = s.slice(lt + 1, gt).trim();
  }

  s = s.toLowerCase();
  if (!s) return null;

  // Reject forms we cannot losslessly normalize as a MERGE KEY. A false merge is the
  // cardinal sin, so anything ambiguous (quoted local parts, embedded whitespace/commas,
  // angle brackets, or anything other than exactly one '@') is treated as un-normalizable
  // (returns null). The caller then routes a *supplied-but-unnormalizable* email to a
  // dedicated path that NEVER name-matches (see resolveEntity), instead of silently
  // collapsing two distinct addresses. Quoted-local addresses like `"a@b"@x.com` are the
  // classic false-merge trap this guards against.
  if (/["'()\s,;:<>\\]/.test(s)) return null;
  if ((s.match(/@/g) || []).length !== 1) return null;

  const atIdx = s.indexOf("@");
  if (atIdx <= 0) return null; // empty local

  let local = s.slice(0, atIdx);
  const domain = s.slice(atIdx + 1);

  // Domain sanity: must contain a dot, no leading/trailing/double dots, and only the
  // characters a real (incl. punycode/IDN-as-xn--) domain uses. This also rejects the
  // `gmail.com>`-style junk that would otherwise bypass the freemail blocklist.
  if (!domain || !domain.includes(".")) return null;
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return null;
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;

  // Strip +tag from the local part ONLY.
  const plusIdx = local.indexOf("+");
  if (plusIdx >= 0) local = local.slice(0, plusIdx);
  if (!local) return null; // e.g. "+sales@acme.com" → empty local → un-normalizable

  return `${local}@${domain}`;
}

/**
 * Extract the corporate domain from a normalized email.
 * Returns null if the email is null OR the domain is a freemail/ISP provider.
 * A freemail domain NEVER becomes a company entity.
 */
export function companyDomainFromEmail(email: string | null): string | null {
  if (!email) return null;

  const atIdx = email.indexOf("@");
  if (atIdx < 0) return null;

  const domain = email.slice(atIdx + 1).toLowerCase();
  if (!domain) return null;

  if (FREEMAIL_DOMAINS.has(domain)) return null;

  return domain;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const MAX_MERGE_CHAIN = 20; // guard against cycles

/**
 * Follow mergedIntoEntityId pointers to find the canonical (surviving) entity.
 * Includes a visited-set cycle guard and a depth cap.
 */
async function followMergeChain(entity: Entity, db: Db): Promise<Entity> {
  const visited = new Set<string>();
  let current = entity;
  let depth = 0;

  while (current.mergedIntoEntityId && depth < MAX_MERGE_CHAIN) {
    if (visited.has(current.id)) {
      // Cycle detected — stop here, return current
      break;
    }
    visited.add(current.id);
    depth++;

    const [next] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, current.mergedIntoEntityId))
      .limit(1);

    if (!next) break; // dangling pointer — treat current as canonical
    current = next;
  }

  return current;
}

/**
 * Bump lastSeenAt and conditionally append a new alias.
 * An alias is appended only if `name` is non-empty and does not already appear
 * (case-insensitive) in displayName or aliases.
 */
async function touchEntitySeen(entity: Entity, name: string | null, db: Db): Promise<Entity> {
  const now = new Date();

  // Build new alias list if applicable
  const existingAliases = (entity.aliases as string[]) ?? [];
  let updatedAliases: string[] | undefined;

  if (name && name.trim()) {
    const nameTrimmed = name.trim();
    const nameLower = nameTrimmed.toLowerCase();
    const alreadyPresent =
      entity.displayName.toLowerCase() === nameLower ||
      existingAliases.some((a) => a.toLowerCase() === nameLower);

    if (!alreadyPresent) {
      updatedAliases = [...existingAliases, nameTrimmed];
    }
  }

  const updateValues: Partial<typeof entities.$inferInsert> = {
    lastSeenAt: now,
    updatedAt: now,
  };

  if (updatedAliases !== undefined) {
    updateValues.aliases = updatedAliases;
  }

  const [updated] = await db
    .update(entities)
    .set(updateValues)
    .where(eq(entities.id, entity.id))
    .returning();

  return updated ?? entity;
}

// ---------------------------------------------------------------------------
// resolveEntity — PERSON resolution
// ---------------------------------------------------------------------------

/**
 * Resolve or create a PERSON entity.
 *
 * Strategy (precision over recall — false merge is the cardinal sin):
 * 1. If we have a normalized email: exact match on (userId, canonicalEmail).
 *    - Found → follow merge chain, bump lastSeenAt, return canonical.
 *    - Not found → INSERT (handle unique-constraint race via onConflictDoNothing).
 * 2. If no email (name-only): exact case-insensitive match on displayName/aliases
 *    among name-only (canonicalEmail IS NULL) person entities for this user.
 *    - Exactly ONE match → follow chain, bump, return.
 *    - Zero OR MORE THAN ONE match → CREATE NEW (ambiguous = unsafe).
 *
 * NEVER fuzzy-match. NEVER merge distinct normalized emails. NAME ≠ JOIN KEY.
 */
export async function resolveEntity(input: ResolveEntityInput, db?: Db): Promise<Entity> {
  const database = db ?? getDb();
  const { userId, name, email } = input;

  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail) {
    return resolveByEmail({ userId, name, normalizedEmail }, database);
  }

  // An email was SUPPLIED but could not be safely normalized into a merge key (quoted
  // local part, empty local after +strip like "+sales@acme.com", junk domain, etc.).
  // We must NOT fall through to name-only matching: two distinct un-normalizable addresses
  // sharing a display name would then false-merge. Route to a dedicated path that keys on
  // the raw address and NEVER name-matches.
  const rawEmail = email?.trim().toLowerCase();
  if (rawEmail) {
    return resolveByUnnormalizableEmail({ userId, name, rawEmail }, database);
  }

  return resolveByNameOnly({ userId, name }, database);
}

/**
 * A supplied email we could not normalize. Find-or-create keyed on the raw address stored
 * in metadata.unresolvedEmail (so repeats of the SAME malformed address dedupe, but two
 * DISTINCT malformed addresses never collapse). canonicalEmail stays NULL — this is not a
 * trustworthy merge key. NEVER name-matches.
 */
async function resolveByUnnormalizableEmail(
  { userId, name, rawEmail }: { userId: string; name: string | null; rawEmail: string },
  db: Db,
): Promise<Entity> {
  const [existing] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "person"),
        isNull(entities.canonicalEmail),
        sql`${entities.metadata}->>'unresolvedEmail' = ${rawEmail}`,
      ),
    )
    .limit(1);

  if (existing) {
    const canonical = await followMergeChain(existing, db);
    return touchEntitySeen(canonical, name, db);
  }

  const [inserted] = await db
    .insert(entities)
    .values({
      userId,
      kind: "person",
      displayName: name?.trim() || rawEmail,
      canonicalEmail: null,
      aliases: name?.trim() ? [name.trim()] : [],
      metadata: { unresolvedEmail: rawEmail },
    })
    .returning();

  if (!inserted) {
    throw new Error(`resolveEntity: unresolvable-email insert returned no row for ${rawEmail}`);
  }

  return inserted;
}

async function resolveByEmail(
  {
    userId,
    name,
    normalizedEmail,
  }: { userId: string; name: string | null; normalizedEmail: string },
  db: Db,
): Promise<Entity> {
  // Attempt lookup by (userId, canonicalEmail)
  const [existing] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.canonicalEmail, normalizedEmail)))
    .limit(1);

  if (existing) {
    const canonical = await followMergeChain(existing, db);
    return touchEntitySeen(canonical, name, db);
  }

  // Not found — INSERT new entity. A role/shared mailbox (sales@, founders@, …) is keyed by
  // email like anyone else but is NOT a person — store it as kind 'other' so it stays out of
  // the people graph and never participates in name-only person matching.
  const displayName = name?.trim() || normalizedEmail;
  const initialAliases: string[] = name?.trim() ? [name.trim()] : [];
  const isRole = isRoleMailbox(normalizedEmail);

  const newEntity: NewEntity = {
    userId,
    kind: isRole ? "other" : "person",
    displayName,
    canonicalEmail: normalizedEmail,
    aliases: initialAliases,
    metadata: isRole ? { roleMailbox: true } : {},
  };

  const [inserted] = await db
    .insert(entities)
    .values(newEntity)
    // Handle unique-constraint race: if another process just inserted the same
    // (userId, canonicalEmail), do nothing and re-SELECT below.
    // The unique index is a PARTIAL index (WHERE canonical_email IS NOT NULL),
    // so we must pass the matching WHERE clause via `where` for Postgres to
    // correctly infer the arbiter index.
    .onConflictDoNothing({
      target: [entities.userId, entities.canonicalEmail],
      where: isNotNull(entities.canonicalEmail),
    })
    .returning();

  if (inserted) {
    return inserted;
  }

  // Race: another insert won — re-SELECT and return that row
  const [raced] = await db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), eq(entities.canonicalEmail, normalizedEmail)))
    .limit(1);

  if (!raced) {
    throw new Error(
      `resolveEntity: insert raced but re-select found nothing for email=${normalizedEmail}`,
    );
  }

  // Honor the "always return the canonical row" contract even on the race path: the winner
  // could already have been merged.
  const canonical = await followMergeChain(raced, db);
  return touchEntitySeen(canonical, name, db);
}

async function resolveByNameOnly(
  { userId, name }: { userId: string; name: string | null },
  db: Db,
): Promise<Entity> {
  const nameTrimmed = name?.trim() ?? null;

  if (nameTrimmed) {
    // Exact case-insensitive match against displayName or aliases for name-only
    // (canonicalEmail IS NULL) person entities belonging to this user.
    //
    // We use a raw SQL expression to check the aliases JSONB array because
    // Drizzle does not have a built-in operator for JSON array membership.
    const matches = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.kind, "person"),
          isNull(entities.canonicalEmail),
          sql`(
            lower(${entities.displayName}) = lower(${nameTrimmed})
            OR EXISTS (
              SELECT 1
              FROM jsonb_array_elements_text(${entities.aliases}) AS alias
              WHERE lower(alias) = lower(${nameTrimmed})
            )
          )`,
        ),
      );

    if (matches.length === 1) {
      const canonical = await followMergeChain(matches[0], db);
      // A name-only resolve must NEVER attach to an entity that HAS an email — even if the
      // matched email-less row was merged into one that does. Following the tombstone here
      // would let "Alex Kim" (no email) bind to alex@corp.com purely on name. Guard it:
      // if the canonical row carries an email, treat as no match and create a new name-only
      // entity instead.
      if (canonical.canonicalEmail === null) {
        return touchEntitySeen(canonical, nameTrimmed, db);
      }
    }

    // Zero, ambiguous (>1), or a match that resolved to an email-bearing entity → CREATE NEW.
  }

  // Create a new name-only entity (or a truly anonymous one if name is blank)
  const displayName = nameTrimmed || "Unknown";
  const initialAliases: string[] = nameTrimmed ? [nameTrimmed] : [];

  const newEntity: NewEntity = {
    userId,
    kind: "person",
    displayName,
    canonicalEmail: null,
    aliases: initialAliases,
    metadata: {},
  };

  const [inserted] = await db.insert(entities).values(newEntity).returning();

  if (!inserted) {
    throw new Error("resolveEntity: name-only insert returned no row");
  }

  return inserted;
}

// ---------------------------------------------------------------------------
// resolveCompany — COMPANY resolution
// ---------------------------------------------------------------------------

/**
 * Resolve or create a COMPANY entity keyed on domain.
 *
 * Companies are matched by metadata->>'domain' (exact), NOT canonicalEmail
 * (which is reserved for person emails). canonicalEmail is left NULL on
 * company rows. The domain is stored in displayName and metadata.domain.
 */
export async function resolveCompany(
  { userId, domain }: { userId: string; domain: string },
  db?: Db,
): Promise<Entity> {
  const database = db ?? getDb();
  const domainLower = domain.toLowerCase().trim();

  // Find existing company by (userId, kind='company', metadata->>'domain')
  const [existing] = await database
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "company"),
        sql`${entities.metadata}->>'domain' = ${domainLower}`,
      ),
    )
    .limit(1);

  if (existing) {
    const canonical = await followMergeChain(existing, database);
    return touchEntitySeen(canonical, null, database);
  }

  // Create new company entity. The partial unique index
  // `entities_user_company_domain_unique` (user_id, (metadata->>'domain')) WHERE kind='company'
  // is the arbiter — onConflictDoNothing makes concurrent inserts of the same domain
  // collapse to one row instead of duplicating. (No target columns: an expression partial
  // index can't be named as a column-list arbiter, and the email partial index can't fire
  // here because canonicalEmail is NULL, so a bare DO NOTHING is safe.)
  const newEntity: NewEntity = {
    userId,
    kind: "company",
    displayName: domainLower,
    canonicalEmail: null,
    aliases: [],
    // Flag punycode/IDN domains for human review — they can be homoglyph spoofs of a real
    // company. We still create the entity (so loops link), but mark it as low-trust.
    metadata: isPunycodeDomain(domainLower) ? { domain: domainLower, idn: true } : { domain: domainLower },
  };

  const [inserted] = await database.insert(entities).values(newEntity).onConflictDoNothing().returning();

  if (inserted) {
    return inserted;
  }

  // Lost the race — re-select the winning row and return its canonical.
  const [raced] = await database
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "company"),
        sql`${entities.metadata}->>'domain' = ${domainLower}`,
      ),
    )
    .limit(1);

  if (!raced) {
    throw new Error(`resolveCompany: insert raced but re-select found nothing for domain=${domainLower}`);
  }

  return touchEntitySeen(await followMergeChain(raced, database), null, database);
}

/**
 * Convenience: extract company domain from an email and resolve/create the
 * company entity. Returns null for freemail domains (no company created).
 */
export async function resolveCompanyFromEmail(
  { userId, email }: { userId: string; email: string | null },
  db?: Db,
): Promise<Entity | null> {
  const normalized = normalizeEmail(email);
  const domain = companyDomainFromEmail(normalized);

  if (!domain) return null;

  return resolveCompany({ userId, domain }, db);
}
