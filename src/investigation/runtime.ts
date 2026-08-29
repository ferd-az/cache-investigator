import type {
  EvidenceValue,
  FinalFinding,
  FindingEvidence,
  Investigation,
  InvestigationChaosMode,
  InvestigationPlanStep,
  InvestigationScope,
  InvestigationToolCall,
  InvestigationToolName,
  InvestigationTrigger
} from "./contracts.ts";
import type {
  InvestigationEventBody,
  InvestigationRepository
} from "./repository.ts";
import {
  InvestigationToolInputError,
  type InvestigationToolResult
} from "../telemetry/tools.ts";

export const investigationRunLimits = {
  maxTurns: 14,
  maxToolCalls: 10,
  maxToolAttempts: 2,
  maxModelAttemptsPerTurn: 2,
  maxInvalidFinalAttempts: 3,
  slowChaosDelayMs: 5_000
} as const;

export type StartInvestigationInput = {
  idempotencyKey: string;
  scope: InvestigationScope;
  trigger?: InvestigationTrigger;
  chaos?: InvestigationChaosMode;
};

export type ResolvedInvestigationStart = {
  id: string;
  input: Required<StartInvestigationInput>;
};

export type InvestigationHistoryEntry = {
  callId: string;
  evidenceId: string;
  call: InvestigationToolCall;
  result?: unknown;
  error?: string;
};

export type InvestigationModelContext = {
  investigation: Investigation;
  history: InvestigationHistoryEntry[];
  turn: number;
  remainingToolCalls: number;
};

export type InvestigationModelDecision =
  | {
      type: "tool";
      call: InvestigationToolCall;
      rationale: string;
    }
  | { type: "final"; finding: unknown }
  | { type: "no_findings"; summary: string };

export interface InvestigationModel {
  next(context: InvestigationModelContext): Promise<InvestigationModelDecision>;
}

export type ToolExecutor = (
  call: InvestigationToolCall
) => Promise<InvestigationToolResult[InvestigationToolName]>;

type PendingToolDecision = {
  type: "tool";
  turn: number;
  callId: string;
  evidenceId: string;
  call: InvestigationToolCall;
  rationale: string;
  attempt: number;
};

type PendingTerminalDecision =
  | { type: "final"; turn: number; finding: unknown }
  | { type: "no_findings"; turn: number; summary: string };

export type InvestigationCheckpoint = {
  version: 1;
  turn: number;
  toolCalls: number;
  modelFailures: number;
  invalidFinalAttempts: number;
  history: InvestigationHistoryEntry[];
  chaos: {
    mode: InvestigationChaosMode;
    step6FailureInjected: boolean;
    slowDelayCompleted: boolean;
    slowDelayStartedAt?: string;
  };
  pending?: PendingToolDecision | PendingTerminalDecision;
};

export type InvestigationRunnerOptions = {
  repository: InvestigationRepository;
  model: InvestigationModel;
  executeTool: ToolExecutor;
  now?: () => Date;
  onPersist?: (investigation: Investigation) => void | Promise<void>;
  onCheckpoint?: (checkpoint: InvestigationCheckpoint) => void | Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  slowDelayMs?: number;
};

export class InvestigationStartConflictError extends Error {
  override name = "InvestigationStartConflictError";
}

export class InvestigationChaosDisabledError extends Error {
  override name = "InvestigationChaosDisabledError";
}

