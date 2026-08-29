import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { seedTelemetryCorpus } from "../../simulator/seed-d1.ts";
import type { FinalFinding, InvestigationToolCall } from "./contracts.ts";
import { D1InvestigationRepository } from "./repository.ts";
import {
  InvestigationChaosDisabledError,
  InvestigationModelResponseError,
  InvestigationStartConflictError,
  investigationRunLimits,
  investigationStallLimits,
  isToolHistoryEntry,
  prepareInvestigation,
  reconcileStalledInvestigation,
  resolveInvestigationStart,
  runInvestigation,
  type InvestigationCheckpoint,
  type InvestigationModel,
  type InvestigationModelContext,
  type InvestigationModelDecision,
  type InvestigationToolHistoryEntry
} from "./runtime.ts";
import {
  buildAnthropicModelMessages,
  modelContextProjectionLimits,
  projectToolResultForModel
} from "./anthropic-model.ts";
import {
  executeInvestigationTool,
  type CheckDependencyHealthResult,
  type ListDeploymentsResult,
  type QueryMetricsResult,
  type SearchLogsResult
} from "../telemetry/tools.ts";

const scope = {
  service: "catalog-edge",
  environment: "production" as const,
  question:
    "Why did catalog-edge latency and origin errors rise during this window?",
  window: {
    from: "2026-08-26T14:00:00.000Z",
    to: "2026-08-26T16:00:00.000Z"
  }
};

let miniflare: Miniflare;
let db: D1Database;
let repository: D1InvestigationRepository;

before(
  async () => {
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: "2026-06-11",
        modules: true,
        script: "export default { fetch() { return new Response('ok') } }",
        d1Databases: { TELEMETRY_DB: "cache-investigator-runtime-test" }
      })
    );
    db = await miniflare.getD1Database("TELEMETRY_DB");
    for (const migrationName of [
      "0001_telemetry.sql",
      "0002_investigations.sql",
      "0003_interrupt_deliveries.sql"
    ]) {
      const migration = await readFile(
        fileURLToPath(
          new URL(`../../migrations/${migrationName}`, import.meta.url)
        ),
        "utf8"
      );
      const statements = migration
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    await seedTelemetryCorpus(db);
    repository = new D1InvestigationRepository(db);
  },
  { timeout: 180_000 }
);

after(async () => {
  await miniflare.dispose();
});

