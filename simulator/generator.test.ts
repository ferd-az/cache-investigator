import assert from "node:assert/strict";
import test from "node:test";
import { completedCacheKeyRegression } from "../src/fixtures/cache-key-regression.ts";
import { aggregateRequests, averageDependencyLatency } from "./aggregate.ts";
import { cacheKeyRegressionScenario } from "./cache-key-regression.ts";
import {
  generateDependencyTelemetry,
  generateDeploymentTelemetry,
  generateRequestTelemetry
} from "./generator.ts";

const requests = [...generateRequestTelemetry()];
const dependencies = generateDependencyTelemetry();
const finding = getFixtureFinding();

const baselineWindow = {
  from: "2026-08-26T14:00:00.000Z",
  to: "2026-08-26T14:08:00.000Z"
};
const botWindow = {
  from: cacheKeyRegressionScenario.decoy.from,
  to: cacheKeyRegressionScenario.decoy.to
};
const recoveredWindow = {
  from: cacheKeyRegressionScenario.decoy.recoveredBy,
  to: cacheKeyRegressionScenario.deployment.deployedAt
};
const incidentWindow = {
  from: "2026-08-26T14:25:00.000Z",
  to: "2026-08-26T14:30:00.000Z"
};

test("generates the complete deterministic two-hour corpus", () => {
  assert.equal(requests.length, 216_000);
  assert.equal(requests[0].id, "req_000001");
  assert.equal(requests.at(-1)?.id, "req_216000");
  assert.ok(requests[0].timestamp >= cacheKeyRegressionScenario.window.from);
  assert.ok(requests.at(-1)!.timestamp < cacheKeyRegressionScenario.window.to);

  const repeated = generateRequestTelemetry();
  assert.deepEqual(
    Array.from({ length: 100 }, () => repeated.next().value),
    requests.slice(0, 100)
  );
});

test("models the bot burst as a recovered decoy", () => {
  const baseline = aggregateRequests(requests, baselineWindow);
  const bot = aggregateRequests(requests, botWindow);
  const recovered = aggregateRequests(requests, recoveredWindow);

  assert.ok(bot.requestsPerMinute > baseline.requestsPerMinute * 1.35);
  assert.equal(bot.response429Rate, 0);
  assert.equal(recovered.response429Rate, 0);
  assert.ok(Math.abs(recovered.cacheHitRate - baseline.cacheHitRate) < 0.01);
  assert.ok(recovered.responseLatencyP99Ms < 250);
});

test("derives the fixture's cache-to-origin causal chain", () => {
  const baseline = aggregateRequests(requests, baselineWindow);
  const service = aggregateRequests(requests, incidentWindow);
  const products = aggregateRequests(requests, {
    ...incidentWindow,
    route: "/products"
  });
  const withSession = aggregateRequests(requests, {
    ...incidentWindow,
    route: "/products",
    hasSessionId: true
  });
  const withoutSession = aggregateRequests(requests, {
    ...incidentWindow,
    route: "/products",
    hasSessionId: false
  });

  assertNear(
    baseline.cacheHitRate,
    fixtureNumber("ev-overview", "Hit rate before") / 100,
    0.01
  );
  assertNear(
    service.cacheHitRate,
    fixtureNumber("ev-overview", "Service hit rate after") / 100,
    0.015
  );
  assertNear(
    products.cacheHitRate,
    fixtureNumber("ev-route", "/products hit rate") / 100,
    0.01
  );
  assertNear(
    withSession.cacheHitRate,
    fixtureNumber("ev-session-segment", "With session_id") / 100,
    0.01
  );
  assertNear(
    withoutSession.cacheHitRate,
    fixtureNumber("ev-session-segment", "Without session_id") / 100,
    0.02
  );
  assertNear(
    service.originRequestsPerMinute,
    fixtureNumber("ev-overview", "Origin requests after"),
    15
  );
  assertNear(
    products.response429Rate,
    fixtureNumber("ev-overview", "/products 429s after") / 100,
    0.005
  );
  assertNear(
    products.responseLatencyP99Ms,
    fixtureNumber("ev-overview", "Response p99 after"),
    15
  );
  assertNear(
    service.cacheKeyCardinality,
    fixtureNumber("ev-session-segment", "Keys per 5m after"),
    50
  );
});

test("keeps unaffected routes healthy after the deployment", () => {
  for (const route of ["/categories", "/search"]) {
    const aggregate = aggregateRequests(requests, {
      ...incidentWindow,
      route
    });
    assert.ok(aggregate.cacheHitRate > 0.89);
    assert.equal(aggregate.response429Rate, 0);
    assert.ok(aggregate.responseLatencyP99Ms < 250);
  }
});

test("changes only session-bearing product cache keys after fault activation", () => {
  const faultActiveAt = Date.parse(
    cacheKeyRegressionScenario.deployment.faultActiveAt
  );
  const productRequests = requests.filter(
    (request) => request.route === "/products" && request.hasSessionId
  );
  const before = productRequests.filter(
    (request) => Date.parse(request.timestamp) < faultActiveAt
  );
  const after = productRequests.filter(
    (request) => Date.parse(request.timestamp) >= faultActiveAt
  );

  assert.ok(
    before.every((request) => !request.cacheKey.includes("session_id"))
  );
  assert.ok(after.every((request) => request.cacheKey.includes("session_id")));

  const deployments = generateDeploymentTelemetry();
  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].version, "catalog-edge-v42");
  assert.match(deployments[0].changes[0], /session_id/);
});

test("produces the high-cardinality log evidence and healthy dependencies", () => {
  const sample = requests
    .filter(
      (request) =>
        request.timestamp >= "2026-08-26T14:20:00.000Z" &&
        request.timestamp < "2026-08-26T14:25:00.000Z" &&
        request.route === "/products" &&
        request.hasSessionId &&
        request.cacheStatus === "MISS" &&
        request.query.category === "shoes" &&
        request.query.page === "1"
    )
    .slice(0, 100);

  assert.equal(sample.length, 100);
  assert.equal(
    new Set(sample.map((request) => request.cacheKey)).size,
    fixtureNumber("ev-log-sample", "Distinct keys")
  );

  assertNear(
    averageDependencyLatency(
      dependencies,
      "catalog-db",
      "2026-08-26T14:15:00.000Z",
      "2026-08-26T14:45:00.000Z"
    ),
    fixtureNumber("ev-dependencies", "catalog-db p99"),
    1
  );
  assertNear(
    averageDependencyLatency(
      dependencies,
      "inventory-api",
      "2026-08-26T14:15:00.000Z",
      "2026-08-26T14:45:00.000Z"
    ),
    fixtureNumber("ev-dependencies", "inventory-api p99"),
    1
  );
  assert.ok(dependencies.every((sample) => sample.healthy));
});

function fixtureNumber(evidenceId: string, label: string): number {
  const evidence = finding.evidence.find((item) => item.id === evidenceId);
  const value = evidence?.values.find((item) => item.label === label)?.value;
  if (typeof value !== "number") {
    throw new Error(`Missing numeric fixture value: ${evidenceId}.${label}`);
  }
  return value;
}

function getFixtureFinding() {
  const fixtureFinding = completedCacheKeyRegression.finding;
  if (!fixtureFinding) {
    throw new Error("Completed fixture must include a finding");
  }
  return fixtureFinding;
}

function assertNear(actual: number, expected: number, tolerance: number) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `Expected ${actual} to be within ${tolerance} of ${expected}`
  );
}
