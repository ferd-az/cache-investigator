import {
  AlertCircleIcon,
  ArrowDown01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  Loading03Icon
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  Investigation,
  InvestigationEvent,
  InvestigationPlanStep
} from "../investigation/contracts";
import { cn } from "../lib/utils";
import { MetadataSeparator } from "./ui/metadata-separator";

type ToolStartedEvent = Extract<InvestigationEvent, { type: "tool.started" }>;
type ToolProgressEvent = Extract<InvestigationEvent, { type: "tool.progress" }>;
type ToolCompletedEvent = Extract<
  InvestigationEvent,
  { type: "tool.completed" }
>;
type ToolFailedEvent = Extract<InvestigationEvent, { type: "tool.failed" }>;
type ModelFailedEvent = Extract<InvestigationEvent, { type: "model.failed" }>;
type EvidenceEvent = Extract<
  InvestigationEvent,
  { type: "observation.added" | "hypothesis.updated" }
>;

type ToolCallLifecycle = {
  callId: string;
  started: ToolStartedEvent;
  progress: ToolProgressEvent[];
  failures: ToolFailedEvent[];
  completed?: ToolCompletedEvent;
  lastSequence: number;
};

const timeFormatter = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

export function LiveInvestigation({
  investigation
}: {
  investigation: Investigation;
}) {
  const reduceMotion = useReducedMotion();
  const calls = useMemo(
    () => groupToolCalls(investigation.events),
    [investigation.events]
  );
  const latestCall = calls.at(-1);
  const activeCall =
    investigation.status === "running" &&
    latestCall &&
    !latestCall.completed &&
    latestCall.failures.at(-1)?.retryable !== false
      ? latestCall
      : undefined;
  const settledCalls = activeCall
    ? calls.filter((call) => call.callId !== activeCall.callId)
    : calls;
  const latestPlan = useMemo(
    () => findLatestPlan(investigation),
    [investigation]
  );
  const evidenceEvents = useMemo(
    () =>
      investigation.events.filter(
        (event): event is EvidenceEvent =>
          event.type === "observation.added" ||
          event.type === "hypothesis.updated"
      ),
    [investigation.events]
  );
  const terminalEvent = useMemo(
    () => findTerminalEvent(investigation.events),
    [investigation.events]
  );
  const isActive =
    investigation.status === "queued" || investigation.status === "running";
  const now = useLiveClock(isActive);
  const latestEvent = investigation.events.at(-1);
  const modelFailures = useMemo(
    () =>
      investigation.events.filter(
        (event): event is ModelFailedEvent => event.type === "model.failed"
      ),
    [investigation.events]
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] px-5 pt-5 pb-20 sm:px-7 sm:pt-6 xl:px-12 xl:pt-7 xl:pb-24">
      <article className="mx-auto flex w-full max-w-[1120px] flex-col gap-12 pt-4">
        <header className="flex max-w-3xl flex-col gap-5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-muted-foreground">
            <InvestigationStatus status={investigation.status} />
            <MetadataValue>
              <code>{investigation.scope.service}</code>
            </MetadataValue>
            <MetadataValue>
              <code>{investigation.scope.environment}</code>
            </MetadataValue>
            <MetadataValue>
              <span className="font-mono tabular-nums">
                {formatWindow(investigation.scope.window)}
              </span>
            </MetadataValue>
          </div>

          <div className="flex flex-col gap-3">
            <h1 className="text-3xl font-medium text-foreground sm:text-4xl">
              {investigation.title}
            </h1>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {investigation.scope.question}
            </p>
          </div>
        </header>

        <div className="grid items-start gap-12 @4xl/main:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col gap-12">
            <section
              className="flex flex-col gap-5"
              aria-labelledby="current-step-title"
            >
              <h2
                className="text-xl font-medium text-foreground"
                id="current-step-title"
              >
                {isActive ? "Current step" : "Outcome"}
              </h2>

              <div className="flex min-h-[168px] flex-col justify-center rounded-2xl bg-muted/50 p-5 sm:p-6">
                <AnimatePresence initial={false} mode="wait">
                  {activeCall ? (
                    <motion.div
                      key={activeCall.callId}
                      initial={
                        reduceMotion
                          ? false
                          : { opacity: 0, transform: "translateY(4px)" }
                      }
                      animate={{ opacity: 1, transform: "translateY(0px)" }}
                      exit={
                        reduceMotion
                          ? { opacity: 1 }
                          : { opacity: 0, transform: "translateY(-4px)" }
                      }
                      transition={{
                        duration: reduceMotion ? 0 : 0.16,
                        ease: "easeOut"
                      }}
                    >
                      <ActiveToolCall call={activeCall} now={now} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={`${investigation.status}:${terminalEvent?.id ?? "plan"}`}
                      initial={
                        reduceMotion
                          ? false
                          : { opacity: 0, transform: "translateY(4px)" }
                      }
                      animate={{ opacity: 1, transform: "translateY(0px)" }}
                      transition={{
                        duration: reduceMotion ? 0 : 0.16,
                        ease: "easeOut"
                      }}
                    >
                      <CurrentInvestigationState
                        investigation={investigation}
                        latestEvent={latestEvent}
                        now={now}
                        plan={latestPlan}
                        settledCallCount={settledCalls.length}
                        terminalEvent={terminalEvent}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </section>

            <section
              className="flex flex-col gap-5"
              aria-labelledby="completed-work-title"
            >
              <div className="flex items-baseline justify-between gap-4">
                <h2
                  className="text-xl font-medium text-foreground"
                  id="completed-work-title"
                >
                  Completed work
                </h2>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  {settledCalls.length}{" "}
                  {settledCalls.length === 1 ? "call" : "calls"}
                </span>
              </div>

              {settledCalls.length ? (
                <ol className="border-t border-border/70">
                  <AnimatePresence initial={false}>
                    {settledCalls.map((call) => (
                      <motion.li
                        key={call.callId}
                        initial={
                          reduceMotion
                            ? false
                            : { opacity: 0, transform: "translateY(4px)" }
                        }
                        animate={{ opacity: 1, transform: "translateY(0px)" }}
                        transition={{
                          duration: reduceMotion ? 0 : 0.16,
                          ease: "easeOut"
                        }}
                      >
                        <SettledToolCall
                          call={call}
                          evidenceEvents={evidenceEvents}
                        />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Completed tool calls will settle here.
                </p>
              )}
            </section>
          </div>

          <aside className="flex flex-col gap-10 @4xl/main:sticky @4xl/main:top-6">
            <PlanRail steps={latestPlan} />
            <ModelNoticesRail events={modelFailures} />
            <FindingsRail events={evidenceEvents} />
          </aside>
        </div>
      </article>
    </div>
  );
}

function InvestigationStatus({ status }: { status: Investigation["status"] }) {
  const config = {
    queued: {
      icon: CircleDashedIcon,
      label: "Queued",
      className: "text-muted-foreground"
    },
    running: {
      icon: Loading03Icon,
      label: "Investigating",
      className: "text-[var(--accent-cobalt-ink)]"
    },
    completed: {
      icon: CheckmarkCircle01Icon,
      label: "Completed",
      className: "text-[var(--accent-emerald)]"
    },
    no_findings: {
      icon: CircleDashedIcon,
      label: "No findings",
      className: "text-muted-foreground"
    },
    failed: {
      icon: CancelCircleIcon,
      label: "Failed",
      className: "text-destructive"
    }
  }[status];

  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1 text-xs font-medium",
        config.className
      )}
    >
      <HugeiconsIcon
        className={
          status === "running"
            ? "animate-spin motion-reduce:animate-none"
            : undefined
        }
        icon={config.icon}
        size={14}
        strokeWidth={1.6}
        aria-hidden="true"
      />
      {config.label}
    </span>
  );
}

function MetadataValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <MetadataSeparator />
      {children}
    </span>
  );
}

