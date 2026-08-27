import type {
  InvestigationToolCall,
  InvestigationToolName
} from "./contracts.ts";
import {
  InvestigationModelError,
  type InvestigationModel,
  type InvestigationModelContext,
  type InvestigationModelDecision
} from "./runtime.ts";

export const investigationModel = "claude-sonnet-5" as const;
export const investigationMaxOutputTokens = 8_192;

const anthropicMessagesEndpoint = "https://api.anthropic.com/v1/messages";
const anthropicApiVersion = "2023-06-01";

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | { type: string; [key: string]: unknown };

type AnthropicMessagesResponse = {
  content: AnthropicContentBlock[];
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null;
};

export type AnthropicModelMessage = {
  role: "assistant" | "user";
  content: Array<Record<string, unknown>>;
};

const toolSchemas = [
  {
    name: "query_metrics",
    description:
      "Query bounded time-bucketed request metrics. Use filters to narrow scope before grouping.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        metrics: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          items: {
            type: "string",
            enum: [
              "request_count",
              "cache_hit_rate",
              "cache_key_cardinality",
              "origin_request_count",
              "origin_error_rate",
              "response_latency_p99"
            ]
          }
        },
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        interval: { type: "string", enum: ["1m", "5m", "15m"] },
        filters: {
          type: "object",
          additionalProperties: { type: "string" }
        },
        groupBy: {
          type: "string",
          enum: ["route", "region", "deployment", "has_session_id"]
        },
        limit: { type: "integer", minimum: 1, maximum: 200 }
      },
      required: ["metrics", "from", "to", "interval"]
    }
  },
  {
    name: "search_logs",
    description:
      "Search bounded request logs using explicit structured filters. Start with a narrow query and an explicit limit of 10 or fewer rows; paginate only when those rows do not answer the question. The server still permits up to 100 rows when genuinely necessary.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        service: { type: "string" },
        route: { type: "string" },
        status: { type: "integer", minimum: 100, maximum: 599 },
        hasSessionId: { type: "boolean" },
        cacheStatus: { type: "string", enum: ["HIT", "MISS"] },
        cursor: { type: "string" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Prefer 10 or fewer rows for an initial investigation."
        }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "list_deployments",
    description: "List deployments in a bounded service and time window.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        service: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 20 }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "check_dependency_health",
    description:
      "Check bounded dependency latency, error rate, and health for a service.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        service: { type: "string" },
        dependencies: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string" }
        }
      },
      required: ["from", "to", "service"]
    }
  }
] as const;

export const modelContextProjectionLimits = {
  maxRowsPerToolResult: 12,
  maxSerializedCharacters: 12_000
} as const;

export type ModelToolResultProjection = {
  callId: string;
  evidenceId: string;
  result?: unknown;
  error?: string;
  projection: {
    originalRowCount: number;
    includedRowCount: number;
    omittedRowCount: number;
    omitted: boolean;
    note: string;
  };
};

export class AnthropicInvestigationModel implements InvestigationModel {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;

