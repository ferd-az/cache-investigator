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

type InvestigationListRowTarget =
  | {
      to: string;
      onSelect?: never;
      pending?: never;
    }
  | {
      to?: never;
      onSelect: () => void;
      pending?: boolean;
    };

export type InvestigationListRow = InvestigationListRowTarget & {
  /** Stable domain id used for keyed list rendering. */
  id: string;
  /** Short display id rendered in the mono lane, e.g. "ALM-07", "INV-041". */
  displayId: string;
  status: InvestigationRowStatus;
  title: string;
  /** Right-aligned lanes (service, key stat, confidence, duration). */
  lanes?: ReactNode;
  timestamp: string;
};

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
              <InvestigationListItem key={row.id} row={row} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function InvestigationListItem({ row }: { row: InvestigationListRow }) {
  if (row.onSelect) {
    return (
      <button
        className="flex w-full items-center justify-between gap-3 rounded-md p-4 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-wait disabled:opacity-70"
        aria-busy={row.pending}
        disabled={row.pending}
        onClick={row.onSelect}
        type="button"
      >
        <InvestigationListItemContent row={row} />
      </button>
    );
  }

  return (
    <div className="relative flex items-center justify-between gap-3 rounded-md p-4 hover:bg-muted/40">
      <InvestigationListItemContent row={row} />
    </div>
  );
}

function InvestigationListItemContent({ row }: { row: InvestigationListRow }) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex w-[104px] shrink-0 items-center gap-2.5">
          <StatusGlyph status={row.status} />
          <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">
            {row.displayId}
          </span>
        </div>
        {row.to ? (
          <Link
            className="truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            to={row.to}
          >
            {row.title}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium text-foreground">
            {row.title}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {row.lanes}
        <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
          {row.timestamp}
        </span>
      </div>
    </>
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

const glyphLabel: Record<InvestigationRowStatus, string> = {
  attention: "Needs attention",
  running: "Investigating",
  completed: "Completed",
  no_findings: "No findings",
  failed: "Failed"
};

function StatusGlyph({ status }: { status: InvestigationRowStatus }) {
  return (
    <span
      className={`flex w-3.5 shrink-0 justify-center ${glyphColor[status]}`}
    >
      <span className="sr-only">{glyphLabel[status]}: </span>
      <HugeiconsIcon
        className={
          status === "running"
            ? "animate-spin motion-reduce:animate-none"
            : undefined
        }
        icon={glyphIcon[status]}
        size={14}
        strokeWidth={1.6}
        aria-hidden="true"
      />
    </span>
  );
}
