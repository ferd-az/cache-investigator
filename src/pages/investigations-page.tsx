import {
  InvestigationList,
  type InvestigationListRow
} from "@/components/investigation-list";
import { completedCacheKeyRegression } from "@/fixtures/cache-key-regression";

export const unresolvedInvestigation = {
  id: "inv_unresolved_cache_regression",
  title: "p99 latency on /products elevated since 14:18 UTC",
  description:
    "A sustained cache-efficiency drop is increasing origin load for catalog traffic after the latest edge rollout.",
  status: "Needs attention",
  severity: "High",
  detectedAt: "2026-08-26T14:18:00.000Z",
  service: "catalog-edge",
  environment: "production"
} as const;

const monthDay = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  timeZone: "UTC"
});

const hourMinute = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

export function InvestigationsPage() {
  const completed = completedCacheKeyRegression;
  const finding = completed.finding!;

  const alarmRows: InvestigationListRow[] = [
    {
      displayId: "ALM-07",
      status: "attention",
      title: unresolvedInvestigation.title,
      lanes: (
        <>
          <span className="text-xs text-muted-foreground">
            {unresolvedInvestigation.service}
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            1.81s <span className="text-muted-foreground/60">/ 240ms</span>
          </span>
        </>
      ),
      timestamp: hourMinute.format(
        new Date(unresolvedInvestigation.detectedAt)
      ),
      to: `/i/${unresolvedInvestigation.id}`
    }
  ];

  const completedRow: InvestigationListRow = {
    displayId: "INV-041",
    status: "completed",
    title: completed.title,
    lanes: (
      <>
        <span className="text-xs text-muted-foreground">
          {completed.scope.service}
        </span>
        <span className="font-mono text-xs text-emerald-600">
          {Math.round(finding.confidence.score * 100)}%
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {durationBetween(completed.startedAt!, completed.completedAt!)}
        </span>
      </>
    ),
    timestamp: monthDay.format(new Date(completed.completedAt!)),
    to: `/i/${completed.id}`
  };

  return (
    <InvestigationList
      groups={[
        { label: "Needs attention", rows: alarmRows },
        { label: "Completed", rows: [completedRow] }
      ]}
    />
  );
}

function durationBetween(start: string, end: string) {
  const seconds = Math.round(
    (new Date(end).getTime() - new Date(start).getTime()) / 1000
  );
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