  constructor(apiKey: string, fetcher: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  async next(
    context: InvestigationModelContext
  ): Promise<InvestigationModelDecision> {
    if (this.apiKey.trim().length === 0) {
      throw new InvestigationModelError(
        "ANTHROPIC_API_KEY is not configured",
        false
      );
    }

    let apiResponse: Response;
    try {
      apiResponse = await this.fetcher(anthropicMessagesEndpoint, {
        method: "POST",
        headers: {
          "anthropic-version": anthropicApiVersion,
          "content-type": "application/json",
          "x-api-key": this.apiKey
        },
        body: JSON.stringify(buildAnthropicModelRequest(context))
      });
    } catch (error) {
      throw new InvestigationModelError(
        `Anthropic request failed: ${messageOf(error)}`,
        true
      );
    }

    if (!apiResponse.ok) {
      throw new InvestigationModelError(
        await anthropicErrorMessage(apiResponse),
        isRetryableAnthropicStatus(apiResponse.status)
      );
    }

    let response: AnthropicMessagesResponse;
    try {
      response = parseAnthropicResponse(await apiResponse.json());
    } catch (error) {
      throw new InvestigationModelError(
        `Anthropic returned a malformed response: ${messageOf(error)}`,
        true
      );
    }

    return decisionFromAnthropicResponse(response);
  }
}

export function buildAnthropicModelRequest(context: InvestigationModelContext) {
  return {
    model: investigationModel,
    max_tokens: investigationMaxOutputTokens,
    system: systemPrompt(context),
    tools: toolSchemas,
    messages: buildAnthropicModelMessages(context)
  };
}

function decisionFromAnthropicResponse(
  response: AnthropicMessagesResponse
): InvestigationModelDecision {
  const toolUses = response.content.filter(isAnthropicToolUseBlock);
  const rationale = response.content
    .filter(isAnthropicTextBlock)
    .map((block) => block.text)
    .join("\n");

  if (toolUses.length > 0) {
    if (response.stop_reason !== "tool_use") {
      throw new InvestigationModelError(
        "Anthropic returned tool_use content without a tool_use stop reason"
      );
    }
    if (toolUses.length !== 1) {
      throw new InvestigationModelError(
        `Anthropic returned ${toolUses.length} tool calls; exactly one is allowed per turn`
      );
    }
    const selected = toolUses[0];
    if (!selected.id || !isToolName(selected.name)) {
      throw new InvestigationModelError(
        `Anthropic selected an unknown or malformed tool: ${selected.name}`
      );
    }
    return {
      type: "tool",
      call: {
        tool: selected.name,
        input: parseArguments(selected.input)
      } as InvestigationToolCall,
      rationale: boundedRationale(rationale, selected.name)
    };
  }

  if (response.stop_reason === "tool_use") {
    throw new InvestigationModelError(
      "Anthropic stopped for tool use without returning a tool_use block"
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new InvestigationModelError(
      `Anthropic reached the ${investigationMaxOutputTokens}-token output limit before completing the turn`
    );
  }
  if (response.stop_reason === "pause_turn") {
    throw new InvestigationModelError(
      "Anthropic unexpectedly paused a turn without a server-side tool"
    );
  }
  if (response.stop_reason === "refusal") {
    throw new InvestigationModelError(
      "Anthropic refused the investigation",
      false
    );
  }

  const text = response.content
    .filter(isAnthropicTextBlock)
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new InvestigationModelError(
      "Anthropic returned no tool call or final response text"
    );
  }
  const parsed = parseJsonResponse(text);
  if (parsed.kind === "final") {
    return { type: "final", finding: parsed.finding };
  }
  if (parsed.kind === "no_findings" && typeof parsed.summary === "string") {
    return { type: "no_findings", summary: parsed.summary };
  }
  throw new InvestigationModelError(
    "The model final response did not match the required envelope"
  );
}

export function buildAnthropicModelMessages(
  context: InvestigationModelContext
): AnthropicModelMessage[] {
  const messages: AnthropicModelMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `Investigate this question: ${context.investigation.scope.question}`
        }
      ]
    }
  ];
  for (const entry of context.history) {
    const projected = projectToolResultForModel(entry);
    messages.push({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: entry.callId,
          name: entry.call.tool,
          input: entry.call.input
        }
      ]
    });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: entry.callId,
          content: JSON.stringify(projected),
          ...(entry.error !== undefined ? { is_error: true } : {})
        }
      ]
    });
  }
  return messages;
}

export function projectToolResultForModel(
  entry: InvestigationModelContext["history"][number]
): ModelToolResultProjection {
  if (entry.error !== undefined) {
    return {
      callId: entry.callId,
      evidenceId: entry.evidenceId,
      error: entry.error,
      projection: {
        originalRowCount: 0,
        includedRowCount: 0,
        omittedRowCount: 0,
        omitted: false,
        note: "The persisted tool call failed and has no result rows."
      }
    };
  }

  const result = asRecord(entry.result);
  const collectionKey = ["points", "rows", "deployments", "dependencies"].find(
    (key) => Array.isArray(result[key])
  );
  const originalRows = collectionKey
    ? (result[collectionKey] as unknown[])
    : [];
  let includedCount = Math.min(
    originalRows.length,
    modelContextProjectionLimits.maxRowsPerToolResult
  );
  let projection = projectedResult(
    entry,
    result,
    collectionKey,
    originalRows,
    includedCount
  );
  while (
    JSON.stringify(projection).length >
      modelContextProjectionLimits.maxSerializedCharacters &&
    includedCount > 0
  ) {
    includedCount -= 1;
    projection = projectedResult(
      entry,
      result,
      collectionKey,
      originalRows,
      includedCount
    );
  }
  return projection;
}

