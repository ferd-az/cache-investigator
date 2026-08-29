export const finalFindingEditorialLimits = {
  headlineChars: 80,
  summaryChars: 200,
  impactSummaryChars: 200,
  affectedRoutes: 8,
  affectedRouteChars: 100,
  impactIndicators: { min: 1, max: 3 },
  mechanism: { min: 2, max: 4, itemChars: 180 },
  rootCauseSummaryChars: 200,
  rootCauseChangeChars: 180,
  confidenceRationaleChars: 280,
  recommendationImmediateChars: 180,
  recommendationVerifyChars: 260,
  followUps: { max: 3, itemChars: 180 },
  evidence: {
    max: 10,
    titleChars: 100,
    claimChars: 240,
    valuesPerItem: 6
  },
  alternatives: {
    max: 4,
    hypothesisChars: 140,
    reasonChars: 240
  },
  valueLabelChars: 100,
  valueUnitChars: 24,
  noFindingsSummaryChars: 300
} as const;

const canonicalUnitByAlias: Readonly<Record<string, string>> = {
  percent: "%",
  percentage: "%",
  pct: "%",
  "%": "%",
  "percent hit": "% hit",
  "% hit": "% hit",
  millisecond: "ms",
  milliseconds: "ms",
  ms: "ms",
  second: "s",
  seconds: "s",
  sec: "s",
  secs: "s",
  s: "s",
  minute: "min",
  minutes: "min",
  min: "min",
  requests_per_minute: "req/min",
  "requests per minute": "req/min",
  "request per minute": "req/min",
  "requests/minute": "req/min",
  "request/minute": "req/min",
  "req/min": "req/min",
  requests_per_second: "req/s",
  "requests per second": "req/s",
  "request per second": "req/s",
  "requests/second": "req/s",
  "request/second": "req/s",
  "req/s": "req/s",
  keys_per_5_minutes: "keys/5 min",
  "keys per 5 minutes": "keys/5 min",
  "keys/5m": "keys/5 min",
  "keys/5 min": "keys/5 min"
};

const machineMetricNames = [
  "request_count",
  "cache_hit_rate",
  "cache_key_cardinality",
  "origin_request_count",
  "origin_error_rate",
  "response_latency_p99"
] as const;

export function canonicalizeFindingUnit(unit: string) {
  const trimmed = unit.trim();
  const alias = trimmed.toLowerCase().replace(/\s+/g, " ");
  return canonicalUnitByAlias[alias] ?? trimmed.replaceAll("_", " ");
}

export function formatFindingValue(value: number | string, unit?: string) {
  if (typeof value === "string") return value;

  const canonicalUnit = unit ? canonicalizeFindingUnit(unit) : undefined;
  const usesWholeNumbers =
    canonicalUnit === "ms" ||
    canonicalUnit === "req/min" ||
    canonicalUnit === "req/s" ||
    canonicalUnit === "requests" ||
    canonicalUnit === "keys" ||
    canonicalUnit === "keys/5 min";
  const maxFractionDigits =
    canonicalUnit === "%" || canonicalUnit === "% hit" || canonicalUnit === "s"
      ? 1
      : usesWholeNumbers || Number.isInteger(value)
        ? 0
        : 1;

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: maxFractionDigits
  }).format(value);
}

export function repeatedEditorialFieldPair(
  fields: ReadonlyArray<readonly [label: string, value: string]>
) {
  const normalized = fields.map(
    ([label, value]) => [label, normalizeEditorialCopy(value)] as const
  );

  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    const [leftLabel, leftValue] = normalized[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < normalized.length;
      rightIndex += 1
    ) {
      const [rightLabel, rightValue] = normalized[rightIndex];
      const shorter =
        leftValue.length <= rightValue.length ? leftValue : rightValue;
      const longer =
        leftValue.length <= rightValue.length ? rightValue : leftValue;
      const repeats =
        leftValue === rightValue ||
        (shorter.split(" ").length >= 6 && longer.includes(shorter));

      if (repeats) return [leftLabel, rightLabel] as const;
    }
  }

  return undefined;
}

export function machineMetricInEditorialField(
  fields: ReadonlyArray<readonly [label: string, value: string]>
) {
  for (const [label, value] of fields) {
    const copy = value.toLowerCase();
    const metric = machineMetricNames.find((name) => copy.includes(name));
    if (metric) return [label, metric] as const;
  }
  return undefined;
}

function normalizeEditorialCopy(value: string) {
  return value
    .toLowerCase()
    .replace(/[`"'()[\]{}.,:;!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
