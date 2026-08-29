import {
  InvestigationList,
  type InvestigationListRow
} from "@/components/investigation-list";
import { completedCacheKeyRegression } from "@/fixtures/cache-key-regression";
import type {
  Investigation,
  InvestigationStatus,
  InvestigationSummary
} from "@/investigation/contracts";
import { displayInvestigationId } from "@/investigation/display-investigation-id";
import type { StartInvestigationInput } from "@/investigation/runtime";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

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

const alarmInvestigationInput = {
  scope: {
    service: unresolvedInvestigation.service,
    environment: unresolvedInvestigation.environment,
    question:
      "Why did /products p99 latency rise as cache efficiency fell after 14:18 UTC?",
    window: {
      from: "2026-08-26T14:00:00.000Z",
      to: "2026-08-26T15:00:00.000Z"
    }
  },
  trigger: {
    kind: "manual",
    label: "Alarm ALM-07: elevated /products p99 latency"
  }
} satisfies Omit<StartInvestigationInput, "idempotencyKey">;

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

const LIST_REFRESH_INTERVAL_MS = 2_500;

export function InvestigationsPage() {
  const navigate = useNavigate();
  const idempotencyKey = useRef(
    `alarm:${unresolvedInvestigation.id}:${crypto.randomUUID()}`
  );
  const [startState, setStartState] = useState<
    | { status: "idle" }
    | { status: "starting" }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [runList, setRunList] = useState<{
    investigations: InvestigationSummary[];
    error: string | null;
  }>({ investigations: [], error: null });
  const completed = completedCacheKeyRegression;
  const isStarting = startState.status === "starting";

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | undefined;
    let controller: AbortController | undefined;

    async function refreshInvestigations() {
      controller = new AbortController();

      try {
        const response = await fetch("/api/investigations", {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        const value: unknown = await response.json();
        if (!response.ok) throw new Error(responseError(value));

        const investigations = responseInvestigations(value);
        if (!investigations) {
          throw new Error("The investigation list returned invalid data.");
        }
        if (!cancelled) {
          setRunList({ investigations, error: null });
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        if (!cancelled) {
          setRunList((current) => ({
            ...current,
            error: "Saved investigations could not be refreshed."
          }));
        }
      } finally {
        if (!cancelled) {
          refreshTimer = window.setTimeout(
            refreshInvestigations,
            LIST_REFRESH_INTERVAL_MS
          );
        }
      }
    }

    void refreshInvestigations();
    return () => {
      cancelled = true;
      controller?.abort();
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, []);

  async function startAlarmInvestigation() {
    if (isStarting) return;
    setStartState({ status: "starting" });

    try {
      const response = await fetch("/api/investigations", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...alarmInvestigationInput,
          idempotencyKey: idempotencyKey.current
        } satisfies StartInvestigationInput)
      });
      const value: unknown = await response.json();
      if (!response.ok) {
        setStartState({
          status: "error",
          message: responseError(value)
        });
        return;
      }
      const investigation = responseInvestigation(value);
      if (!investigation) {
        setStartState({
          status: "error",
          message: "The investigation started without returning a valid run."
        });
        return;
      }
      navigate(`/i/${encodeURIComponent(investigation.id)}`);
    } catch {
      setStartState({
        status: "error",
        message: "The investigation could not be started."
      });
    }
  }

  const alarmRows: InvestigationListRow[] = [
    {
      id: unresolvedInvestigation.id,
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
          {isStarting ? (
            <span className="text-xs text-muted-foreground">Starting…</span>
          ) : null}
        </>
      ),
      timestamp: hourMinute.format(
        new Date(unresolvedInvestigation.detectedAt)
      ),
      onSelect: () => void startAlarmInvestigation(),
      pending: isStarting
    }
  ];

  const completedRow: InvestigationListRow = {
    id: completed.id,
    displayId: "INV-041",
    status: "completed",
    title: completed.title,
    lanes: (
      <>
        <span className="text-xs text-muted-foreground">
          {completed.scope.service}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {durationBetween(completed.startedAt!, completed.completedAt!)}
        </span>
      </>
    ),
    timestamp: monthDay.format(new Date(completed.completedAt!)),
    to: `/i/${completed.id}`
  };
  const persistedRuns = runList.investigations.filter(
    (investigation) =>
      investigation.id !== completed.id &&
      investigation.id !== unresolvedInvestigation.id
  );
  const inProgressRows = persistedRuns
    .filter(
      (investigation) =>
        investigation.status === "queued" || investigation.status === "running"
    )
    .map(toInvestigationRow);
  const terminalRows = persistedRuns
    .filter(
      (investigation) =>
        investigation.status === "completed" ||
        investigation.status === "no_findings" ||
        investigation.status === "failed"
    )
    .map(toInvestigationRow);
  const groups = [
    { label: "Needs attention", rows: alarmRows },
    ...(inProgressRows.length
      ? [{ label: "In progress", rows: inProgressRows }]
      : []),
    { label: "Completed", rows: [...terminalRows, completedRow] }
  ];

  return (
    <div className="flex flex-col gap-3">
      <InvestigationList groups={groups} />
      {startState.status === "error" ? (
        <p
          className="px-6 text-sm text-destructive"
          role="alert"
          aria-live="polite"
        >
          {startState.message}
        </p>
      ) : null}
      {runList.error ? (
        <p
          className="px-6 text-sm text-destructive"
          role="alert"
          aria-live="polite"
        >
          {runList.error}
        </p>
      ) : null}
    </div>
  );
}

