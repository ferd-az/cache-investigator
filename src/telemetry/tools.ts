import {
  investigationToolLimits,
  type CheckDependencyHealthInput,
  type InvestigationToolCall,
  type InvestigationToolName,
  type ListDeploymentsInput,
  type MetricName,
  type QueryMetricsInput,
  type SearchLogsInput
} from "../investigation/contracts.ts";

const INTERVAL_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000
} as const;

const METRICS = new Set<MetricName>([
  "request_count",
  "cache_hit_rate",
  "cache_key_cardinality",
  "origin_request_count",
  "origin_error_rate",
  "response_latency_p99"
]);

const METRIC_FILTER_COLUMNS = {
  service: "service",
  environment: "environment",
  route: "route",
  region: "region",
  deployment: "deployment",
  traffic_source: "traffic_source",
  cache_status: "cache_status",
  response_status: "response_status",
  has_session_id: "has_session_id"
} as const;

const GROUP_COLUMNS = {
  route: "route",
  region: "region",
  deployment: "deployment",
  has_session_id: "has_session_id"
} as const;

export const metricUnits: Record<MetricName, string> = {
  request_count: "requests",
  cache_hit_rate: "percent",
  cache_key_cardinality: "keys",
  origin_request_count: "requests_per_minute",
  origin_error_rate: "percent",
  response_latency_p99: "milliseconds"
};

export class InvestigationToolInputError extends Error {
  override name = "InvestigationToolInputError";
}

export type MetricPoint = {
  bucketStart: string;
  bucketEnd: string;
  group?: string | boolean;
  values: Partial<Record<MetricName, number>>;
};

export type QueryMetricsResult = {
  from: string;
  to: string;
  interval: QueryMetricsInput["interval"];
  units: Partial<Record<MetricName, string>>;
  points: MetricPoint[];
};

export type LogRecord = {
  id: string;
  timestamp: string;
  service: string;
  environment: string;
  region: string;
  method: string;
  route: string;
  query: Record<string, string>;
  hasSessionId: boolean;
  sessionId?: string;
  trafficSource: string;
  deployment: string;
  cacheKey: string;
  cacheStatus: "HIT" | "MISS";
  originRequest: boolean;
  originQueueDepth: number;
  responseStatus: number;
  responseLatencyMs: number;
};

export type SearchLogsResult = {
  rows: LogRecord[];
  nextCursor?: string;
};

export type DeploymentRecord = {
  id: string;
  service: string;
  environment: string;
  version: string;
  commit: string;
  deployedAt: string;
  changes: string[];
};

export type ListDeploymentsResult = {
  deployments: DeploymentRecord[];
};

export type DependencyHealthRecord = {
  dependency: string;
  sampleCount: number;
  latencyP99Ms: number;
  errorRatePercent: number;
  healthy: boolean;
};

export type CheckDependencyHealthResult = {
  dependencies: DependencyHealthRecord[];
};

export type InvestigationToolResult = {
  query_metrics: QueryMetricsResult;
  search_logs: SearchLogsResult;
  list_deployments: ListDeploymentsResult;
  check_dependency_health: CheckDependencyHealthResult;
};

type Window = {
  from: string;
  to: string;
  fromMs: number;
  toMs: number;
};

type MetricRow = {
  bucket_ms: number;
  group_value: string | number | null;
  request_count: number;
  cache_hit_rate: number;
  cache_key_cardinality: number;
  origin_request_count: number;
  origin_error_rate: number;
  response_latency_p99: number;
};

type LogRow = {
  id: string;
  timestamp_ms: number;
  service: string;
  environment: string;
  region: string;
  method: string;
  route: string;
  query_json: string;
  has_session_id: number;
  session_id: string | null;
  traffic_source: string;
  deployment: string;
  cache_key: string;
  cache_status: "HIT" | "MISS";
  origin_request: number;
  origin_queue_depth: number;
  response_status: number;
  response_latency_ms: number;
};