function ActiveToolCall({
  call,
  now
}: {
  call: ToolCallLifecycle;
  now: number;
}) {
  const reduceMotion = useReducedMotion();
  const progress = call.progress.at(-1);
  const failure = call.failures.at(-1);
  const scope = toolScope(call.started);
  const elapsedMs = Math.max(
    0,
    now - Date.parse(call.started.at),
    progress?.elapsedMs ?? 0
  );
  const lastEventAt =
    progress?.sequence && progress.sequence > (failure?.sequence ?? 0)
      ? progress.at
      : (failure?.at ?? call.started.at);

  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
      <HugeiconsIcon
        className="mt-0.5 animate-spin text-[var(--accent-cobalt-ink)] motion-reduce:animate-none"
        icon={Loading03Icon}
        size={17}
        strokeWidth={1.6}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-foreground">
            {displayToolLabel(call.started)}
          </h3>
          <CallMetadata
            tool={call.started.tool}
            scope={scope}
            elapsedMs={elapsedMs}
          />
        </div>

        <div
          className="flex min-h-10 flex-col gap-2"
          aria-live="polite"
          aria-atomic="true"
        >
          {failure ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-amber-700">
                Attempt {failure.attempt} failed · retrying
              </span>
              <p className="text-sm text-muted-foreground">{failure.message}</p>
            </div>
          ) : null}
          <AnimatePresence initial={false} mode="wait">
            {progress && (!failure || progress.sequence > failure.sequence) ? (
              <motion.p
                className="text-sm text-muted-foreground"
                key={progress.id}
                initial={
                  reduceMotion
                    ? false
                    : { opacity: 0, transform: "translateY(2px)" }
                }
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={
                  reduceMotion
                    ? { opacity: 1 }
                    : { opacity: 0, transform: "translateY(-2px)" }
                }
                transition={{
                  duration: reduceMotion ? 0 : 0.14,
                  ease: "easeOut"
                }}
              >
                {progress.message}
              </motion.p>
            ) : !failure ? (
              <motion.p
                className="text-sm text-muted-foreground"
                key="in-progress"
                initial={false}
                animate={{ opacity: 1 }}
              >
                Tool call in progress.
              </motion.p>
            ) : null}
          </AnimatePresence>
          <ActivityAge at={lastEventAt} now={now} />
        </div>
      </div>
    </div>
  );
}

