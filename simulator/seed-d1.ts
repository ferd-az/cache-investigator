import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cacheKeyRegressionScenario } from "./cache-key-regression.ts";
import {
  generateDependencyTelemetry,
  generateDeploymentTelemetry,
  generateRequestTelemetry,
  type DependencyTelemetry,
  type DeploymentTelemetry,
  type RequestTelemetry
} from "./generator.ts";

const D1_BINDING = "TELEMETRY_DB";
const REQUEST_ROWS_PER_STATEMENT = 20;
const STATEMENTS_PER_BATCH = 40;
const MAX_SQL_FILE_BYTES = 4_000_000;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const wranglerBin = resolve(
  projectRoot,
  "node_modules/wrangler/bin/wrangler.js"
);

export const telemetryCorpusId = `${cacheKeyRegressionScenario.id}:v${cacheKeyRegressionScenario.version}`;

export type TelemetrySeedSummary = {
  corpusId: string;
  status: "ready";
  requestCount: number;
  deploymentCount: number;
  dependencyCount: number;
};

type SeedPlan = {
  prepare: string[];
  data: AsyncIterable<string>;
  finalize: string[];
  expected: Omit<TelemetrySeedSummary, "status">;
};

/**
 * Replaces every row for the known deterministic corpus ID. The corpus remains
 * inactive until all expected rows are present, so tools cannot query a partial
 * seed. Older corpus IDs are retained but deactivated.
 */
export async function seedTelemetryCorpus(
  db: D1Database
): Promise<TelemetrySeedSummary> {
  const plan = createSeedPlan();

  await executeBatch(db, plan.prepare);
  await executeStatementBatches(db, plan.data);
  await executeBatch(db, plan.finalize);

  return verifySeed(db, plan.expected);
}

export function createSeedPlan(): SeedPlan {
  const scenario = cacheKeyRegressionScenario;
  const deployments = generateDeploymentTelemetry(scenario);
  const dependencies = generateDependencyTelemetry(scenario);
  const expected = {
    corpusId: telemetryCorpusId,
    requestCount:
      ((Date.parse(scenario.window.to) - Date.parse(scenario.window.from)) /
        60_000) *
      scenario.traffic.requestsPerMinute,
    deploymentCount: deployments.length,
    dependencyCount: dependencies.length
  };

  return {
    prepare: createPrepareStatements(expected.requestCount),
    data: createDataStatements(deployments, dependencies),
    finalize: createFinalizeStatements(expected),
    expected
  };
}

async function* createDataStatements(
  deployments: DeploymentTelemetry[],
  dependencies: DependencyTelemetry[]
): AsyncGenerator<string> {
  let requests: RequestTelemetry[] = [];

  for (const request of generateRequestTelemetry()) {
    requests.push(request);
    if (requests.length === REQUEST_ROWS_PER_STATEMENT) {
      yield requestInsert(requests);
      requests = [];
    }
  }

  if (requests.length > 0) yield requestInsert(requests);
  yield deploymentInsert(deployments);

  for (let index = 0; index < dependencies.length; index += 100) {
    yield dependencyInsert(dependencies.slice(index, index + 100));
  }
}

function createPrepareStatements(expectedRequestCount: number): string[] {
  const scenario = cacheKeyRegressionScenario;
  const corpus = sql(telemetryCorpusId);

  return [
    "UPDATE telemetry_corpora SET active = 0",
    `INSERT INTO telemetry_corpora (
      id, scenario_version, seed, window_from_ms, window_to_ms,
      expected_request_count, status, active, seeded_at
    ) VALUES (
      ${corpus}, ${scenario.version}, ${scenario.seed},
      ${Date.parse(scenario.window.from)}, ${Date.parse(scenario.window.to)},
      ${expectedRequestCount}, 'seeding', 0, NULL
    ) ON CONFLICT(id) DO UPDATE SET
      scenario_version = excluded.scenario_version,
      seed = excluded.seed,
      window_from_ms = excluded.window_from_ms,
      window_to_ms = excluded.window_to_ms,
      expected_request_count = excluded.expected_request_count,
      status = 'seeding',
      active = 0,
      seeded_at = NULL`,
    `DELETE FROM request_telemetry WHERE corpus_id = ${corpus}`,
    `DELETE FROM deployment_telemetry WHERE corpus_id = ${corpus}`,
    `DELETE FROM dependency_telemetry WHERE corpus_id = ${corpus}`
  ];
}

