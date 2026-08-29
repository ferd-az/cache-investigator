import assert from "node:assert/strict";
import test from "node:test";
import { completedCacheKeyRegression } from "../fixtures/cache-key-regression.ts";
import type { QueryMetricsResult } from "../telemetry/tools.ts";
import type { Investigation } from "./contracts.ts";
import { getInvestigationSignalData } from "./signal-data.ts";

test("chart data comes from the investigation's persisted tool results", () => {
  const signal = getInvestigationSignalData(completedCacheKeyRegression);

  assert.ok(signal);
  assert.equal(signal.scopeLabel, "/products");
  assert.equal(signal.series.from, "2026-08-26T14:00:00.000Z");
  assert.equal(signal.series.to, "2026-08-26T15:00:00.000Z");
  assert.equal(signal.series.points.length, 60);
  assert.equal(signal.onsetAt, "2026-08-26T14:20:00.000Z");
  assert.deepEqual(signal.markers, [
    {
      label: "catalog-edge-v42",
      at: "2026-08-26T14:18:00.000Z"
    }
  ]);
  assert.deepEqual(signal.bands, [
    {
      label: "bot burst",
      from: "2026-08-26T14:08:00.000Z",
      to: "2026-08-26T14:12:00.000Z"
    }
  ]);
});

test("reported onset aligns to the nearest observable metric bucket", () => {
  const investigation: Investigation = {
    ...completedCacheKeyRegression,
    finding: {
      ...completedCacheKeyRegression.finding!,
      impact: {
        ...completedCacheKeyRegression.finding!.impact,
        startedAt: "2026-08-26T14:18:00.000Z"
      }
    },
    events: completedCacheKeyRegression.events.map((event) => {
      if (
        event.type === "tool.started" &&
        event.tool === "query_metrics" &&
        event.callId === "call-overview"
      ) {
        return {
          ...event,
          input: { ...event.input, interval: "5m" as const }
        };
      }
      if (event.type === "tool.completed" && event.callId === "call-overview") {
        const result = event.result as QueryMetricsResult;
        return {
          ...event,
          result: {
            ...result,
            interval: "5m" as const,
            points: result.points
              .filter(
                (point) => new Date(point.bucketStart).getUTCMinutes() % 5 === 0
              )
              .map((point) => ({
                ...point,
                bucketEnd: new Date(
                  Date.parse(point.bucketStart) + 5 * 60_000
                ).toISOString()
              }))
          }
        };
      }
      return event;
    })
  };

  assert.equal(
    getInvestigationSignalData(investigation)?.onsetAt,
    "2026-08-26T14:20:00.000Z"
  );
});

test("chart data is absent when the investigation has no persisted metric result", () => {
  const withoutResults: Investigation = {
    ...completedCacheKeyRegression,
    events: completedCacheKeyRegression.events.map((event) =>
      event.type === "tool.completed" ? { ...event, result: undefined } : event
    )
  };

  assert.equal(getInvestigationSignalData(withoutResults), null);
});

test("the overview receipt contains only values derived from its metric result", () => {
  const evidence =
    completedCacheKeyRegression.finding?.evidence.find(
      (item) => item.id === "ev-overview"
    ) ?? assert.fail("Missing overview evidence");
  const labels = evidence.values.map((value) => value.label);

  assert.ok(labels.every((label) => label.startsWith("GET /products")));
  assert.ok(labels.every((label) => !/capacity|service-wide/i.test(label)));
  assert.deepEqual(
    evidence.values.map((value) => value.value),
    [93, 18, 900, 13.6, 1806]
  );
});