test("start is stable and rejects idempotency-key scope drift", async () => {
  const first = await prepareInvestigation(repository, {
    idempotencyKey: "happy-path",
    scope
  });
  const duplicate = await prepareInvestigation(repository, {
    idempotencyKey: "happy-path",
    scope
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.investigation.id, first.investigation.id);
  assert.equal(duplicate.investigation.status, "queued");

  await assert.rejects(
    () =>
      prepareInvestigation(repository, {
        idempotencyKey: "happy-path",
        scope: { ...scope, question: "A different question" }
      }),
    InvestigationStartConflictError
  );
  await assert.rejects(
    () =>
      prepareInvestigation(repository, {
        idempotencyKey: "chaos-disabled",
        scope,
        chaos: "slow"
      }),
    InvestigationChaosDisabledError
  );
});

test("persisted runs can be listed as lightweight summaries", async () => {
  const prepared = await prepareInvestigation(
    repository,
    {
      idempotencyKey: "list-summary",
      scope
    },
    new Date("2026-08-28T12:00:00.000Z")
  );
  const summaries = await repository.list();
  const summary = summaries.find(
    (candidate) => candidate.id === prepared.investigation.id
  );

  assert.ok(summary);
  assert.equal(summary.status, "queued");
  assert.equal(summary.scope.service, scope.service);
  assert.equal(summary.createdAt, "2026-08-28T12:00:00.000Z");
  assert.equal("events" in summary, false);
  assert.equal("plan" in summary, false);
  assert.equal("finding" in summary, false);
});

test(
  "a resumed multi-step run recovers the cache regression with ordered durable evidence",
  { timeout: 180_000 },
  async () => {
    const prepared = await prepareInvestigation(repository, {
      idempotencyKey: "happy-path",
      scope
    });
    const model = new EvidenceDrivenFakeModel();
    let interrupted = false;
    let failSearchOnce = true;
    const executeTool = async (call: InvestigationToolCall) => {
      if (call.tool === "search_logs" && failSearchOnce) {
        failSearchOnce = false;
        throw new Error("temporary D1 read failure");
      }
      return executeInvestigationTool(db, call);
    };

    await assert.rejects(
      () =>
        runInvestigation(prepared.investigation.id, {
          repository,
          model,
          executeTool,
          onCheckpoint(checkpoint) {
            if (
              !interrupted &&
              checkpoint.pending?.type === "tool" &&
              checkpoint.pending.turn === 4
            ) {
              interrupted = true;
              throw new SimulatedInterruption();
            }
          }
        }),
      SimulatedInterruption
    );

    const checkpoint = await repository.loadCheckpoint<InvestigationCheckpoint>(
      prepared.investigation.id
    );
    assert.equal(checkpoint?.pending?.type, "tool");
    assert.equal(checkpoint?.turn, 4);
    const runningDuplicate = await prepareInvestigation(repository, {
      idempotencyKey: "happy-path",
      scope
    });
    assert.equal(runningDuplicate.created, false);
    assert.equal(runningDuplicate.investigation.status, "running");

    const completed = await runInvestigation(prepared.investigation.id, {
      repository,
      model,
      executeTool
    });

    assert.equal(completed.status, "completed");
    assert.ok(completed.finding);
    assert.match(completed.finding.headline, /cache-key change/i);
    assert.match(completed.finding.rootCause.change, /session_id/i);
    assert.ok(
      completed.finding.rootCause.mechanism.some((step) =>
        /session_id/i.test(step)
      )
    );
    assert.match(completed.finding.summary, /origin/i);
    assert.match(completed.finding.summary, /latency/i);
    assert.equal(completed.finding.impact.indicators.length, 3);
    assert.deepEqual(
      completed.finding.impact.indicators.map((indicator) => indicator.unit),
      ["%", "%", "ms"]
    );
    assert.ok(
      completed.finding.alternativesRuledOut.some((alternative) =>
        /bot burst/i.test(alternative.hypothesis)
      )
    );
    assert.ok(
      completed.finding.alternativesRuledOut.some((alternative) =>
        /dependenc/i.test(alternative.hypothesis)
      )
    );
    assert.deepEqual(
      completed.events.map((event) => event.sequence),
      completed.events.map((_, index) => index + 1)
    );
    assert.equal(
      new Set(completed.events.map((event) => event.id)).size,
      completed.events.length
    );

    const failedAttempt = completed.events.find(
      (event) => event.type === "tool.failed"
    );
    assert.ok(failedAttempt && failedAttempt.retryable);
    const completedCalls = completed.events.filter(
      (event) => event.type === "tool.completed"
    );
    assert.equal(completedCalls.length, 7);
    assert.equal(
      completed.events.filter((event) => event.type === "tool.progress").length,
      0
    );
    assert.equal(
      new Set(completedCalls.map((event) => event.callId)).size,
      completedCalls.length
    );

    const evidenceKinds = new Set(
      completed.finding.evidence.map((item) => item.kind)
    );
    assert.deepEqual(
      evidenceKinds,
      new Set(["metric", "log", "deployment", "dependency"])
    );
    assert.ok(
      completed.finding.evidence.some(
        (item) =>
          item.kind === "deployment" &&
          item.values.some((entry) => entry.value === "catalog-edge-v42")
      )
    );
    for (const evidence of completed.finding.evidence) {
      assert.ok(
        completedCalls.some(
          (event) =>
            event.callId === evidence.source.callId &&
            event.evidenceIds?.includes(evidence.id)
        )
      );
    }
  }
);

test(
  "overlong or repeated final copy is rejected before a concise finding completes",
  { timeout: 180_000 },
  async () => {
    const prepared = await prepareInvestigation(repository, {
      idempotencyKey: "editorial-final-retries",
      scope
    });
    const model = new EvidenceDrivenFakeModel((finding, attempt) => {
      if (attempt === 1) {
        return {
          ...finding,
          impact: {
            ...finding.impact,
            indicators: [
              ...finding.impact.indicators,
              value("origin requests", 908, "requests_per_minute")
            ]
          }
        };
      }
      if (attempt === 2) {
        return {
          ...finding,
          rootCause: {
            ...finding.rootCause,
            summary: finding.rootCause.change
          }
        };
      }
      return finding;
    });

    const completed = await runInvestigation(prepared.investigation.id, {
      repository,
      model,
      executeTool: (call) => executeInvestigationTool(db, call)
    });

    assert.equal(completed.status, "completed");
    assert.equal(model.finalFindingAttempts, 3);
    const editorialFailures = completed.events.filter(
      (event) => event.type === "model.failed"
    );
    assert.equal(editorialFailures.length, 2);
    assert.match(editorialFailures[0].message, /between 1 and 3 entries/);
    assert.match(editorialFailures[1].message, /repeat the same copy/);
  }
);

test("the server-owned tool budget terminates an unbounded model", async () => {
  const prepared = await prepareInvestigation(repository, {
    idempotencyKey: "tool-cap",
    scope
  });
  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: new EndlessMetricsModel(),
    executeTool: async () => ({
      from: scope.window.from,
      to: scope.window.to,
      interval: "15m",
      units: { request_count: "requests" },
      points: []
    })
  });
  assert.equal(completed.status, "failed");
  const terminalEvent = completed.events.at(-1);
  assert.match(
    terminalEvent?.type === "investigation.failed" ? terminalEvent.message : "",
    /10-tool-call limit/
  );
  assert.equal(
    completed.events.filter((event) => event.type === "tool.completed").length,
    10
  );
});

