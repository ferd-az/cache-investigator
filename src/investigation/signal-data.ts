import type { Investigation, MetricName } from "./contracts";
import type {
  DeploymentRecord,
  ListDeploymentsResult,
  QueryMetricsResult
} from "../telemetry/tools";

const PLOTTED_METRICS = new Set<MetricName>([
  "cache_hit_rate",
  "cache_key_cardinality",
  "origin_request_count",
  "response_latency_p99"
]);

export type InvestigationSignalData = {
  series: QueryMetricsResult;
  scopeLabel: string;
  onsetAt?: string;
  markers: Array<{ label: string; at: string }>;
  bands: Array<{ label: string; from: string; to: string }>;
};

type MetricCandidate = {
  callId: string;
  route?: string;
  series: QueryMetricsResult;
  score: number;
};

/**
 * Builds chart input exclusively from persisted tool results belonging to this
 * investigation. Simulator configuration and standalone UI fixtures never
 * participate in this selection.
 */
export function getInvestigationSignalData(
  investigation: Investigation
): InvestigationSignalData | null {
  const starts = new Map(
    investigation.events
      .filter((event) => event.type === "tool.started")
      .map((event) => [event.callId, event])
  );
  const candidates: MetricCandidate[] = [];
  const deployments: DeploymentRecord[] = [];

  for (const event of investigation.events) {
    if (event.type !== "tool.completed" || event.result === undefined) continue;
    const started = starts.get(event.callId);
    if (!started) continue;

    if (
      started.tool === "query_metrics" &&
      started.input.groupBy === undefined &&
      isQueryMetricsResult(event.result) &&
      event.result.points.every((point) => point.group === undefined)
    ) {
      const metrics = availableMetrics(event.result);
      const plottedMetricCount = metrics.filter((metric) =>
        PLOTTED_METRICS.has(metric)
      ).length;
      if (plottedMetricCount > 0) {
        candidates.push({
          callId: event.callId,
          route: started.input.filters?.route,
          series: event.result,
          score:
            plottedMetricCount * 100 +
            (started.input.interval === "1m" ? 20 : 0) +
            (started.input.filters?.route ? 10 : 0)
        });
      }
    }

    if (
      started.tool === "list_deployments" &&
      isListDeploymentsResult(event.result)
    ) {
      deployments.push(...event.result.deployments);
    }
  }

  const candidate = candidates.sort(
    (left, right) => right.score - left.score
  )[0];
  if (!candidate) return null;

  const windowFrom = Date.parse(investigation.scope.window.from);
  const windowTo = Date.parse(investigation.scope.window.to);
  const markers = deployments
    .filter((deployment) => {
      const deployedAt = Date.parse(deployment.deployedAt);
      return deployedAt >= windowFrom && deployedAt < windowTo;
    })
    .map((deployment) => ({
      label: deployment.version,
      at: deployment.deployedAt
    }));

  return {
    series: candidate.series,
    scopeLabel: candidate.route ?? investigation.scope.service,
    onsetAt: nearestObservedBucketStart(
      candidate.series,
      investigation.finding?.impact.startedAt
    ),
    markers,
    bands: detectRuledOutTrafficBurst(investigation, candidate, markers)
  };
}

function nearestObservedBucketStart(
  series: QueryMetricsResult,
  reportedOnset?: string
) {
  if (!reportedOnset || series.points.length === 0) return undefined;
  const target = Date.parse(reportedOnset);
  if (!Number.isFinite(target)) return undefined;

  return series.points.reduce((nearest, point) => {
    const nearestDistance = Math.abs(Date.parse(nearest.bucketStart) - target);
    const pointDistance = Math.abs(Date.parse(point.bucketStart) - target);
    return pointDistance <= nearestDistance ? point : nearest;
  }).bucketStart;
}

function availableMetrics(series: QueryMetricsResult): MetricName[] {
  const metrics = new Set<MetricName>();
  for (const point of series.points) {
    for (const [metric, value] of Object.entries(point.values)) {
      if (typeof value === "number" && isMetricName(metric)) {
        metrics.add(metric);
      }
    }
  }
  return [...metrics];
}

