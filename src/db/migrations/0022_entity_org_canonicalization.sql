-- 0022_entity_org_canonicalization.sql
-- Org-Visibility Re-Founding (Wave 0.3) — entities become org-canonical (one per org).
--
-- SOFT-MERGE strategy: duplicates are pointed at a canonical row via merged_into_entity_id
-- (never deleted, reversible), exactly the mechanism resolveEntity/findEntityByQuery already use.
-- This file ADDS per-org partial unique indexes over the ACTIVE (non-merged) rows. It is
-- ADDITIVE + idempotent; the old per-user unique indexes are kept (harmless, still hold).
--
-- ORDERING: this migration can only succeed AFTER scripts/backfill-merge-entities.ts has run
-- (which sets merged_into_entity_id on the duplicates). If active duplicates still exist for an
-- (org_id, canonical_email) or (org_id, domain), the CREATE UNIQUE INDEX will fail by design —
-- that is the guard proving the merge completed. Apply with plain `psql -f` (txn-safe).

-- Active (non-merged) person entities are unique per (org, canonical_email).
CREATE UNIQUE INDEX IF NOT EXISTS "entities_org_canonical_email_active_unique"
  ON "entities" ("org_id", "canonical_email")
  WHERE "canonical_email" IS NOT NULL AND "merged_into_entity_id" IS NULL;

-- Active (non-merged) company entities are unique per (org, domain).
CREATE UNIQUE INDEX IF NOT EXISTS "entities_org_company_domain_active_unique"
  ON "entities" ("org_id", ((metadata ->> 'domain')))
  WHERE "kind" = 'company' AND "merged_into_entity_id" IS NULL;