test("the server-owned turn budget terminates a resumed over-budget run", async () => {
  const prepared = await prepareInvestigation(repository, {
    idempotencyKey: "turn-cap",
    scope
  });
  await repository.saveCheckpoint(prepared.investigation.id, {
    version: 1,
    turn: 14,
    toolCalls: 0,
    modelFailures: 0,
    invalidFinalAttempts: 0,
    history: [],
    chaos: {
      mode: "none",
      step6FailureInjected: false,
      slowDelayCompleted: false
    }
  } satisfies InvestigationCheckpoint);
  const neverCalled: InvestigationModel = {
    async next() {
      throw new Error("The model must not run after the turn cap");
    }
  };
  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: neverCalled,
    executeTool: async () => {
      throw new Error("No tool should run after the turn cap");
    }
  });
  assert.equal(completed.status, "failed");
  const terminalEvent = completed.events.at(-1);
  assert.match(
    terminalEvent?.type === "investigation.failed" ? terminalEvent.message : "",
    /14-turn limit/
  );
});

test("invalid final findings stop after the bounded retry budget", async () => {
  const prepared = await prepareInvestigation(repository, {
    idempotencyKey: "invalid-final-cap",
    scope
  });
  let modelCalls = 0;
  const rejectionsSeen: number[] = [];
  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: {
      async next(context) {
        modelCalls += 1;
        const rejections = context.history.flatMap((entry) =>
          entry.kind === "rejected_final" ? [entry] : []
        );
        rejectionsSeen.push(rejections.length);
        for (const rejection of rejections) {
          assert.equal(rejection.responseText, "{}");
          assert.match(rejection.reason, /finding\.evidence/);
        }
        return { type: "final", finding: {} };
      }
    },
    executeTool: async () => {
      throw new Error("No tool should run for an invalid final finding");
    }
  });

  assert.equal(completed.status, "failed");
  assert.equal(modelCalls, investigationRunLimits.maxInvalidFinalAttempts);
  assert.deepEqual(rejectionsSeen, [0, 1, 2]);
  const failures = completed.events.filter(
    (event) => event.type === "model.failed"
  );
  assert.equal(failures.length, investigationRunLimits.maxInvalidFinalAttempts);
  assert.deepEqual(
    failures.map((event) => event.attempt),
    [1, 2, 3]
  );
  assert.deepEqual(
    failures.map((event) => event.retryable),
    [true, true, false]
  );
  const terminalEvent = completed.events.at(-1);
  assert.match(
    terminalEvent?.type === "investigation.failed" ? terminalEvent.message : "",
    /repeatedly returned an invalid final finding/
  );
});

test("unparseable final responses feed back as rejections within the same budget", async () => {
  const prepared = await prepareInvestigation(repository, {
    idempotencyKey: "unparseable-final-cap",
    scope
  });
  const replayedTexts: string[][] = [];
  const failed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: {
      async next(context) {
        replayedTexts.push(
          context.history.flatMap((entry) =>
            entry.kind === "rejected_final" ? [entry.responseText] : []
          )
        );
        throw new InvestigationModelResponseError(
          "The model response was not valid JSON; reply with only the JSON envelope",
          `prose attempt ${replayedTexts.length}`
        );
      }
    },
    executeTool: async () => {
      throw new Error("No tool should run for an unparseable final response");
    }
  });

  assert.equal(failed.status, "failed");
  assert.deepEqual(replayedTexts, [
    [],
    ["prose attempt 1"],
    ["prose attempt 1", "prose attempt 2"]
  ]);
  const failures = failed.events.filter(
    (event) => event.type === "model.failed"
  );
  assert.equal(failures.length, investigationRunLimits.maxInvalidFinalAttempts);
  assert.ok(failures.every((event) => /not valid JSON/.test(event.message)));
  const terminal = failed.events.at(-1);
  assert.match(
    terminal?.type === "investigation.failed" ? terminal.message : "",
    /repeatedly returned an invalid final finding/
  );
});

