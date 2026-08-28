import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  CheckmarkCircle02Icon,
  SquareTerminalIcon
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { completedCacheKeyRegression } from "../fixtures/cache-key-regression";
import type {
  FindingEvidence,
  InvestigationEvent
} from "../investigation/contracts";
import { cn } from "../lib/utils";
import { unresolvedInvestigation } from "./investigations-page";

const utcDateTime = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short"
});

const utcTime = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

export function InvestigationDetailPage() {
  const { id } = useParams();

  if (id === unresolvedInvestigation.id) {
    return <UnresolvedDetail />;
  }

  if (id === completedCacheKeyRegression.id) {
    return <CompletedDetail />;
  }

  return (
    <div className="not-found">
      <h1>Investigation not found</h1>
      <Link to="/">
        <HugeiconsIcon
          icon={ArrowLeft01Icon}
          size={15}
          strokeWidth={1.6}
          aria-hidden="true"
        />{" "}
        Back to investigations
      </Link>
    </div>
  );
}

function UnresolvedDetail() {
  return (
    <div className="detail-page">
      <section className="detail-main">
        <header className="detail-title">
          <span className="detail-state attention-state">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              size={15}
              strokeWidth={1.6}
              aria-hidden="true"
            />{" "}
            Needs attention
          </span>
          <h1>{unresolvedInvestigation.title}</h1>
          <p>{unresolvedInvestigation.description}</p>
        </header>
      </section>

      <PropertiesRail
        rows={[
          ["Status", unresolvedInvestigation.status],
          ["Severity", unresolvedInvestigation.severity],
          ["Detected", formatDate(unresolvedInvestigation.detectedAt)],
          ["Service", unresolvedInvestigation.service],
          ["Environment", unresolvedInvestigation.environment]
        ]}
      />
    </div>
  );
}

