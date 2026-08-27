import type {
  FinalFinding,
  Investigation,
  InvestigationPlanStep
} from "../investigation/contracts";

const investigationId = "inv_cache_20260826_001";

const plan: InvestigationPlanStep[] = [
  {
    id: "locate-change",
    title: "Locate when user-facing behavior changed",
    status: "completed"
  },
  {
    id: "narrow-scope",
    title: "Narrow the regression by route and traffic segment",
    status: "completed"
  },
  {
    id: "correlate-changes",
    title: "Correlate the onset with deployments and configuration changes",
    status: "completed"
  },
  {
    id: "test-cause",
    title: "Test the leading cause against logs and dependency health",
    status: "completed"
  }
];

const finding: FinalFinding = {
  id: "finding_cache_key_session_id",
  headline: "A cache-key change is overloading the catalog origin",
  status: "confirmed",
  summary:
    "catalog-edge-v42 began including session_id in /products cache keys. The resulting key explosion dropped cache hits, pushed request volume past origin capacity, and caused 429s and elevated latency.",
  impact: {
    startedAt: "2026-08-26T14:20:00.000Z",
    summary:
      "GET /products is returning 12.7% 429 responses with p99 latency at 1.81 seconds. Other catalog routes remain healthy.",
    affectedRoutes: ["GET /products"],
    indicators: [
      { label: "Cache hit rate", value: 18, unit: "%" },
      { label: "Origin 429 rate", value: 12.7, unit: "%" },
      { label: "Response p99", value: 1810, unit: "ms" }
    ]
  },
  rootCause: {
    summary:
      "The /products cache key now varies by the high-cardinality session_id query parameter.",
    change:
      "catalog-edge-v42 (commit 8f31ad2) removed session_id from the cache-key normalization exclusion list.",
    mechanism: [
      "Session-bearing requests stopped sharing cached /products responses.",
      "Five-minute cache-key cardinality rose from 124 to about 4,480.",
      "/products cache hit rate fell from 92% to 18%, sending misses to the origin.",
      "Origin traffic exceeded capacity and produced 429s and queueing latency."
    ]
  },
  confidence: {
    level: "high",
    score: 0.96,
    rationale:
      "The onset follows one deployment by two minutes, is isolated to its changed route, and only affects requests carrying session_id. Origin dependencies remained healthy."
  },
  recommendation: {
    immediate:
      "Roll back catalog-edge-v42 or restore session_id removal in the /products cache-key normalizer.",
    verify:
      "Confirm key cardinality returns below 2,000 per five minutes, cache hit rate exceeds 90%, and origin 429s fall below 0.5% for 15 minutes.",
    followUps: [
      "Add a cardinality guardrail for cache-key dimensions.",
      "Alert when cache misses and origin saturation rise together after a deployment.",
      "Add a regression test covering ignored session and tracking parameters."
    ]
  },
  evidence: [
    {
      id: "ev-overview",
      kind: "metric",
      title: "The regression begins at 14:20 UTC",
      claim:
        "Cache hit rate, origin errors, and response latency change together two minutes after the deployment.",
      source: {
        tool: "query_metrics",
        callId: "call-overview",
        input: {
          metrics: [
            "request_count",
            "cache_hit_rate",
            "origin_request_count",
            "origin_error_rate",
            "response_latency_p99"
          ],
          from: "2026-08-26T14:00:00.000Z",
          to: "2026-08-26T15:00:00.000Z",
          interval: "5m"
        }
      },
      window: {
        from: "2026-08-26T14:00:00.000Z",
        to: "2026-08-26T15:00:00.000Z"
      },
      values: [
        { label: "Hit rate before", value: 92, unit: "%" },
        { label: "Service hit rate after", value: 45.7, unit: "%" },
        { label: "Origin requests after", value: 945, unit: "req/min" },
        { label: "Route origin capacity", value: 750, unit: "req/min" },
        { label: "/products 429s after", value: 12.7, unit: "%" },
        { label: "Response p99 after", value: 1810, unit: "ms" }
      ]
    },
    {
      id: "ev-route",
      kind: "metric",
      title: "The impact is isolated to GET /products",
      claim:
        "/categories and /search retain normal hit rates and latency during the same window.",
      source: {
        tool: "query_metrics",
        callId: "call-route",
        input: {
          metrics: ["cache_hit_rate", "origin_error_rate"],
          from: "2026-08-26T14:15:00.000Z",
          to: "2026-08-26T14:45:00.000Z",
          interval: "5m",
          groupBy: "route"
        }
      },
      window: {
        from: "2026-08-26T14:15:00.000Z",
        to: "2026-08-26T14:45:00.000Z"
      },
      values: [
        { label: "/products hit rate", value: 18, unit: "%" },
        { label: "/categories hit rate", value: 91.4, unit: "%" },
        { label: "/search hit rate", value: 90.8, unit: "%" }
      ]
    },
    {
      id: "ev-deployment",
      kind: "deployment",
      title: "catalog-edge-v42 changed cache-key normalization",
      claim:
        "The only deployment near the onset removed session_id from the ignored-parameter list for /products.",
      source: {
        tool: "list_deployments",
        callId: "call-deployments",
        input: {
          from: "2026-08-26T13:20:00.000Z",
          to: "2026-08-26T14:30:00.000Z",
          service: "catalog-edge",
          limit: 20
        }
      },
      observedAt: "2026-08-26T14:18:00.000Z",
      values: [
        { label: "Version", value: "catalog-edge-v42" },
        { label: "Commit", value: "8f31ad2" },
        { label: "Time to symptom", value: 2, unit: "min" }
      ]
    },
    {
      id: "ev-session-segment",
      kind: "metric",
      title: "Only session-bearing requests lose cache reuse",
      claim:
        "Requests with session_id fall to a 3.8% hit rate while requests without it remain above 90%.",
      source: {
        tool: "query_metrics",
        callId: "call-session-segment",
        input: {
          metrics: ["cache_hit_rate", "cache_key_cardinality"],
          from: "2026-08-26T14:20:00.000Z",
          to: "2026-08-26T14:40:00.000Z",
          interval: "5m",
          filters: { route: "/products" },
          groupBy: "has_session_id"
        }
      },
      window: {
        from: "2026-08-26T14:20:00.000Z",
        to: "2026-08-26T14:40:00.000Z"
      },
      values: [
        { label: "With session_id", value: 3.8, unit: "% hit" },
        { label: "Without session_id", value: 90.7, unit: "% hit" },
        { label: "Keys per 5m before", value: 124 },
        { label: "Keys per 5m after", value: 4480 }
      ]
    },
    {
      id: "ev-log-sample",
      kind: "log",
      title: "Cache keys differ only by session_id",
      claim:
        "Miss samples for the same product query produce distinct cache keys when session_id changes.",
      source: {
        tool: "search_logs",
        callId: "call-logs",
        input: {
          from: "2026-08-26T14:20:00.000Z",
          to: "2026-08-26T14:25:00.000Z",
          service: "catalog-edge",
          route: "/products",
          cacheStatus: "MISS",
          hasSessionId: true,
          limit: 100
        }
      },
      window: {
        from: "2026-08-26T14:20:00.000Z",
        to: "2026-08-26T14:25:00.000Z"
      },
      values: [
        { label: "Samples inspected", value: 100 },
        { label: "Distinct keys", value: 100 },
        { label: "Shared product query", value: "category=shoes&page=1" }
      ]
    },
    {
      id: "ev-dependencies",
      kind: "dependency",
      title: "Origin dependencies are healthy",
      claim:
        "Database and inventory API latency remain within baseline; origin errors track excess request volume instead.",
      source: {
        tool: "check_dependency_health",
        callId: "call-dependencies-retry",
        input: {
          from: "2026-08-26T14:15:00.000Z",
          to: "2026-08-26T14:45:00.000Z",
          service: "catalog-origin",
          dependencies: ["catalog-db", "inventory-api"]
        }
      },
      window: {
        from: "2026-08-26T14:15:00.000Z",
        to: "2026-08-26T14:45:00.000Z"
      },
      values: [
        { label: "catalog-db p99", value: 42, unit: "ms" },
        { label: "inventory-api p99", value: 71, unit: "ms" },
        { label: "Unhealthy dependencies", value: 0 }
      ]
    },
    {
      id: "ev-bot-recovery",
      kind: "metric",
      title: "The earlier bot burst recovered before the incident",
      claim:
        "Traffic spiked from 14:08–14:12, but hit rate and latency returned to baseline by 14:14.",
      source: {
        tool: "query_metrics",
        callId: "call-overview",
        input: {
          metrics: [
            "request_count",
            "cache_hit_rate",
            "origin_request_count",
            "origin_error_rate",
            "response_latency_p99"
          ],
          from: "2026-08-26T14:00:00.000Z",
          to: "2026-08-26T15:00:00.000Z",
          interval: "5m"
        }
      },
      window: {
        from: "2026-08-26T14:00:00.000Z",
        to: "2026-08-26T14:20:00.000Z"
      },
      values: [
        { label: "Burst ended", value: "14:12 UTC" },
        { label: "Metrics recovered", value: "14:14 UTC" },
        { label: "Regression began", value: "14:20 UTC" }
      ]
    }
  ],
  alternativesRuledOut: [
    {
      hypothesis: "The 14:08 bot burst exhausted origin capacity",
      reason:
        "The traffic burst ended and all service indicators recovered six minutes before the persistent regression began.",
      evidenceIds: ["ev-bot-recovery", "ev-overview"]
    },
    {
      hypothesis: "A downstream database or inventory dependency degraded",
      reason:
        "Both dependencies remained within their normal latency and error bands throughout the incident window.",
      evidenceIds: ["ev-dependencies"]
    }
  ]
};