test("a silent running investigation is resumed, then honestly failed, by reads", async () => {
  const createdAt = new Date("2026-08-28T10:00:00.000Z");
  const prepared = await prepareInvestigation(
    repository,
    { idempotencyKey: "stall-reconciliation", scope },
    createdAt
  );
  const startedAt = "2026-08-28T10:00:05.000Z";
  await repository.appendEvent(
    prepared.investigation.id,
    "investigation.started",
    startedAt,
    { type: "investigation.started", question: scope.question }
  );
  await repository.patch(prepared.investigation.id, {
    status: "running",
    startedAt
  });

  const fresh = await reconcileStalledInvestigation(
    repository,
    prepared.investigation.id,
    {
      now: () => new Date("2026-08-28T10:01:00.000Z"),
      resume: async () => {
        throw new Error("A fresh run must not be resumed");
      }
    }
  );
  assert.equal(fresh?.action, "none");
  assert.equal(fresh?.investigation.status, "running");

  let resumed = false;
  const silent = await reconcileStalledInvestigation(
    repository,
    prepared.investigation.id,
    {
      now: () =>
        new Date(
          Date.parse(startedAt) + investigationStallLimits.resumeAfterMs + 1_000
        ),
      resume: async () => {
        resumed = true;
      }
    }
  );
  assert.equal(silent?.action, "resumed");
  assert.equal(resumed, true);
  assert.equal(silent?.investigation.status, "running");

  const dead = await reconcileStalledInvestigation(
    repository,
    prepared.investigation.id,
    {
      now: () =>
        new Date(
          Date.parse(startedAt) + investigationStallLimits.failAfterMs + 60_000
        ),
      resume: async () => {
        throw new Error("A hard-stalled run must be failed, not resumed");
      }
    }
  );
  assert.equal(dead?.action, "failed");
  assert.equal(dead?.investigation.status, "failed");
  const terminal = dead?.investigation.events.at(-1);
  assert.ok(terminal && terminal.type === "investigation.failed");
  assert.match(terminal.message, /stalled/);
  assert.match(terminal.message, /made no progress/);
  assert.equal(terminal.recoverable, false);

  const afterFailure = await reconcileStalledInvestigation(
    repository,
    prepared.investigation.id,
    {
      now: () => new Date("2026-08-29T10:00:00.000Z"),
      resume: async () => {
        throw new Error("A terminal run must not be resumed");
      }
    }
  );
  assert.equal(afterFailure?.action, "none");
  assert.equal(afterFailure?.investigation.status, "failed");
});

test("stable per-run identities keep a completed run isolated from an active run", async () => {
  const completedStart = await resolveInvestigationStart({
    idempotencyKey: "happy-path",
    scope
  });
  const activePrepared = await prepareInvestigation(repository, {
    idempotencyKey: "isolated-active-run",
    scope: { ...scope, question: "Investigate this independent active run" }
  });
  const activeStart = await resolveInvestigationStart({
    idempotencyKey: "isolated-active-run",
    scope: { ...scope, question: "Investigate this independent active run" }
  });
  assert.notEqual(activeStart.id, completedStart.id);
  assert.equal(activeStart.id, activePrepared.investigation.id);

  await assert.rejects(
    () =>
      runInvestigation(activePrepared.investigation.id, {
        repository,
        model: new EndlessMetricsModel(),
        executeTool: async () => ({
          from: scope.window.from,
          to: scope.window.to,
          interval: "15m",
          units: { request_count: "requests" },
          points: []
        }),
        onCheckpoint(checkpoint) {
          if (checkpoint.pending?.type === "tool") {
            throw new SimulatedInterruption();
          }
        }
      }),
    SimulatedInterruption
  );

  const completed = await repository.get(completedStart.id);
  const active = await repository.get(activeStart.id);
  assert.equal(completed?.status, "completed");
  assert.equal(active?.status, "running");
  assert.equal(completed?.id, completedStart.id);
  assert.equal(active?.id, activeStart.id);
  assert.notEqual(completed?.events.length, active?.events.length);
});

test("fatal chaos preserves partial work and ends with an honest failure", async () => {
  const prepared = await prepareInvestigation(
    repository,
    { idempotencyKey: "chaos-fatal", scope, chaos: "fatal" },
    new Date(),
    { allowChaos: true }
  );
  const failed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: new EvidenceDrivenFakeModel(),
    executeTool: (call) => executeInvestigationTool(db, call)
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.configuration.chaos, "fatal");
  assert.equal(
    failed.events.filter((event) => event.type === "tool.completed").length,
    3
  );
  const toolFailure = failed.events.find(
    (event) =>
      event.type === "tool.failed" &&
      event.message.includes("telemetry source became unavailable")
  );
  assert.ok(toolFailure && toolFailure.type === "tool.failed");
  assert.equal(toolFailure.retryable, false);
  const terminal = failed.events.at(-1);
  assert.match(
    terminal?.type === "investigation.failed" ? terminal.message : "",
    /stopped after a required telemetry source became unavailable/
  );
});