function createFinalizeStatements(
  expected: Omit<TelemetrySeedSummary, "status">
): string[] {
  const corpus = sql(expected.corpusId);
  const countsMatch = `
    (SELECT COUNT(*) FROM request_telemetry WHERE corpus_id = ${corpus}) = ${expected.requestCount}
    AND (SELECT COUNT(*) FROM deployment_telemetry WHERE corpus_id = ${corpus}) = ${expected.deploymentCount}
    AND (SELECT COUNT(*) FROM dependency_telemetry WHERE corpus_id = ${corpus}) = ${expected.dependencyCount}`;

  return [
    `UPDATE telemetry_corpora
      SET status = CASE WHEN ${countsMatch} THEN 'ready' ELSE 'seeding' END,
          active = CASE WHEN ${countsMatch} THEN 1 ELSE 0 END,
          seeded_at = CASE WHEN ${countsMatch} THEN ${sql(new Date().toISOString())} ELSE NULL END
      WHERE id = ${corpus}`
  ];
}

function requestInsert(requests: RequestTelemetry[]): string {
  return multiRowInsert(
    "request_telemetry",
    [
      "corpus_id",
      "id",
      "timestamp_ms",
      "service",
      "environment",
      "region",
      "method",
      "route",
      "query_json",
      "has_session_id",
      "session_id",
      "traffic_source",
      "deployment",
      "cache_key",
      "cache_status",
      "origin_request",
      "origin_queue_depth",
      "response_status",
      "response_latency_ms"
    ],
    requests.map((request) => [
      telemetryCorpusId,
      request.id,
      Date.parse(request.timestamp),
      request.service,
      request.environment,
      request.region,
      request.method,
      request.route,
      JSON.stringify(request.query),
      request.hasSessionId,
      request.sessionId ?? null,
      request.trafficSource,
      request.deployment,
      request.cacheKey,
      request.cacheStatus,
      request.originRequest,
      request.originQueueDepth,
      request.responseStatus,
      request.responseLatencyMs
    ])
  );
}

function deploymentInsert(deployments: DeploymentTelemetry[]): string {
  return multiRowInsert(
    "deployment_telemetry",
    [
      "corpus_id",
      "id",
      "service",
      "environment",
      "version",
      "commit_hash",
      "deployed_at_ms",
      "changes_json"
    ],
    deployments.map((deployment) => [
      telemetryCorpusId,
      deployment.id,
      deployment.service,
      deployment.environment,
      deployment.version,
      deployment.commit,
      Date.parse(deployment.deployedAt),
      JSON.stringify(deployment.changes)
    ])
  );
}

function dependencyInsert(dependencies: DependencyTelemetry[]): string {
  return multiRowInsert(
    "dependency_telemetry",
    [
      "corpus_id",
      "timestamp_ms",
      "service",
      "dependency",
      "latency_p99_ms",
      "error_rate",
      "healthy"
    ],
    dependencies.map((sample) => [
      telemetryCorpusId,
      Date.parse(sample.timestamp),
      sample.service,
      sample.dependency,
      sample.latencyP99Ms,
      sample.errorRate,
      sample.healthy
    ])
  );
}

function multiRowInsert(
  table: string,
  columns: string[],
  rows: Array<Array<string | number | boolean | null>>
): string {
  const values = rows
    .map((row) => `(${row.map((value) => sql(value)).join(", ")})`)
    .join(",\n");
  const statement = `INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${values}`;

  if (Buffer.byteLength(statement) > 100_000) {
    throw new Error(`Seed statement for ${table} exceeds D1's 100 KB limit`);
  }

  return statement;
}

function sql(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Cannot serialize non-finite SQL number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replaceAll("'", "''")}'`;
}

async function executeStatementBatches(
  db: D1Database,
  statements: AsyncIterable<string>
) {
  let batch: string[] = [];

  for await (const statement of statements) {
    batch.push(statement);
    if (batch.length === STATEMENTS_PER_BATCH) {
      await executeBatch(db, batch);
      batch = [];
    }
  }

  if (batch.length > 0) await executeBatch(db, batch);
}

