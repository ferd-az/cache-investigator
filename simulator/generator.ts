import {
  cacheKeyRegressionScenario,
  type CacheRegressionScenario
} from "./cache-key-regression.ts";

export type CacheStatus = "HIT" | "MISS";

export type RequestTelemetry = {
  id: string;
  timestamp: string;
  service: string;
  environment: "production";
  region: "ams" | "iad" | "sfo";
  method: "GET";
  route: string;
  query: Record<string, string>;
  hasSessionId: boolean;
  sessionId?: string;
  trafficSource: "user" | "bot";
  deployment: string;
  cacheKey: string;
  cacheStatus: CacheStatus;
  originRequest: boolean;
  originQueueDepth: number;
  responseStatus: 200 | 429;
  responseLatencyMs: number;
};

export type DeploymentTelemetry = {
  id: string;
  service: string;
  environment: "production";
  version: string;
  commit: string;
  deployedAt: string;
  changes: string[];
};

export type DependencyTelemetry = {
  timestamp: string;
  service: "catalog-origin";
  dependency: "catalog-db" | "inventory-api";
  latencyP99Ms: number;
  errorRate: number;
  healthy: true;
};

export type TelemetryCorpus = {
  requestCount: number;
  requests: IterableIterator<RequestTelemetry>;
  deployments: DeploymentTelemetry[];
  dependencies: DependencyTelemetry[];
};

type CacheEntry = {
  expiresAt: number;
};

type RecentSessionRequest = {
  sessionId: string;
  baseKey: string;
  query: Record<string, string>;
};

const PRODUCT_CATEGORIES = [
  "shoes",
  "jackets",
  "bags",
  "shirts",
  "pants",
  "hats",
  "socks",
  "watches",
  "accessories",
  "sale"
] as const;

const SEARCH_TERMS = [
  "running",
  "trail",
  "winter",
  "linen",
  "travel",
  "waterproof",
  "lightweight"
] as const;

const REGIONS = ["ams", "iad", "sfo"] as const;

export function createTelemetryCorpus(
  scenario: CacheRegressionScenario = cacheKeyRegressionScenario
): TelemetryCorpus {
  return {
    requestCount: getTargetRequestCount(scenario),
    requests: generateRequestTelemetry(scenario),
    deployments: generateDeploymentTelemetry(scenario),
    dependencies: generateDependencyTelemetry(scenario)
  };
}