test("no-findings chaos ends deterministically after persisted checks", async () => {
  const prepared = await prepareInvestigation(
    repository,
    {
      idempotencyKey: "chaos-no-findings",
      scope,
      chaos: "no-findings"
    },
    new Date(),
    { allowChaos: true }
  );
  const model = new EvidenceDrivenFakeModel();
  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model,
    executeTool: (call) => executeInvestigationTool(db, call)
  });

  assert.equal(completed.status, "no_findings");
  assert.equal(completed.configuration.chaos, "no-findings");
  assert.equal(model.finalFindingAttempts, 0);
  assert.equal(
    completed.events.filter((event) => event.type === "tool.completed").length,
    3
  );
  const terminal = completed.events.at(-1);
  assert.match(
    terminal?.type === "investigation.no_findings" ? terminal.summary : "",
    /no actionable cache regression/
  );
});

test("invalid-final chaos deterministically exhausts final validation", async () => {
  const prepared = await prepareInvestigation(
    repository,
    {
      idempotencyKey: "chaos-invalid-final",
      scope,
      chaos: "invalid-final"
    },
    new Date(),
    { allowChaos: true }
  );
  const model = new EvidenceDrivenFakeModel();
  const failed = await runInvestigation(prepared.investigation.id, {
    repository,
    model,
    executeTool: (call) => executeInvestigationTool(db, call)
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.configuration.chaos, "invalid-final");
  assert.equal(model.finalFindingAttempts, 0);
  assert.equal(
    failed.events.filter((event) => event.type === "tool.completed").length,
    3
  );
  const rejectedFinals = failed.events.filter(
    (event) => event.type === "model.failed"
  );
  assert.equal(
    rejectedFinals.length,
    investigationRunLimits.maxInvalidFinalAttempts
  );
  assert.ok(
    rejectedFinals.every((event) => /finding\.evidence/.test(event.message))
  );
  const terminal = failed.events.at(-1);
  assert.match(
    terminal?.type === "investigation.failed" ? terminal.message : "",
    /repeatedly returned an invalid final finding/
  );
});

test(
  "step6 chaos persists one recoverable failure across interruption and resume",
  { timeout: 180_000 },
  async () => {
    const prepared = await prepareInvestigation(
      repository,
      { idempotencyKey: "chaos-step6", scope, chaos: "step6" },
      new Date(),
      { allowChaos: true }
    );
    let interrupted = false;
    await assert.rejects(
      () =>
        runInvestigation(prepared.investigation.id, {
          repository,
          model: new EvidenceDrivenFakeModel(),
          executeTool: (call) => executeInvestigationTool(db, call),
          onCheckpoint(checkpoint) {
            if (
              !interrupted &&
              checkpoint.chaos.step6FailureInjected &&
              checkpoint.pending?.type === "tool"
            ) {
              interrupted = true;
              throw new SimulatedInterruption();
            }
          }
        }),
      SimulatedInterruption
    );

    const interruptedCheckpoint =
      await repository.loadCheckpoint<InvestigationCheckpoint>(
        prepared.investigation.id
      );
    assert.equal(interruptedCheckpoint?.chaos.mode, "step6");
    assert.equal(interruptedCheckpoint?.chaos.step6FailureInjected, true);
    assert.equal(interruptedCheckpoint?.pending?.type, "tool");

    const completed = await runInvestigation(prepared.investigation.id, {
      repository,
      model: new EvidenceDrivenFakeModel(),
      executeTool: (call) => executeInvestigationTool(db, call)
    });
    assert.equal(completed.status, "completed");
    assert.match(completed.finding?.rootCause.change ?? "", /session_id/i);
    const injectedFailure = completed.events.find(
      (event) =>
        event.type === "tool.failed" &&
        event.message === "Injected recoverable step6 tool failure"
    );
    assert.ok(injectedFailure && injectedFailure.type === "tool.failed");
    assert.equal(injectedFailure.retryable, true);
    assert.equal(injectedFailure.attempt, 1);
    assert.equal(
      completed.events.filter(
        (event) =>
          event.type === "tool.failed" &&
          event.message === "Injected recoverable step6 tool failure"
      ).length,
      1
    );
  }
);

test("slow chaos resumes its persisted delay and emits truthful progress", async () => {
  const prepared = await prepareInvestigation(
    repository,
    { idempotencyKey: "chaos-slow", scope, chaos: "slow" },
    new Date("2026-08-27T00:00:00.000Z"),
    { allowChaos: true }
  );
  let currentMs = Date.parse("2026-08-27T00:00:00.000Z");
  const now = () => new Date(currentMs);
  let interrupted = false;
  await assert.rejects(
    () =>
      runInvestigation(prepared.investigation.id, {
        repository,
        model: new SingleMetricModel(),
        executeTool: (call) => executeInvestigationTool(db, call),
        now,
        slowDelayMs: 1_000,
        sleep: async (milliseconds) => {
          currentMs += milliseconds;
        },
        onCheckpoint(checkpoint) {
          if (
            !interrupted &&
            checkpoint.chaos.slowDelayStartedAt &&
            !checkpoint.chaos.slowDelayCompleted
          ) {
            interrupted = true;
            throw new SimulatedInterruption();
          }
        }
      }),
    SimulatedInterruption
  );

  const persisted = await repository.loadCheckpoint<InvestigationCheckpoint>(
    prepared.investigation.id
  );
  assert.equal(persisted?.chaos.mode, "slow");
  assert.ok(persisted?.chaos.slowDelayStartedAt);
  assert.equal(persisted?.chaos.slowDelayCompleted, false);

  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model: new SingleMetricModel(),
    executeTool: (call) => executeInvestigationTool(db, call),
    now,
    slowDelayMs: 1_000,
    sleep: async (milliseconds) => {
      currentMs += milliseconds;
    }
  });
  assert.equal(completed.status, "no_findings");
  assert.equal(completed.configuration.chaos, "slow");
  const progress = completed.events.filter(
    (event) => event.type === "tool.progress"
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].elapsedMs, 1_000);
  assert.match(progress[0].message, /delay completed/i);
});