function CurrentInvestigationState({
  investigation,
  latestEvent,
  now,
  plan,
  settledCallCount,
  terminalEvent
}: {
  investigation: Investigation;
  latestEvent?: InvestigationEvent;
  now: number;
  plan: InvestigationPlanStep[];
  settledCallCount: number;
  terminalEvent?: InvestigationEvent;
}) {
  const activeStep =
    plan.find((step) => step.status === "active") ??
    plan.find((step) => step.status === "pending");
  const activeStepIndex = activeStep
    ? plan.findIndex((step) => step.id === activeStep.id)
    : -1;
  const isFinalStep =
    activeStepIndex >= 0 && activeStepIndex === plan.length - 1;
  const latestModelFailure =
    latestEvent?.type === "model.failed" ? latestEvent : undefined;
  const lastUpdateAt =
    latestEvent?.at ?? investigation.startedAt ?? investigation.createdAt;

  if (terminalEvent?.type === "investigation.failed") {
    return (
      <StateMessage
        icon={CancelCircleIcon}
        iconClassName="text-destructive"
        eyebrow="Investigation failed"
        title={terminalEvent.message}
        activityAt={terminalEvent.at}
        now={now}
      />
    );
  }

  if (terminalEvent?.type === "investigation.no_findings") {
    return (
      <StateMessage
        icon={CircleDashedIcon}
        iconClassName="text-muted-foreground"
        eyebrow="No findings"
        title={terminalEvent.summary}
        activityAt={terminalEvent.at}
        now={now}
      />
    );
  }

  if (terminalEvent?.type === "investigation.completed") {
    return (
      <StateMessage
        icon={CheckmarkCircle01Icon}
        iconClassName="text-[var(--accent-emerald)]"
        eyebrow="Completed"
        title={terminalEvent.summary}
        activityAt={terminalEvent.at}
        now={now}
      />
    );
  }

  if (investigation.status === "queued") {
    return (
      <StateMessage
        icon={CircleDashedIcon}
        iconClassName="text-muted-foreground"
        eyebrow="Queued"
        title={investigation.scope.question}
        detail="Waiting for the durable investigation worker to start."
        activityAt={lastUpdateAt}
        live
        now={now}
      />
    );
  }

  if (latestModelFailure) {
    return (
      <StateMessage
        icon={Loading03Icon}
        iconClassName="animate-spin text-amber-700 motion-reduce:animate-none"
        eyebrow={
          latestModelFailure.retryable
            ? `Retrying model request · attempt ${latestModelFailure.attempt + 1}`
            : `Correcting rejected model output · attempt ${
                latestModelFailure.attempt + 1
              }`
        }
        title={latestModelFailure.message}
        detail={activeStep?.title}
        activityAt={lastUpdateAt}
        live
        now={now}
      />
    );
  }

  const phaseDetail = activeStep?.detail
    ? activeStep.detail
    : settledCallCount
      ? isFinalStep
        ? `Reviewing ${settledCallCount} completed tool ${
            settledCallCount === 1 ? "call" : "calls"
          } and preparing the final finding.`
        : `Reviewing the latest evidence from ${settledCallCount} completed tool ${
            settledCallCount === 1 ? "call" : "calls"
          }.`
      : "Preparing the first telemetry check.";

  return (
    <StateMessage
      icon={Loading03Icon}
      iconClassName="animate-spin text-[var(--accent-cobalt-ink)] motion-reduce:animate-none"
      eyebrow={
        isFinalStep
          ? "Preparing final finding"
          : activeStep
            ? "Choosing the next check"
            : "Investigation in progress"
      }
      title={activeStep?.title ?? investigation.scope.question}
      detail={phaseDetail}
      activityAt={lastUpdateAt}
      live
      now={now}
    />
  );
}