function CompletedDetail() {
  const investigation = completedCacheKeyRegression;
  const finding = investigation.finding!;
  const primaryEvidence = finding.evidence.slice(0, 5);
  const supportingEvidence = finding.evidence.slice(primaryEvidence.length);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(
    primaryEvidence[0]?.id ?? finding.evidence[0]?.id
  );
  const evidenceNumbers = new Map(
    finding.evidence.map((evidence, index) => [evidence.id, index + 1])
  );
  const selectedEvidence =
    finding.evidence.find((evidence) => evidence.id === selectedEvidenceId) ??
    finding.evidence[0];
  const selectedEvidenceNumber = selectedEvidence
    ? evidenceNumbers.get(selectedEvidence.id)
    : undefined;
  const impactFacts = [
    {
      label: "Since",
      value: formatTime(finding.impact.startedAt)
    },
    ...finding.impact.indicators
  ];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pt-5 pb-[68px] sm:px-7 sm:pt-6 sm:pb-[76px] xl:px-12 xl:pt-7 xl:pb-24">
      <article className="mx-auto w-full max-w-[1120px]">
        <section className="mt-4" aria-labelledby="finding-title">
          <div className="grid gap-8 @4xl/main:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.8fr)] @4xl/main:items-start">
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-[7px] text-xs text-[#85858d] tabular-nums">
                <span className="inline-flex min-h-6 items-center gap-1 text-xs font-[570] text-[#28785f]">
                  <HugeiconsIcon
                    icon={CheckmarkCircle01Icon}
                    size={14}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />{" "}
                  Root cause confirmed
                </span>
                <span>
                  {Math.round(finding.confidence.score * 100)}% confidence
                </span>
                <span className="text-[#b7b7bd]" aria-hidden="true">
                  ·
                </span>
                <span>
                  {durationBetween(
                    investigation.startedAt!,
                    investigation.completedAt!
                  )}
                </span>
                <span className="text-[#b7b7bd]" aria-hidden="true">
                  ·
                </span>
                <span>{formatDate(investigation.completedAt!)}</span>
              </div>

              <h1
                className="max-w-[680px] text-3xl leading-[1.12] font-medium tracking-[-0.04em] text-balance text-[#202025] sm:text-4xl"
                id="finding-title"
              >
                {finding.headline}
              </h1>
              <p className="mt-4 max-w-[720px] text-sm leading-[1.62] text-[#515158]">
                {finding.summary}
              </p>
              <p className="mt-2.5 max-w-[720px] text-xs leading-[1.6] text-[#77777f]">
                <strong className="font-[570] text-[#56565d]">
                  Change identified:
                </strong>{" "}
                {finding.rootCause.change}
              </p>

              <div
                className="mt-8 grid grid-cols-2 gap-x-8 gap-y-6 @4xl/main:grid-cols-4"
                aria-label="Incident impact"
              >
                {impactFacts.map((fact) => (
                  <dl className="min-w-0" key={fact.label}>
                    <dt className="truncate font-mono text-xs text-[#86868e]">
                      {fact.label}
                    </dt>
                    <dd className="mt-1.5 text-xl leading-[1.2] font-[620] tracking-[-0.025em] text-[#2d2d33]">
                      {fact.value}
                      {"unit" in fact && fact.unit ? (
                        <small className="ml-[3px] text-xs font-medium tracking-normal text-[#74747c]">
                          {fact.unit}
                        </small>
                      ) : null}
                    </dd>
                  </dl>
                ))}
              </div>
            </div>

            <aside
              className="rounded-2xl bg-[#edf1ff] p-5 sm:p-6"
              aria-labelledby="recommendation-title"
            >
              <header>
                <SectionLabel className="text-[#6670b4]">
                  Recommended action
                </SectionLabel>
                <h2
                  className="text-lg font-[610] tracking-[-0.02em] text-[#292f63]"
                  id="recommendation-title"
                >
                  Restore cache-key normalization
                </h2>
              </header>
              <p className="mt-2 text-sm leading-[1.6] text-[#4f5688]">
                {finding.recommendation.immediate}
              </p>
              <div className="mt-5 grid gap-1.5 text-xs leading-[1.5] text-[#747aa0]">
                <strong className="font-mono font-medium text-[#575e8d]">
                  Recovery check
                </strong>
                <span>{finding.recommendation.verify}</span>
              </div>
            </aside>
          </div>
        </section>

        <section
          className="pt-14"
          aria-labelledby="evidence-title"
          id="evidence-workspace"
        >
          <div className="max-w-[650px]">
            <SectionLabel>Evidence</SectionLabel>
            <h2
              className="text-xl font-[610] tracking-[-0.025em] text-[#29292f]"
              id="evidence-title"
            >
              Why this conclusion holds
            </h2>
            <p className="mt-2 max-w-[610px] text-xs leading-[1.55] text-[#797981]">
              Five claims form the shortest supported path from symptom to
              cause. Open any receipt to inspect the underlying tool call.
            </p>
          </div>

          <div className="mt-6 overflow-hidden rounded-3xl border border-[#e8e8eb] bg-[#f7f7f8] @5xl/main:grid @5xl/main:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.35fr)]">
            <div className="p-3 sm:p-4" aria-label="Evidence claims">
              {primaryEvidence.map((evidence, index) => (
                <EvidenceSelector
                  evidence={evidence}
                  isSelected={evidence.id === selectedEvidence?.id}
                  number={index + 1}
                  onSelect={() => setSelectedEvidenceId(evidence.id)}
                  key={evidence.id}
                />
              ))}

              {supportingEvidence.length ? (
                <div className="mt-4 pt-2">
                  <span className="mb-2 block px-4 font-mono text-xs text-[#8a8a91]">
                    Supporting receipts
                  </span>
                  {supportingEvidence.map((evidence) => (
                    <EvidenceSelector
                      evidence={evidence}
                      isSelected={evidence.id === selectedEvidence?.id}
                      number={evidenceNumbers.get(evidence.id)!}
                      onSelect={() => setSelectedEvidenceId(evidence.id)}
                      compact
                      key={evidence.id}
                    />
                  ))}
                </div>
              ) : null}
            </div>

            <div
              className="border-t border-[#e8e8eb] bg-white p-5 sm:p-7 @5xl/main:min-h-[560px] @5xl/main:border-t-0 @5xl/main:border-l @5xl/main:p-9"
              id="evidence-panel"
            >
              {selectedEvidence && selectedEvidenceNumber ? (
                <EvidenceInspector
                  evidence={selectedEvidence}
                  event={findToolCompletion(
                    investigation.events,
                    selectedEvidence.source.callId
                  )}
                  number={selectedEvidenceNumber}
                />
              ) : null}
            </div>
          </div>
        </section>

        <section
          className="mt-14 overflow-hidden rounded-3xl border border-[#e8e8eb] bg-[#f7f7f8] @4xl/main:grid @4xl/main:grid-cols-2"
          aria-label="Investigation record"
        >
          <div className="p-5 sm:p-7 @4xl/main:p-8">
            <SectionLabel>Ruled out</SectionLabel>
            <h2
              className="text-lg font-[610] tracking-[-0.02em] text-[#29292f]"
              id="alternatives-title"
            >
              Plausible, but unsupported
            </h2>
            <div className="mt-5">
              {finding.alternativesRuledOut.map((alternative) => (
                <div
                  className="relative grid grid-cols-[22px_minmax(0,1fr)] gap-2 py-4 text-[#368467] after:absolute after:right-0 after:bottom-0 after:left-[30px] after:h-px after:bg-[#e8e8eb] last:after:hidden"
                  key={alternative.hypothesis}
                >
                  <HugeiconsIcon
                    className="mt-px"
                    icon={CheckmarkCircle02Icon}
                    size={16}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                  <span>
                    <strong className="text-sm font-medium text-[#404047]">
                      {alternative.hypothesis}
                    </strong>
                    <p className="mt-1 max-w-[650px] text-xs leading-[1.55] text-[#73737b]">
                      {alternative.reason}
                    </p>
                    <span className="mt-2 flex gap-1">
                      {alternative.evidenceIds.map((evidenceId) => {
                        const evidence = finding.evidence.find(
                          (candidate) => candidate.id === evidenceId
                        );
                        const number = evidenceNumbers.get(evidenceId);

                        return evidence && number ? (
                          <a
                            href="#evidence-workspace"
                            key={evidence.id}
                            aria-label={`View evidence ${number}: ${evidence.title}`}
                            className="inline-flex min-h-7 min-w-7 items-center justify-center font-mono text-xs text-[#5b62b4] hover:underline"
                            onClick={() => setSelectedEvidenceId(evidence.id)}
                          >
                            [{number}]
                          </a>
                        ) : null;
                      })}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t border-[#e8e8eb] p-5 sm:p-7 @4xl/main:border-t-0 @4xl/main:border-l @4xl/main:p-8">
            <SectionLabel>Investigation record</SectionLabel>
            <details className="group">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-xl px-2 text-sm text-[#404047] hover:bg-black/[0.035] [&::-webkit-details-marker]:hidden">
                <span className="flex items-center gap-2 font-medium">
                  <HugeiconsIcon
                    icon={SquareTerminalIcon}
                    size={16}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                  Full investigation path
                </span>
                <span className="font-mono text-xs text-[#85858d]">
                  {investigation.events.length} events
                </span>
              </summary>
              <ol className="m-0 mt-2 max-h-[360px] list-none overflow-y-auto px-2 pb-2">
                {investigation.events.map((event) => (
                  <li
                    className="grid grid-cols-[72px_1fr] gap-2.5 border-b border-[#e8e8eb] py-2 text-xs leading-[1.45] text-[#65656c] last:border-0"
                    key={event.id}
                  >
                    <time
                      className="font-mono text-xs text-[#96969c]"
                      dateTime={event.at}
                    >
                      {utcTime.format(new Date(event.at))}
                    </time>
                    <span>{eventLabel(event)}</span>
                  </li>
                ))}
              </ol>
            </details>
          </div>
        </section>
      </article>
    </div>
  );
}

function SectionLabel({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "mb-[7px] block font-mono text-xs font-medium tracking-[-0.01em] text-[#85858c]",
        className
      )}
    >
      {children}
    </span>
  );
}

function PropertiesRail({ rows }: { rows: Array<[string, string]> }) {
  return (
    <aside className="properties-rail" aria-label="Investigation properties">
      <h2>Properties</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

function EvidenceSelector({
  evidence,
  isSelected,
  number,
  onSelect,
  compact = false
}: {
  evidence: FindingEvidence;
  isSelected: boolean;
  number: number;
  onSelect: () => void;
  compact?: boolean;
}) {
  return (
    <button
      className={cn(
        "grid min-h-11 w-full grid-cols-[36px_minmax(0,1fr)_16px] items-start gap-2 rounded-xl px-3 text-left transition-colors duration-150 motion-reduce:transition-none",
        compact ? "py-3" : "py-4",
        isSelected
          ? "bg-white shadow-[0_1px_2px_rgb(0_0_0_/_4%),0_0_0_1px_rgb(0_0_0_/_4%)]"
          : "hover:bg-black/[0.035]"
      )}
      aria-controls="evidence-panel"
      aria-pressed={isSelected}
      onClick={onSelect}
      type="button"
    >
      <span
        className={cn(
          "font-mono text-xs font-medium tabular-nums",
          isSelected ? "text-[#5661b3]" : "text-[#92929a]"
        )}
        aria-hidden="true"
      >
        [{number}]
      </span>
      <span className="min-w-0">
        <strong className="block text-sm leading-[1.35] font-medium text-[#323238]">
          {evidence.title}
        </strong>
        {!compact ? (
          <small className="mt-1 block text-xs leading-[1.5] text-[#73737b]">
            {evidence.claim}
          </small>
        ) : null}
      </span>
      <HugeiconsIcon
        className={cn(
          "mt-px transition-transform duration-150 motion-reduce:transition-none",
          isSelected ? "translate-x-0.5 text-[#5962af]" : "text-[#aaaab0]"
        )}
        icon={ArrowRight01Icon}
        size={14}
        strokeWidth={1.6}
        aria-hidden="true"
      />
    </button>
  );
}

function EvidenceInspector({
  evidence,
  event,
  number
}: {
  evidence: FindingEvidence;
  event?: Extract<InvestigationEvent, { type: "tool.completed" }>;
  number: number;
}) {
  return (
    <div aria-live="polite">
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-[#85858d]">
        <span className="font-medium text-[#5962af]">Receipt [{number}]</span>
        <span aria-hidden="true">·</span>
        <span>{evidence.kind}</span>
      </div>

      <h3 className="mt-4 max-w-[620px] text-xl leading-[1.25] font-[610] tracking-[-0.025em] text-[#29292f]">
        {evidence.title}
      </h3>
      <p className="mt-2 max-w-[650px] text-sm leading-[1.6] text-[#62626a]">
        {evidence.claim}
      </p>

      <div className="mt-7 rounded-2xl bg-[#f7f7f8] p-5 sm:p-6">
        <div className="flex flex-wrap gap-x-7 gap-y-4">
          <span className="grid gap-1">
            <small className="font-mono text-xs text-[#8c8c94]">Tool</small>
            <code className="text-xs font-medium text-[#45454c]">
              {evidence.source.tool}
            </code>
          </span>
          {event?.rowCount !== undefined ? (
            <span className="grid gap-1">
              <small className="font-mono text-xs text-[#8c8c94]">Rows</small>
              <strong className="text-xs font-medium text-[#45454c]">
                {event.rowCount.toLocaleString()}
              </strong>
            </span>
          ) : null}
          {event ? (
            <span className="grid gap-1">
              <small className="font-mono text-xs text-[#8c8c94]">
                Duration
              </small>
              <strong className="text-xs font-medium text-[#45454c]">
                {formatMilliseconds(event.durationMs)}
              </strong>
            </span>
          ) : null}
          <span className="grid gap-1">
            <small className="font-mono text-xs text-[#8c8c94]">Call</small>
            <code className="text-xs font-medium text-[#45454c]">
              {evidence.source.callId}
            </code>
          </span>
        </div>

        {event ? (
          <p className="mt-5 max-w-[620px] text-xs leading-[1.55] text-[#65656d]">
            {event.summary}
          </p>
        ) : null}

        <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-x-5 gap-y-4">
          {evidence.values.map((value) => (
            <span className="grid gap-1" key={value.label}>
              <small className="font-mono text-xs text-[#8c8c94]">
                {value.label}
              </small>
              <strong className="text-sm font-medium text-[#35353b]">
                {formatEvidenceValue(value)}
              </strong>
            </span>
          ))}
        </div>

        <details className="group/query mt-6">
          <summary className="min-h-11 cursor-pointer list-none py-3 font-mono text-xs font-medium text-[#62626a] [&::-webkit-details-marker]:hidden">
            Query input
            <span
              className="ml-[5px] text-[#9b9ba2] group-open/query:hidden"
              aria-hidden="true"
            >
              +
            </span>
            <span
              className="ml-[5px] hidden text-[#9b9ba2] group-open/query:inline"
              aria-hidden="true"
            >
              −
            </span>
          </summary>
          <pre className="overflow-x-auto rounded-xl bg-[#ededf0] p-4 text-xs leading-[1.55] whitespace-pre-wrap text-[#55555d]">
            {JSON.stringify(evidence.source.input, null, 2)}
          </pre>
        </details>

        {event?.result !== undefined ? (
          <details className="group/result mt-2">
            <summary className="min-h-11 cursor-pointer list-none py-3 font-mono text-xs font-medium text-[#62626a] [&::-webkit-details-marker]:hidden">
              Raw result
              <span
                className="ml-[5px] text-[#9b9ba2] group-open/result:hidden"
                aria-hidden="true"
              >
                +
              </span>
              <span
                className="ml-[5px] hidden text-[#9b9ba2] group-open/result:inline"
                aria-hidden="true"
              >
                −
              </span>
            </summary>
            <pre className="overflow-x-auto rounded-xl bg-[#ededf0] p-4 text-xs leading-[1.55] whitespace-pre-wrap text-[#55555d]">
              {JSON.stringify(event.result, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function findToolCompletion(events: InvestigationEvent[], callId: string) {
  return events.find(
    (event): event is Extract<InvestigationEvent, { type: "tool.completed" }> =>
      event.type === "tool.completed" && event.callId === callId
  );
}

function formatEvidenceValue(value: FindingEvidence["values"][number]) {
  return `${value.value}${value.unit ? ` ${value.unit}` : ""}`;
}

function formatMilliseconds(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds % 1000 ? 1 : 0)}s`;
}

function eventLabel(event: InvestigationEvent) {
  switch (event.type) {
    case "investigation.started":
      return `Started: ${event.question}`;
    case "plan.updated":
      return `Plan updated with ${event.steps.length} steps`;
    case "tool.started":
      return event.label;
    case "tool.progress":
      return event.message;
    case "tool.completed":
      return event.summary;
    case "tool.failed":
    case "model.failed":
      return event.message;
    case "observation.added":
      return `${event.title}: ${event.detail}`;
    case "hypothesis.updated":
      return `${event.statement} — ${event.status.replaceAll("_", " ")}`;
    case "investigation.completed":
    case "investigation.no_findings":
      return event.summary;
    case "investigation.failed":
      return event.message;
  }
}

function formatDate(value: string) {
  return utcDateTime.format(new Date(value));
}

function formatTime(value: string) {
  return `${utcTime.format(new Date(value)).replace(/:00$/, "")} UTC`;
}

function durationBetween(start: string, end: string) {
  const seconds = Math.round(
    (new Date(end).getTime() - new Date(start).getTime()) / 1000
  );
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
