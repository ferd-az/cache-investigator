import {
  Alert02Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  Loading03Icon
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export type InvestigationRowStatus =
  | "attention"
  | "running"
  | "completed"
  | "no_findings"
  | "failed";

export interface InvestigationListRow {
  /** Short display id rendered in the mono lane, e.g. "ALM-07", "INV-041". */
  displayId: string;
  status: InvestigationRowStatus;
  title: string;
  /** Right-aligned lanes (service, key stat, confidence, duration). */
  lanes?: ReactNode;
  timestamp: string;
  to: string;
}

export interface InvestigationListGroup {
  label: string;
  rows: InvestigationListRow[];
}

export function InvestigationList({
  groups
}: {
  groups: InvestigationListGroup[];
}) {
  return (
    <div className="flex flex-col gap-5 px-2 py-4 lg:px-3">
      {groups.map((group) => (
        <section className="flex flex-col gap-1.5" key={group.label}>
          <div className="flex items-center gap-2 rounded-md bg-muted/60 px-4 py-2">
            <h2 className="text-xs font-medium text-foreground">
              {group.label}
            </h2>
            <span className="font-mono text-xs text-muted-foreground">
              {group.rows.length}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {group.rows.map((row) => (
              <InvestigationListItem key={row.displayId} row={row} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function InvestigationListItem({ row }: { row: InvestigationListRow }) {
  return (
    <div className="relative flex items-center justify-between gap-3 rounded-md p-4 hover:bg-muted/40">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex w-[76px] shrink-0 items-center gap-2.5">
          <StatusGlyph status={row.status} />
          <span className="font-mono text-xs text-muted-foreground">
            {row.displayId}
          </span>
        </div>
        <Link
          className="truncate text-[13px] text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
          to={row.to}
        >
          {row.title}
        </Link>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {row.lanes}
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
          {row.timestamp}
        </span>
      </div>
    </div>
  );
}

const glyphColor: Record<InvestigationRowStatus, string> = {
  attention: "text-amber-600",
  running: "text-blue-600",
  completed: "text-emerald-600",
  no_findings: "text-muted-foreground",
  failed: "text-destructive"
};

const glyphIcon: Record<InvestigationRowStatus, typeof Alert02Icon> = {
  attention: Alert02Icon,
  running: Loading03Icon,
  completed: CheckmarkCircle01Icon,
  no_findings: CircleDashedIcon,
  failed: CancelCircleIcon
};

function StatusGlyph({ status }: { status: InvestigationRowStatus }) {
  return (
    <span
      aria-hidden="true"
      className={`flex w-3.5 shrink-0 justify-center ${glyphColor[status]}`}
    >
      <HugeiconsIcon
        className={
          status === "running"
            ? "animate-spin motion-reduce:animate-none"
            : undefined
        }
        icon={glyphIcon[status]}
        size={14}
        strokeWidth={1.6}
      />
    </span>
  );
}
