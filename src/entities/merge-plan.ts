/**
 * Entity canonicalization planner (Wave 0.3) — PURE + deterministic.
 *
 * Per-user → per-org: within an org, two colleagues' separate "jane@acme.com" / "Acme Corp"
 * rows collapse to ONE canonical entity. This module only PLANS the merge (which row is
 * canonical, which fold into it); the apply step (scripts/backfill-merge-entities.ts) does the
 * SOFT-merge — sets merged_into_entity_id on the duplicates (never deletes), re-points FK links,
 * and is therefore reversible. Reversibility matters because a false identity merge is the
 * cardinal confidentiality failure this re-founding guards against.
 *
 * SR5 discipline: the merge key is email (person) / domain (company) ONLY — NEVER a name match.
 */
import { normalizeEmail } from "@/entities/resolve";

export type EntityForMerge = {
  id: string;
  /** "person" | "company" | other entity kinds. Only person/company have merge keys. */
  kind: string;
  canonicalEmail: string | null;
  /** metadata->>'domain' for company entities; null otherwise. */
  domain: string | null;
  /** non-null = already merged into another entity → left untouched. */
  mergedIntoEntityId: string | null;
  /** epoch ms; the earliest-seen row in a group becomes canonical (deterministic). */
  firstSeenAtMs: number;
};

export type EntityMergePlan = {
  /** duplicate entity id → canonical entity id it should merge into. */
  remaps: { from: string; into: string }[];
  /** the canonical (surviving-as-active) entity id of each group. */
  canonicalIds: string[];
  /** number of groups that actually had >1 active member (drove a merge). */
  mergedGroupCount: number;
};

function mergeKey(e: EntityForMerge): string | null {
  if (e.kind === "company") {
    return e.domain ? `company:${e.domain.toLowerCase()}` : null;
  }
  const norm = normalizeEmail(e.canonicalEmail);
  return norm ? `person:${norm}` : null;
}

/**
 * Group an org's ACTIVE entities by merge key, pick the earliest-seen as canonical (tiebreak by
 * id asc), and map the rest into it. Already-merged rows and rows without a merge key are left
 * untouched. Total + deterministic — same input always yields the same plan.
 */
export function planEntityMerges(entities: EntityForMerge[]): EntityMergePlan {
  const groups = new Map<string, EntityForMerge[]>();
  for (const e of entities) {
    if (e.mergedIntoEntityId) continue; // already merged
    const key = mergeKey(e);
    if (!key) continue; // no email/domain → standalone, never name-matched
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }

  const remaps: { from: string; into: string }[] = [];
  const canonicalIds: string[] = [];
  let mergedGroupCount = 0;

  for (const arr of groups.values()) {
    arr.sort(
      (a, b) =>
        a.firstSeenAtMs - b.firstSeenAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const canonical = arr[0];
    canonicalIds.push(canonical.id);
    if (arr.length > 1) {
      mergedGroupCount += 1;
      for (let i = 1; i < arr.length; i++) {
        remaps.push({ from: arr[i].id, into: canonical.id });
      }
    }
  }

  return { remaps, canonicalIds, mergedGroupCount };
}
