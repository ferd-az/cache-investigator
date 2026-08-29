import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import {
  seedTelemetryCorpus,
  telemetryCorpusId
} from "../../simulator/seed-d1.ts";
import {
  checkDependencyHealth,
  listDeployments,
  queryMetrics,
  searchLogs,
  type MetricPoint
} from "./tools.ts";

const fixtureWindow = {
  from: "2026-08-26T14:00:00.000Z",
  to: "2026-08-26T16:00:00.000Z"
};

let miniflare: Miniflare;
let db: D1Database;

before(
  async () => {
    miniflare = new Miniflare(
      convertV4MiniflareOptions({
        compatibilityDate: "2026-06-11",
        modules: true,
        script: "export default { fetch() { return new Response('ok') } }",
        d1Databases: { TELEMETRY_DB: "cache-investigator-test" }
      })
    );
    db = await miniflare.getD1Database("TELEMETRY_DB");
    const migration = await readFile(
      fileURLToPath(
        new URL("../../migrations/0001_telemetry.sql", import.meta.url)
      ),
      "utf8"
    );
    const statements = migration
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
    await seedTelemetryCorpus(db);
  },
  { timeout: 180_000 }
);

after(async () => {
  await miniflare.dispose();
});

test(
  "the deterministic corpus seeds completely and replaces the known corpus on rerun",
  { timeout: 180_000 },
  async () => {
    const initial = await corpusCounts();
    assert.deepEqual(initial, {
      corpus_id: telemetryCorpusId,
      status: "ready",
      active: 1,
      request_count: 216_000,
      deployment_count: 1,
      dependency_count: 240
    });

    await db
      .prepare(
        "UPDATE request_telemetry SET response_status = 599 WHERE corpus_id = ? AND id = ?"
      )
      .bind(telemetryCorpusId, "req_000001")
      .run();

    const replacement = await seedTelemetryCorpus(db);
    assert.equal(replacement.requestCount, 216_000);
    assert.equal(
      await db
        .prepare(
          "SELECT COUNT(*) AS count FROM request_telemetry WHERE corpus_id = ? AND response_status = 599"
        )
        .bind(telemetryCorpusId)
        .first("count"),
      0
    );
    assert.deepEqual(await corpusCounts(), initial);
  }
);

test("query_metrics recovers the regression, affected segment, and healthy routes", async () => {
  const overview = await queryMetrics(db, {
    metrics: [
      "cache_hit_rate",
      "origin_request_count",
      "origin_error_rate",
      "response_latency_p99"
    ],
    from: "2026-08-26T14:00:00.000Z",
    to: "2026-08-26T15:00:00.000Z",
    interval: "5m"
  });
  const healthy = pointAt(overview.points, "2026-08-26T14:15:00.000Z");
  const regressed = pointAt(overview.points, "2026-08-26T14:25:00.000Z");
  assert.ok(value(healthy, "cache_hit_rate") > 85);
  assert.ok(value(regressed, "cache_hit_rate") < 55);
  assert.ok(value(regressed, "origin_request_count") > 850);
  assert.ok(value(regressed, "origin_error_rate") > 5);
  assert.ok(value(regressed, "response_latency_p99") > 1_700);

  const routes = await queryMetrics(db, {
    metrics: ["cache_hit_rate", "origin_error_rate"],
    from: "2026-08-26T14:15:00.000Z",
    to: "2026-08-26T14:45:00.000Z",
    interval: "5m",
    groupBy: "route"
  });
  const productAfter = groupedPoint(
    routes.points,
    "2026-08-26T14:25:00.000Z",
    "/products"
  );
  const categoriesAfter = groupedPoint(
    routes.points,
    "2026-08-26T14:25:00.000Z",
    "/categories"
  );
  const searchAfter = groupedPoint(
    routes.points,
    "2026-08-26T14:25:00.000Z",
    "/search"
  );
  assert.ok(value(productAfter, "cache_hit_rate") < 25);
  assert.ok(value(productAfter, "origin_error_rate") > 10);
  assert.ok(value(categoriesAfter, "cache_hit_rate") > 85);
  assert.equal(value(categoriesAfter, "origin_error_rate"), 0);
  assert.ok(value(searchAfter, "cache_hit_rate") > 85);
  assert.equal(value(searchAfter, "origin_error_rate"), 0);

  const sessions = await queryMetrics(db, {
    metrics: ["cache_hit_rate", "cache_key_cardinality"],
    from: "2026-08-26T14:20:00.000Z",
    to: "2026-08-26T14:40:00.000Z",
    interval: "5m",
    filters: { route: "/products" },
    groupBy: "has_session_id"
  });
  const withSession = sessions.points.filter((point) => point.group === true);
  const withoutSession = sessions.points.filter(
    (point) => point.group === false
  );
  assert.equal(withSession.length, 4);
  assert.equal(withoutSession.length, 4);
  assert.ok(withSession.every((point) => value(point, "cache_hit_rate") < 8));
  assert.ok(
    withSession.every((point) => value(point, "cache_key_cardinality") > 3_500)
  );
  assert.ok(
    withoutSession.every((point) => value(point, "cache_hit_rate") > 85)
  );
});