function StateMessage({
  icon,
  iconClassName,
  eyebrow,
  title,
  detail,
  activityAt,
  live = false,
  now
}: {
  icon: typeof AlertCircleIcon;
  iconClassName: string;
  eyebrow: string;
  title: string;
  detail?: string;
  activityAt: string;
  live?: boolean;
  now: number;
}) {
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
      <HugeiconsIcon
        className={cn("mt-0.5", iconClassName)}
        icon={icon}
        size={17}
        strokeWidth={1.6}
        aria-hidden="true"
      />
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {eyebrow}
        </span>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {detail ? (
          <p className="text-sm text-muted-foreground">{detail}</p>
        ) : null}
        {live ? (
          <ActivityAge at={activityAt} now={now} />
        ) : (
          <time
            className="font-mono text-xs text-muted-foreground tabular-nums"
            dateTime={activityAt}
          >
            Updated {timeFormatter.format(new Date(activityAt))} UTC
          </time>
        )}
      </div>
    </div>
  );
}

function CallMetadata({
  tool,
  scope,
  elapsedMs,
  completed
}: {
  tool: ToolStartedEvent["tool"];
  scope?: string;
  elapsedMs?: number;
  completed?: ToolCompletedEvent;
}) {
  const metadata: ReactNode[] = [
    <code key="tool">{tool}</code>,
    ...(scope ? [<code key="scope">{scope}</code>] : []),
    ...(completed?.rowCount !== undefined
      ? [
          <span className="font-mono tabular-nums" key="rows">
            {completed.rowCount.toLocaleString()} rows
          </span>
        ]
      : []),
    ...(elapsedMs !== undefined
      ? [
          <span className="font-mono tabular-nums" key="elapsed">
            {formatMilliseconds(elapsedMs)}
          </span>
        ]
      : []),
    ...(completed?.evidenceIds?.length
      ? [
          <span className="font-mono tabular-nums" key="evidence">
            {completed.evidenceIds.length} evidence{" "}
            {completed.evidenceIds.length === 1 ? "receipt" : "receipts"}
          </span>
        ]
      : [])
  ];

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      {metadata.map((item, index) => (
        <span className="inline-flex items-center gap-2" key={index}>
          {index ? <MetadataSeparator /> : null}
          {item}
        </span>
      ))}
    </div>
  );
}

