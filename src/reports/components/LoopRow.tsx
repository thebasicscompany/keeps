import { Badge } from "@/components/ui/badge";
import { SourceEvidenceChip } from "./SourceEvidenceChip";
import { RowActions } from "./RowActions";
import type { ReportRow } from "@/reports/query";

interface LoopRowProps {
  row: ReportRow;
  token: string;
  canViewSensitiveEvidence: boolean;
}

/** Formats dueRelativeMs into a short human string. Returns null when no due date. */
function formatDueRelative(dueRelativeMs: number | null): string | null {
  if (dueRelativeMs === null) return null;

  const absDays = Math.abs(dueRelativeMs) / (1000 * 60 * 60 * 24);

  if (Math.abs(dueRelativeMs) < 12 * 60 * 60 * 1000) {
    // Within 12h either side → "due today"
    return "due today";
  }

  if (dueRelativeMs < 0) {
    // Overdue
    const days = Math.round(absDays);
    return days === 1 ? "overdue 1d" : `overdue ${days}d`;
  }

  // Future
  const days = Math.round(absDays);
  return days === 1 ? "due in 1d" : `due in ${days}d`;
}

export function LoopRow({ row, token, canViewSensitiveEvidence }: LoopRowProps) {
  const { loop, dueRelativeMs } = row;
  const dueLabel = formatDueRelative(dueRelativeMs);

  const ownerLabel = loop.ownerText
    ? `owner: ${loop.ownerText}`
    : loop.requesterText
    ? `from: ${loop.requesterText}`
    : null;

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
      {/* Left: summary + meta */}
      <div className="min-w-0 flex-1 space-y-1">
        {/* Summary */}
        <p className="text-sm font-semibold leading-snug text-[#14140F]">{loop.summary}</p>

        {/* Meta row: owner chip + due label */}
        <div className="flex flex-wrap items-center gap-1.5">
          {ownerLabel && (
            <Badge
              variant="outline"
              className="rounded-none text-xs font-medium text-[#6F6F66]"
            >
              {ownerLabel}
            </Badge>
          )}
          {dueLabel && (
            <span
              className={`text-xs font-medium ${
                dueRelativeMs !== null && dueRelativeMs < 0
                  ? "text-[#B42318]"
                  : "text-[#6F6F66]"
              }`}
            >
              {dueLabel}
            </span>
          )}
        </div>

        {/* Source evidence */}
        <div>
          <SourceEvidenceChip
            quote={loop.sourceQuote}
            canViewSensitiveEvidence={canViewSensitiveEvidence}
            token={token}
          />
        </div>
      </div>

      {/* Right: actions */}
      <div className="shrink-0">
        <RowActions loopId={loop.id} token={token} />
      </div>
    </div>
  );
}
