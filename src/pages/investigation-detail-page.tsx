import {
  AlertCircleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  SquareTerminalIcon
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useAgent } from "agents/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { LiveInvestigation } from "../components/live-investigation";
import {
  InvestigationSequenceNav,
  investigationSequenceSections,
  type InvestigationSequenceSectionId
} from "../components/investigation-sequence-nav";
import { SignalStripChart } from "../components/signal-strip-chart";
import { Button } from "../components/ui/button";
import { MetadataSeparator } from "../components/ui/metadata-separator";
import { completedCacheKeyRegression } from "../fixtures/cache-key-regression";
import type {
  FindingEvidence,
  Investigation,
  InvestigationAgentState,
  InvestigationEvent
} from "../investigation/contracts";
import {
  canonicalizeFindingUnit,
  formatFindingValue
} from "../investigation/finding-editorial";
import { getInvestigationSignalData } from "../investigation/signal-data";
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

const COPY_STATUS_RESET_DELAY = 1_600;

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through for browsers that expose but block the Clipboard API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function InvestigationDetailPage() {
  const { id } = useParams();

  if (!id) return <InvestigationNotFound />;

  if (id === unresolvedInvestigation.id) {
    return <UnresolvedDetail />;
  }

  if (id === completedCacheKeyRegression.id) {
    return <CompletedDetail investigation={completedCacheKeyRegression} />;
  }

  return <PersistedInvestigationDetail id={id} />;
}

function PersistedInvestigationDetail({ id }: { id: string }) {
  const agent = useAgent<InvestigationAgentState>({
    agent: "InvestigationAgent",
    name: id
  });
  const [loadState, setLoadState] = useState<
    | { status: "loading" }
    | { status: "loaded"; investigation: Investigation }
    | { status: "not-found" }
    | { status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoadState({ status: "loading" });

    async function loadInvestigation() {
      try {
        const response = await fetch(
          `/api/investigations/${encodeURIComponent(id)}`,
          {
            headers: { Accept: "application/json" },
            signal: controller.signal
          }
        );
        if (response.status === 404) {
          setLoadState({ status: "not-found" });
          return;
        }
        if (!response.ok) {
          setLoadState({ status: "error" });
          return;
        }

        const value: unknown = await response.json();
        if (!isInvestigation(value) || value.id !== id) {
          setLoadState({ status: "error" });
          return;
        }
        setLoadState({ status: "loaded", investigation: value });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setLoadState({ status: "error" });
      }
    }

    void loadInvestigation();
    return () => controller.abort();
  }, [id]);

  const hydratedInvestigation =
    loadState.status === "loaded" ? loadState.investigation : null;
  const agentInvestigation =
    agent.state?.investigation?.id === id ? agent.state.investigation : null;
  const investigation = freshestInvestigation(
    hydratedInvestigation,
    agentInvestigation
  );

  if (investigation) {
    if (investigation.status === "completed" && investigation.finding) {
      return <CompletedDetail investigation={investigation} />;
    }
    return <LiveInvestigation investigation={investigation} />;
  }

  if (loadState.status === "not-found") return <InvestigationNotFound />;

  if (loadState.status === "error" || agent.connectionError) {
    return (
      <DetailStateMessage
        title="Investigation unavailable"
        detail="The persisted investigation could not be loaded."
      />
    );
  }

  return (
    <DetailStateMessage
      title="Loading investigation"
      detail="Reconnecting to persisted investigation state."
    />
  );
}