function toInvestigationRow(
  investigation: InvestigationSummary
): InvestigationListRow {
  const duration =
    investigation.startedAt === undefined
      ? null
      : durationBetween(
          investigation.startedAt,
          investigation.completedAt ?? new Date().toISOString()
        );

  return {
    id: investigation.id,
    displayId: displayInvestigationId(investigation.id),
    status:
      investigation.status === "queued" ? "running" : investigation.status,
    title: investigation.title,
    lanes: (
      <>
        <span className="text-xs text-muted-foreground">
          {investigation.scope.service}
        </span>
        {duration ? (
          <span className="font-mono text-xs text-muted-foreground">
            {duration}
          </span>
        ) : null}
      </>
    ),
    timestamp: formatListTimestamp(
      investigation.completedAt ?? investigation.createdAt
    ),
    to: `/i/${encodeURIComponent(investigation.id)}`
  };
}

function formatListTimestamp(value: string) {
  const date = new Date(value);
  const now = new Date();
  const isToday =
    date.getUTCFullYear() === now.getUTCFullYear() &&
    date.getUTCMonth() === now.getUTCMonth() &&
    date.getUTCDate() === now.getUTCDate();
  return isToday ? hourMinute.format(date) : monthDay.format(date);
}

function durationBetween(start: string, end: string) {
  const seconds = Math.round(
    (new Date(end).getTime() - new Date(start).getTime()) / 1000
  );
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function responseInvestigation(value: unknown): Investigation | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  if (!("investigation" in value)) return null;
  const investigation = value.investigation;
  if (
    typeof investigation !== "object" ||
    investigation === null ||
    Array.isArray(investigation) ||
    !("id" in investigation) ||
    typeof investigation.id !== "string"
  ) {
    return null;
  }
  return investigation as Investigation;
}

function responseInvestigations(value: unknown): InvestigationSummary[] | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("investigations" in value) ||
    !Array.isArray(value.investigations) ||
    !value.investigations.every(isInvestigationSummary)
  ) {
    return null;
  }
  return value.investigations;
}

function isInvestigationSummary(value: unknown): value is InvestigationSummary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<InvestigationSummary>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    isInvestigationStatus(candidate.status) &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.scope === "object" &&
    candidate.scope !== null &&
    typeof candidate.scope.service === "string"
  );
}

function isInvestigationStatus(value: unknown): value is InvestigationStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "completed" ||
    value === "no_findings" ||
    value === "failed"
  );
}

function responseError(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return "The investigation could not be started.";
}