test("origin_error_rate includes origin 503s and excludes non-origin errors", async () => {
  const evidenceFrom = "2026-08-26T14:25:00.000Z";
  const evidenceTo = "2026-08-26T14:30:00.000Z";
  const currentEvidence = await queryMetrics(db, {
    metrics: ["origin_error_rate"],
    from: evidenceFrom,
    to: evidenceTo,
    interval: "5m",
    filters: { route: "/products" }
  });
  const legacy429Rate = await db
    .prepare(
      `SELECT ROUND(100.0 * SUM(r.response_status = 429) / COUNT(*), 2) AS rate
      FROM request_telemetry r
      JOIN telemetry_corpora c ON c.id = r.corpus_id
      WHERE c.active = 1 AND c.status = 'ready'
        AND r.timestamp_ms >= ? AND r.timestamp_ms < ? AND r.route = ?`
    )
    .bind(Date.parse(evidenceFrom), Date.parse(evidenceTo), "/products")
    .first<number>("rate");
  assert.equal(
    value(currentEvidence.points[0], "origin_error_rate"),
    legacy429Rate
  );

  const futureFrom = "2026-08-26T14:00:00.000Z";
  const futureTo = "2026-08-26T14:01:00.000Z";
  const originRequestId = await requestIdForOriginState(
    futureFrom,
    futureTo,
    true
  );
  const nonOriginRequestId = await requestIdForOriginState(
    futureFrom,
    futureTo,
    false
  );

  try {
    await db.batch([
      db
        .prepare(
          "UPDATE request_telemetry SET response_status = 503 WHERE corpus_id = ? AND id = ?"
        )
        .bind(telemetryCorpusId, originRequestId),
      db
        .prepare(
          "UPDATE request_telemetry SET response_status = 503 WHERE corpus_id = ? AND id = ?"
        )
        .bind(telemetryCorpusId, nonOriginRequestId)
    ]);

    const futureErrors = await queryMetrics(db, {
      metrics: ["request_count", "origin_error_rate"],
      from: futureFrom,
      to: futureTo,
      interval: "1m"
    });
    assert.equal(futureErrors.points.length, 1);
    const requestCount = value(futureErrors.points[0], "request_count");
    assert.ok(requestCount > 0);
    assert.equal(
      value(futureErrors.points[0], "origin_error_rate"),
      Math.round((100 / requestCount) * 100) / 100
    );
  } finally {
    await db.batch([
      db
        .prepare(
          "UPDATE request_telemetry SET response_status = 200 WHERE corpus_id = ? AND id = ?"
        )
        .bind(telemetryCorpusId, originRequestId),
      db
        .prepare(
          "UPDATE request_telemetry SET response_status = 200 WHERE corpus_id = ? AND id = ?"
        )
        .bind(telemetryCorpusId, nonOriginRequestId)
    ]);
  }
});

test("query_metrics rejects grouped overflow and returns every compliant grouped point", async () => {
  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: ["request_count"],
        from: "2026-08-26T14:00:00Z",
        to: "2026-08-26T16:00:00Z",
        interval: "1m",
        groupBy: "route"
      }),
    /would return 360 points, exceeding the 200-point budget; use a wider interval, narrower window, or additional filter/
  );

  const complete = await queryMetrics(db, {
    metrics: ["request_count"],
    from: "2026-08-26T14:00:00Z",
    to: "2026-08-26T15:00:00Z",
    interval: "5m",
    groupBy: "route",
    limit: 36
  });
  assert.equal(complete.points.length, 36);
  assert.deepEqual(
    [...new Set(complete.points.map((point) => point.group))],
    ["/categories", "/products", "/search"]
  );
  assert.equal(complete.points[0].bucketStart, "2026-08-26T14:00:00.000Z");
  assert.equal(complete.points.at(-1)?.bucketStart, "2026-08-26T14:55:00.000Z");
});

