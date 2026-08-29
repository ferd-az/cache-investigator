import { randomUUID } from "node:crypto";
import type { InvestigationChaosMode } from "../src/investigation/contracts.ts";

const scenarioNames = [
  "normal",
  "slow",
  "tool-failure",
  "fatal",
  "no-findings",
  "invalid-final"
] as const;

type ScenarioName = (typeof scenarioNames)[number];

const scenario = option("--scenario");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printUsage();
  process.exit(0);
}
if (!scenarioNames.includes(scenario as ScenarioName)) {
  printUsage();
  process.exit(1);
}

const selectedScenario = scenario as ScenarioName;
const baseUrl =
  option("--base-url") ??
  process.env.CACHE_INVESTIGATOR_URL ??
  "http://localhost:5173";
const endpoint = new URL("/api/investigations", baseUrl);
const chaos = chaosFor(selectedScenario);
if (chaos !== "none") endpoint.searchParams.set("chaos", chaos);

let response: Response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(startInput(selectedScenario))
  });
} catch {
  throw new Error(
    `Could not connect to ${endpoint.origin}. Start the app with npm run dev or pass --base-url.`
  );
}
const result: unknown = await response.json();
if (!response.ok) {
  throw new Error(
    `Could not start ${selectedScenario}: ${response.status} ${errorMessage(result)}`
  );
}
const investigationId = investigationIdFrom(result);
const permalink = new URL(`/i/${encodeURIComponent(investigationId)}`, baseUrl);

console.log(
  `Started “${selectedScenario}”: ${expectationFor(selectedScenario)}`
);
console.log(permalink.href);

function startInput(scenarioName: ScenarioName) {
  const noFindings = scenarioName === "no-findings";
  return {
    idempotencyKey: `state-test:${scenarioName}:${randomUUID()}`,
    scope: {
      service: "catalog-edge",
      environment: "production",
      question: noFindings
        ? "Did catalog cache health degrade during this quiet five-minute window?"
        : "Why did /products p99 latency rise as cache efficiency fell after 14:18 UTC?",
      window: noFindings
        ? {
            from: "2026-08-26T14:00:00.000Z",
            to: "2026-08-26T14:05:00.000Z"
          }
        : {
            from: "2026-08-26T14:00:00.000Z",
            to: "2026-08-26T15:00:00.000Z"
          }
    },
    trigger: {
      kind: "manual",
      label: `State test: ${scenarioName}`
    }
  };
}

function chaosFor(scenarioName: ScenarioName): InvestigationChaosMode {
  if (scenarioName === "slow") return "slow";
  if (scenarioName === "tool-failure") return "step6";
  if (scenarioName === "fatal") return "fatal";
  if (scenarioName === "no-findings") return "no-findings";
  if (scenarioName === "invalid-final") return "invalid-final";
  return "none";
}

function expectationFor(scenarioName: ScenarioName) {
  return {
    normal: "a completed investigation",
    slow: "a delayed tool call with truthful progress",
    "tool-failure": "one recoverable tool failure followed by a retry",
    fatal: "partial evidence followed by a terminal failure",
    "no-findings": "a healthy-window investigation with no actionable finding",
    "invalid-final": "bounded final-validation retries followed by failure"
  }[scenarioName];
}

function option(name: string) {
  const direct = process.argv.find((argument) =>
    argument.startsWith(`${name}=`)
  );
  if (direct) return direct.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1] ?? "";
}

function investigationIdFrom(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    "investigation" in value &&
    typeof value.investigation === "object" &&
    value.investigation !== null &&
    "id" in value.investigation &&
    typeof value.investigation.id === "string"
  ) {
    return value.investigation.id;
  }
  throw new Error("The server response did not include an investigation ID");
}

function errorMessage(value: unknown) {
  return typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
    ? value.error
    : JSON.stringify(value);
}

function printUsage() {
  console.log(`Usage:
  npm run investigate -- --scenario <name>

Scenarios:
  ${scenarioNames.join("\n  ")}

Options:
  --base-url <url>  Defaults to CACHE_INVESTIGATOR_URL or http://localhost:5173`);
}
