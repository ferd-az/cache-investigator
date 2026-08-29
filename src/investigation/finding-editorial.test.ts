import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalizeFindingUnit,
  formatFindingValue,
  machineMetricInEditorialField,
  repeatedEditorialFieldPair
} from "./finding-editorial.ts";

test("finding units and values use compact engineering notation", () => {
  assert.equal(canonicalizeFindingUnit("percent"), "%");
  assert.equal(canonicalizeFindingUnit("milliseconds"), "ms");
  assert.equal(canonicalizeFindingUnit("requests_per_minute"), "req/min");
  assert.equal(canonicalizeFindingUnit("cache_entries"), "cache entries");

  assert.equal(formatFindingValue(18.01, "percent"), "18");
  assert.equal(formatFindingValue(13.6, "percent"), "13.6");
  assert.equal(formatFindingValue(1807, "milliseconds"), "1,807");
  assert.equal(formatFindingValue(907.8, "requests_per_minute"), "908");
});

test("editorial repetition catches copied sections without rejecting related claims", () => {
  assert.deepEqual(
    repeatedEditorialFieldPair([
      ["rootCause.change", "v17 lowered the upstream timeout to 500 ms."],
      [
        "rootCause.summary",
        "v17 lowered the upstream timeout to 500 ms. Requests now close early."
      ]
    ]),
    ["rootCause.change", "rootCause.summary"]
  );

  assert.equal(
    repeatedEditorialFieldPair([
      ["rootCause.change", "v17 lowered the upstream timeout to 500 ms."],
      [
        "rootCause.summary",
        "The gateway now closes requests before the payment service responds."
      ]
    ]),
    undefined
  );
});

test("editorial copy rejects machine metric names but preserves useful identifiers", () => {
  assert.deepEqual(
    machineMetricInEditorialField([
      [
        "recommendation.verify",
        "Confirm cache_hit_rate remains above 90% for 10 minutes."
      ]
    ]),
    ["recommendation.verify", "cache_hit_rate"]
  );
  assert.equal(
    machineMetricInEditorialField([
      [
        "rootCause.change",
        "catalog-edge-v42 stopped stripping session_id from /products cache keys."
      ]
    ]),
    undefined
  );
});