test("tool windows accept explicit ISO timezones and normalize to UTC", async () => {
  const withoutMilliseconds = await queryMetrics(db, {
    metrics: ["request_count"],
    from: "2026-08-26T14:00:00Z",
    to: "2026-08-26T14:05:00Z",
    interval: "5m"
  });
  assert.equal(withoutMilliseconds.from, "2026-08-26T14:00:00.000Z");
  assert.equal(withoutMilliseconds.to, "2026-08-26T14:05:00.000Z");

  const fractionalSeconds = await queryMetrics(db, {
    metrics: ["request_count"],
    from: "2026-08-26T14:00:00.123456Z",
    to: "2026-08-26T14:00:01.9Z",
    interval: "1m"
  });
  assert.equal(fractionalSeconds.from, "2026-08-26T14:00:00.123Z");
  assert.equal(fractionalSeconds.to, "2026-08-26T14:00:01.900Z");

  const offset = await queryMetrics(db, {
    metrics: ["request_count"],
    from: "2026-08-26T16:00:00+02:00",
    to: "2026-08-26T16:05:00+02:00",
    interval: "5m"
  });
  assert.equal(offset.from, "2026-08-26T14:00:00.000Z");
  assert.equal(offset.to, "2026-08-26T14:05:00.000Z");

  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: ["request_count"],
        from: "not-a-timestamp",
        to: "2026-08-26T14:05:00Z",
        interval: "5m"
      }),
    /explicit timezone/
  );
  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: ["request_count"],
        from: "2026-02-30T14:00:00Z",
        to: "2026-08-26T14:05:00Z",
        interval: "5m"
      }),
    /valid ISO-8601 timestamp/
  );
  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: ["request_count"],
        from: "2026-08-26T14:00:00",
        to: "2026-08-26T14:05:00Z",
        interval: "5m"
      }),
    /explicit timezone/
  );
});

test("search_logs is capped, parameterized, and paginates stable evidence", async () => {
  const input = {
    from: "2026-08-26T14:20:00.000Z",
    to: "2026-08-26T14:25:00.000Z",
    service: "catalog-edge",
    route: "/products",
    cacheStatus: "MISS",
    hasSessionId: true,
    limit: 100
  } as const;
  const first = await searchLogs(db, input);
  assert.equal(first.rows.length, 100);
  assert.ok(first.nextCursor);
  assert.ok(first.rows.every((row) => row.cacheStatus === "MISS"));
  assert.ok(first.rows.every((row) => row.sessionId));
  assert.ok(new Set(first.rows.map((row) => row.cacheKey)).size >= 95);

  const byBaseQuery = new Map<string, Set<string>>();
  for (const row of first.rows) {
    const { session_id: _sessionId, ...baseQuery } = row.query;
    const key = JSON.stringify(baseQuery);
    const cacheKeys = byBaseQuery.get(key) ?? new Set<string>();
    cacheKeys.add(row.cacheKey);
    byBaseQuery.set(key, cacheKeys);
  }
  assert.ok([...byBaseQuery.values()].some((cacheKeys) => cacheKeys.size > 1));

  const second = await searchLogs(db, { ...input, cursor: first.nextCursor });
  assert.equal(second.rows.length, 100);
  assert.equal(
    first.rows.some((row) => second.rows.some((next) => next.id === row.id)),
    false
  );

  const injected = await searchLogs(db, {
    ...input,
    service: "catalog-edge' OR 1=1 --",
    limit: 1
  });
  assert.deepEqual(injected.rows, []);
  await assert.rejects(
    () => searchLogs(db, { ...input, query: "deprecated" }),
    /unsupported field query/
  );
  await assert.rejects(
    () => searchLogs(db, { ...input, cacheStatus: "miss" }),
    /cacheStatus must be HIT or MISS/
  );
  await assert.rejects(
    () => searchLogs(db, { ...input, hasSessionId: "true" }),
    /hasSessionId must be a boolean/
  );
});

test("deployment and dependency tools return the correlated change and healthy controls", async () => {
  const deployments = await listDeployments(db, {
    from: "2026-08-26T13:20:00.000Z",
    to: "2026-08-26T14:30:00.000Z",
    service: "catalog-edge",
    limit: 20
  });
  assert.equal(deployments.deployments.length, 1);
  assert.equal(deployments.deployments[0].version, "catalog-edge-v42");
  assert.equal(deployments.deployments[0].commit, "8f31ad2");
  assert.equal(
    deployments.deployments[0].deployedAt,
    "2026-08-26T14:18:00.000Z"
  );
  assert.match(deployments.deployments[0].changes[0], /session_id/);

  const dependencies = await checkDependencyHealth(db, {
    from: "2026-08-26T14:15:00.000Z",
    to: "2026-08-26T14:45:00.000Z",
    service: "catalog-origin",
    dependencies: ["catalog-db", "inventory-api"]
  });
  assert.deepEqual(
    dependencies.dependencies.map((dependency) => dependency.dependency),
    ["catalog-db", "inventory-api"]
  );
  assert.ok(
    dependencies.dependencies.every((dependency) => dependency.healthy)
  );
  assert.ok(
    dependencies.dependencies.every(
      (dependency) => dependency.sampleCount === 30
    )
  );
  assert.ok(dependencies.dependencies[0].latencyP99Ms >= 39);
  assert.ok(dependencies.dependencies[0].latencyP99Ms <= 45);
  assert.ok(dependencies.dependencies[1].latencyP99Ms >= 67);
  assert.ok(dependencies.dependencies[1].latencyP99Ms <= 75);

  const emptyDependencies = await checkDependencyHealth(db, {
    from: "2026-08-26T14:15:00.000Z",
    to: "2026-08-26T14:45:00.000Z",
    service: "catalog-edge",
    dependencies: ["origin"]
  });
  assert.deepEqual(emptyDependencies.dependencies, []);
  assert.deepEqual(emptyDependencies.availableTargets, [
    {
      service: "catalog-origin",
      dependencies: ["catalog-db", "inventory-api"]
    }
  ]);
});

