/**
 * entities/lookup — conservative read-only entity lookup for recall queries (Phase 7 C2).
 *
 * findEntityByQuery resolves a user-typed string (from classifyInsightCommand's
 * entityCandidate) to an existing entity graph id. It is STRICTLY read-only:
 * it NEVER creates an entity. A false-match is significantly less harmful than a
 * false-merge (the cardinal sin lives in resolve.ts), but we still prefer precision:
 * when a query matches multiple distinct entities ambiguously, we return null so the
 * caller falls back to the existing "did you mean…" clarification.
 *
 * Resolution order:
 *   1. Email: exact normalizeEmail match on canonicalEmail.
 *   2. Domain: exact match on metadata->>'domain' for company entities.
 *   3. Name/alias: exact case-insensitive match on displayName or any alias. When
 *      multiple distinct entities (by id) match, return null (ambiguous).
 *   4. Domain-contains: company entities whose metadata->>'domain' CONTAINS the term
 *      (e.g. "acme" → "acme.com"). Only when the above paths found nothing.
 *      Same ambiguity rule: null if multiple distinct entities match.
 *
 * Merged entities (mergedIntoEntityId IS NOT NULL) are excluded — the caller should
 * only ever see canonical (surviving) entities.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { entities } from "@/db/schema";
import { normalizeEmail } from "@/entities/resolve";

type Db = ReturnType<typeof getDb>;

export type EntityLookupResult = {
  id: string;
  displayName: string;
  kind: string;
};

/** True when query looks like an email address (contains exactly one @). */
function looksLikeEmail(query: string): boolean {
  return (query.match(/@/g) ?? []).length === 1;
}

/** True when query looks like a bare domain (contains a dot, no @, no spaces). */
function looksLikeDomain(query: string): boolean {
  return !query.includes("@") && !query.includes(" ") && query.includes(".");
}

/**
 * Look up an entity by a user-supplied query string (name, email, or domain).
 * Returns the entity id + display info, or null when nothing matches or the
 * match is ambiguous across multiple distinct entities.
 *
 * Accepts an optional drizzle db handle for testing; defaults to getDb().
 */
export async function findEntityByQuery(
  input: { userId: string; query: string },
  db?: Db,
): Promise<EntityLookupResult | null> {
  const database = db ?? getDb();
  const { userId, query } = input;
  const trimmed = query.trim();
  if (!trimmed) return null;

  // ── 1. Email lookup ──────────────────────────────────────────────────────────
  if (looksLikeEmail(trimmed)) {
    const normalized = normalizeEmail(trimmed);
    if (!normalized) return null;

    const rows = await database
      .select({ id: entities.id, displayName: entities.displayName, kind: entities.kind })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.canonicalEmail, normalized),
          isNull(entities.mergedIntoEntityId),
        ),
      )
      .limit(2);

    return rowsToResult(rows);
  }

  // ── 2. Domain lookup (exact) ─────────────────────────────────────────────────
  if (looksLikeDomain(trimmed)) {
    const domainLower = trimmed.toLowerCase();
    const rows = await database
      .select({ id: entities.id, displayName: entities.displayName, kind: entities.kind })
      .from(entities)
      .where(
        and(
          eq(entities.userId, userId),
          eq(entities.kind, "company"),
          sql`${entities.metadata}->>'domain' = ${domainLower}`,
          isNull(entities.mergedIntoEntityId),
        ),
      )
      .limit(2);

    if (rows.length > 0) return rowsToResult(rows);
    // Fall through to name/domain-contains paths below.
  }

  // ── 3. Exact name/alias match (case-insensitive) ─────────────────────────────
  const nameLower = trimmed.toLowerCase();
  const nameRows = await database
    .select({ id: entities.id, displayName: entities.displayName, kind: entities.kind })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        isNull(entities.mergedIntoEntityId),
        sql`(
          lower(${entities.displayName}) = ${nameLower}
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(${entities.aliases}) AS alias
            WHERE lower(alias) = ${nameLower}
          )
        )`,
      ),
    )
    .limit(3);

  // Deduplicate by id (shouldn't be needed but guard for safety)
  const nameUnique = deduplicateById(nameRows);
  if (nameUnique.length === 1) return nameUnique[0];
  if (nameUnique.length > 1) return null; // ambiguous

  // ── 4. Domain-contains: company domain includes the term ─────────────────────
  // Only for non-email, non-domain queries — "acme" matches "acme.com" or "acme.co.uk".
  const domainContainsRows = await database
    .select({ id: entities.id, displayName: entities.displayName, kind: entities.kind })
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, "company"),
        isNull(entities.mergedIntoEntityId),
        sql`${entities.metadata}->>'domain' ILIKE ${"%" + trimmed.toLowerCase() + "%"}`,
      ),
    )
    .limit(3);

  const domainUnique = deduplicateById(domainContainsRows);
  if (domainUnique.length === 1) return domainUnique[0];

  return null; // no match or ambiguous
}

function deduplicateById(rows: EntityLookupResult[]): EntityLookupResult[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

function rowsToResult(rows: EntityLookupResult[]): EntityLookupResult | null {
  const unique = deduplicateById(rows);
  if (unique.length === 1) return unique[0];
  return null; // 0 or >1 → null
}
