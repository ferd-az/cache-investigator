export type InvestigationStatus =
  | "queued"
  | "running"
  | "completed"
  | "no_findings"
  | "failed";

export type PlanStepStatus = "pending" | "active" | "completed" | "skipped";

export type InvestigationPlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  detail?: string;
};

export type InvestigationScope = {
  service: string;
  environment: "production" | "staging";
  question: string;
  window: {
    from: string;
    to: string;
  };
};

export type InvestigationTrigger = {
  kind: "manual" | "scheduled";
  label: string;
};

export type MetricName =
  | "request_count"
  | "cache_hit_rate"
  | "cache_key_cardinality"
  | "origin_request_count"
  | "origin_error_rate"
  | "response_latency_p99";

export type QueryMetricsInput = {
  metrics: MetricName[];
  from: string;
  to: string;
  interval: "1m" | "5m" | "15m";
  filters?: Record<string, string>;
  groupBy?: "route" | "region" | "deployment" | "has_session_id";
  limit?: number;
};

export type SearchLogsInput = {
  from: string;
  to: string;
  service?: string;
  route?: string;
  status?: number;
  hasSessionId?: boolean;
  cacheStatus?: "HIT" | "MISS";
  cursor?: string;
  limit?: number;
};

export type ListDeploymentsInput = {
  from: string;
  to: string;
  service?: string;
  limit?: number;
};

export type CheckDependencyHealthInput = {
  from: string;
  to: string;
  service: string;
  dependencies?: string[];
};

export type InvestigationToolInput = {
  query_metrics: QueryMetricsInput;
  search_logs: SearchLogsInput;
  list_deployments: ListDeploymentsInput;
  check_dependency_health: CheckDependencyHealthInput;
};

export type InvestigationToolName = keyof InvestigationToolInput;

export type InvestigationToolCall = {
  [Tool in InvestigationToolName]: {
    tool: Tool;
    input: InvestigationToolInput[Tool];
  };
}[InvestigationToolName];

export const investigationToolLimits = {
  query_metrics: {
    maxMetrics: 6,
    maxBuckets: 200,
    maxWindowHours: 24
  },
  search_logs: {
    maxRows: 100,
    maxWindowHours: 2
  },
  list_deployments: {
    maxRows: 20,
    maxWindowHours: 168
  },
  check_dependency_health: {
    maxDependencies: 10,
    maxWindowHours: 24
  }
} as const;

type EventEnvelope = {
  id: string;
  investigationId: string;
  sequence: number;
  at: string;
};

type InvestigationStartedEvent = {
  type: "investigation.started";
  question: string;
};

type PlanUpdatedEvent = {
  type: "plan.updated";
  steps: InvestigationPlanStep[];
};

type ToolStartedEvent = InvestigationToolCall & {
  type: "tool.started";
  callId: string;
  label: string;
};

type ToolProgressEvent = {
  type: "tool.progress";
  callId: string;
  message: string;
  elapsedMs: number;
};

type ToolCompletedEvent = {
  type: "tool.completed";
  callId: string;
  summary: string;
  durationMs: number;
  rowCount?: number;
  nextCursor?: string;
  evidenceIds?: string[];
};

type ToolFailedEvent = {
  type: "tool.failed";
  callId: string;
  message: string;
  durationMs: number;
  attempt: number;
  retryable: boolean;
};

type ObservationAddedEvent = {
  type: "observation.added";
  observationId: string;
  title: string;
  detail: string;
  evidenceIds: string[];
};

type HypothesisUpdatedEvent = {
  type: "hypothesis.updated";
  hypothesisId: string;
  statement: string;
  status: "considering" | "supported" | "weakened" | "ruled_out";
  confidence: number;
  evidenceIds: string[];
};

type InvestigationCompletedEvent = {
  type: "investigation.completed";
  findingId: string;
  summary: string;
};

type InvestigationNoFindingsEvent = {
  type: "investigation.no_findings";
  summary: string;
};

type InvestigationFailedEvent = {
  type: "investigation.failed";
  message: string;
  recoverable: boolean;
};

export type InvestigationEvent = EventEnvelope &
  (
    | InvestigationStartedEvent
    | PlanUpdatedEvent
    | ToolStartedEvent
    | ToolProgressEvent
    | ToolCompletedEvent
    | ToolFailedEvent
    | ObservationAddedEvent
    | HypothesisUpdatedEvent
    | InvestigationCompletedEvent
    | InvestigationNoFindingsEvent
    | InvestigationFailedEvent
  );

export type EvidenceValue = {
  label: string;
  value: number | string;
  unit?: string;
};

export type FindingEvidence = {
  id: string;
  kind: "metric" | "log" | "deployment" | "dependency";
  title: string;
  claim: string;
  source: InvestigationToolCall & {
    callId: string;
  };
  observedAt?: string;
  window?: {
    from: string;
    to: string;
  };
  values: EvidenceValue[];
};

export type FinalFinding = {
  id: string;
  headline: string;
  status: "confirmed" | "likely" | "inconclusive";
  summary: string;
  impact: {
    startedAt: string;
    summary: string;
    affectedRoutes: string[];
    indicators: EvidenceValue[];
  };
  rootCause: {
    summary: string;
    change: string;
    mechanism: string[];
  };
  confidence: {
    level: "high" | "medium" | "low";
    score: number;
    rationale: string;
  };
  recommendation: {
    immediate: string;
    verify: string;
    followUps: string[];
  };
  evidence: FindingEvidence[];
  alternativesRuledOut: Array<{
    hypothesis: string;
    reason: string;
    evidenceIds: string[];
  }>;
};

export type Investigation = {
  id: string;
  title: string;
  status: InvestigationStatus;
  trigger: InvestigationTrigger;
  scope: InvestigationScope;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  plan: InvestigationPlanStep[];
  events: InvestigationEvent[];
  finding?: FinalFinding;
};

export type InvestigationAgentState = {
  activeInvestigation: Investigation | null;
};