test("all tool limits and time windows are enforced before querying", async () => {
  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: ["request_count"],
        from: fixtureWindow.from,
        to: "2026-08-26T17:21:00.000Z",
        interval: "1m"
      }),
    /200-bucket limit/
  );
  await assert.rejects(
    () =>
      queryMetrics(db, {
        metrics: [
          "request_count",
          "cache_hit_rate",
          "cache_key_cardinality",
          "origin_request_count",
          "origin_error_rate",
          "response_latency_p99",
          "request_count"
        ],
        from: fixtureWindow.from,
        to: fixtureWindow.to,
        interval: "15m"
      }),
    /6-metric limit/
  );
  await assert.rejects(
    () =>
      searchLogs(db, {
        from: fixtureWindow.from,
        to: "2026-08-26T16:00:00.001Z"
      }),
    /2-hour limit/
  );
  await assert.rejects(
    () =>
      searchLogs(db, {
        ...fixtureWindow,
        limit: 101
      }),
    /between 1 and 100/
  );
  await assert.rejects(
    () =>
      listDeployments(db, {
        ...fixtureWindow,
        limit: 21
      }),
    /between 1 and 20/
  );
  await assert.rejects(
    () =>
      checkDependencyHealth(db, {
        ...fixtureWindow,
        service: "catalog-origin",
        dependencies: Array.from({ length: 11 }, (_, index) => `dep-${index}`)
      }),
    /10-dependency limit/
  );
  await assert.rejects(
    () =>
      checkDependencyHealth(db, {
        from: fixtureWindow.from,
        to: "2026-08-27T14:00:00.001Z",
        service: "catalog-origin"
      }),
    /24-hour limit/
  );
});

async function corpusCounts() {
  return db
    .prepare(
      `SELECT
        c.id AS corpus_id,
        c.status,
        c.active,
        (SELECT COUNT(*) FROM request_telemetry WHERE corpus_id = c.id) AS request_count,
        (SELECT COUNT(*) FROM deployment_telemetry WHERE corpus_id = c.id) AS deployment_count,
        (SELECT COUNT(*) FROM dependency_telemetry WHERE corpus_id = c.id) AS dependency_count
      FROM telemetry_corpora c
      WHERE c.id = ?`
    )
    .bind(telemetryCorpusId)
    .first();
}

async function requestIdForOriginState(
  from: string,
  to: string,
  originRequest: boolean
): Promise<string> {
  const id = await db
    .prepare(
      `SELECT r.id
      FROM request_telemetry r
      JOIN telemetry_corpora c ON c.id = r.corpus_id
      WHERE c.active = 1 AND c.status = 'ready'
        AND r.timestamp_ms >= ? AND r.timestamp_ms < ?
        AND r.origin_request = ? AND r.response_status = 200
      ORDER BY r.timestamp_ms ASC, r.id ASC
      LIMIT 1`
    )
    .bind(Date.parse(from), Date.parse(to), originRequest ? 1 : 0)
    .first<string>("id");
  assert.ok(id, `Missing request with origin_request=${String(originRequest)}`);
  return id;
}

function pointAt(points: MetricPoint[], bucketStart: string): MetricPoint {
  const point = points.find(
    (candidate) => candidate.bucketStart === bucketStart
  );
  assert.ok(point, `Missing metric bucket ${bucketStart}`);
  return point;
}

function groupedPoint(
  points: MetricPoint[],
  bucketStart: string,
  group: string | boolean
): MetricPoint {
  const point = points.find(
    (candidate) =>
      candidate.bucketStart === bucketStart && candidate.group === group
  );
  assert.ok(point, `Missing metric bucket ${bucketStart} for ${String(group)}`);
  return point;
}

function value(
  point: MetricPoint,
  metric: keyof MetricPoint["values"]
): number {
  const result = point.values[metric];
  assert.ok(typeof result === "number", `Missing metric ${metric}`);
  return result;
}