test("maximum log evidence stays complete while model context is honestly compacted", async () => {
  const prepared = await prepareInvestigation(repository, {
    idempotencyKey: "context-projection",
    scope
  });
  const model = new MaxLogsProjectionModel();
  const completed = await runInvestigation(prepared.investigation.id, {
    repository,
    model,
    executeTool: (call) => executeInvestigationTool(db, call)
  });
  assert.equal(completed.status, "no_findings");
  assert.ok(model.projection);
  assert.equal(model.projection.projection.originalRowCount, 100);
  assert.ok(model.projection.projection.includedRowCount <= 12);
  assert.ok(model.projection.projection.omittedRowCount > 0);
  assert.match(
    model.projection.projection.note,
    /complete result remains stored/
  );
  assert.equal(model.projection.callId, "call:1:search_logs");
  assert.ok(
    JSON.stringify(model.projection).length <=
      modelContextProjectionLimits.maxSerializedCharacters
  );

  const checkpoint = await repository.loadCheckpoint<InvestigationCheckpoint>(
    prepared.investigation.id
  );
  const persistedEntry = checkpoint?.history[0];
  assert.ok(persistedEntry && isToolHistoryEntry(persistedEntry));
  const persistedResult = persistedEntry.result as SearchLogsResult;
  assert.equal(persistedResult.rows.length, 100);
  const completion = completed.events.find(
    (event) => event.type === "tool.completed"
  );
  assert.ok(completion && completion.result);
  assert.equal((completion.result as SearchLogsResult).rows.length, 100);
  assert.equal(completion.callId, model.projection.callId);
});

class SimulatedInterruption extends Error {}

class EndlessMetricsModel implements InvestigationModel {
  async next(): Promise<InvestigationModelDecision> {
    return {
      type: "tool",
      rationale: "Keep querying",
      call: {
        tool: "query_metrics",
        input: {
          metrics: ["request_count"],
          ...scope.window,
          interval: "15m"
        }
      }
    };
  }
}

class SingleMetricModel implements InvestigationModel {
  async next(
    context: InvestigationModelContext
  ): Promise<InvestigationModelDecision> {
    if (context.history.length > 0) {
      return {
        type: "no_findings",
        summary: "The single diagnostic query completed without a finding."
      };
    }
    return tool("Run one diagnostic metric query", {
      tool: "query_metrics",
      input: {
        metrics: ["request_count"],
        from: "2026-08-26T14:00:00.000Z",
        to: "2026-08-26T14:05:00.000Z",
        interval: "5m"
      }
    });
  }
}

class MaxLogsProjectionModel implements InvestigationModel {
  projection?: ReturnType<typeof projectToolResultForModel>;

  async next(
    context: InvestigationModelContext
  ): Promise<InvestigationModelDecision> {
    if (context.history.length === 0) {
      return tool("Load the maximum bounded log page", {
        tool: "search_logs",
        input: {
          from: "2026-08-26T14:20:00.000Z",
          to: "2026-08-26T14:30:00.000Z",
          service: "catalog-edge",
          route: "/products",
          limit: 100
        }
      });
    }
    const first = context.history[0];
    assert.ok(isToolHistoryEntry(first));
    assert.equal((first.result as SearchLogsResult).rows.length, 100);
    this.projection = projectToolResultForModel(first);
    const messages = buildAnthropicModelMessages(context);
    const resultMessage = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          message.content.some((block) => block.type === "tool_result")
      );
    assert.ok(resultMessage);
    const resultBlock = resultMessage.content.find(
      (block) => block.type === "tool_result"
    );
    assert.ok(resultBlock);
    assert.equal(typeof resultBlock.content, "string");
    const messageProjection = JSON.parse(
      resultBlock.content as string
    ) as ReturnType<typeof projectToolResultForModel>;
    assert.deepEqual(messageProjection, this.projection);
    return {
      type: "no_findings",
      summary:
        "Context projection was verified without discarding persisted logs."
    };
  }
}

