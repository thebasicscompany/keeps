import { Badge } from "@/components/ui/badge";
import type { ReportKind } from "@/reports/query";

const KIND_LABELS: Record<ReportKind, string> = {
  insights: "Insights",
  waiting_on: "Waiting on",
  stale: "Stale loops",
  weekly: "Weekly summary",
  entity: "Loops for",
};

interface ReportHeaderProps {
  kind: ReportKind;
  scope: { entity?: string } & Record<string, unknown>;
  totalOpen: number;
  now: Date;
}

function formatAsOf(now: Date): string {
  // Absolute short format: "Jun 13, 9:41 AM"
  return now.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function ReportHeader({ kind, scope, totalOpen, now }: ReportHeaderProps) {
  const baseLabel = KIND_LABELS[kind];
  const title = kind === "entity" && scope.entity ? `${baseLabel} ${scope.entity}` : baseLabel;
  const openLabel = totalOpen === 1 ? "1 open loop" : `${totalOpen} open loops`;

  return (
    <div className="mb-6 border-b border-[#E2E2DD] pb-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-[22px] font-bold leading-tight tracking-normal text-[#14140F]">
          {title}
        </h1>
        {scope.entity && kind !== "entity" && (
          <Badge variant="outline" className="rounded-none text-xs font-medium text-[#6F6F66]">
            {scope.entity}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm font-medium text-[#6F6F66]">
        {openLabel}
        <span className="mx-1.5 text-[#C8C8C3]">&middot;</span>
        as of {formatAsOf(now)}
      </p>
    </div>
  );
}
