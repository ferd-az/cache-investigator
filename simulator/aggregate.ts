import type { DependencyTelemetry, RequestTelemetry } from "./generator.ts";

export type RequestFilter = {
  from: string;
  to: string;
  route?: string;
  hasSessionId?: boolean;
};

export type RequestAggregate = {
  requestCount: number;
  requestsPerMinute: number;
  cacheHitRate: number;
  cacheKeyCardinality: number;
  originRequestsPerMinute: number;
  response429Rate: number;
  responseLatencyP99Ms: number;
};

export function aggregateRequests(
  requests: Iterable<RequestTelemetry>,
  filter: RequestFilter
): RequestAggregate {
  const from = Date.parse(filter.from);
  const to = Date.parse(filter.to);
  const durationMinutes = (to - from) / 60_000;
  const cacheKeys = new Set<string>();
  const latencies: number[] = [];
  let requestCount = 0;
  let cacheHits = 0;
  let originRequests = 0;
  let response429s = 0;

  for (const request of requests) {
    const timestamp = Date.parse(request.timestamp);
    if (timestamp < from || timestamp >= to) continue;
    if (filter.route && request.route !== filter.route) continue;
    if (
      filter.hasSessionId !== undefined &&
      request.hasSessionId !== filter.hasSessionId
    ) {
      continue;
    }

    requestCount += 1;
    if (request.cacheStatus === "HIT") cacheHits += 1;
    if (request.originRequest) originRequests += 1;
    if (request.responseStatus === 429) response429s += 1;
    cacheKeys.add(request.cacheKey);
    latencies.push(request.responseLatencyMs);
  }

  return {
    requestCount,
    requestsPerMinute: round(requestCount / durationMinutes, 1),
    cacheHitRate: ratio(cacheHits, requestCount),
    cacheKeyCardinality: cacheKeys.size,
    originRequestsPerMinute: round(originRequests / durationMinutes, 1),
    response429Rate: ratio(response429s, requestCount),
    responseLatencyP99Ms: percentile(latencies, 0.99)
  };
}

export function averageDependencyLatency(
  samples: Iterable<DependencyTelemetry>,
  dependency: DependencyTelemetry["dependency"],
  from: string,
  to: string
): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  let total = 0;
  let count = 0;

  for (const sample of samples) {
    const timestamp = Date.parse(sample.timestamp);
    if (
      sample.dependency === dependency &&
      timestamp >= fromMs &&
      timestamp < toMs
    ) {
      total += sample.latencyP99Ms;
      count += 1;
    }
  }

  return count === 0 ? 0 : round(total / count, 1);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  values.sort((left, right) => left - right);
  const index = Math.ceil(values.length * quantile) - 1;
  return values[Math.max(0, index)];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