export function* generateRequestTelemetry(
  scenario: CacheRegressionScenario = cacheKeyRegressionScenario
): Generator<RequestTelemetry> {
  const random = createRandom(scenario.seed);
  const from = Date.parse(scenario.window.from);
  const to = Date.parse(scenario.window.to);
  const deployedAt = Date.parse(scenario.deployment.deployedAt);
  const faultActiveAt = Date.parse(scenario.deployment.faultActiveAt);
  const decoyFrom = Date.parse(scenario.decoy.from);
  const decoyTo = Date.parse(scenario.decoy.to);
  const durationSeconds = Math.floor((to - from) / 1000);
  const targetRequestCount = getTargetRequestCount(scenario);
  const weightedSeconds = getWeightedSeconds(scenario);
  const keySpace = createHealthyKeySpace(scenario);
  const cache = new Map<string, CacheEntry>();
  const recentSessionRequests: RecentSessionRequest[] = [];
  let requestSequence = 0;
  let emitted = 0;
  let cumulativeWeight = 0;
  let originMinute = -1;
  let originRequestsByRoute = new Map<string, number>();

  for (let second = 0; second < durationSeconds; second += 1) {
    const secondAt = from + second * 1000;
    const inBotBurst = secondAt >= decoyFrom && secondAt < decoyTo;
    const weight = inBotBurst ? scenario.decoy.trafficMultiplier : 1;
    cumulativeWeight += weight;

    const targetEmitted =
      second === durationSeconds - 1
        ? targetRequestCount
        : Math.floor((targetRequestCount * cumulativeWeight) / weightedSeconds);
    const requestsThisSecond = targetEmitted - emitted;

    for (let offset = 0; offset < requestsThisSecond; offset += 1) {
      const timestamp =
        secondAt + Math.floor(((offset + 0.5) * 1000) / requestsThisSecond);
      const minute = Math.floor((timestamp - from) / 60_000);
      if (minute !== originMinute) {
        originMinute = minute;
        originRequestsByRoute = new Map<string, number>();
      }

      requestSequence += 1;
      const route = chooseRoute(random, scenario);
      const hasSessionId = random() < scenario.traffic.sessionParameterShare;
      const faultActive = timestamp >= faultActiveAt;
      const recent =
        route === "/products" &&
        hasSessionId &&
        faultActive &&
        recentSessionRequests.length > 0 &&
        random() < scenario.traffic.sessionRepeatRate
          ? recentSessionRequests[
              Math.floor(random() * recentSessionRequests.length)
            ]
          : undefined;
      const base =
        recent ??
        chooseBaseRequest(random, route, keySpace, hasSessionId, scenario);
      const sessionId = hasSessionId
        ? (recent?.sessionId ?? `sid_${requestSequence.toString(36)}`)
        : undefined;

      if (
        route === "/products" &&
        hasSessionId &&
        faultActive &&
        !recent &&
        sessionId
      ) {
        recentSessionRequests.push({
          sessionId,
          baseKey: base.baseKey,
          query: base.query
        });
        if (recentSessionRequests.length > 512) {
          recentSessionRequests.shift();
        }
      }

      const cacheKey = buildCacheKey(
        base.baseKey,
        route,
        sessionId,
        faultActive
      );
      const existing = cache.get(cacheKey);
      const cacheHit =
        existing !== undefined &&
        existing.expiresAt > timestamp &&
        random() >= scenario.cache.revalidationRate;

      if (!cacheHit) {
        cache.set(cacheKey, {
          expiresAt: timestamp + scenario.cache.ttlSeconds * 1000
        });
        originRequestsByRoute.set(
          route,
          (originRequestsByRoute.get(route) ?? 0) + 1
        );
      }

      const routeOriginRequests = originRequestsByRoute.get(route) ?? 0;
      const overCapacity =
        !cacheHit &&
        routeOriginRequests > scenario.origin.capacityPerRoutePerMinute;
      const responseStatus = overCapacity ? 429 : 200;
      const utilization = Math.min(
        1,
        routeOriginRequests / scenario.origin.capacityPerRoutePerMinute
      );
      const responseLatencyMs = getResponseLatency(
        random,
        cacheHit,
        overCapacity,
        utilization,
        scenario
      );
      const trafficSource =
        inBotBurst &&
        random() <
          (scenario.decoy.trafficMultiplier - 1) /
            scenario.decoy.trafficMultiplier
          ? "bot"
          : "user";

      yield {
        id: `req_${requestSequence.toString().padStart(6, "0")}`,
        timestamp: new Date(timestamp).toISOString(),
        service: scenario.service,
        environment: scenario.environment,
        region: REGIONS[Math.floor(random() * REGIONS.length)],
        method: "GET",
        route,
        query: sessionId
          ? { ...base.query, session_id: sessionId }
          : base.query,
        hasSessionId,
        ...(sessionId ? { sessionId } : {}),
        trafficSource,
        deployment:
          timestamp >= deployedAt
            ? scenario.deployment.version
            : "catalog-edge-v41",
        cacheKey,
        cacheStatus: cacheHit ? "HIT" : "MISS",
        originRequest: !cacheHit,
        originQueueDepth: overCapacity
          ? routeOriginRequests - scenario.origin.capacityPerRoutePerMinute
          : 0,
        responseStatus,
        responseLatencyMs
      };
    }

    emitted = targetEmitted;
  }
}

export function generateDeploymentTelemetry(
  scenario: CacheRegressionScenario = cacheKeyRegressionScenario
): DeploymentTelemetry[] {
  return [
    {
      id: scenario.deployment.id,
      service: scenario.service,
      environment: scenario.environment,
      version: scenario.deployment.version,
      commit: scenario.deployment.commit,
      deployedAt: scenario.deployment.deployedAt,
      changes: [scenario.deployment.change]
    }
  ];
}

export function generateDependencyTelemetry(
  scenario: CacheRegressionScenario = cacheKeyRegressionScenario
): DependencyTelemetry[] {
  const random = createRandom(scenario.seed + 1);
  const from = Date.parse(scenario.window.from);
  const to = Date.parse(scenario.window.to);
  const samples: DependencyTelemetry[] = [];

  for (let timestamp = from; timestamp < to; timestamp += 60_000) {
    samples.push(
      {
        timestamp: new Date(timestamp).toISOString(),
        service: "catalog-origin",
        dependency: "catalog-db",
        latencyP99Ms: Math.round(39 + random() * 6),
        errorRate: round(0.0005 + random() * 0.001, 4),
        healthy: true
      },
      {
        timestamp: new Date(timestamp).toISOString(),
        service: "catalog-origin",
        dependency: "inventory-api",
        latencyP99Ms: Math.round(67 + random() * 8),
        errorRate: round(0.0008 + random() * 0.0012, 4),
        healthy: true
      }
    );
  }

  return samples;
}

