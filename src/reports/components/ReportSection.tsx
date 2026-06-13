import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoopRow } from "./LoopRow";
import type { ReportSection as ReportSectionData } from "@/reports/query";

interface ReportSectionProps {
  section: ReportSectionData;
  token: string;
  canViewSensitiveEvidence: boolean;
}

export function ReportSection({ section, token, canViewSensitiveEvidence }: ReportSectionProps) {
  if (section.rows.length === 0) {
    return (
      <p className="text-sm text-[#6F6F66]">
        {section.title}: none
      </p>
    );
  }

  return (
    <Card className="rounded-none">
      <CardHeader className="rounded-none">
        <CardTitle className="text-sm font-semibold uppercase tracking-wide text-[#6F6F66]">
          {section.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-[#E2E2DD]">
          {section.rows.map((row) => (
            <li key={row.loop.id} className="px-4 py-3">
              <LoopRow
                row={row}
                token={token}
                canViewSensitiveEvidence={canViewSensitiveEvidence}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