function SettledToolCall({
  call,
  evidenceEvents
}: {
  call: ToolCallLifecycle;
  evidenceEvents: EvidenceEvent[];
}) {
  const completed = call.completed;
  const lastFailure = call.failures.at(-1);
  const failed = !completed && Boolean(lastFailure);
  const interrupted = !completed && !lastFailure;
  const scope = toolScope(call.started);
  const receiptIds = completed?.evidenceIds ?? [];

  return (
    <details className="group border-b border-border/70">
      <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[20px_minmax(0,1fr)_20px] gap-3 py-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        <HugeiconsIcon
          className={cn(
            "mt-0.5",
            failed && "text-destructive",
            interrupted && "text-amber-700",
            completed && "text-[var(--accent-emerald)]"
          )}
          icon={
            failed
              ? CancelCircleIcon
              : interrupted
                ? AlertCircleIcon
                : CheckmarkCircle01Icon
          }
          size={17}
          strokeWidth={1.6}
          aria-hidden="true"
        />

        <span className="flex min-w-0 flex-col gap-2">
          <span className="text-sm font-medium text-foreground">
            {displayToolLabel(call.started)}
          </span>
          <CallMetadata
            tool={call.started.tool}
            scope={scope}
            elapsedMs={completed?.durationMs ?? lastFailure?.durationMs}
            completed={completed}
          />
          <span
            className={cn(
              "text-sm leading-relaxed",
              failed ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {completed?.summary ??
              lastFailure?.message ??
              "The call did not reach a persisted completion."}
          </span>
          {call.failures.length && completed ? (
            <span className="text-xs text-amber-700">
              Completed after {call.failures.length + 1} attempts
            </span>
          ) : null}
        </span>

        <HugeiconsIcon
          className="mt-0.5 text-muted-foreground transition-transform duration-150 ease-out group-open:rotate-180 motion-reduce:transition-none"
          icon={ArrowDown01Icon}
          size={16}
          strokeWidth={1.6}
          aria-hidden="true"
        />
      </summary>

      <div className="flex flex-col gap-6 pb-6 pl-8">
        {call.failures.length ? (
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-foreground">Attempts</h4>
            <ul className="flex flex-col gap-2">
              {call.failures.map((failure) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground"
                  key={failure.id}
                >
                  <span className="font-mono tabular-nums">
                    Attempt {failure.attempt}
                  </span>
                  <span>{failure.message}</span>
                  <span className="font-mono tabular-nums">
                    {formatMilliseconds(failure.durationMs)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {receiptIds.length ? (
          <div className="flex flex-col gap-2">
            <h4 className="text-sm font-medium text-foreground">
              Evidence receipts
            </h4>
            <div className="flex flex-wrap gap-2">
              {receiptIds.map((evidenceId) => {
                const relatedEvent = evidenceEvents.find((event) =>
                  event.evidenceIds.includes(evidenceId)
                );

                return relatedEvent ? (
                  <a
                    className="inline-flex min-h-11 items-center rounded-xl bg-muted px-3 font-mono text-xs text-[var(--accent-cobalt-ink)] hover:underline"
                    href={`#live-finding-${relatedEvent.id}`}
                    key={evidenceId}
                  >
                    {evidenceId}
                  </a>
                ) : (
                  <code
                    className="inline-flex min-h-11 items-center rounded-xl bg-muted px-3 text-xs text-muted-foreground"
                    key={evidenceId}
                  >
                    {evidenceId}
                  </code>
                );
              })}
            </div>
          </div>
        ) : null}

        {completed?.nextCursor ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Next cursor</span>
            <code className="text-xs text-foreground">
              {completed.nextCursor}
            </code>
          </div>
        ) : null}

        <PayloadDisclosure label="Input" value={call.started.input} />
        <PayloadDisclosure
          label="Raw result"
          value={completed?.result}
          unavailableLabel="No raw result was persisted for this call."
        />
      </div>
    </details>
  );
}

function PayloadDisclosure({
  label,
  value,
  unavailableLabel
}: {
  label: string;
  value: unknown;
  unavailableLabel?: string;
}) {
  return (
    <details className="group/payload">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
        {label}
        <span className="group-open/payload:hidden" aria-hidden="true">
          +
        </span>
        <span className="hidden group-open/payload:inline" aria-hidden="true">
          −
        </span>
      </summary>
      {value === undefined ? (
        <p className="text-xs text-muted-foreground">{unavailableLabel}</p>
      ) : (
        <pre className="max-h-96 overflow-auto rounded-xl bg-muted p-4 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </details>
  );
}

function PlanRail({ steps }: { steps: InvestigationPlanStep[] }) {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="live-plan-title">
      <h2 className="text-sm font-medium text-foreground" id="live-plan-title">
        Plan
      </h2>
      {steps.length ? (
        <ol className="flex flex-col gap-4">
          {steps.map((step) => (
            <li
              className="grid grid-cols-[16px_minmax(0,1fr)] gap-2.5"
              key={step.id}
            >
              <PlanStatusIcon status={step.status} />
              <span className="flex flex-col gap-1">
                <span
                  className={cn(
                    "text-sm",
                    step.status === "active"
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <span className="sr-only">
                    {step.status.replaceAll("_", " ")}:{" "}
                  </span>
                  {step.title}
                </span>
                {step.detail ? (
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {step.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          The plan has not been persisted yet.
        </p>
      )}
    </section>
  );
}

function PlanStatusIcon({
  status
}: {
  status: InvestigationPlanStep["status"];
}) {
  const isActive = status === "active";
  const isComplete = status === "completed";

  return (
    <HugeiconsIcon
      className={cn(
        "mt-0.5",
        isActive &&
          "animate-spin text-[var(--accent-cobalt-ink)] motion-reduce:animate-none",
        isComplete && "text-[var(--accent-emerald)]",
        !isActive && !isComplete && "text-muted-foreground"
      )}
      icon={
        isActive
          ? Loading03Icon
          : isComplete
            ? CheckmarkCircle01Icon
            : CircleDashedIcon
      }
      size={15}
      strokeWidth={1.6}
      aria-hidden="true"
    />
  );
}

function ModelNoticesRail({ events }: { events: ModelFailedEvent[] }) {
  if (!events.length) return null;

  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="model-notices-title"
    >
      <h2
        className="text-sm font-medium text-foreground"
        id="model-notices-title"
      >
        Run notices
      </h2>
      <ol className="flex flex-col gap-5">
        {events.map((event) => (
          <li className="flex flex-col gap-1.5" key={event.id}>
            <span className="text-xs font-medium text-amber-700">
              {event.retryable
                ? "Model request retry"
                : "Model output rejected"}
            </span>
            <p className="text-sm leading-relaxed text-foreground">
              {event.message}
            </p>
            <span className="flex flex-wrap items-center gap-2 font-mono text-xs text-muted-foreground tabular-nums">
              <span>attempt {event.attempt}</span>
              <MetadataSeparator />
              <time dateTime={event.at}>
                {timeFormatter.format(new Date(event.at))} UTC
              </time>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function FindingsRail({ events }: { events: EvidenceEvent[] }) {
  return (
    <section
      className="flex flex-col gap-4"
      aria-labelledby="live-findings-title"
    >
      <h2
        className="text-sm font-medium text-foreground"
        id="live-findings-title"
      >
        Findings so far
      </h2>
      {events.length ? (
        <ol className="flex flex-col gap-5">
          {events.map((event) => (
            <li
              className="flex scroll-mt-6 flex-col gap-1.5"
              id={`live-finding-${event.id}`}
              key={event.id}
            >
              {event.type === "observation.added" ? (
                <>
                  <p className="text-sm leading-relaxed text-foreground">
                    {event.detail}
                  </p>
                  <span className="font-mono text-xs text-muted-foreground">
                    {event.title}
                  </span>
                </>
              ) : (
                <>
                  <p className="text-sm leading-relaxed text-foreground">
                    {event.statement}
                  </p>
                  <span className="text-xs text-muted-foreground">
                    {event.status.replaceAll("_", " ")}
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">
          Persisted observations will appear here.
        </p>
      )}
    </section>
  );
}

function ActivityAge({ at, now }: { at: string; now: number }) {
  const elapsedMs = Math.max(0, now - Date.parse(at));

  return (
    <span className="font-mono text-xs text-muted-foreground tabular-nums">
      {formatElapsedDuration(elapsedMs)} since last persisted update
    </span>
  );
}

function useLiveClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);

  return now;
}

function groupToolCalls(events: InvestigationEvent[]): ToolCallLifecycle[] {
  const calls = new Map<string, ToolCallLifecycle>();

  for (const event of events) {
    if (event.type === "tool.started") {
      const existing = calls.get(event.callId);
      calls.set(event.callId, {
        callId: event.callId,
        started: existing?.started ?? event,
        progress: existing?.progress ?? [],
        failures: existing?.failures ?? [],
        completed: existing?.completed,
        lastSequence: Math.max(existing?.lastSequence ?? 0, event.sequence)
      });
      continue;
    }

    if (
      event.type !== "tool.progress" &&
      event.type !== "tool.completed" &&
      event.type !== "tool.failed"
    ) {
      continue;
    }

    const call = calls.get(event.callId);
    if (!call) continue;
    call.lastSequence = Math.max(call.lastSequence, event.sequence);

    if (event.type === "tool.progress") call.progress.push(event);
    if (event.type === "tool.failed") call.failures.push(event);
    if (event.type === "tool.completed") call.completed = event;
  }

  return [...calls.values()].sort(
    (left, right) => left.started.sequence - right.started.sequence
  );
}

function findLatestPlan(investigation: Investigation) {
  for (let index = investigation.events.length - 1; index >= 0; index -= 1) {
    const event = investigation.events[index];
    if (event.type === "plan.updated") return event.steps;
  }
  return investigation.plan;
}

function findTerminalEvent(events: InvestigationEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.type === "investigation.failed" ||
      event.type === "investigation.no_findings" ||
      event.type === "investigation.completed"
    ) {
      return event;
    }
  }
  return undefined;
}

function displayToolLabel(event: ToolStartedEvent) {
  const label = event.label.trim();
  if (
    label.length <= 140 &&
    /^(checking|comparing|correlating|finding|inspecting|looking|measuring|querying|retrying|reviewing|sampling|scanning|testing|validating|verifying)\b/i.test(
      label
    )
  ) {
    return label;
  }

  switch (event.tool) {
    case "query_metrics": {
      const route = event.input.filters?.route;
      if (event.input.groupBy === "route") {
        return "Comparing cache and origin behavior by route";
      }
      if (event.input.groupBy === "has_session_id") {
        return "Comparing cache behavior with and without session IDs";
      }
      return route
        ? `Inspecting cache and origin signals for ${route}`
        : "Inspecting service metrics across the incident window";
    }
    case "search_logs":
      return event.input.route
        ? `Inspecting request logs for ${event.input.route}`
        : "Inspecting request logs for the incident window";
    case "list_deployments":
      return event.input.service
        ? `Reviewing deployments for ${event.input.service}`
        : "Reviewing deployments near the incident";
    case "check_dependency_health":
      return `Checking dependency health for ${event.input.service}`;
  }
}

function toolScope(event: ToolStartedEvent) {
  switch (event.tool) {
    case "query_metrics": {
      const route = event.input.filters?.route;
      const grouping = event.input.groupBy
        ? `by ${event.input.groupBy.replaceAll("_", " ")}`
        : undefined;
      return [route, grouping].filter(Boolean).join(" · ") || undefined;
    }
    case "search_logs":
      return [event.input.service, event.input.route]
        .filter(Boolean)
        .join(" · ");
    case "list_deployments":
      return event.input.service;
    case "check_dependency_health":
      return event.input.service;
  }
}

function formatWindow(window: Investigation["scope"]["window"]) {
  return `${timeFormatter.format(new Date(window.from))}–${timeFormatter.format(
    new Date(window.to)
  )} UTC`;
}

function formatMilliseconds(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds}ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds % 1000 ? 1 : 0)}s`;
}

function formatElapsedDuration(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}