function projectedResult(
  entry: InvestigationModelContext["history"][number],
  result: Record<string, unknown>,
  collectionKey: string | undefined,
  rows: unknown[],
  includedCount: number
): ModelToolResultProjection {
  const omittedCount = rows.length - includedCount;
  return {
    callId: entry.callId,
    evidenceId: entry.evidenceId,
    result: collectionKey
      ? { ...result, [collectionKey]: rows.slice(0, includedCount) }
      : result,
    projection: {
      originalRowCount: rows.length,
      includedRowCount: includedCount,
      omittedRowCount: omittedCount,
      omitted: omittedCount > 0,
      note:
        omittedCount > 0
          ? `${omittedCount} persisted result rows were omitted from model context; the complete result remains stored under call ${entry.callId}.`
          : `All persisted result rows for call ${entry.callId} are included.`
    }
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { value };
}

function systemPrompt(context: InvestigationModelContext) {
  const { scope } = context.investigation;
  const completedTools = new Set(
    context.history
      .filter((entry) => entry.result !== undefined)
      .map((entry) => entry.call.tool)
  );
  const requiredEvidenceTools: InvestigationToolName[] = [
    "query_metrics",
    "search_logs",
    "list_deployments",
    "check_dependency_health"
  ];
  const missingEvidenceTools = requiredEvidenceTools.filter(
    (tool) => !completedTools.has(tool)
  );
  return `You are a production cache-regression investigator. Work only from the supplied scope and results returned by the four server tools. Never assume a cause, invent telemetry, or request data outside the scope.

Scope:
- service: ${scope.service}
- environment: ${scope.environment}
- from: ${scope.window.from}
- to: ${scope.window.to}
- current turn: ${context.turn}
- remaining tool calls: ${context.remainingToolCalls}
- completed evidence tools: ${[...completedTools].join(", ") || "none"}
- missing required evidence tools: ${missingEvidenceTools.join(", ") || "none"}

Choose at most one tool per turn. Start with aggregate metrics, localize affected routes and request segments, correlate timing with deployments, inspect structured logs, and check dependencies or transient traffic as alternative explanations. You must successfully call all four evidence tools before returning a final finding; if the missing required evidence tools list is non-empty, call one of those tools next instead of finalizing. Keep queries narrow enough to remain under server limits. For search_logs, set an explicit limit of 10 or fewer first and paginate only if needed. Omit optional tool fields when unused; do not send null. Encode integer fields such as limit and status as JSON numbers, not strings. Tool errors are evidence about invalid inputs; correct them on a later turn. Historical tool payloads may include a projection marker; omitted rows remain persisted, so narrow or paginate rather than assuming they do not exist.

When the evidence is sufficient, return JSON only with this envelope: {"kind":"final","finding":FINAL_FINDING}. Use this exact FINAL_FINDING shape:
{"headline":"...","status":"confirmed|likely|inconclusive","summary":"...","impact":{"startedAt":"ISO timestamp","summary":"...","affectedRoutes":["..."],"indicators":[{"label":"...","value":0,"unit":"optional"}]},"rootCause":{"summary":"...","change":"...","mechanism":["..."]},"confidence":{"level":"high|medium|low","score":0.0,"rationale":"..."},"recommendation":{"immediate":"...","verify":"...","followUps":["..."]},"evidence":[{"id":"exact evidenceId","kind":"metric|log|deployment|dependency","title":"...","claim":"...","source":{"callId":"exact callId"},"observedAt":"optional ISO timestamp","window":{"from":"ISO timestamp","to":"ISO timestamp"},"values":[{"label":"...","value":0,"unit":"optional"}]}],"alternativesRuledOut":[{"hypothesis":"...","reason":"...","evidenceIds":["exact evidenceId"]}]}.
Each evidence item must use an exact evidenceId and source.callId from a completed tool result. Cite metric, log, deployment, and dependency evidence. Rule out at least one plausible alternative. Do not copy a tool result wholesale.

If bounded evidence genuinely supports no actionable finding, return {"kind":"no_findings","summary":"..."}.`;
}

function parseArguments(value: unknown): InvestigationToolCall["input"] {
  const parsed = parseArgumentObject(value);
  const normalized = omitNullValues(parsed) as Record<string, unknown>;
  for (const key of ["limit", "status"] as const) {
    const fieldValue = normalized[key];
    if (typeof fieldValue === "string" && /^\d+$/.test(fieldValue)) {
      normalized[key] = Number(fieldValue);
    }
  }
  return normalized as InvestigationToolCall["input"];
}

function parseArgumentObject(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new InvestigationModelError("Tool arguments were not valid JSON");
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvestigationModelError("Tool arguments must be an object");
  }
  return parsed as Record<string, unknown>;
}