export async function queryMetrics(
  db: D1Database,
  value: unknown
): Promise<QueryMetricsResult> {
  const input = parseQueryMetricsInput(value);
  const window = parseWindow(
    input,
    investigationToolLimits.query_metrics.maxWindowHours
  );
  const intervalMs = INTERVAL_MS[input.interval];
  const requestedBuckets = Math.ceil(
    (window.toMs - window.fromMs) / intervalMs
  );
  if (requestedBuckets > investigationToolLimits.query_metrics.maxBuckets) {
    throw new InvestigationToolInputError(
      `query_metrics exceeds the ${investigationToolLimits.query_metrics.maxBuckets}-bucket limit`
    );
  }

  const conditions = ["timestamp_ms >= ?", "timestamp_ms < ?"];
  const bindings: Array<string | number> = [window.fromMs, window.toMs];

  for (const [key, rawValue] of Object.entries(input.filters ?? {})) {
    const column =
      METRIC_FILTER_COLUMNS[key as keyof typeof METRIC_FILTER_COLUMNS];
    if (!column) {
      throw new InvestigationToolInputError(
        `query_metrics does not support the filter ${key}`
      );
    }
    const filterValue = boundedString(rawValue, `filters.${key}`);
    if (key === "has_session_id") {
      conditions.push(`${column} = ?`);
      bindings.push(parseBooleanFilter(filterValue, `filters.${key}`) ? 1 : 0);
    } else if (key === "response_status") {
      conditions.push(`${column} = ?`);
      bindings.push(parseStatus(filterValue, `filters.${key}`));
    } else {
      conditions.push(`${column} = ?`);
      bindings.push(filterValue);
    }
  }

  const groupColumn = input.groupBy ? GROUP_COLUMNS[input.groupBy] : undefined;
  const groupExpression = groupColumn ?? "NULL";
  const bucketExpression = `CAST(timestamp_ms / ${intervalMs} AS INTEGER) * ${intervalMs}`;
  const pointBudget =
    input.limit ?? investigationToolLimits.query_metrics.maxBuckets;
  const projectedPointCount = await countMetricPoints(
    db,
    conditions,
    bindings,
    bucketExpression,
    groupExpression
  );
  if (projectedPointCount > pointBudget) {
    throw new InvestigationToolInputError(
      `query_metrics would return ${projectedPointCount} points, exceeding the ${pointBudget}-point budget; use a wider interval, narrower window, or additional filter`
    );
  }

  const result = await db
    .prepare(
      `WITH scoped AS (
        SELECT r.*
        FROM request_telemetry r
        JOIN telemetry_corpora c ON c.id = r.corpus_id
        WHERE c.active = 1 AND c.status = 'ready'
          AND ${conditions.join(" AND ")}
      ), ranked AS (
        SELECT
          *,
          ${bucketExpression} AS bucket_ms,
          ${groupExpression} AS group_value,
          ROW_NUMBER() OVER (
            PARTITION BY ${bucketExpression}, ${groupExpression}
            ORDER BY response_latency_ms
          ) AS latency_rank,
          COUNT(*) OVER (
            PARTITION BY ${bucketExpression}, ${groupExpression}
          ) AS bucket_count
        FROM scoped
      )
      SELECT
        bucket_ms,
        group_value,
        COUNT(*) AS request_count,
        ROUND(100.0 * SUM(cache_status = 'HIT') / COUNT(*), 2) AS cache_hit_rate,
        COUNT(DISTINCT cache_key) AS cache_key_cardinality,
        ROUND(SUM(origin_request) / (${intervalMs} / 60000.0), 2) AS origin_request_count,
        ROUND(
          100.0 * SUM(origin_request = 1 AND response_status >= 400) / COUNT(*),
          2
        ) AS origin_error_rate,
        MAX(
          CASE
            WHEN latency_rank = CAST((bucket_count * 99 + 99) / 100 AS INTEGER)
            THEN response_latency_ms
          END
        ) AS response_latency_p99
      FROM ranked
      GROUP BY bucket_ms, group_value
      ORDER BY bucket_ms ASC, group_value ASC`
    )
    .bind(...bindings)
    .all<MetricRow>();

  if (result.results.length > pointBudget) {
    throw new InvestigationToolInputError(
      `query_metrics result changed during execution and exceeded the ${pointBudget}-point budget; retry the query`
    );
  }

  const units = Object.fromEntries(
    input.metrics.map((metric) => [metric, metricUnits[metric]])
  ) as Partial<Record<MetricName, string>>;

  return {
    from: window.from,
    to: window.to,
    interval: input.interval,
    units,
    points: result.results.map((row) => ({
      bucketStart: new Date(row.bucket_ms).toISOString(),
      bucketEnd: new Date(
        Math.min(row.bucket_ms + intervalMs, window.toMs)
      ).toISOString(),
      ...(input.groupBy
        ? {
            group:
              input.groupBy === "has_session_id"
                ? Boolean(row.group_value)
                : String(row.group_value)
          }
        : {}),
      values: Object.fromEntries(
        input.metrics.map((metric) => [metric, Number(row[metric])])
      ) as Partial<Record<MetricName, number>>
    }))
  };
}