function detectRuledOutTrafficBurst(
  investigation: Investigation,
  candidate: MetricCandidate,
  markers: Array<{ label: string; at: string }>
) {
  const alternative = investigation.finding?.alternativesRuledOut.find(
    (item) =>
      /\b(bot|traffic|burst)\b/i.test(item.hypothesis) &&
      item.evidenceIds.some(
        (evidenceId) =>
          investigation.finding?.evidence.find(
            (evidence) => evidence.id === evidenceId
          )?.source.callId === candidate.callId
      )
  );
  if (!alternative) return [];

  const firstMarkerAt = markers.length
    ? Math.min(...markers.map((marker) => Date.parse(marker.at)))
    : Date.parse(investigation.finding!.impact.startedAt);
  const points = candidate.series.points
    .filter(
      (point) =>
        point.values.request_count !== undefined &&
        Date.parse(point.bucketStart) < firstMarkerAt
    )
    .sort(
      (left, right) =>
        Date.parse(left.bucketStart) - Date.parse(right.bucketStart)
    );
  if (points.length < 4) return [];

  const baseline = median(
    points.map((point) => point.values.request_count as number)
  );
  const elevated = points.filter(
    (point) => (point.values.request_count as number) > baseline * 1.2
  );
  if (elevated.length < 2) return [];

  const intervalMs = intervalToMilliseconds(candidate.series.interval);
  const runs: (typeof elevated)[] = [];
  for (const point of elevated) {
    const current = runs.at(-1);
    const previous = current?.at(-1);
    if (
      !previous ||
      Date.parse(point.bucketStart) - Date.parse(previous.bucketStart) >
        intervalMs
    ) {
      runs.push([point]);
    } else {
      current!.push(point);
    }
  }
  const burst = runs
    .filter((run) => run.length >= 2)
    .sort((left, right) => right.length - left.length)[0];
  if (!burst) return [];

  return [
    {
      label: /\bbot\b/i.test(alternative.hypothesis)
        ? "bot burst"
        : "traffic burst",
      from: burst[0].bucketStart,
      to: burst.at(-1)!.bucketEnd
    }
  ];
}

function isQueryMetricsResult(value: unknown): value is QueryMetricsResult {
  if (!isRecord(value) || !Array.isArray(value.points)) return false;
  if (
    typeof value.from !== "string" ||
    typeof value.to !== "string" ||
    !["1m", "5m", "15m"].includes(String(value.interval)) ||
    !isRecord(value.units)
  ) {
    return false;
  }
  return value.points.every(
    (point) =>
      isRecord(point) &&
      typeof point.bucketStart === "string" &&
      typeof point.bucketEnd === "string" &&
      isRecord(point.values) &&
      Object.values(point.values).every(
        (metricValue) => typeof metricValue === "number"
      ) &&
      (point.group === undefined ||
        typeof point.group === "string" ||
        typeof point.group === "boolean")
  );
}

function isListDeploymentsResult(
  value: unknown
): value is ListDeploymentsResult {
  return (
    isRecord(value) &&
    Array.isArray(value.deployments) &&
    value.deployments.every(
      (deployment) =>
        isRecord(deployment) &&
        typeof deployment.id === "string" &&
        typeof deployment.service === "string" &&
        typeof deployment.environment === "string" &&
        typeof deployment.version === "string" &&
        typeof deployment.commit === "string" &&
        typeof deployment.deployedAt === "string" &&
        Array.isArray(deployment.changes) &&
        deployment.changes.every((change) => typeof change === "string")
    )
  );
}

function isMetricName(value: string): value is MetricName {
  return [
    "request_count",
    "cache_hit_rate",
    "cache_key_cardinality",
    "origin_request_count",
    "origin_error_rate",
    "response_latency_p99"
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intervalToMilliseconds(interval: QueryMetricsResult["interval"]) {
  switch (interval) {
    case "1m":
      return 60_000;
    case "5m":
      return 300_000;
    case "15m":
      return 900_000;
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}