class EvidenceDrivenFakeModel implements InvestigationModel {
  finalFindingAttempts = 0;
  private readonly transformFinding: (
    finding: FinalFinding,
    attempt: number
  ) => unknown;

  constructor(
    transformFinding: (finding: FinalFinding, attempt: number) => unknown = (
      finding
    ) => finding
  ) {
    this.transformFinding = transformFinding;
  }

  async next(
    context: InvestigationModelContext
  ): Promise<InvestigationModelDecision> {
    const completed = context.history
      .filter(isToolHistoryEntry)
      .filter((entry) => entry.result !== undefined);
    switch (completed.length) {
      case 0:
        return tool("Establish the incident timeline", {
          tool: "query_metrics",
          input: {
            metrics: [
              "cache_hit_rate",
              "origin_request_count",
              "origin_error_rate",
              "response_latency_p99"
            ],
            from: "2026-08-26T14:00:00.000Z",
            to: "2026-08-26T15:00:00.000Z",
            interval: "5m"
          }
        });
      case 1:
        return tool("Localize the affected route", {
          tool: "query_metrics",
          input: {
            metrics: ["cache_hit_rate", "origin_error_rate"],
            from: "2026-08-26T14:15:00.000Z",
            to: "2026-08-26T14:45:00.000Z",
            interval: "5m",
            groupBy: "route"
          }
        });
      case 2:
        return tool("Compare session-bearing cache behavior", {
          tool: "query_metrics",
          input: {
            metrics: ["cache_hit_rate", "cache_key_cardinality"],
            from: "2026-08-26T14:20:00.000Z",
            to: "2026-08-26T14:40:00.000Z",
            interval: "5m",
            filters: { route: "/products" },
            groupBy: "has_session_id"
          }
        });
      case 3:
        return tool("Inspect session-bearing cache misses", {
          tool: "search_logs",
          input: {
            from: "2026-08-26T14:20:00.000Z",
            to: "2026-08-26T14:30:00.000Z",
            service: "catalog-edge",
            route: "/products",
            hasSessionId: true,
            cacheStatus: "MISS",
            limit: 5
          }
        });
      case 4:
        return tool("Correlate the change with a deployment", {
          tool: "list_deployments",
          input: {
            from: "2026-08-26T13:30:00.000Z",
            to: "2026-08-26T15:00:00.000Z",
            service: "catalog-edge"
          }
        });
      case 5:
        return tool("Check downstream dependency health", {
          tool: "check_dependency_health",
          input: {
            from: "2026-08-26T14:00:00.000Z",
            to: "2026-08-26T15:00:00.000Z",
            service: "catalog-edge"
          }
        });
      case 6:
        return tool("Test the transient traffic alternative", {
          tool: "query_metrics",
          input: {
            metrics: ["request_count", "cache_hit_rate"],
            from: "2026-08-26T14:05:00.000Z",
            to: "2026-08-26T14:16:00.000Z",
            interval: "1m"
          }
        });
      default:
        this.finalFindingAttempts += 1;
        return {
          type: "final",
          finding: this.transformFinding(
            buildFinding(completed),
            this.finalFindingAttempts
          )
        };
    }
  }
}

function tool(
  rationale: string,
  call: InvestigationToolCall
): InvestigationModelDecision {
  return { type: "tool", rationale, call };
}