export async function searchLogs(
  db: D1Database,
  value: unknown
): Promise<SearchLogsResult> {
  const input = parseSearchLogsInput(value);
  const window = parseWindow(
    input,
    investigationToolLimits.search_logs.maxWindowHours
  );
  const limit = input.limit ?? investigationToolLimits.search_logs.maxRows;
  const conditions = ["timestamp_ms >= ?", "timestamp_ms < ?"];
  const bindings: Array<string | number> = [window.fromMs, window.toMs];

  if (input.service) {
    conditions.push("service = ?");
    bindings.push(input.service);
  }
  if (input.route) {
    conditions.push("route = ?");
    bindings.push(input.route);
  }
  if (input.status !== undefined) {
    conditions.push("response_status = ?");
    bindings.push(input.status);
  }
  if (input.hasSessionId !== undefined) {
    conditions.push("has_session_id = ?");
    bindings.push(input.hasSessionId ? 1 : 0);
  }
  if (input.cacheStatus !== undefined) {
    conditions.push("cache_status = ?");
    bindings.push(input.cacheStatus);
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, window);
    conditions.push(
      "(r.timestamp_ms > ? OR (r.timestamp_ms = ? AND r.id > ?))"
    );
    bindings.push(cursor.timestampMs, cursor.timestampMs, cursor.id);
  }
  bindings.push(limit + 1);

  const result = await db
    .prepare(
      `SELECT
        r.id, r.timestamp_ms, r.service, r.environment, r.region, r.method,
        r.route, r.query_json, r.has_session_id, r.session_id,
        r.traffic_source, r.deployment, r.cache_key, r.cache_status,
        r.origin_request, r.origin_queue_depth, r.response_status,
        r.response_latency_ms
      FROM request_telemetry r
      JOIN telemetry_corpora c ON c.id = r.corpus_id
      WHERE c.active = 1 AND c.status = 'ready'
        AND ${conditions.join(" AND ")}
      ORDER BY r.timestamp_ms ASC, r.id ASC
      LIMIT ?`
    )
    .bind(...bindings)
    .all<LogRow>();

  const hasMore = result.results.length > limit;
  const page = result.results.slice(0, limit);
  const last = page.at(-1);

  return {
    rows: page.map(toLogRecord),
    ...(hasMore && last
      ? { nextCursor: encodeCursor(last.timestamp_ms, last.id) }
      : {})
  };
}

export async function listDeployments(
  db: D1Database,
  value: unknown
): Promise<ListDeploymentsResult> {
  const input = parseListDeploymentsInput(value);
  const window = parseWindow(
    input,
    investigationToolLimits.list_deployments.maxWindowHours
  );
  const limit = input.limit ?? investigationToolLimits.list_deployments.maxRows;
  const conditions = ["deployed_at_ms >= ?", "deployed_at_ms < ?"];
  const bindings: Array<string | number> = [window.fromMs, window.toMs];
  if (input.service) {
    conditions.push("service = ?");
    bindings.push(input.service);
  }
  bindings.push(limit);

  const result = await db
    .prepare(
      `SELECT d.id, d.service, d.environment, d.version, d.commit_hash,
        d.deployed_at_ms, d.changes_json
      FROM deployment_telemetry d
      JOIN telemetry_corpora c ON c.id = d.corpus_id
      WHERE c.active = 1 AND c.status = 'ready'
        AND ${conditions.join(" AND ")}
      ORDER BY d.deployed_at_ms DESC, d.id DESC
      LIMIT ?`
    )
    .bind(...bindings)
    .all<{
      id: string;
      service: string;
      environment: string;
      version: string;
      commit_hash: string;
      deployed_at_ms: number;
      changes_json: string;
    }>();

  return {
    deployments: result.results.map((row) => ({
      id: row.id,
      service: row.service,
      environment: row.environment,
      version: row.version,
      commit: row.commit_hash,
      deployedAt: new Date(row.deployed_at_ms).toISOString(),
      changes: parseJsonArray(row.changes_json, "deployment changes")
    }))
  };
}

