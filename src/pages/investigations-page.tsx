import {
  InvestigationList,
  type InvestigationListRow
} from "@/components/investigation-list";
import { completedCacheKeyRegression } from "@/fixtures/cache-key-regression";
import type { Investigation } from "@/investigation/contracts";
import type { StartInvestigationInput } from "@/investigation/runtime";
import { useRef, useState } from "react";
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
  const completed = completedCacheKeyRegression;
  const finding = completed.finding!;
  const isStarting = startState.status === "starting";

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
      displayId: "ALM-07",
      status: isStarting ? "running" : "attention",
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
    <div className="flex flex-col gap-3">
      <InvestigationList
        groups={[
          { label: "Needs attention", rows: alarmRows },
          { label: "Completed", rows: [completedRow] }
        ]}
      />
      {startState.status === "error" ? (
        <p
          className="px-6 text-sm text-destructive"
          role="alert"
          aria-live="polite"
        >
          {startState.message}
        </p>
      ) : null}
    </div>
  );
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
