/**
 * EntityHeader — entity-centric header block for /r entity reports (Phase 7 C2).
 *
 * Shown above the loop sections when the report scope has an entityId. Displays:
 *   - Entity display name as headline (kind badge for companies)
 *   - Relationship recency: first seen / last seen dates
 *   - Open vs closed loop counts
 *   - Synthesized status text (the model summary is rendered by the page above this)
 *
 * Styling matches the existing report page: Bricolage Grotesque (inherited),
 * seafoam accent (#C1F5DF), ink (#14140F), muted gray (#6F6F66), warm white bg.
 */

import type { ReportScope } from "@/reports/query";

interface EntityHeaderProps {
  scope: ReportScope;
  /** Total open loop count from sections. */
  totalOpen: number;
  /** Total closed loop count — caller computes from sections. */
  totalClosed: number;
  now: Date;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatRelative(iso: string, now: Date): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * Entity header block. Rendered when scope.entityId is present on an entity report.
 * Receives first/last seen from scope (populated by entitySliceToSections) when available.
 */
export function EntityHeader({ scope, totalOpen, totalClosed, now }: EntityHeaderProps) {
  const displayName = scope.entity ?? "Entity";
  const firstSeenIso = typeof scope.firstSeenAt === "string" ? scope.firstSeenAt : null;
  const lastSeenIso = typeof scope.lastSeenAt === "string" ? scope.lastSeenAt : null;
  const entityKind = typeof scope.entityKind === "string" ? scope.entityKind : null;

  const openLabel = totalOpen === 1 ? "1 open" : `${totalOpen} open`;
  const closedLabel = totalClosed === 1 ? "1 closed" : `${totalClosed} closed`;

  return (
    <div className="rounded-none border border-[#C1F5DF] bg-[#F5FDF9] px-4 py-4">
      {/* Entity name + kind badge */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[20px] font-bold leading-tight tracking-normal text-[#14140F]">
          {displayName}
        </h2>
        {entityKind === "company" && (
          <span className="inline-block rounded-none border border-[#C1F5DF] bg-[#C1F5DF] px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#14140F]">
            Company
          </span>
        )}
      </div>

      {/* Loop counts */}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-sm font-medium text-[#6F6F66]">
        <span>{openLabel}</span>
        <span className="text-[#C8C8C3]">&middot;</span>
        <span>{closedLabel}</span>
      </div>

      {/* Relationship recency */}
      {(firstSeenIso || lastSeenIso) && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#6F6F66]">
          {firstSeenIso && (
            <span>
              First seen{" "}
              <span className="font-medium text-[#14140F]">
                {formatDate(firstSeenIso)}
              </span>
            </span>
          )}
          {lastSeenIso && (
            <span>
              Last active{" "}
              <span className="font-medium text-[#14140F]">
                {formatRelative(lastSeenIso, now)}
              </span>{" "}
              <span className="text-[#C8C8C3]">({formatDate(lastSeenIso)})</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