function getTargetRequestCount(scenario: CacheRegressionScenario): number {
  const durationMinutes =
    (Date.parse(scenario.window.to) - Date.parse(scenario.window.from)) /
    60_000;
  return Math.round(durationMinutes * scenario.traffic.requestsPerMinute);
}

function getWeightedSeconds(scenario: CacheRegressionScenario): number {
  const durationSeconds =
    (Date.parse(scenario.window.to) - Date.parse(scenario.window.from)) / 1000;
  const decoySeconds =
    (Date.parse(scenario.decoy.to) - Date.parse(scenario.decoy.from)) / 1000;
  return (
    durationSeconds + decoySeconds * (scenario.decoy.trafficMultiplier - 1)
  );
}

function createHealthyKeySpace(scenario: CacheRegressionScenario) {
  const total = scenario.cache.baselineKeyCardinalityPerFiveMinutes;
  const products = scenario.cache.healthyKeyCardinalityByRoute["/products"];
  const categories = scenario.cache.healthyKeyCardinalityByRoute["/categories"];
  const search = scenario.cache.healthyKeyCardinalityByRoute["/search"];

  if (
    !products ||
    !categories ||
    !search ||
    products + categories + search !== total
  ) {
    throw new Error(
      "Healthy per-route key counts must equal baseline key cardinality"
    );
  }

  return {
    "/products": Array.from({ length: products }, (_, index) => {
      const category = PRODUCT_CATEGORIES[index % PRODUCT_CATEGORIES.length];
      const page = Math.floor(index / PRODUCT_CATEGORIES.length) + 1;
      const query = { category, page: String(page), sort: "popular" };
      return {
        baseKey: `/products?category=${category}&page=${page}&sort=popular`,
        query
      };
    }),
    "/categories": Array.from({ length: categories }, (_, index) => {
      const query = { id: `cat-${index + 1}` };
      return {
        baseKey: `/categories?id=${query.id}`,
        query
      };
    }),
    "/search": Array.from({ length: search }, (_, index) => {
      const query = {
        q: SEARCH_TERMS[index % SEARCH_TERMS.length],
        page: String(Math.floor(index / SEARCH_TERMS.length) + 1)
      };
      return {
        baseKey: `/search?page=${query.page}&q=${query.q}`,
        query
      };
    })
  };
}

function chooseRoute(
  random: () => number,
  scenario: CacheRegressionScenario
): string {
  const roll = random();
  let cumulative = 0;

  for (const route of scenario.traffic.routes) {
    cumulative += route.share;
    if (roll < cumulative) return route.path;
  }

  return scenario.traffic.routes.at(-1)!.path;
}

function chooseBaseRequest(
  random: () => number,
  route: string,
  keySpace: ReturnType<typeof createHealthyKeySpace>,
  hasSessionId: boolean,
  scenario: CacheRegressionScenario
) {
  let requests = keySpace[route as keyof typeof keySpace];
  if (!requests)
    throw new Error(`No healthy key space configured for ${route}`);

  if (route === "/products" && !hasSessionId) {
    requests = requests.slice(0, scenario.traffic.anonymousProductKeyCount);
  }

  return requests[Math.floor(random() * requests.length)];
}

function buildCacheKey(
  baseKey: string,
  route: string,
  sessionId: string | undefined,
  faultActive: boolean
): string {
  if (route === "/products" && sessionId && faultActive) {
    return `${baseKey}&session_id=${sessionId}`;
  }
  return baseKey;
}

function getResponseLatency(
  random: () => number,
  cacheHit: boolean,
  overCapacity: boolean,
  utilization: number,
  scenario: CacheRegressionScenario
): number {
  if (cacheHit) return Math.round(26 + random() * 24);
  if (overCapacity) {
    return Math.round(
      scenario.origin.overloadBackoffMs +
        scenario.origin.baselineLatencyP99Ms * 0.5 +
        random() * 90
    );
  }
  return Math.round(
    scenario.origin.baselineLatencyP99Ms -
      43 +
      random() * 50 +
      utilization ** 3 * 12
  );
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