export class InvestigationModelError extends Error {
  override name = "InvestigationModelError";
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

export async function prepareInvestigation(
  repository: InvestigationRepository,
  value: unknown,
  now = new Date(),
  options: { allowChaos?: boolean } = {}
): Promise<{ investigation: Investigation; created: boolean }> {
  const { id, input } = await resolveInvestigationStart(value, options);
  const existing = await repository.getByIdempotencyKey(input.idempotencyKey);
  if (existing) {
    if (!sameStart(existing, input)) {
      throw new InvestigationStartConflictError(
        "The idempotency key is already associated with a different investigation scope"
      );
    }
    return { investigation: existing, created: false };
  }

  const investigation = await repository.create({
    id,
    idempotencyKey: input.idempotencyKey,
    title: titleFor(input.scope.question),
    trigger: input.trigger,
    scope: input.scope,
    configuration: { chaos: input.chaos },
    createdAt: now.toISOString(),
    plan: initialPlan()
  });
  if (!sameStart(investigation, input)) {
    throw new InvestigationStartConflictError(
      "The idempotency key is already associated with a different investigation scope"
    );
  }
  return { investigation, created: true };
}

export async function resolveInvestigationStart(
  value: unknown,
  options: { allowChaos?: boolean } = {}
): Promise<ResolvedInvestigationStart> {
  const input = parseStartInput(value, options.allowChaos ?? false);
  return {
    id: await stableInvestigationId(input.idempotencyKey),
    input
  };
}

export async function runInvestigation(
  investigationId: string,
  options: InvestigationRunnerOptions
): Promise<Investigation> {
  const now = options.now ?? (() => new Date());
  let investigation = await requiredInvestigation(
    options.repository,
    investigationId
  );
  if (isTerminal(investigation.status)) return investigation;

  const loadedCheckpoint =
    await options.repository.loadCheckpoint<InvestigationCheckpoint>(
      investigationId
    );
  let checkpoint = loadedCheckpoint
    ? {
        ...loadedCheckpoint,
        invalidFinalAttempts: loadedCheckpoint.invalidFinalAttempts ?? 0
      }
    : initialCheckpoint(investigation.configuration.chaos);

  if (investigation.status === "queued") {
    const startedAt = now().toISOString();
    await options.repository.appendEvent(
      investigationId,
      "investigation.started",
      startedAt,
      {
        type: "investigation.started",
        question: investigation.scope.question
      }
    );
    await options.repository.appendEvent(
      investigationId,
      "plan.initial",
      startedAt,
      { type: "plan.updated", steps: investigation.plan }
    );
    await options.repository.patch(investigationId, {
      status: "running",
      startedAt
    });
    investigation = await persisted(options, investigationId);
  }

  while (true) {
    investigation = await requiredInvestigation(
      options.repository,
      investigationId
    );
    if (isTerminal(investigation.status)) return investigation;

    if (checkpoint.pending?.type === "tool") {
      checkpoint = await executePendingTool(
        investigation,
        checkpoint,
        options,
        now
      );
      continue;
    }

    if (checkpoint.pending?.type === "final") {
      try {
        const finding = normalizeFinalFinding(
          checkpoint.pending.finding,
          investigation,
          checkpoint.history
        );
        return completeInvestigation(
          investigation,
          finding,
          checkpoint,
          options,
          now
        );
      } catch (error) {
        checkpoint = await recordInvalidFinal(
          investigation,
          checkpoint,
          messageOf(error),
          options,
          now
        );
        if (
          checkpoint.invalidFinalAttempts >=
          investigationRunLimits.maxInvalidFinalAttempts
        ) {
          return failInvestigation(
            investigation,
            "The model repeatedly returned an invalid final finding",
            false,
            checkpoint,
            options,
            now
          );
        }
        continue;
      }
    }

    if (checkpoint.pending?.type === "no_findings") {
      return completeNoFindings(
        investigation,
        checkpoint.pending.summary,
        checkpoint,
        options,
        now
      );
    }

    if (checkpoint.turn >= investigationRunLimits.maxTurns) {
      return failInvestigation(
        investigation,
        `Investigation reached the ${investigationRunLimits.maxTurns}-turn limit`,
        false,
        checkpoint,
        options,
        now
      );
    }

    let decision: InvestigationModelDecision;
    try {
      decision = await options.model.next({
        investigation,
        history: checkpoint.history,
        turn: checkpoint.turn + 1,
        remainingToolCalls:
          investigationRunLimits.maxToolCalls - checkpoint.toolCalls
      });
    } catch (error) {
      const modelError =
        error instanceof InvestigationModelError
          ? error
          : new InvestigationModelError(messageOf(error));
      checkpoint = await recordModelFailure(
        investigation,
        checkpoint,
        modelError.message,
        modelError.retryable,
        options,
        now
      );
      if (
        !modelError.retryable ||
        checkpoint.modelFailures >=
          investigationRunLimits.maxModelAttemptsPerTurn
      ) {
        return failInvestigation(
          investigation,
          `Model execution failed: ${modelError.message}`,
          modelError.retryable,
          checkpoint,
          options,
          now
        );
      }
      continue;
    }

    const turn = checkpoint.turn + 1;
    checkpoint = {
      ...checkpoint,
      turn,
      modelFailures: 0,
      invalidFinalAttempts:
        decision.type === "tool" ? 0 : checkpoint.invalidFinalAttempts,
      pending:
        decision.type === "tool"
          ? {
              ...decision,
              turn,
              callId: `call:${turn}:${decision.call.tool}`,
              evidenceId: `evidence:call:${turn}:${decision.call.tool}`,
              attempt: 1
            }
          : { ...decision, turn }
    };
    await saveCheckpoint(options, investigationId, checkpoint);
  }
}

async function executePendingTool(
  investigation: Investigation,
  checkpoint: InvestigationCheckpoint,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<InvestigationCheckpoint> {
  const pending = checkpoint.pending;
  if (!pending || pending.type !== "tool") return checkpoint;
  if (checkpoint.toolCalls >= investigationRunLimits.maxToolCalls) {
    await failInvestigation(
      investigation,
      `Investigation reached the ${investigationRunLimits.maxToolCalls}-tool-call limit`,
      false,
      checkpoint,
      options,
      now
    );
    return checkpoint;
  }

  const started = now();
  await emit(
    options,
    investigation.id,
    `tool.started:${pending.callId}`,
    started,
    {
      type: "tool.started",
      ...pending.call,
      callId: pending.callId,
      label: pending.rationale
    }
  );

  if (
    checkpoint.chaos.mode === "step6" &&
    checkpoint.toolCalls === 5 &&
    !checkpoint.chaos.step6FailureInjected
  ) {
    await emit(
      options,
      investigation.id,
      `tool.failed:${pending.callId}:chaos-step6`,
      now(),
      {
        type: "tool.failed",
        callId: pending.callId,
        message: "Injected recoverable step6 tool failure",
        durationMs: Math.max(0, now().getTime() - started.getTime()),
        attempt: pending.attempt,
        retryable: true
      }
    );
    const next: InvestigationCheckpoint = {
      ...checkpoint,
      chaos: { ...checkpoint.chaos, step6FailureInjected: true },
      pending: { ...pending, attempt: pending.attempt + 1 }
    };
    await saveCheckpoint(options, investigation.id, next);
    return next;
  }

  checkpoint = await applySlowChaos(
    investigation,
    checkpoint,
    pending,
    options,
    now
  );

  try {
    const result = await options.executeTool(pending.call);
    const durationMs = Math.max(0, now().getTime() - started.getTime());
    const summary = summarizeToolResult(pending.call.tool, result);
    await emit(
      options,
      investigation.id,
      `tool.completed:${pending.callId}`,
      now(),
      {
        type: "tool.completed",
        callId: pending.callId,
        summary,
        durationMs,
        ...resultMetadata(result),
        evidenceIds: [pending.evidenceId],
        result
      }
    );
    await emit(
      options,
      investigation.id,
      `observation:${pending.callId}`,
      now(),
      {
        type: "observation.added",
        observationId: `observation:${pending.callId}`,
        title: `${pending.call.tool} result`,
        detail: summary,
        evidenceIds: [pending.evidenceId]
      }
    );

    const next: InvestigationCheckpoint = {
      ...checkpoint,
      toolCalls: checkpoint.toolCalls + 1,
      history: [
        ...checkpoint.history,
        {
          callId: pending.callId,
          evidenceId: pending.evidenceId,
          call: pending.call,
          result
        }
      ]
    };
    delete next.pending;
    await updatePlan(investigation, pending.call.tool, options, now());
    await saveCheckpoint(options, investigation.id, next);
    return next;
  } catch (error) {
    const inputError = error instanceof InvestigationToolInputError;
    const retryable = !inputError;
    const durationMs = Math.max(0, now().getTime() - started.getTime());
    await emit(
      options,
      investigation.id,
      `tool.failed:${pending.callId}:${pending.attempt}`,
      now(),
      {
        type: "tool.failed",
        callId: pending.callId,
        message: messageOf(error),
        durationMs,
        attempt: pending.attempt,
        retryable
      }
    );

    if (retryable && pending.attempt < investigationRunLimits.maxToolAttempts) {
      const next = {
        ...checkpoint,
        pending: { ...pending, attempt: pending.attempt + 1 }
      };
      await saveCheckpoint(options, investigation.id, next);
      return next;
    }

    const next: InvestigationCheckpoint = {
      ...checkpoint,
      toolCalls: checkpoint.toolCalls + 1,
      history: [
        ...checkpoint.history,
        {
          callId: pending.callId,
          evidenceId: pending.evidenceId,
          call: pending.call,
          error: messageOf(error)
        }
      ]
    };
    delete next.pending;
    await saveCheckpoint(options, investigation.id, next);
    return next;
  }
}

async function applySlowChaos(
  investigation: Investigation,
  checkpoint: InvestigationCheckpoint,
  pending: PendingToolDecision,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<InvestigationCheckpoint> {
  if (checkpoint.chaos.mode !== "slow" || checkpoint.chaos.slowDelayCompleted) {
    return checkpoint;
  }

  const delayMs =
    options.slowDelayMs ?? investigationRunLimits.slowChaosDelayMs;
  const startedAt = checkpoint.chaos.slowDelayStartedAt ?? now().toISOString();
  let next: InvestigationCheckpoint = checkpoint;
  if (!checkpoint.chaos.slowDelayStartedAt) {
    next = {
      ...checkpoint,
      chaos: { ...checkpoint.chaos, slowDelayStartedAt: startedAt }
    };
    await saveCheckpoint(options, investigation.id, next);
  }

  const elapsedBeforeWait = Math.max(
    0,
    now().getTime() - Date.parse(startedAt)
  );
  const remainingMs = Math.max(0, delayMs - elapsedBeforeWait);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  if (remainingMs > 0) await sleep(remainingMs);

  const elapsedMs = Math.max(1, now().getTime() - Date.parse(startedAt));
  await emit(
    options,
    investigation.id,
    `tool.progress:slow:${pending.callId}`,
    now(),
    {
      type: "tool.progress",
      callId: pending.callId,
      message: "Slow-mode delay completed; continuing the tool call",
      elapsedMs
    }
  );
  next = {
    ...next,
    chaos: { ...next.chaos, slowDelayCompleted: true }
  };
  await saveCheckpoint(options, investigation.id, next);
  return next;
}

async function recordModelFailure(
  investigation: Investigation,
  checkpoint: InvestigationCheckpoint,
  message: string,
  retryable: boolean,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<InvestigationCheckpoint> {
  const attempt = checkpoint.modelFailures + 1;
  await emit(
    options,
    investigation.id,
    `model.failed:${checkpoint.turn + 1}:${attempt}`,
    now(),
    {
      type: "model.failed",
      turn: checkpoint.turn + 1,
      message,
      attempt,
      retryable
    }
  );
  const next = { ...checkpoint, modelFailures: attempt };
  delete next.pending;
  await saveCheckpoint(options, investigation.id, next);
  return next;
}

async function recordInvalidFinal(
  investigation: Investigation,
  checkpoint: InvestigationCheckpoint,
  message: string,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<InvestigationCheckpoint> {
  const attempt = checkpoint.invalidFinalAttempts + 1;
  const retryable = attempt < investigationRunLimits.maxInvalidFinalAttempts;
  await emit(
    options,
    investigation.id,
    `model.invalid-final:${checkpoint.turn}:${attempt}`,
    now(),
    {
      type: "model.failed",
      turn: checkpoint.turn,
      message,
      attempt,
      retryable
    }
  );
  const next = {
    ...checkpoint,
    modelFailures: 0,
    invalidFinalAttempts: attempt
  };
  delete next.pending;
  await saveCheckpoint(options, investigation.id, next);
  return next;
}

async function updatePlan(
  investigation: Investigation,
  tool: InvestigationToolName,
  options: InvestigationRunnerOptions,
  at: Date
) {
  const target =
    tool === "query_metrics"
      ? "baseline"
      : tool === "search_logs"
        ? "localize"
        : "correlate";
  const current = await requiredInvestigation(
    options.repository,
    investigation.id
  );
  const plan = current.plan.map((step) => ({
    ...step,
    status:
      step.id === target
        ? "completed"
        : step.status === "pending" && firstPending(current.plan) === step.id
          ? "active"
          : step.status
  })) satisfies InvestigationPlanStep[];
  if (JSON.stringify(plan) === JSON.stringify(current.plan)) return;
  await emit(options, investigation.id, `plan.after:${target}`, at, {
    type: "plan.updated",
    steps: plan
  });
  await options.repository.patch(investigation.id, { plan });
  await persisted(options, investigation.id);
}

async function completeInvestigation(
  investigation: Investigation,
  finding: FinalFinding,
  checkpoint: InvestigationCheckpoint,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<Investigation> {
  const completedAt = now().toISOString();
  await emit(options, investigation.id, "hypothesis.root-cause", now(), {
    type: "hypothesis.updated",
    hypothesisId: "root-cause",
    statement: finding.rootCause.summary,
    status: "supported",
    confidence: finding.confidence.score,
    evidenceIds: finding.evidence.map((item) => item.id)
  });
  for (const [index, alternative] of finding.alternativesRuledOut.entries()) {
    await emit(
      options,
      investigation.id,
      `hypothesis.alternative:${index}`,
      now(),
      {
        type: "hypothesis.updated",
        hypothesisId: `alternative:${index}`,
        statement: alternative.hypothesis,
        status: "ruled_out",
        confidence: finding.confidence.score,
        evidenceIds: alternative.evidenceIds
      }
    );
  }
  await emit(options, investigation.id, "investigation.completed", now(), {
    type: "investigation.completed",
    findingId: finding.id,
    summary: finding.summary
  });
  await options.repository.patch(investigation.id, {
    status: "completed",
    completedAt,
    finding,
    plan: investigation.plan.map((step) => ({ ...step, status: "completed" }))
  });
  const next = { ...checkpoint };
  delete next.pending;
  await saveCheckpoint(options, investigation.id, next);
  return persisted(options, investigation.id);
}

async function completeNoFindings(
  investigation: Investigation,
  summary: string,
  checkpoint: InvestigationCheckpoint,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<Investigation> {
  const bounded = requiredString(summary, "no-findings summary", 2_000);
  await emit(options, investigation.id, "investigation.no_findings", now(), {
    type: "investigation.no_findings",
    summary: bounded
  });
  await options.repository.patch(investigation.id, {
    status: "no_findings",
    completedAt: now().toISOString()
  });
  const next = { ...checkpoint };
  delete next.pending;
  await saveCheckpoint(options, investigation.id, next);
  return persisted(options, investigation.id);
}

async function failInvestigation(
  investigation: Investigation,
  message: string,
  recoverable: boolean,
  checkpoint: InvestigationCheckpoint,
  options: InvestigationRunnerOptions,
  now: () => Date
): Promise<Investigation> {
  await emit(options, investigation.id, "investigation.failed", now(), {
    type: "investigation.failed",
    message,
    recoverable
  });
  await options.repository.patch(investigation.id, {
    status: "failed",
    completedAt: now().toISOString()
  });
  const next = { ...checkpoint };
  delete next.pending;
  await saveCheckpoint(options, investigation.id, next);
  return persisted(options, investigation.id);
}

async function emit(
  options: InvestigationRunnerOptions,
  investigationId: string,
  operationKey: string,
  at: Date,
  event: InvestigationEventBody
) {
  await options.repository.appendEvent(
    investigationId,
    operationKey,
    at.toISOString(),
    event
  );
  await persisted(options, investigationId);
}

async function saveCheckpoint(
  options: InvestigationRunnerOptions,
  investigationId: string,
  checkpoint: InvestigationCheckpoint
) {
  await options.repository.saveCheckpoint(investigationId, checkpoint);
  await options.onCheckpoint?.(checkpoint);
}

async function persisted(
  options: InvestigationRunnerOptions,
  investigationId: string
): Promise<Investigation> {
  const investigation = await requiredInvestigation(
    options.repository,
    investigationId
  );
  await options.onPersist?.(investigation);
  return investigation;
}

function parseStartInput(
  value: unknown,
  allowChaos: boolean
): Required<StartInvestigationInput> {
  const input = object(value, "investigation start");
  const scope = object(input.scope, "scope");
  const window = object(scope.window, "scope.window");
  const from = explicitTimestamp(window.from, "scope.window.from");
  const to = explicitTimestamp(window.to, "scope.window.to");
  if (Date.parse(to) <= Date.parse(from)) {
    throw new InvestigationToolInputError(
      "scope.window.to must be later than scope.window.from"
    );
  }
  if (Date.parse(to) - Date.parse(from) > 24 * 3_600_000) {
    throw new InvestigationToolInputError(
      "Investigation window must not exceed 24 hours"
    );
  }
  const environment = requiredString(scope.environment, "scope.environment");
  if (environment !== "production" && environment !== "staging") {
    throw new InvestigationToolInputError(
      "scope.environment must be production or staging"
    );
  }
  const triggerValue =
    input.trigger === undefined
      ? { kind: "manual", label: "Diagnostic API" }
      : object(input.trigger, "trigger");
  if (triggerValue.kind !== "manual" && triggerValue.kind !== "scheduled") {
    throw new InvestigationToolInputError(
      "trigger.kind must be manual or scheduled"
    );
  }
  const chaos = input.chaos ?? "none";
  if (chaos !== "none" && chaos !== "step6" && chaos !== "slow") {
    throw new InvestigationToolInputError("chaos must be none, step6, or slow");
  }
  if (chaos !== "none" && !allowChaos) {
    throw new InvestigationChaosDisabledError(
      "Investigation chaos modes are disabled in this environment"
    );
  }

  return {
    idempotencyKey: requiredString(input.idempotencyKey, "idempotencyKey", 200),
    scope: {
      service: requiredString(scope.service, "scope.service"),
      environment,
      question: requiredString(scope.question, "scope.question", 2_000),
      window: { from, to }
    },
    trigger: {
      kind: triggerValue.kind,
      label: requiredString(triggerValue.label, "trigger.label")
    },
    chaos
  };
}

function sameStart(
  existing: Investigation,
  input: Required<StartInvestigationInput>
) {
  return (
    JSON.stringify(existing.scope) === JSON.stringify(input.scope) &&
    JSON.stringify(existing.trigger) === JSON.stringify(input.trigger) &&
    existing.configuration.chaos === input.chaos
  );
}

async function stableInvestigationId(idempotencyKey: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey)
  );
  return `inv_${[...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function initialPlan(): InvestigationPlanStep[] {
  return [
    {
      id: "baseline",
      title: "Establish the metric timeline",
      status: "active"
    },
    {
      id: "localize",
      title: "Localize the affected traffic segment",
      status: "pending"
    },
    {
      id: "correlate",
      title: "Correlate deployments and dependency health",
      status: "pending"
    },
    {
      id: "conclude",
      title: "Validate evidence and recommend remediation",
      status: "pending"
    }
  ];
}

function initialCheckpoint(
  mode: InvestigationChaosMode
): InvestigationCheckpoint {
  return {
    version: 1,
    turn: 0,
    toolCalls: 0,
    modelFailures: 0,
    invalidFinalAttempts: 0,
    history: [],
    chaos: {
      mode,
      step6FailureInjected: false,
      slowDelayCompleted: false
    }
  };
}

function normalizeFinalFinding(
  value: unknown,
  investigation: Investigation,
  history: InvestigationHistoryEntry[]
): FinalFinding {
  const input = object(value, "final finding");
  const completed = new Map(
    history
      .filter((entry) => entry.result !== undefined)
      .map((entry) => [entry.callId, entry])
  );
  const evidenceInput = array(input.evidence, "finding.evidence", 12);
  const evidenceIdMap = new Map<string, string>();
  const evidence = evidenceInput.map((item, index) => {
    const raw = object(item, `finding.evidence[${index}]`);
    const source = object(raw.source, `finding.evidence[${index}].source`);
    const callId = requiredString(
      source.callId,
      `finding.evidence[${index}].source.callId`
    );
    const executed = completed.get(callId);
    if (!executed) {
      throw new InvestigationModelError(
        `Finding evidence references unknown completed call ${callId}`,
        false
      );
    }
    const id = executed.evidenceId;
    evidenceIdMap.set(
      requiredString(raw.id, `finding.evidence[${index}].id`),
      id
    );
    return {
      id,
      kind: evidenceKind(executed.call.tool),
      title: requiredString(raw.title, `finding.evidence[${index}].title`, 300),
      claim: requiredString(
        raw.claim,
        `finding.evidence[${index}].claim`,
        1_000
      ),
      source: { ...executed.call, callId },
      ...optionalTimestamp(
        raw.observedAt,
        `finding.evidence[${index}].observedAt`
      ),
      ...optionalEvidenceWindow(
        raw.window,
        `finding.evidence[${index}].window`
      ),
      values: parseValues(raw.values, `finding.evidence[${index}].values`)
    } satisfies FindingEvidence;
  });
  const kinds = new Set(evidence.map((item) => item.kind));
  for (const kind of ["metric", "log", "deployment", "dependency"] as const) {
    if (!kinds.has(kind)) {
      throw new InvestigationModelError(
        `Final finding must cite ${kind} evidence`,
        false
      );
    }
  }

  const impact = object(input.impact, "finding.impact");
  const rootCause = object(input.rootCause, "finding.rootCause");
  const confidence = object(input.confidence, "finding.confidence");
  const recommendation = object(input.recommendation, "finding.recommendation");
  const status = input.status;
  if (
    status !== "confirmed" &&
    status !== "likely" &&
    status !== "inconclusive"
  ) {
    throw new InvestigationModelError("Finding status is invalid", false);
  }
  const level = confidence.level;
  if (level !== "high" && level !== "medium" && level !== "low") {
    throw new InvestigationModelError(
      "Finding confidence level is invalid",
      false
    );
  }
  const score = confidence.score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 1
  ) {
    throw new InvestigationModelError(
      "Finding confidence score must be between 0 and 1",
      false
    );
  }

  const alternatives = array(
    input.alternativesRuledOut,
    "finding.alternativesRuledOut",
    8
  ).map((item, index) => {
    const alternative = object(item, `finding.alternativesRuledOut[${index}]`);
    const rawIds = stringArray(
      alternative.evidenceIds,
      `finding.alternativesRuledOut[${index}].evidenceIds`,
      12
    );
    const evidenceIds = rawIds.map((id) => evidenceIdMap.get(id) ?? id);
    if (evidenceIds.some((id) => !evidence.some((item) => item.id === id))) {
      throw new InvestigationModelError(
        "Alternative hypothesis references unknown evidence",
        false
      );
    }
    return {
      hypothesis: requiredString(
        alternative.hypothesis,
        `finding.alternativesRuledOut[${index}].hypothesis`,
        500
      ),
      reason: requiredString(
        alternative.reason,
        `finding.alternativesRuledOut[${index}].reason`,
        1_000
      ),
      evidenceIds
    };
  });
  if (alternatives.length === 0) {
    throw new InvestigationModelError(
      "Final finding must rule out at least one alternative",
      false
    );
  }

  return {
    id: `finding:${investigation.id}`,
    headline: requiredString(input.headline, "finding.headline", 300),
    status,
    summary: requiredString(input.summary, "finding.summary", 2_000),
    impact: {
      startedAt: explicitTimestamp(
        impact.startedAt,
        "finding.impact.startedAt"
      ),
      summary: requiredString(impact.summary, "finding.impact.summary", 1_000),
      affectedRoutes: stringArray(
        impact.affectedRoutes,
        "finding.impact.affectedRoutes",
        20
      ),
      indicators: parseValues(impact.indicators, "finding.impact.indicators")
    },
    rootCause: {
      summary: requiredString(
        rootCause.summary,
        "finding.rootCause.summary",
        1_000
      ),
      change: requiredString(
        rootCause.change,
        "finding.rootCause.change",
        1_000
      ),
      mechanism: stringArray(
        rootCause.mechanism,
        "finding.rootCause.mechanism",
        12
      )
    },
    confidence: {
      level,
      score,
      rationale: requiredString(
        confidence.rationale,
        "finding.confidence.rationale",
        1_000
      )
    },
    recommendation: {
      immediate: requiredString(
        recommendation.immediate,
        "finding.recommendation.immediate",
        1_000
      ),
      verify: requiredString(
        recommendation.verify,
        "finding.recommendation.verify",
        1_000
      ),
      followUps: stringArray(
        recommendation.followUps,
        "finding.recommendation.followUps",
        12
      )
    },
    evidence,
    alternativesRuledOut: alternatives
  };
}

function parseValues(value: unknown, label: string): EvidenceValue[] {
  return array(value, label, 20).map((item, index) => {
    const entry = object(item, `${label}[${index}]`);
    if (
      typeof entry.value !== "string" &&
      (typeof entry.value !== "number" || !Number.isFinite(entry.value))
    ) {
      throw new InvestigationModelError(
        `${label}[${index}].value is invalid`,
        false
      );
    }
    return {
      label: requiredString(entry.label, `${label}[${index}].label`, 200),
      value: entry.value,
      ...(entry.unit === undefined
        ? {}
        : { unit: requiredString(entry.unit, `${label}[${index}].unit`, 100) })
    };
  });
}

function optionalTimestamp(value: unknown, label: string) {
  return value === undefined
    ? {}
    : { observedAt: explicitTimestamp(value, label) };
}

function optionalEvidenceWindow(value: unknown, label: string) {
  if (value === undefined) return {};
  const window = object(value, label);
  return {
    window: {
      from: explicitTimestamp(window.from, `${label}.from`),
      to: explicitTimestamp(window.to, `${label}.to`)
    }
  };
}

function evidenceKind(tool: InvestigationToolName): FindingEvidence["kind"] {
  switch (tool) {
    case "query_metrics":
      return "metric";
    case "search_logs":
      return "log";
    case "list_deployments":
      return "deployment";
    case "check_dependency_health":
      return "dependency";
  }
}

function summarizeToolResult(tool: InvestigationToolName, result: unknown) {
  const value = object(result, `${tool} result`);
  switch (tool) {
    case "query_metrics":
      return `${array(value.points, "metric points", 200).length} metric points returned`;
    case "search_logs":
      return `${array(value.rows, "log rows", 100).length} log rows returned${value.nextCursor ? " with another page available" : ""}`;
    case "list_deployments":
      return `${array(value.deployments, "deployments", 20).length} deployments returned`;
    case "check_dependency_health":
      return `${array(value.dependencies, "dependencies", 10).length} dependency health records returned`;
  }
}

function resultMetadata(result: unknown): {
  rowCount?: number;
  nextCursor?: string;
} {
  const value = object(result, "tool result");
  for (const key of ["points", "rows", "deployments", "dependencies"]) {
    if (Array.isArray(value[key])) {
      return {
        rowCount: value[key].length,
        ...(typeof value.nextCursor === "string"
          ? { nextCursor: value.nextCursor }
          : {})
      };
    }
  }
  return {};
}

function firstPending(plan: InvestigationPlanStep[]) {
  return plan.find((step) => step.status === "pending")?.id;
}

function isTerminal(status: Investigation["status"]) {
  return (
    status === "completed" || status === "no_findings" || status === "failed"
  );
}

async function requiredInvestigation(
  repository: InvestigationRepository,
  id: string
): Promise<Investigation> {
  const investigation = await repository.get(id);
  if (!investigation) throw new Error(`Investigation ${id} was not found`);
  return investigation;
}

function titleFor(question: string) {
  return question.length <= 96 ? question : `${question.slice(0, 93)}...`;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvestigationModelError(`${label} must be an object`, false);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new InvestigationModelError(
      `${label} must be an array with at most ${max} entries`,
      false
    );
  }
  return value;
}

function stringArray(value: unknown, label: string, max: number): string[] {
  return array(value, label, max).map((item, index) =>
    requiredString(item, `${label}[${index}]`, 1_000)
  );
}

function requiredString(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new InvestigationModelError(
      `${label} must be a non-empty string no longer than ${max} characters`,
      false
    );
  }
  return value;
}

function explicitTimestamp(value: unknown, label: string) {
  const timestamp = requiredString(value, label);
  if (
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new InvestigationToolInputError(
      `${label} must be a valid ISO-8601 timestamp with an explicit timezone`
    );
  }
  return new Date(Date.parse(timestamp)).toISOString();
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
