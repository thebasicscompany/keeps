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
 * Normalize an email address for use as the canonical merge key:
 * - Trim whitespace
 * - Lowercase the entire address
 * - Strip +tags from the local part ONLY (jane+newsletter@acme.com → jane@acme.com)
 * - Return null if empty, no @, or otherwise malformed
 */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const atIdx = trimmed.indexOf("@");
  if (atIdx <= 0) return null; // no @ or @ at start

  const local = trimmed.slice(0, atIdx);
  const domain = trimmed.slice(atIdx + 1);

  if (!domain || !domain.includes(".")) return null;

  // Strip +tag from local part
  const plusIdx = local.indexOf("+");
  const normalizedLocal = plusIdx >= 0 ? local.slice(0, plusIdx) : local;

  if (!normalizedLocal) return null;

  return `${normalizedLocal}@${domain}`;
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
  } else {
    return resolveByNameOnly({ userId, name }, database);
  }
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

  // Not found — INSERT new person entity
  const displayName = name?.trim() || normalizedEmail;
  const initialAliases: string[] = name?.trim() ? [name.trim()] : [];

  const newEntity: NewEntity = {
    userId,
    kind: "person",
    displayName,
    canonicalEmail: normalizedEmail,
    aliases: initialAliases,
    metadata: {},
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

  return raced;
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
      // Exactly one match — safe to return it (follow merge chain first)
      const canonical = await followMergeChain(matches[0], db);
      return touchEntitySeen(canonical, nameTrimmed, db);
    }

    // Zero or more-than-one match → ambiguous. Fall through to create new.
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

  // Create new company entity
  const newEntity: NewEntity = {
    userId,
    kind: "company",
    displayName: domainLower,
    canonicalEmail: null,
    aliases: [],
    metadata: { domain: domainLower },
  };

  const [inserted] = await database.insert(entities).values(newEntity).returning();

  if (!inserted) {
    throw new Error(`resolveCompany: insert returned no row for domain=${domainLower}`);
  }

  return inserted;
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