export async function checkDependencyHealth(
  db: D1Database,
  value: unknown
): Promise<CheckDependencyHealthResult> {
  const input = parseCheckDependencyHealthInput(value);
  const window = parseWindow(
    input,
    investigationToolLimits.check_dependency_health.maxWindowHours
  );
  const conditions = ["timestamp_ms >= ?", "timestamp_ms < ?", "service = ?"];
  const bindings: Array<string | number> = [
    window.fromMs,
    window.toMs,
    input.service
  ];
  if (input.dependencies) {
    conditions.push(
      `dependency IN (${input.dependencies.map(() => "?").join(", ")})`
    );
    bindings.push(...input.dependencies);
  }
  bindings.push(
    investigationToolLimits.check_dependency_health.maxDependencies
  );

  const result = await db
    .prepare(
      `SELECT
        d.dependency,
        COUNT(*) AS sample_count,
        ROUND(AVG(d.latency_p99_ms), 1) AS latency_p99_ms,
        ROUND(100.0 * AVG(d.error_rate), 3) AS error_rate_percent,
        MIN(d.healthy) AS healthy
      FROM dependency_telemetry d
      JOIN telemetry_corpora c ON c.id = d.corpus_id
      WHERE c.active = 1 AND c.status = 'ready'
        AND ${conditions.join(" AND ")}
      GROUP BY d.dependency
      ORDER BY d.dependency ASC
      LIMIT ?`
    )
    .bind(...bindings)
    .all<{
      dependency: string;
      sample_count: number;
      latency_p99_ms: number;
      error_rate_percent: number;
      healthy: number;
    }>();

  return {
    dependencies: result.results.map((row) => ({
      dependency: row.dependency,
      sampleCount: row.sample_count,
      latencyP99Ms: row.latency_p99_ms,
      errorRatePercent: row.error_rate_percent,
      healthy: Boolean(row.healthy)
    }))
  };
}

export async function executeInvestigationTool<
  Tool extends InvestigationToolName
>(
  db: D1Database,
  call: Extract<InvestigationToolCall, { tool: Tool }>
): Promise<InvestigationToolResult[Tool]> {
  switch (call.tool) {
    case "query_metrics":
      return queryMetrics(db, call.input) as Promise<
        InvestigationToolResult[Tool]
      >;
    case "search_logs":
      return searchLogs(db, call.input) as Promise<
        InvestigationToolResult[Tool]
      >;
    case "list_deployments":
      return listDeployments(db, call.input) as Promise<
        InvestigationToolResult[Tool]
      >;
    case "check_dependency_health":
      return checkDependencyHealth(db, call.input) as Promise<
        InvestigationToolResult[Tool]
      >;
  }
}

