import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnthropicInvestigationModel,
  buildAnthropicModelRequest,
  buildAnthropicModelMessages,
  investigationMaxOutputTokens,
  investigationModel
} from "./anthropic-model.ts";
import {
  InvestigationModelError,
  type InvestigationModelContext
} from "./runtime.ts";

const window = {
  from: "2026-08-26T14:00:00.000Z",
  to: "2026-08-26T16:00:00.000Z"
};

test("Anthropic request uses Sonnet 5 without unsupported sampling or thinking fields", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const model = new AnthropicInvestigationModel(
    "placeholder",
    async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return jsonResponse({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Establish the baseline." },
          {
            type: "tool_use",
            id: "toolu_baseline",
            name: "query_metrics",
            input: {
              metrics: ["cache_hit_rate"],
              ...window,
              interval: "15m"
            }
          }
        ]
      });
    }
  );

  const decision = await model.next(modelContext());
  assert.equal(decision.type, "tool");
  if (decision.type !== "tool") return;
  assert.equal(decision.call.tool, "query_metrics");
  assert.match(decision.rationale, /baseline/i);
  assert.equal(requestedUrl, "https://api.anthropic.com/v1/messages");

  const headers = new Headers(requestedInit?.headers);
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.has("x-api-key"), true);
  const body = JSON.parse(String(requestedInit?.body)) as Record<
    string,
    unknown
  >;
  assert.equal(body.model, investigationModel);
  assert.equal(body.max_tokens, investigationMaxOutputTokens);
  assert.ok(!("temperature" in body));
  assert.ok(!("top_p" in body));
  assert.ok(!("top_k" in body));
  assert.ok(!("thinking" in body));
  const tools = body.tools as Array<Record<string, unknown>>;
  assert.ok(tools.every((tool) => "input_schema" in tool));
  assert.ok(tools.every((tool) => !("parameters" in tool)));
  assert.deepEqual(body.tool_choice, {
    type: "auto",
    disable_parallel_tool_use: true
  });
  assert.match(String(body.system), /bot or other transient traffic/i);
  assert.match(String(body.system), /filters\.traffic_source/i);
  assert.match(String(body.system), /remaining tool calls is 0/i);

  const finalOnlyRequest = buildAnthropicModelRequest({
    ...modelContext(),
    remainingToolCalls: 0
  });
  assert.deepEqual(finalOnlyRequest.tool_choice, { type: "none" });
});

test("Anthropic request binds the platform fetch receiver", async () => {
  const receiverAwareFetch = async function (this: unknown) {
    assert.equal(this, globalThis);
    return jsonResponse({
      stop_reason: "tool_use",
      content: [toolUse("toolu_bound_fetch", "query_metrics")]
    });
  } as unknown as typeof fetch;

  const model = new AnthropicInvestigationModel(
    "placeholder",
    receiverAwareFetch
  );
  await model.next(modelContext());
});

test("Anthropic history uses valid provider IDs while preserving persisted call IDs", () => {
  const messages = buildAnthropicModelMessages(
    modelContext([
      {
        callId: "call:1:query_metrics",
        evidenceId: "evidence:call:1:query_metrics",
        call: {
          tool: "query_metrics",
          input: {
            metrics: ["request_count"],
            ...window,
            interval: "15m"
          }
        },
        result: { points: [{ bucket: window.from, request_count: 1 }] }
      },
      {
        callId: "call:2:search_logs",
        evidenceId: "evidence:call:2:search_logs",
        call: {
          tool: "search_logs",
          input: { ...window, limit: 10 }
        },
        error: "bounded validation error"
      }
    ])
  );

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant", "user"]
  );
  assert.deepEqual(messages[1].content[0], {
    type: "tool_use",
    id: "call_1_query_metrics",
    name: "query_metrics",
    input: {
      metrics: ["request_count"],
      ...window,
      interval: "15m"
    }
  });
  assert.equal(messages[2].content[0].type, "tool_result");
  assert.equal(messages[2].content[0].tool_use_id, "call_1_query_metrics");
  assert.equal(messages[2].content[0].is_error, undefined);
  assert.equal(
    JSON.parse(String(messages[2].content[0].content)).callId,
    "call:1:query_metrics"
  );
  assert.equal(messages[4].content[0].is_error, true);
  assert.equal(messages[4].content[0].tool_use_id, "call_2_search_logs");
});

test("Anthropic adapter parses a final JSON text block and omits nested null optionals", async () => {
  const model = modelReturning({
    stop_reason: "end_turn",
    content: [
      { type: "thinking", thinking: "private adaptive reasoning" },
      {
        type: "text",
        text: JSON.stringify({
          kind: "final",
          finding: {
            headline: "Cache regression confirmed",
            evidence: [
              { values: [{ label: "error rate", value: 4.2, unit: null }] }
            ]
          }
        })
      }
    ]
  });

  assert.deepEqual(await model.next(modelContext()), {
    type: "final",
    finding: {
      headline: "Cache regression confirmed",
      evidence: [{ values: [{ label: "error rate", value: 4.2 }] }]
    }
  });
});

test("Anthropic adapter rejects multiple tool calls deterministically", async () => {
  const model = modelReturning({
    stop_reason: "tool_use",
    content: [
      toolUse("toolu_one", "query_metrics"),
      toolUse("toolu_two", "list_deployments")
    ]
  });

  await assert.rejects(
    model.next(modelContext()),
    (error: unknown) =>
      error instanceof InvestigationModelError &&
      error.retryable &&
      /exactly one/.test(error.message)
  );
});

test("Anthropic API retryability follows response status", async () => {
  const retryable = new AnthropicInvestigationModel("placeholder", async () =>
    jsonResponse(
      { error: { type: "rate_limit_error", message: "try later" } },
      429
    )
  );
  await assert.rejects(
    retryable.next(modelContext()),
    (error: unknown) =>
      error instanceof InvestigationModelError && error.retryable
  );

  const invalid = new AnthropicInvestigationModel("placeholder", async () =>
    jsonResponse(
      { error: { type: "invalid_request_error", message: "bad request" } },
      400
    )
  );
  await assert.rejects(
    invalid.next(modelContext()),
    (error: unknown) =>
      error instanceof InvestigationModelError && !error.retryable
  );
});

test("Anthropic max_tokens stop remains bounded and retryable", async () => {
  const model = modelReturning({
    stop_reason: "max_tokens",
    content: [{ type: "text", text: "incomplete" }]
  });
  await assert.rejects(
    model.next(modelContext()),
    (error: unknown) =>
      error instanceof InvestigationModelError &&
      error.retryable &&
      error.message.includes(String(investigationMaxOutputTokens))
  );
});

function modelReturning(body: unknown) {
  return new AnthropicInvestigationModel("placeholder", async () =>
    jsonResponse(body)
  );
}

function toolUse(id: string, name: string) {
  return {
    type: "tool_use",
    id,
    name,
    input: { ...window, service: "catalog-edge" }
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function modelContext(
  history: InvestigationModelContext["history"] = []
): InvestigationModelContext {
  return {
    investigation: {
      scope: {
        service: "catalog-edge",
        environment: "production",
        question: "Why did latency and origin errors rise?",
        window
      }
    } as InvestigationModelContext["investigation"],
    history,
    turn: history.length + 1,
    remainingToolCalls: 10 - history.length
  };
}
