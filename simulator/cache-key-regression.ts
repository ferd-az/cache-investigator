export type CacheRegressionScenario = {
  id: string;
  version: number;
  seed: number;
  service: string;
  environment: "production";
  window: {
    from: string;
    to: string;
    intervalSeconds: number;
  };
  traffic: {
    requestsPerMinute: number;
    sessionParameterShare: number;
    sessionRepeatRate: number;
    anonymousProductKeyCount: number;
    routes: Array<{
      path: string;
      share: number;
    }>;
  };
  cache: {
    baselineHitRate: number;
    ttlSeconds: number;
    revalidationRate: number;
    baselineKeyCardinalityPerFiveMinutes: number;
    healthyKeyCardinalityByRoute: Record<string, number>;
    healthyKeyParameters: string[];
    regressedKeyParameters: string[];
  };
  origin: {
    capacityPerRoutePerMinute: number;
    baselineLatencyP99Ms: number;
    overloadBackoffMs: number;
  };
  decoy: {
    kind: "bot_burst";
    from: string;
    to: string;
    trafficMultiplier: number;
    recoveredBy: string;
  };
  deployment: {
    id: string;
    version: string;
    commit: string;
    deployedAt: string;
    faultActiveAt: string;
    change: string;
  };
  expectedOutcome: {
    affectedRoute: string;
    incidentStartedAt: string;
    cacheHitRate: number;
    cacheKeyCardinalityPerFiveMinutes: number;
    originRequestsPerMinute: number;
    originErrorRate: number;
    responseLatencyP99Ms: number;
  };
};

/**
 * Source of truth for the offline telemetry generator.
 *
 * Worker code and investigation tools must never import this module. They query
 * the generated telemetry only, so the agent cannot read the answer key.
 */
export const cacheKeyRegressionScenario = {
  id: "cache-key-session-regression",
  version: 1,
  seed: 42617,
  service: "catalog-edge",
  environment: "production",
  window: {
    from: "2026-08-26T14:00:00.000Z",
    to: "2026-08-26T16:00:00.000Z",
    intervalSeconds: 1
  },
  traffic: {
    requestsPerMinute: 1800,
    sessionParameterShare: 0.84,
    sessionRepeatRate: 0.04,
    anonymousProductKeyCount: 16,
    routes: [
      { path: "/products", share: 0.62 },
      { path: "/categories", share: 0.23 },
      { path: "/search", share: 0.15 }
    ]
  },
  cache: {
    baselineHitRate: 0.92,
    ttlSeconds: 150,
    revalidationRate: 0.064,
    baselineKeyCardinalityPerFiveMinutes: 124,
    healthyKeyCardinalityByRoute: {
      "/products": 40,
      "/categories": 42,
      "/search": 42
    },
    healthyKeyParameters: ["category", "page", "sort"],
    regressedKeyParameters: ["category", "page", "sort", "session_id"]
  },
  origin: {
    capacityPerRoutePerMinute: 750,
    baselineLatencyP99Ms: 185,
    overloadBackoffMs: 1630
  },
  decoy: {
    kind: "bot_burst",
    from: "2026-08-26T14:08:00.000Z",
    to: "2026-08-26T14:12:00.000Z",
    trafficMultiplier: 1.4,
    recoveredBy: "2026-08-26T14:14:00.000Z"
  },
  deployment: {
    id: "dep_01K3KYH7Y6F6VJ8F2E66R5XQ3B",
    version: "catalog-edge-v42",
    commit: "8f31ad2",
    deployedAt: "2026-08-26T14:18:00.000Z",
    faultActiveAt: "2026-08-26T14:20:00.000Z",
    change:
      "The /products cache key stopped removing the session_id query parameter."
  },
  expectedOutcome: {
    affectedRoute: "/products",
    incidentStartedAt: "2026-08-26T14:20:00.000Z",
    cacheHitRate: 0.18,
    cacheKeyCardinalityPerFiveMinutes: 4480,
    originRequestsPerMinute: 945,
    originErrorRate: 0.127,
    responseLatencyP99Ms: 1810
  }
} as const satisfies CacheRegressionScenario;