async function countMetricPoints(
  db: D1Database,
  conditions: string[],
  bindings: Array<string | number>,
  bucketExpression: string,
  groupExpression: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS point_count
      FROM (
        SELECT
          ${bucketExpression} AS bucket_ms,
          ${groupExpression} AS group_value
        FROM request_telemetry r
        JOIN telemetry_corpora c ON c.id = r.corpus_id
        WHERE c.active = 1 AND c.status = 'ready'
          AND ${conditions.join(" AND ")}
        GROUP BY bucket_ms, group_value
      )`
    )
    .bind(...bindings)
    .first<{ point_count: number }>();

  return Number(row?.point_count ?? 0);
}

function parseQueryMetricsInput(value: unknown): QueryMetricsInput {
  const input = object(value, "query_metrics input");
  const rawMetrics = input.metrics;
  if (!Array.isArray(rawMetrics) || rawMetrics.length === 0) {
    throw new InvestigationToolInputError("metrics must be a non-empty array");
  }
  if (rawMetrics.length > investigationToolLimits.query_metrics.maxMetrics) {
    throw new InvestigationToolInputError(
      `metrics exceeds the ${investigationToolLimits.query_metrics.maxMetrics}-metric limit`
    );
  }
  const metrics = rawMetrics.map((metric) => {
    if (typeof metric !== "string" || !METRICS.has(metric as MetricName)) {
      throw new InvestigationToolInputError(
        `Unsupported metric: ${String(metric)}`
      );
    }
    return metric as MetricName;
  });
  if (new Set(metrics).size !== metrics.length) {
    throw new InvestigationToolInputError(
      "metrics must not contain duplicates"
    );
  }
  if (
    input.interval !== "1m" &&
    input.interval !== "5m" &&
    input.interval !== "15m"
  ) {
    throw new InvestigationToolInputError("interval must be 1m, 5m, or 15m");
  }
  const groupBy = optionalString(input.groupBy, "groupBy");
  if (groupBy && !(groupBy in GROUP_COLUMNS)) {
    throw new InvestigationToolInputError(`Unsupported groupBy: ${groupBy}`);
  }
  const filters =
    input.filters === undefined ? undefined : object(input.filters, "filters");

  return {
    metrics,
    from: boundedString(input.from, "from"),
    to: boundedString(input.to, "to"),
    interval: input.interval,
    ...(filters
      ? {
          filters: Object.fromEntries(
            Object.entries(filters).map(([key, filter]) => [
              key,
              boundedString(filter, `filters.${key}`)
            ])
          )
        }
      : {}),
    ...(groupBy ? { groupBy: groupBy as QueryMetricsInput["groupBy"] } : {}),
    ...parseOptionalLimit(
      input.limit,
      investigationToolLimits.query_metrics.maxBuckets
    )
  };
}

function parseSearchLogsInput(value: unknown): SearchLogsInput {
  const input = object(value, "search_logs input");
  assertKnownKeys(input, "search_logs input", [
    "from",
    "to",
    "service",
    "route",
    "status",
    "hasSessionId",
    "cacheStatus",
    "cursor",
    "limit"
  ]);
  const status =
    input.status === undefined
      ? undefined
      : parseStatus(input.status, "status");
  let hasSessionId: boolean | undefined;
  if (input.hasSessionId !== undefined) {
    if (typeof input.hasSessionId !== "boolean") {
      throw new InvestigationToolInputError("hasSessionId must be a boolean");
    }
    hasSessionId = input.hasSessionId;
  }
  let cacheStatus: SearchLogsInput["cacheStatus"];
  if (input.cacheStatus !== undefined) {
    if (input.cacheStatus !== "HIT" && input.cacheStatus !== "MISS") {
      throw new InvestigationToolInputError("cacheStatus must be HIT or MISS");
    }
    cacheStatus = input.cacheStatus;
  }
  return {
    from: boundedString(input.from, "from"),
    to: boundedString(input.to, "to"),
    ...optionalStringProperty(input, "service"),
    ...optionalStringProperty(input, "route"),
    ...(status === undefined ? {} : { status }),
    ...(hasSessionId === undefined ? {} : { hasSessionId }),
    ...(cacheStatus === undefined ? {} : { cacheStatus }),
    ...optionalStringProperty(input, "cursor", 1_000),
    ...parseOptionalLimit(
      input.limit,
      investigationToolLimits.search_logs.maxRows
    )
  };
}

function parseListDeploymentsInput(value: unknown): ListDeploymentsInput {
  const input = object(value, "list_deployments input");
  return {
    from: boundedString(input.from, "from"),
    to: boundedString(input.to, "to"),
    ...optionalStringProperty(input, "service"),
    ...parseOptionalLimit(
      input.limit,
      investigationToolLimits.list_deployments.maxRows
    )
  };
}

function parseCheckDependencyHealthInput(
  value: unknown
): CheckDependencyHealthInput {
  const input = object(value, "check_dependency_health input");
  let dependencies: string[] | undefined;
  if (input.dependencies !== undefined) {
    if (!Array.isArray(input.dependencies) || input.dependencies.length === 0) {
      throw new InvestigationToolInputError(
        "dependencies must be a non-empty array when provided"
      );
    }
    if (
      input.dependencies.length >
      investigationToolLimits.check_dependency_health.maxDependencies
    ) {
      throw new InvestigationToolInputError(
        `dependencies exceeds the ${investigationToolLimits.check_dependency_health.maxDependencies}-dependency limit`
      );
    }
    dependencies = input.dependencies.map((dependency, index) =>
      boundedString(dependency, `dependencies[${index}]`)
    );
    if (new Set(dependencies).size !== dependencies.length) {
      throw new InvestigationToolInputError(
        "dependencies must not contain duplicates"
      );
    }
  }
  return {
    from: boundedString(input.from, "from"),
    to: boundedString(input.to, "to"),
    service: boundedString(input.service, "service"),
    ...(dependencies ? { dependencies } : {})
  };
}

function parseWindow(
  input: { from: string; to: string },
  maxWindowHours: number
): Window {
  const fromMs = parseIsoTimestamp(input.from, "from");
  const toMs = parseIsoTimestamp(input.to, "to");
  if (toMs <= fromMs) {
    throw new InvestigationToolInputError("to must be later than from");
  }
  if (toMs - fromMs > maxWindowHours * 3_600_000) {
    throw new InvestigationToolInputError(
      `Time window exceeds the ${maxWindowHours}-hour limit`
    );
  }
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    fromMs,
    toMs
  };
}

function parseIsoTimestamp(value: string, label: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match) {
    throw new InvestigationToolInputError(
      `${label} must be an ISO-8601 timestamp with an explicit timezone`
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const validCalendarDate =
    month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  if (
    !validCalendarDate ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new InvestigationToolInputError(
      `${label} must be a valid ISO-8601 timestamp`
    );
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new InvestigationToolInputError(
      `${label} must be a valid ISO-8601 timestamp`
    );
  }
  return timestamp;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function toLogRecord(row: LogRow): LogRecord {
  return {
    id: row.id,
    timestamp: new Date(row.timestamp_ms).toISOString(),
    service: row.service,
    environment: row.environment,
    region: row.region,
    method: row.method,
    route: row.route,
    query: parseJsonObject(row.query_json, "log query"),
    hasSessionId: Boolean(row.has_session_id),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    trafficSource: row.traffic_source,
    deployment: row.deployment,
    cacheKey: row.cache_key,
    cacheStatus: row.cache_status,
    originRequest: Boolean(row.origin_request),
    originQueueDepth: row.origin_queue_depth,
    responseStatus: row.response_status,
    responseLatencyMs: row.response_latency_ms
  };
}

function encodeCursor(timestampMs: number, id: string): string {
  return btoa(JSON.stringify({ timestampMs, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(cursor: string, window: Window) {
  try {
    const base64 = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const parsed = JSON.parse(atob(base64 + padding)) as unknown;
    const value = object(parsed, "cursor");
    const timestampMs = value.timestampMs;
    const id = value.id;
    if (
      typeof timestampMs !== "number" ||
      !Number.isSafeInteger(timestampMs) ||
      typeof id !== "string" ||
      id.length === 0
    ) {
      throw new Error("Invalid cursor shape");
    }
    if (timestampMs < window.fromMs || timestampMs >= window.toMs) {
      throw new Error("Cursor is outside the requested window");
    }
    return { timestampMs, id: boundedString(id, "cursor.id") };
  } catch (error) {
    if (error instanceof InvestigationToolInputError) throw error;
    throw new InvestigationToolInputError(
      "cursor is invalid for this query window"
    );
  }
}

function parseJsonObject(value: string, label: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  const result = object(parsed, label);
  for (const [key, item] of Object.entries(result)) {
    if (typeof item !== "string") {
      throw new Error(`${label}.${key} is not a string`);
    }
  }
  return result as Record<string, string>;
}

function parseJsonArray(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`${label} is not a string array`);
  }
  return parsed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvestigationToolInputError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  input: Record<string, unknown>,
  label: string,
  allowedKeys: string[]
) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(input).find((key) => !allowed.has(key));
  if (unknown) {
    throw new InvestigationToolInputError(
      `${label} contains unsupported field ${unknown}`
    );
  }
}

function boundedString(value: unknown, label: string, maxLength = 200): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new InvestigationToolInputError(
      `${label} must be a non-empty string no longer than ${maxLength} characters`
    );
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : boundedString(value, label);
}

function optionalStringProperty(
  input: Record<string, unknown>,
  key: string,
  maxLength = 200
): Record<string, string> {
  return input[key] === undefined
    ? {}
    : { [key]: boundedString(input[key], key, maxLength) };
}

function parseOptionalLimit(
  value: unknown,
  maximum: number
): { limit?: number } {
  if (value === undefined) return {};
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new InvestigationToolInputError(
      `limit must be an integer between 1 and ${maximum}`
    );
  }
  return { limit: value as number };
}

function parseBooleanFilter(value: string, label: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new InvestigationToolInputError(`${label} must be true or false`);
}

function parseStatus(value: unknown, label: string): number {
  const number = typeof value === "string" ? Number(value) : value;
  if (
    !Number.isInteger(number) ||
    (number as number) < 100 ||
    (number as number) > 599
  ) {
    throw new InvestigationToolInputError(
      `${label} must be an HTTP status code`
    );
  }
  return number as number;
}