function parseJsonResponse(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return omitNullValues(value) as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    throw new InvestigationModelError(
      "The model response was neither JSON text nor an object"
    );
  }
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }
    return omitNullValues(parsed) as Record<string, unknown>;
  } catch {
    throw new InvestigationModelError("The model response was not valid JSON");
  }
}

function omitNullValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullValues);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, fieldValue]) => fieldValue !== null)
      .map(([key, fieldValue]) => [key, omitNullValues(fieldValue)])
  );
}

function parseAnthropicResponse(value: unknown): AnthropicMessagesResponse {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new Error("response content must be an array");
  }
  const allowedStopReasons: AnthropicMessagesResponse["stop_reason"][] = [
    "end_turn",
    "max_tokens",
    "stop_sequence",
    "tool_use",
    "pause_turn",
    "refusal",
    null
  ];
  if (
    !allowedStopReasons.includes(
      value.stop_reason as AnthropicMessagesResponse["stop_reason"]
    )
  ) {
    throw new Error("response stop_reason is invalid");
  }
  const content = value.content.map((block) => {
    if (!isRecord(block) || typeof block.type !== "string") {
      throw new Error("response content block is malformed");
    }
    return block as AnthropicContentBlock;
  });
  return {
    content,
    stop_reason: value.stop_reason as AnthropicMessagesResponse["stop_reason"]
  };
}

function isAnthropicTextBlock(
  block: AnthropicContentBlock
): block is AnthropicTextBlock {
  return block.type === "text" && typeof block.text === "string";
}

function isAnthropicToolUseBlock(
  block: AnthropicContentBlock
): block is AnthropicToolUseBlock {
  return (
    block.type === "tool_use" &&
    typeof block.id === "string" &&
    typeof block.name === "string" &&
    "input" in block
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function anthropicErrorMessage(response: Response) {
  let detail = "request failed";
  try {
    const body = (await response.json()) as unknown;
    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
    ) {
      detail = body.error.message.replaceAll(/\s+/g, " ").trim().slice(0, 300);
    }
  } catch {
    // Keep a bounded status-only fallback for non-JSON errors.
  }
  return `Anthropic API ${response.status}: ${detail}`;
}

function isRetryableAnthropicStatus(status: number) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedRationale(value: unknown, tool: string) {
  const fallback = `Investigate with ${tool}`;
  if (typeof value !== "string" || !value) return fallback;
  const compact = value.replaceAll(/\s+/g, " ").trim();
  return compact.length === 0 ? fallback : compact.slice(0, 300);
}

function isToolName(value: unknown): value is InvestigationToolName {
  return (
    value === "query_metrics" ||
    value === "search_logs" ||
    value === "list_deployments" ||
    value === "check_dependency_health"
  );
}