async function executeBatch(db: D1Database, statements: string[]) {
  if (statements.length === 0) return;
  if (statements.length > STATEMENTS_PER_BATCH) {
    throw new Error(`Seed batch exceeds ${STATEMENTS_PER_BATCH} D1 statements`);
  }
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

async function verifySeed(
  db: D1Database,
  expected: Omit<TelemetrySeedSummary, "status">
): Promise<TelemetrySeedSummary> {
  const row = await db
    .prepare(
      `SELECT
        c.id AS corpus_id,
        c.status,
        (SELECT COUNT(*) FROM request_telemetry WHERE corpus_id = c.id) AS request_count,
        (SELECT COUNT(*) FROM deployment_telemetry WHERE corpus_id = c.id) AS deployment_count,
        (SELECT COUNT(*) FROM dependency_telemetry WHERE corpus_id = c.id) AS dependency_count
      FROM telemetry_corpora c
      WHERE c.id = ? AND c.active = 1`
    )
    .bind(expected.corpusId)
    .first<{
      corpus_id: string;
      status: string;
      request_count: number;
      deployment_count: number;
      dependency_count: number;
    }>();

  if (
    !row ||
    row.status !== "ready" ||
    row.request_count !== expected.requestCount ||
    row.deployment_count !== expected.deploymentCount ||
    row.dependency_count !== expected.dependencyCount
  ) {
    throw new Error(`D1 seed verification failed: ${JSON.stringify(row)}`);
  }

  return {
    corpusId: row.corpus_id,
    status: "ready",
    requestCount: row.request_count,
    deploymentCount: row.deployment_count,
    dependencyCount: row.dependency_count
  };
}

async function writeSeedSqlFiles(directory: string, plan: SeedPlan) {
  const files: string[] = [];
  files.push(await writeSqlFile(directory, "000-prepare.sql", plan.prepare));

  let statements: string[] = [];
  let bytes = 0;
  let index = 1;

  for await (const statement of plan.data) {
    const statementBytes = Buffer.byteLength(statement) + 2;
    if (statements.length > 0 && bytes + statementBytes > MAX_SQL_FILE_BYTES) {
      files.push(
        await writeSqlFile(
          directory,
          `${String(index).padStart(3, "0")}-data.sql`,
          statements
        )
      );
      index += 1;
      statements = [];
      bytes = 0;
    }
    statements.push(statement);
    bytes += statementBytes;
  }

  if (statements.length > 0) {
    files.push(
      await writeSqlFile(
        directory,
        `${String(index).padStart(3, "0")}-data.sql`,
        statements
      )
    );
  }

  files.push(await writeSqlFile(directory, "999-finalize.sql", plan.finalize));
  return files;
}

async function writeSqlFile(
  directory: string,
  filename: string,
  statements: string[]
) {
  const path = resolve(directory, filename);
  await writeFile(path, `${statements.join(";\n")};\n`, "utf8");
  return path;
}

async function runWrangler(args: string[], capture = false): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: projectRoot,
      env: { ...process.env, CI: "1" },
      stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit"
    });
    let stdout = "";
    if (capture && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`Wrangler exited with code ${code}`));
    });
  });
}

async function runCli() {
  const mode = process.argv[2];
  if (mode !== "--local" && mode !== "--remote") {
    throw new Error("Pass exactly one seed target: --local or --remote");
  }
  const persistPath = process.env.CACHE_INVESTIGATOR_D1_PERSIST_PATH;
  if (persistPath && mode !== "--local") {
    throw new Error(
      "CACHE_INVESTIGATOR_D1_PERSIST_PATH can only be used with --local"
    );
  }
  const targetArgs = [
    mode,
    ...(persistPath ? ["--persist-to", resolve(persistPath)] : [])
  ];

  const directory = await mkdtemp(
    resolve(tmpdir(), "cache-investigator-seed-")
  );
  try {
    await runWrangler(["d1", "migrations", "apply", D1_BINDING, ...targetArgs]);
    const plan = createSeedPlan();
    const files = await writeSeedSqlFiles(directory, plan);
    for (const file of files) {
      await runWrangler([
        "d1",
        "execute",
        D1_BINDING,
        ...targetArgs,
        "--file",
        file,
        "--yes"
      ]);
    }

    const output = await runWrangler(
      [
        "d1",
        "execute",
        D1_BINDING,
        ...targetArgs,
        "--command",
        `SELECT id, status, expected_request_count FROM telemetry_corpora WHERE active = 1`,
        "--json"
      ],
      true
    );
    const result = JSON.parse(output) as Array<{
      results?: Array<{
        id: string;
        status: string;
        expected_request_count: number;
      }>;
    }>;
    const corpus = result[0]?.results?.[0];
    if (
      corpus?.id !== telemetryCorpusId ||
      corpus.status !== "ready" ||
      corpus.expected_request_count !== plan.expected.requestCount
    ) {
      throw new Error(
        `Wrangler seed verification failed: ${JSON.stringify(corpus)}`
      );
    }
    console.log(
      `Replaced ${telemetryCorpusId} with ${plan.expected.requestCount} deterministic request rows.`
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