function buildFinding(history: InvestigationToolHistoryEntry[]): FinalFinding {
  const overview = history[0].result as QueryMetricsResult;
  const routes = history[1].result as QueryMetricsResult;
  const sessions = history[2].result as QueryMetricsResult;
  const logs = history[3].result as SearchLogsResult;
  const deployments = history[4].result as ListDeploymentsResult;
  const dependencies = history[5].result as CheckDependencyHealthResult;
  const decoy = history[6].result as QueryMetricsResult;
  const regressed = overview.points.find(
    (point) => point.bucketStart === "2026-08-26T14:25:00.000Z"
  )!;
  const affected = routes.points.find(
    (point) =>
      point.bucketStart === "2026-08-26T14:25:00.000Z" &&
      point.group === "/products"
  )!;
  const session = sessions.points.find(
    (point) =>
      point.bucketStart === "2026-08-26T14:25:00.000Z" && point.group === true
  )!;
  const deployment = deployments.deployments[0];
  const sample = logs.rows[0];
  const peak = decoy.points.find(
    (point) => point.bucketStart === "2026-08-26T14:09:00.000Z"
  )!;
  const recovered = decoy.points.find(
    (point) => point.bucketStart === "2026-08-26T14:15:00.000Z"
  )!;
  const evidence = history.map((entry, index) => ({
    id: entry.evidenceId,
    kind:
      entry.call.tool === "query_metrics"
        ? ("metric" as const)
        : entry.call.tool === "search_logs"
          ? ("log" as const)
          : entry.call.tool === "list_deployments"
            ? ("deployment" as const)
            : ("dependency" as const),
    title: `Evidence ${index + 1}: ${entry.call.tool}`,
    claim: evidenceClaim(index),
    source: { ...entry.call, callId: entry.callId },
    window: { from: scope.window.from, to: scope.window.to },
    values: evidenceValues(index, {
      regressed,
      affected,
      session,
      sample,
      deployment,
      dependencies,
      peak,
      recovered
    })
  }));

  return {
    id: "model-proposed-id",
    headline: "A cache-key change is overloading the catalog origin",
    status: "confirmed",
    summary:
      "A cache-key change fragmented /products responses by session_id, overloading the origin and increasing errors and latency.",
    impact: {
      startedAt: "2026-08-26T14:20:00.000Z",
      summary:
        "The regression affected /products while other routes remained healthy.",
      affectedRoutes: ["/products"],
      indicators: [
        value("cache hit rate", regressed.values.cache_hit_rate, "percent"),
        value(
          "origin error rate",
          regressed.values.origin_error_rate,
          "percent"
        ),
        value(
          "response latency p99",
          regressed.values.response_latency_p99,
          "milliseconds"
        )
      ]
    },
    rootCause: {
      summary:
        "Each session produced a separate cache entry, driving misses to the origin.",
      change: `${deployment.version} stopped stripping session_id from /products cache keys.`,
      mechanism: [
        `Session-bearing requests produced ${session.values.cache_key_cardinality} keys per five-minute bucket.`,
        `A sampled miss included session_id=${sample.sessionId} in ${sample.cacheKey}.`,
        "The miss amplification drove origin saturation, errors, and latency."
      ]
    },
    confidence: {
      level: "high",
      score: 0.97,
      rationale:
        "Metric segmentation, raw logs, deployment timing, and healthy dependencies converge on one mechanism."
    },
    recommendation: {
      immediate: "Remove session_id from the /products cache key and redeploy.",
      verify:
        "Confirm cache hit rate and key cardinality normalize before origin error and latency indicators recover.",
      followUps: [
        "Add cache-key cardinality alerts by route.",
        "Regression-test cache-key parameter allowlists."
      ]
    },
    evidence,
    alternativesRuledOut: [
      {
        hypothesis: "The earlier bot burst caused the sustained incident",
        reason: `Traffic recovered from ${peak.values.request_count} to ${recovered.values.request_count} requests per minute before the later regression.`,
        evidenceIds: [history[6].evidenceId]
      },
      {
        hypothesis: "A downstream dependency degraded",
        reason: "All sampled downstream dependencies remained healthy.",
        evidenceIds: [history[5].evidenceId]
      }
    ]
  };
}

function evidenceClaim(index: number) {
  return [
    "Cache hit rate fell as origin demand, errors, and p99 latency rose.",
    "The regression was isolated to /products.",
    "Session-bearing /products requests had low hit rate and high key cardinality.",
    "Session-bearing cache misses contain fragmented cache keys.",
    "A cache-key deployment immediately preceded the regression.",
    "Downstream dependencies remained healthy.",
    "The earlier traffic burst recovered before the sustained incident."
  ][index];
}

function evidenceValues(
  index: number,
  evidence: {
    regressed: QueryMetricsResult["points"][number];
    affected: QueryMetricsResult["points"][number];
    session: QueryMetricsResult["points"][number];
    sample: SearchLogsResult["rows"][number];
    deployment: ListDeploymentsResult["deployments"][number];
    dependencies: CheckDependencyHealthResult;
    peak: QueryMetricsResult["points"][number];
    recovered: QueryMetricsResult["points"][number];
  }
) {
  switch (index) {
    case 0:
      return [
        value(
          "cache hit rate",
          evidence.regressed.values.cache_hit_rate,
          "percent"
        )
      ];
    case 1:
      return [
        value(
          "/products hit rate",
          evidence.affected.values.cache_hit_rate,
          "percent"
        )
      ];
    case 2:
      return [
        value(
          "session key cardinality",
          evidence.session.values.cache_key_cardinality,
          "keys"
        )
      ];
    case 3:
      return [value("sample cache status", evidence.sample.cacheStatus)];
    case 4:
      return [value("deployment", evidence.deployment.version)];
    case 5:
      return [
        value(
          "healthy dependencies",
          evidence.dependencies.dependencies.filter((item) => item.healthy)
            .length
        )
      ];
    default:
      return [
        value("burst requests", evidence.peak.values.request_count, "requests"),
        value(
          "recovered requests",
          evidence.recovered.values.request_count,
          "requests"
        )
      ];
  }
}

function value(
  label: string,
  metric: number | string | undefined,
  unit?: string
) {
  assert.notEqual(metric, undefined);
  return { label, value: metric!, ...(unit ? { unit } : {}) };
}
