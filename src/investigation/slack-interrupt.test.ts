import assert from "node:assert/strict";
import test from "node:test";
import { completedCacheKeyRegression } from "../fixtures/cache-key-regression.ts";
import {
  buildSlackInterruptPayload,
  deliverSlackInterrupt,
  type SlackInterruptDeliveryStore
} from "./slack-interrupt.ts";

const appOrigin = "https://cache-investigator.example";
const webhookUrl = "https://hooks.slack.com/services/T000/B000/secret";

test("Slack payload compresses a finding and links to its artifact", () => {
  const payload = buildSlackInterruptPayload(
    completedCacheKeyRegression,
    appOrigin
  );

  assert.ok(payload);
  assert.equal(payload.blocks.length, 4);
  assert.match(payload.text, /cache-key change is overloading/i);
  assert.match(payload.text, /Next: Roll back catalog-edge-v42/i);
  assert.match(
    payload.text,
    /https:\/\/cache-investigator\.example\/i\/inv_cache_20260826_001/
  );
  assert.doesNotMatch(payload.text, /alternatives ruled out/i);

  const action = payload.blocks.at(-1);
  assert.ok(action && action.type === "actions");
  assert.equal(
    action.elements[0].url,
    "https://cache-investigator.example/i/inv_cache_20260826_001"
  );
});

test("Slack message text escapes model-authored markup", () => {
  const investigation = {
    ...completedCacheKeyRegression,
    finding: {
      ...completedCacheKeyRegression.finding!,
      headline: "Origin overload <@U123> & cache misses"
    }
  };
  const payload = buildSlackInterruptPayload(investigation, appOrigin);

  assert.ok(payload);
  const headline = payload.blocks[1];
  assert.ok(headline.type === "section");
  assert.equal(
    headline.text.text,
    "*Origin overload &lt;@U123&gt; &amp; cache misses*"
  );
  assert.match(payload.text, /&lt;@U123&gt; &amp; cache misses/);
  assert.doesNotMatch(payload.text, /<@U123>/);
});

test("delivery claims once and records a successful Slack request", async () => {
  const store = new MemoryDeliveryStore();
  let requests = 0;

  const first = await deliverSlackInterrupt({
    investigation: completedCacheKeyRegression,
    appOrigin,
    webhookUrl,
    store,
    fetcher: async (input, init) => {
      requests += 1;
      assert.equal(String(input), webhookUrl);
      assert.equal(init?.method, "POST");
      assert.match(String(init?.body), /Open investigation/);
      return new Response("ok");
    },
    now: () => new Date("2026-08-28T20:00:00.000Z")
  });
  const duplicate = await deliverSlackInterrupt({
    investigation: completedCacheKeyRegression,
    appOrigin,
    webhookUrl,
    store,
    fetcher: async () => {
      requests += 1;
      return new Response("ok");
    }
  });

  assert.equal(first.status, "sent");
  assert.equal(duplicate.status, "already_attempted");
  assert.equal(requests, 1);
  assert.equal(store.status, "sent");
});

test("delivery failure is recorded without throwing", async () => {
  const store = new MemoryDeliveryStore();
  const result = await deliverSlackInterrupt({
    investigation: completedCacheKeyRegression,
    appOrigin,
    webhookUrl,
    store,
    fetcher: async () => new Response("invalid_payload", { status: 400 }),
    now: () => new Date("2026-08-28T20:00:00.000Z")
  });

  assert.deepEqual(result, {
    status: "failed",
    error: "Slack webhook returned HTTP 400"
  });
  assert.equal(store.status, "failed");
  assert.equal(store.error, "Slack webhook returned HTTP 400");
});

test("unconfigured and non-terminal runs do not claim delivery", async () => {
  const store = new MemoryDeliveryStore();
  const unconfigured = await deliverSlackInterrupt({
    investigation: completedCacheKeyRegression,
    appOrigin,
    store
  });
  const active = await deliverSlackInterrupt({
    investigation: { ...completedCacheKeyRegression, status: "running" },
    appOrigin,
    webhookUrl,
    store
  });

  assert.equal(unconfigured.status, "unconfigured");
  assert.equal(active.status, "not_actionable");
  assert.equal(store.status, null);
});

test("delivery-store failures do not disturb a completed investigation", async () => {
  const result = await deliverSlackInterrupt({
    investigation: completedCacheKeyRegression,
    appOrigin,
    webhookUrl,
    store: {
      async claim() {
        throw new Error("D1 unavailable");
      },
      async markSent() {},
      async markFailed() {}
    }
  });

  assert.deepEqual(result, {
    status: "failed",
    error: "Slack delivery could not claim: D1 unavailable"
  });
});

class MemoryDeliveryStore implements SlackInterruptDeliveryStore {
  status: "sending" | "sent" | "failed" | null = null;
  error: string | null = null;

  async claim() {
    if (this.status) return false;
    this.status = "sending";
    return true;
  }

  async markSent() {
    this.status = "sent";
  }

  async markFailed(_investigationId: string, _failedAt: string, error: string) {
    this.status = "failed";
    this.error = error;
  }
}