function InvestigationNotFound() {
  return (
    <div className="not-found">
      <h1 className="text-xl font-medium">Investigation not found</h1>
      <Link className="text-xs" to="/">
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

function DetailStateMessage({
  title,
  detail
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-2 px-5 py-12 sm:px-7 xl:px-12">
      <h1 className="text-xl font-medium text-foreground">{title}</h1>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function UnresolvedDetail() {
  return (
    <div className="detail-page">
      <section className="detail-main">
        <header className="detail-title">
          <span className="detail-state attention-state text-xs font-medium">
            <HugeiconsIcon
              icon={AlertCircleIcon}
              size={15}
              strokeWidth={1.6}
              aria-hidden="true"
            />{" "}
            Needs attention
          </span>
          <h1 className="text-2xl font-medium">
            {unresolvedInvestigation.title}
          </h1>
          <p className="text-sm">{unresolvedInvestigation.description}</p>
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

function CompletedDetail({ investigation }: { investigation: Investigation }) {
  const finding = investigation.finding!;
  const recommendationTitle = "Restore cache-key normalization";
  const signalData = getInvestigationSignalData(investigation);
  const impactStartedAt = signalData?.onsetAt ?? finding.impact.startedAt;
  const primaryEvidence = finding.evidence.slice(0, 5);
  const supportingEvidence = finding.evidence.slice(primaryEvidence.length);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(
    primaryEvidence[0]?.id ?? finding.evidence[0]?.id
  );
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  );
  const [activeSectionId, setActiveSectionId] =
    useState<InvestigationSequenceSectionId>("conclusion");
  const reduceMotion = useReducedMotion();
  const evidenceNumbers = new Map(
    finding.evidence.map((evidence, index) => [evidence.id, index + 1])
  );
  const selectedEvidence =
    finding.evidence.find((evidence) => evidence.id === selectedEvidenceId) ??
    finding.evidence[0];
  const selectedEvidenceNumber = selectedEvidence
    ? evidenceNumbers.get(selectedEvidence.id)
    : undefined;
  const impactScope =
    finding.impact.affectedRoutes.length === 1
      ? finding.impact.affectedRoutes[0]
      : undefined;

  useEffect(() => {
    if (copyStatus === "idle") return;

    const timeout = window.setTimeout(
      () => setCopyStatus("idle"),
      COPY_STATUS_RESET_DELAY
    );
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  useEffect(() => {
    const sections = investigationSequenceSections.flatMap(({ id }) => {
      const element = document.getElementById(id);
      return element ? [{ id, element }] : [];
    });
    if (!sections.length) return;

    let animationFrame = 0;
    const updateActiveSection = () => {
      animationFrame = 0;
      const activationLine = Math.min(window.innerHeight * 0.28, 184);
      const isAtPageEnd =
        window.scrollY + window.innerHeight >=
        document.documentElement.scrollHeight - 2;
      let nextSectionId = sections[0].id;

      for (const section of sections) {
        if (section.element.getBoundingClientRect().top <= activationLine) {
          nextSectionId = section.id;
        }
      }

      if (isAtPageEnd) {
        nextSectionId = sections[sections.length - 1].id;
      }

      setActiveSectionId((current) =>
        current === nextSectionId ? current : nextSectionId
      );
    };
    const scheduleUpdate = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(updateActiveSection);
    };

    updateActiveSection();
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);

    return () => {
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  function navigateToSection(sectionId: InvestigationSequenceSectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;

    setActiveSectionId(sectionId);
    section.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    });

    const url = new URL(window.location.href);
    url.hash = sectionId;
    window.history.replaceState(window.history.state, "", url);
  }

  async function copyRecommendation() {
    const recommendation = [
      recommendationTitle,
      finding.recommendation.immediate,
      "",
      "Verify recovery",
      finding.recommendation.verify
    ].join("\n");

    const copied = await copyTextToClipboard(recommendation);
    setCopyStatus(copied ? "copied" : "error");
  }

  const showCopyStatus = copyStatus !== "idle";
  const copyStatusVariants = {
    initial: (showStatus: boolean) =>
      showStatus && !reduceMotion
        ? { opacity: 0, scale: 0.94, filter: "blur(4px)" }
        : { opacity: 0, scale: 1, filter: "blur(0px)" },
    animate: (showStatus: boolean) => ({
      opacity: 1,
      scale: 1,
      filter: "blur(0px)",
      transition: reduceMotion
        ? { duration: 0 }
        : {
            duration: showStatus ? 0.18 : 0.12,
            ease: "easeOut" as const
          }
    }),
    exit: (showStatus: boolean) =>
      showStatus && !reduceMotion
        ? {
            opacity: 0,
            scale: 1.04,
            filter: "blur(4px)",
            transition: { duration: 0.14, ease: "easeOut" as const }
          }
        : {
            opacity: 0,
            scale: 1,
            filter: "blur(0px)",
            transition: reduceMotion
              ? { duration: 0 }
              : { duration: 0.1, ease: "easeOut" as const }
          }
  };

  return (
    <div className="grid w-full grid-cols-[0_minmax(0,1fr)] @2xl/main:grid-cols-[32px_minmax(0,1fr)]">
      <InvestigationSequenceNav
        activeSectionId={activeSectionId}
        onSelect={navigateToSection}
      />

      <div className="mx-auto w-full max-w-[1440px] min-w-0 px-5 pt-5 pb-[68px] sm:px-7 sm:pt-6 sm:pb-[76px] xl:px-12 xl:pt-7 xl:pb-24">
        <article className="mx-auto flex w-full max-w-[1120px] min-w-0 flex-col gap-14 pt-4">
          <section
            className="flex scroll-mt-6 flex-col gap-14"
            aria-labelledby="finding-title"
            id="conclusion"
          >
            <div className="grid gap-8 @4xl/main:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.8fr)] @4xl/main:items-stretch">
              <div className="flex flex-col gap-8">
                <div className="flex flex-col gap-6">
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-[7px] text-xs text-[#85858d] tabular-nums">
                      <span className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-[var(--accent-emerald)]">
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
                      <span className="inline-flex items-center gap-2">
                        <MetadataSeparator />
                        <span>
                          {durationBetween(
                            investigation.startedAt!,
                            investigation.completedAt!
                          )}
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-2">
                        <MetadataSeparator />
                        <span>{formatDate(investigation.completedAt!)}</span>
                      </span>
                    </div>

                    <h1
                      className="max-w-[680px] text-3xl leading-[1.12] font-medium tracking-[-0.04em] text-balance text-[#202025] sm:text-4xl"
                      id="finding-title"
                    >
                      {finding.headline}
                    </h1>
                  </div>

                  <div
                    className="flex max-w-[720px] scroll-mt-6 flex-col gap-2"
                    id="triggering-change"
                  >
                    <SectionLabel>Triggering change</SectionLabel>
                    <p className="text-base leading-[1.5] font-medium tracking-[-0.01em] text-[#35353b]">
                      {finding.rootCause.change}
                    </p>
                    <p className="text-sm leading-[1.6] text-[#686870]">
                      {finding.rootCause.summary}
                    </p>
                  </div>
                </div>

                <div
                  className="flex scroll-mt-6 flex-col gap-4"
                  aria-label="Incident impact"
                  id="impact-signals"
                >
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[#74747c]">
                    <span className="font-medium text-[#2d2d33]">Impact</span>
                    {impactScope ? (
                      <span className="inline-flex min-w-0 items-center">
                        <span className="font-mono text-[#66666e] [overflow-wrap:anywhere]">
                          {keepHttpMethodWithRoute(impactScope)}
                        </span>
                      </span>
                    ) : null}
                    <span className="inline-flex items-center gap-2">
                      <MetadataSeparator />
                      <span>since {formatTime(impactStartedAt)}</span>
                    </span>
                  </div>

                  <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-3">
                    {finding.impact.indicators.map((indicator) => (
                      <dl
                        className="flex min-w-0 flex-col gap-2"
                        key={indicator.label}
                      >
                        <dt className="order-2 text-sm leading-[1.35] text-[#2d2d33] [overflow-wrap:anywhere]">
                          {scopedMetricLabel(indicator.label, impactScope)}
                        </dt>
                        <dd className="order-1 flex items-baseline gap-[3px] text-2xl leading-[1.15] font-semibold tracking-[-0.03em] text-[#2d2d33]">
                          {formatFindingValue(indicator.value, indicator.unit)}
                          {indicator.unit ? (
                            <small className="text-xs font-medium tracking-normal text-[#74747c]">
                              {canonicalizeFindingUnit(indicator.unit)}
                            </small>
                          ) : null}
                        </dd>
                      </dl>
                    ))}
                  </div>
                </div>
              </div>

              <aside
                className="flex flex-col justify-between gap-8 rounded-2xl bg-[#f7f7f8] p-5 sm:p-6"
                aria-labelledby="recommendation-title"
              >
                <div className="flex flex-col gap-2">
                  <header className="flex flex-col gap-[7px]">
                    <SectionLabel>Recommended action</SectionLabel>
                    <h2
                      className="text-lg font-medium tracking-[-0.02em] text-[#29292f]"
                      id="recommendation-title"
                    >
                      {recommendationTitle}
                    </h2>
                  </header>
                  <p className="text-sm leading-[1.6] text-[#5f5f67]">
                    {finding.recommendation.immediate}
                  </p>
                </div>
                <div className="flex flex-col gap-5">
                  <div className="grid gap-1.5 text-sm leading-[1.55] text-[#707078]">
                    <strong className="font-medium text-[#4d4d54]">
                      Verify recovery
                    </strong>
                    <span>{finding.recommendation.verify}</span>
                  </div>
                  <footer className="flex justify-end">
                    <Button
                      className="w-48 overflow-hidden px-3"
                      variant="outline"
                      onClick={() => void copyRecommendation()}
                      type="button"
                    >
                      <span className="sr-only" aria-live="polite">
                        {copyStatus === "copied"
                          ? "Recommendation copied"
                          : copyStatus === "error"
                            ? "Recommendation could not be copied"
                            : "Copy recommendation"}
                      </span>
                      <AnimatePresence
                        initial={false}
                        mode="wait"
                        custom={showCopyStatus}
                      >
                        <motion.span
                          className="inline-flex items-center justify-center gap-1.5"
                          key={copyStatus}
                          aria-hidden="true"
                          custom={showCopyStatus}
                          variants={copyStatusVariants}
                          initial="initial"
                          animate="animate"
                          exit="exit"
                        >
                          <HugeiconsIcon
                            data-icon="inline-start"
                            icon={
                              copyStatus === "idle"
                                ? Copy01Icon
                                : copyStatus === "error"
                                  ? AlertCircleIcon
                                  : CheckmarkCircle02Icon
                            }
                            size={16}
                            strokeWidth={1.6}
                          />
                          {copyStatus === "idle"
                            ? "Copy recommendation"
                            : copyStatus === "error"
                              ? "Copy failed"
                              : "Copied"}
                        </motion.span>
                      </AnimatePresence>
                    </Button>
                  </footer>
                </div>
              </aside>
            </div>

            {signalData ? (
              <SignalStripChart
                series={signalData.series}
                from={investigation.scope.window.from}
                to={investigation.scope.window.to}
                scopeLabel={signalData.scopeLabel}
                onsetAt={impactStartedAt}
                markers={signalData.markers}
                bands={signalData.bands}
              />
            ) : null}
          </section>

          <section
            className="flex scroll-mt-6 flex-col gap-6"
            aria-labelledby="evidence-title"
            id="evidence-workspace"
          >
            <div className="flex max-w-[650px] flex-col gap-2">
              <SectionLabel>Evidence</SectionLabel>
              <h2
                className="text-xl font-medium tracking-[-0.025em] text-[#29292f]"
                id="evidence-title"
              >
                Why this conclusion holds
              </h2>
              <p className="max-w-[610px] text-sm leading-[1.6] text-[#707078]">
                Five claims form the shortest supported path from symptom to
                cause. Open any receipt to inspect the underlying tool call.
              </p>
            </div>

            <div className="overflow-hidden rounded-3xl border border-border bg-muted/50 @5xl/main:grid @5xl/main:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.35fr)]">
              <div
                className="flex flex-col gap-4 p-3 sm:p-4"
                aria-label="Evidence claims"
              >
                <div>
                  {primaryEvidence.map((evidence, index) => (
                    <EvidenceSelector
                      evidence={evidence}
                      isSelected={evidence.id === selectedEvidence?.id}
                      number={index + 1}
                      onSelect={() => setSelectedEvidenceId(evidence.id)}
                      key={evidence.id}
                    />
                  ))}
                </div>

                {supportingEvidence.length ? (
                  <div className="flex flex-col gap-2 pt-2">
                    <span className="block px-4 text-xs font-medium text-muted-foreground">
                      Supporting receipts
                    </span>
                    <div>
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
                  </div>
                ) : null}
              </div>

              <div
                className="border-t border-border bg-background p-5 sm:p-7 @5xl/main:min-h-[560px] @5xl/main:border-t-0 @5xl/main:border-l @5xl/main:p-9"
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
                    sharedScope={impactScope}
                  />
                ) : null}
              </div>
            </div>
          </section>

          <section
            className="scroll-mt-6 overflow-hidden rounded-3xl border border-[#e8e8eb] bg-[#f7f7f8] @4xl/main:grid @4xl/main:grid-cols-2"
            aria-label="Investigation record"
            id="ruled-out-record"
          >
            <div className="flex flex-col gap-5 p-5 sm:p-7 @4xl/main:p-8">
              <header className="flex flex-col gap-[7px]">
                <SectionLabel>Ruled out</SectionLabel>
                <h2
                  className="text-lg font-medium tracking-[-0.02em] text-[#29292f]"
                  id="alternatives-title"
                >
                  Plausible, but unsupported
                </h2>
              </header>
              <div>
                {finding.alternativesRuledOut.map((alternative) => (
                  <div
                    className="grid grid-cols-[22px_minmax(0,1fr)] gap-2 py-4 text-[var(--accent-emerald)]"
                    key={alternative.hypothesis}
                  >
                    <HugeiconsIcon
                      className="translate-y-px"
                      icon={CheckmarkCircle02Icon}
                      size={16}
                      strokeWidth={1.6}
                      aria-hidden="true"
                    />
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col gap-1">
                        <strong className="text-sm font-medium text-[#404047]">
                          {alternative.hypothesis}
                        </strong>
                        <p className="max-w-[650px] text-sm leading-[1.55] text-[#6b6b73]">
                          {alternative.reason}
                        </p>
                      </div>
                      <span className="flex gap-1">
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
                              className="inline-flex min-h-7 min-w-7 items-center justify-center font-mono text-xs text-[var(--accent-cobalt-ink)] hover:underline"
                              onClick={() => setSelectedEvidenceId(evidence.id)}
                            >
                              [{number}]
                            </a>
                          ) : null;
                        })}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-[#e8e8eb] p-5 sm:p-7 @4xl/main:border-t-0 @4xl/main:border-l @4xl/main:p-8">
              <SectionLabel>Investigation record</SectionLabel>
              <details className="group flex flex-col gap-2">
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
                <ol className="max-h-[360px] list-none overflow-y-auto px-2 pb-2">
                  {investigation.events.map((event) => (
                    <li
                      className="grid grid-cols-[72px_1fr] gap-2.5 py-2 text-xs leading-[1.45] text-[#65656c]"
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
        "block text-sm font-medium tracking-[-0.01em] text-[#2d2d33]",
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
      <h2 className="text-xs font-medium">Properties</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs">{label}</dt>
            <dd className="text-xs">{value}</dd>
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
          ? "bg-background shadow-[0_1px_2px_rgb(0_0_0_/_4%),0_0_0_1px_rgb(0_0_0_/_4%)]"
          : "hover:bg-muted"
      )}
      aria-controls="evidence-panel"
      aria-pressed={isSelected}
      onClick={onSelect}
      type="button"
    >
      <span
        className={cn(
          "font-mono text-xs font-medium tabular-nums",
          isSelected
            ? "text-[var(--accent-cobalt-ink)]"
            : "text-muted-foreground"
        )}
        aria-hidden="true"
      >
        [{number}]
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <strong className="block text-sm leading-[1.35] font-medium text-foreground">
          {evidence.title}
        </strong>
        {!compact ? (
          <small className="block text-sm leading-[1.5] text-muted-foreground">
            {evidence.claim}
          </small>
        ) : null}
      </span>
      <HugeiconsIcon
        className={cn(
          "translate-y-px transition-transform duration-150 motion-reduce:transition-none",
          isSelected
            ? "translate-x-0.5 text-[var(--accent-cobalt-ink)]"
            : "text-muted-foreground"
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
  number,
  sharedScope
}: {
  evidence: FindingEvidence;
  event?: Extract<InvestigationEvent, { type: "tool.completed" }>;
  number: number;
  sharedScope?: string;
}) {
  const valueScope =
    sharedScope &&
    evidence.values.length > 0 &&
    evidence.values.every((value) => value.label.startsWith(`${sharedScope} `))
      ? sharedScope
      : undefined;

  return (
    <div className="flex flex-col gap-7" aria-live="polite">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono text-xs font-medium text-[var(--accent-cobalt-ink)]">
            Receipt [{number}]
          </span>
          <span className="inline-flex items-center gap-2">
            <MetadataSeparator />
            <span>{evidence.kind}</span>
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="max-w-[620px] text-xl leading-[1.25] font-medium tracking-[-0.025em] text-foreground">
            {evidence.title}
          </h3>
          <p className="max-w-[650px] text-sm leading-[1.6] text-muted-foreground">
            {evidence.claim}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-6 rounded-2xl bg-muted/50 p-5 sm:p-6">
        <div className="flex flex-col gap-5">
          <div className="flex flex-wrap gap-x-7 gap-y-4">
            <span className="grid gap-1">
              <small className="text-xs text-muted-foreground">Tool</small>
              <code className="text-xs font-medium text-foreground">
                {evidence.source.tool}
              </code>
            </span>
            {event?.rowCount !== undefined ? (
              <span className="grid gap-1">
                <small className="text-xs text-muted-foreground">Rows</small>
                <strong className="text-xs font-medium text-foreground">
                  {event.rowCount.toLocaleString()}
                </strong>
              </span>
            ) : null}
            {event ? (
              <span className="grid gap-1">
                <small className="text-xs text-muted-foreground">
                  Duration
                </small>
                <strong className="text-xs font-medium text-foreground">
                  {formatMilliseconds(event.durationMs)}
                </strong>
              </span>
            ) : null}
            <span className="grid gap-1">
              <small className="text-xs text-muted-foreground">Call</small>
              <code className="text-xs font-medium text-foreground">
                {evidence.source.callId}
              </code>
            </span>
          </div>

          {event ? (
            <p className="max-w-[620px] text-xs leading-[1.55] text-muted-foreground">
              {event.summary}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="font-medium text-foreground">Measurements</span>
            {valueScope ? (
              <span className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {keepHttpMethodWithRoute(valueScope)}
              </span>
            ) : null}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(112px,1fr))] gap-x-5 gap-y-4">
            {evidence.values.map((value) => (
              <span className="grid gap-1" key={value.label}>
                <small className="text-xs text-muted-foreground">
                  {scopedMetricLabel(value.label, valueScope)}
                </small>
                <strong className="text-sm font-medium text-foreground">
                  {formatEvidenceValue(value)}
                </strong>
              </span>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <details className="group/query">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-[5px] py-3 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span>Query input</span>
              <span className="group-open/query:hidden" aria-hidden="true">
                +
              </span>
              <span
                className="hidden group-open/query:inline"
                aria-hidden="true"
              >
                −
              </span>
            </summary>
            <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-xs leading-[1.55] whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(evidence.source.input, null, 2)}
            </pre>
          </details>

          {event?.result !== undefined ? (
            <details className="group/result">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-[5px] py-3 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                <span>Raw result</span>
                <span className="group-open/result:hidden" aria-hidden="true">
                  +
                </span>
                <span
                  className="hidden group-open/result:inline"
                  aria-hidden="true"
                >
                  −
                </span>
              </summary>
              <pre className="overflow-x-auto rounded-xl bg-muted p-4 text-xs leading-[1.55] whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(event.result, null, 2)}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function scopedMetricLabel(label: string, sharedScope?: string) {
  const prefix = sharedScope ? `${sharedScope} ` : "";
  const metric =
    prefix && label.startsWith(prefix) ? label.slice(prefix.length) : label;

  return metric ? `${metric[0].toUpperCase()}${metric.slice(1)}` : label;
}

function keepHttpMethodWithRoute(scope: string) {
  return scope.replace(/^([A-Z]+)\s+(?=\/)/, "$1\u00a0");
}

function findToolCompletion(events: InvestigationEvent[], callId: string) {
  return events.find(
    (event): event is Extract<InvestigationEvent, { type: "tool.completed" }> =>
      event.type === "tool.completed" && event.callId === callId
  );
}

function formatEvidenceValue(value: FindingEvidence["values"][number]) {
  const unit = value.unit ? canonicalizeFindingUnit(value.unit) : undefined;
  return `${formatFindingValue(value.value, unit)}${unit ? ` ${unit}` : ""}`;
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

function freshestInvestigation(
  hydrated: Investigation | null,
  agent: Investigation | null
) {
  if (!hydrated) return agent;
  if (!agent) return hydrated;

  const hydratedSequence = hydrated.events.at(-1)?.sequence ?? 0;
  const agentSequence = agent.events.at(-1)?.sequence ?? 0;
  if (hydratedSequence !== agentSequence) {
    return hydratedSequence > agentSequence ? hydrated : agent;
  }
  if (Boolean(hydrated.finding) !== Boolean(agent.finding)) {
    return hydrated.finding ? hydrated : agent;
  }

  const statusRank: Record<Investigation["status"], number> = {
    queued: 0,
    running: 1,
    completed: 2,
    no_findings: 2,
    failed: 2
  };
  return statusRank[hydrated.status] > statusRank[agent.status]
    ? hydrated
    : agent;
}

function isInvestigation(value: unknown): value is Investigation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<Investigation>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.scope === "object" &&
    candidate.scope !== null &&
    Array.isArray(candidate.plan) &&
    Array.isArray(candidate.events)
  );
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