export const completedCacheKeyRegression: Investigation = {
  id: investigationId,
  title: "Catalog latency and 429 regression",
  status: "completed",
  trigger: {
    kind: "manual",
    label: "Investigate the production catalog regression"
  },
  scope: {
    service: "catalog-edge",
    environment: "production",
    question:
      "Why did catalog latency and 429 responses increase after 14:00 UTC?",
    window: {
      from: "2026-08-26T14:00:00.000Z",
      to: "2026-08-26T15:00:00.000Z"
    }
  },
  createdAt: "2026-08-26T14:49:00.000Z",
  startedAt: "2026-08-26T14:49:02.000Z",
  completedAt: "2026-08-26T14:51:08.000Z",
  plan,
  events: [
    {
      id: "evt-001",
      investigationId,
      sequence: 1,
      at: "2026-08-26T14:49:02.000Z",
      type: "investigation.started",
      question:
        "Why did catalog latency and 429 responses increase after 14:00 UTC?"
    },
    {
      id: "evt-002",
      investigationId,
      sequence: 2,
      at: "2026-08-26T14:49:03.000Z",
      type: "plan.updated",
      steps: plan.map((step, index) => ({
        ...step,
        status: index === 0 ? "active" : "pending"
      }))
    },
    {
      id: "evt-003",
      investigationId,
      sequence: 3,
      at: "2026-08-26T14:49:04.000Z",
      type: "tool.started",
      callId: "call-overview",
      tool: "query_metrics",
      label: "Scanning service indicators for the first sustained change",
      input: {
        metrics: [
          "request_count",
          "cache_hit_rate",
          "origin_request_count",
          "origin_error_rate",
          "response_latency_p99"
        ],
        from: "2026-08-26T14:00:00.000Z",
        to: "2026-08-26T15:00:00.000Z",
        interval: "5m"
      }
    },
    {
      id: "evt-004",
      investigationId,
      sequence: 4,
      at: "2026-08-26T14:49:09.000Z",
      type: "tool.progress",
      callId: "call-overview",
      message: "Aggregating 108,000 request records into five-minute buckets",
      elapsedMs: 5000
    },
    {
      id: "evt-005",
      investigationId,
      sequence: 5,
      at: "2026-08-26T14:49:12.000Z",
      type: "tool.completed",
      callId: "call-overview",
      summary:
        "Found a sustained change at 14:20: hit rate falls as origin errors and p99 latency rise.",
      durationMs: 8100,
      rowCount: 60,
      evidenceIds: ["ev-overview", "ev-bot-recovery"]
    },
    {
      id: "evt-006",
      investigationId,
      sequence: 6,
      at: "2026-08-26T14:49:14.000Z",
      type: "hypothesis.updated",
      hypothesisId: "hyp-bot-burst",
      statement: "An earlier bot burst exhausted origin capacity",
      status: "considering",
      confidence: 0.28,
      evidenceIds: ["ev-bot-recovery"]
    },
    {
      id: "evt-007",
      investigationId,
      sequence: 7,
      at: "2026-08-26T14:49:16.000Z",
      type: "tool.started",
      callId: "call-route",
      tool: "query_metrics",
      label: "Comparing cache and error behavior by route",
      input: {
        metrics: ["cache_hit_rate", "origin_error_rate"],
        from: "2026-08-26T14:15:00.000Z",
        to: "2026-08-26T14:45:00.000Z",
        interval: "5m",
        groupBy: "route"
      }
    },
    {
      id: "evt-008",
      investigationId,
      sequence: 8,
      at: "2026-08-26T14:49:21.000Z",
      type: "tool.completed",
      callId: "call-route",
      summary:
        "The persistent regression is isolated to GET /products; other catalog routes remain healthy.",
      durationMs: 4700,
      rowCount: 36,
      evidenceIds: ["ev-route"]
    },
    {
      id: "evt-009",
      investigationId,
      sequence: 9,
      at: "2026-08-26T14:49:23.000Z",
      type: "observation.added",
      observationId: "obs-route-scope",
      title: "The regression is route-specific",
      detail:
        "Only /products loses cache efficiency, which points away from a service-wide traffic or dependency failure.",
      evidenceIds: ["ev-route"]
    },
    {
      id: "evt-010",
      investigationId,
      sequence: 10,
      at: "2026-08-26T14:49:25.000Z",
      type: "tool.started",
      callId: "call-deployments",
      tool: "list_deployments",
      label: "Looking for changes immediately before 14:20",
      input: {
        from: "2026-08-26T13:20:00.000Z",
        to: "2026-08-26T14:30:00.000Z",
        service: "catalog-edge",
        limit: 20
      }
    },
    {
      id: "evt-011",
      investigationId,
      sequence: 11,
      at: "2026-08-26T14:49:28.000Z",
      type: "tool.completed",
      callId: "call-deployments",
      summary:
        "catalog-edge-v42 deployed at 14:18 and changed cache-key normalization for /products.",
      durationMs: 2900,
      rowCount: 1,
      evidenceIds: ["ev-deployment"]
    },
    {
      id: "evt-012",
      investigationId,
      sequence: 12,
      at: "2026-08-26T14:49:31.000Z",
      type: "hypothesis.updated",
      hypothesisId: "hyp-cache-key",
      statement:
        "catalog-edge-v42 fragmented the /products cache by session_id",
      status: "considering",
      confidence: 0.68,
      evidenceIds: ["ev-overview", "ev-route", "ev-deployment"]
    },
    {
      id: "evt-013",
      investigationId,
      sequence: 13,
      at: "2026-08-26T14:49:34.000Z",
      type: "tool.started",
      callId: "call-session-segment",
      tool: "query_metrics",
      label: "Testing cache behavior with and without session_id",
      input: {
        metrics: ["cache_hit_rate", "cache_key_cardinality"],
        from: "2026-08-26T14:20:00.000Z",
        to: "2026-08-26T14:40:00.000Z",
        interval: "5m",
        filters: { route: "/products" },
        groupBy: "has_session_id"
      }
    },
    {
      id: "evt-014",
      investigationId,
      sequence: 14,
      at: "2026-08-26T14:49:40.000Z",
      type: "tool.completed",
      callId: "call-session-segment",
      summary:
        "Session-bearing requests have a 3.8% hit rate and drive a 36x increase in key cardinality.",
      durationMs: 6100,
      rowCount: 16,
      evidenceIds: ["ev-session-segment"]
    },
    {
      id: "evt-015",
      investigationId,
      sequence: 15,
      at: "2026-08-26T14:49:43.000Z",
      type: "tool.started",
      callId: "call-logs",
      tool: "search_logs",
      label: "Sampling misses to inspect the generated cache keys",
      input: {
        from: "2026-08-26T14:20:00.000Z",
        to: "2026-08-26T14:25:00.000Z",
        service: "catalog-edge",
        route: "/products",
        cacheStatus: "MISS",
        hasSessionId: true,
        limit: 100
      }
    },
    {
      id: "evt-016",
      investigationId,
      sequence: 16,
      at: "2026-08-26T14:49:51.000Z",
      type: "tool.progress",
      callId: "call-logs",
      message:
        "Reading the capped sample; the remaining rows stay in telemetry",
      elapsedMs: 8000
    },
    {
      id: "evt-017",
      investigationId,
      sequence: 17,
      at: "2026-08-26T14:49:56.000Z",
      type: "tool.completed",
      callId: "call-logs",
      summary:
        "All 100 equivalent product requests have distinct keys that differ by session_id.",
      durationMs: 12800,
      rowCount: 100,
      nextCursor: "log_01K3M0E7VF5R",
      evidenceIds: ["ev-log-sample"]
    },
    {
      id: "evt-018",
      investigationId,
      sequence: 18,
      at: "2026-08-26T14:49:59.000Z",
      type: "hypothesis.updated",
      hypothesisId: "hyp-cache-key",
      statement:
        "catalog-edge-v42 fragmented the /products cache by session_id",
      status: "supported",
      confidence: 0.92,
      evidenceIds: ["ev-deployment", "ev-session-segment", "ev-log-sample"]
    },
    {
      id: "evt-019",
      investigationId,
      sequence: 19,
      at: "2026-08-26T14:50:02.000Z",
      type: "tool.started",
      callId: "call-dependencies",
      tool: "check_dependency_health",
      label: "Checking whether downstream degradation explains the errors",
      input: {
        from: "2026-08-26T14:15:00.000Z",
        to: "2026-08-26T14:45:00.000Z",
        service: "catalog-origin",
        dependencies: ["catalog-db", "inventory-api"]
      }
    },
    {
      id: "evt-020",
      investigationId,
      sequence: 20,
      at: "2026-08-26T14:50:33.000Z",
      type: "tool.failed",
      callId: "call-dependencies",
      message: "Dependency summary timed out after 30 seconds",
      durationMs: 30000,
      attempt: 1,
      retryable: true
    },
    {
      id: "evt-021",
      investigationId,
      sequence: 21,
      at: "2026-08-26T14:50:35.000Z",
      type: "tool.started",
      callId: "call-dependencies-retry",
      tool: "check_dependency_health",
      label: "Retrying dependency health with the two relevant dependencies",
      input: {
        from: "2026-08-26T14:15:00.000Z",
        to: "2026-08-26T14:45:00.000Z",
        service: "catalog-origin",
        dependencies: ["catalog-db", "inventory-api"]
      }
    },
    {
      id: "evt-022",
      investigationId,
      sequence: 22,
      at: "2026-08-26T14:50:41.000Z",
      type: "tool.completed",
      callId: "call-dependencies-retry",
      summary:
        "Both downstream dependencies remain within baseline latency and error bands.",
      durationMs: 5800,
      rowCount: 2,
      evidenceIds: ["ev-dependencies"]
    },
    {
      id: "evt-023",
      investigationId,
      sequence: 23,
      at: "2026-08-26T14:50:44.000Z",
      type: "hypothesis.updated",
      hypothesisId: "hyp-bot-burst",
      statement: "An earlier bot burst exhausted origin capacity",
      status: "ruled_out",
      confidence: 0.03,
      evidenceIds: ["ev-bot-recovery", "ev-overview"]
    },
    {
      id: "evt-024",
      investigationId,
      sequence: 24,
      at: "2026-08-26T14:50:47.000Z",
      type: "observation.added",
      observationId: "obs-causal-chain",
      title: "The full causal chain is supported",
      detail:
        "Deployment, key cardinality, hit-rate collapse, origin overload, and user-facing errors align in order.",
      evidenceIds: [
        "ev-overview",
        "ev-route",
        "ev-deployment",
        "ev-session-segment",
        "ev-log-sample",
        "ev-dependencies"
      ]
    },
    {
      id: "evt-025",
      investigationId,
      sequence: 25,
      at: "2026-08-26T14:51:08.000Z",
      type: "investigation.completed",
      findingId: finding.id,
      summary:
        "Confirmed: session_id cache-key fragmentation is overloading the catalog origin."
    }
  ],
  finding
};
