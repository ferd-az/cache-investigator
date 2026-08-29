import type { Investigation } from "./contracts.ts";

const SLACK_TRANSPORT = "slack";
const SLACK_WEBHOOK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

export type SlackInterruptPayload = {
  text: string;
  blocks: Array<
    | {
        type: "context";
        elements: Array<{ type: "mrkdwn"; text: string }>;
      }
    | {
        type: "section";
        text: { type: "mrkdwn"; text: string };
      }
    | {
        type: "actions";
        elements: Array<{
          type: "button";
          action_id: string;
          text: { type: "plain_text"; text: string };
          url: string;
          style: "primary";
        }>;
      }
  >;
};

export type SlackInterruptDeliveryStatus =
  | "sent"
  | "already_attempted"
  | "not_actionable"
  | "unconfigured"
  | "invalid_configuration"
  | "failed";

export type SlackInterruptDeliveryResult = {
  status: SlackInterruptDeliveryStatus;
  error?: string;
};

export interface SlackInterruptDeliveryStore {
  claim(investigationId: string, attemptedAt: string): Promise<boolean>;
  markSent(investigationId: string, sentAt: string): Promise<void>;
  markFailed(
    investigationId: string,
    failedAt: string,
    error: string
  ): Promise<void>;
}

export class D1SlackInterruptDeliveryStore implements SlackInterruptDeliveryStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async claim(investigationId: string, attemptedAt: string) {
    const result = await this.db
      .prepare(
        `INSERT OR IGNORE INTO investigation_interrupt_deliveries (
          investigation_id, transport, status, attempted_at
        ) VALUES (?, ?, 'sending', ?)`
      )
      .bind(investigationId, SLACK_TRANSPORT, attemptedAt)
      .run();
    return result.meta.changes === 1;
  }

  async markSent(investigationId: string, sentAt: string) {
    await this.db
      .prepare(
        `UPDATE investigation_interrupt_deliveries
        SET status = 'sent', completed_at = ?, error = NULL
        WHERE investigation_id = ? AND transport = ?`
      )
      .bind(sentAt, investigationId, SLACK_TRANSPORT)
      .run();
  }

  async markFailed(investigationId: string, failedAt: string, error: string) {
    await this.db
      .prepare(
        `UPDATE investigation_interrupt_deliveries
        SET status = 'failed', completed_at = ?, error = ?
        WHERE investigation_id = ? AND transport = ?`
      )
      .bind(failedAt, error, investigationId, SLACK_TRANSPORT)
      .run();
  }
}

export function buildSlackInterruptPayload(
  investigation: Investigation,
  appOrigin: string
): SlackInterruptPayload | null {
  if (investigation.status !== "completed" || !investigation.finding) {
    return null;
  }

  const finding = investigation.finding;
  const artifactUrl = new URL(
    `/i/${encodeURIComponent(investigation.id)}`,
    appOrigin
  ).toString();
  const context = [
    "Cache Investigator",
    finding.status === "confirmed"
      ? "Confirmed"
      : finding.status === "likely"
        ? "Likely"
        : "Inconclusive",
    investigation.scope.environment,
    investigation.scope.service
  ]
    .map(escapeSlackText)
    .join("  •  ");
  const headline = escapeSlackText(finding.headline);
  const impact = escapeSlackText(finding.impact.summary);
  const immediateAction = escapeSlackText(finding.recommendation.immediate);

  return {
    text: [
      `Cache Investigator: ${headline}`,
      impact,
      `Next: ${immediateAction}`,
      artifactUrl
    ].join("\n"),
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: context }]
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${headline}*` }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${impact}\n*Next:* ${immediateAction}`
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "open_investigation",
            text: { type: "plain_text", text: "Open investigation" },
            url: artifactUrl,
            style: "primary"
          }
        ]
      }
    ]
  };
}

export async function deliverSlackInterrupt({
  investigation,
  appOrigin,
  webhookUrl,
  store,
  fetcher = globalThis.fetch.bind(globalThis),
  now = () => new Date()
}: {
  investigation: Investigation;
  appOrigin: string;
  webhookUrl?: string;
  store: SlackInterruptDeliveryStore;
  fetcher?: typeof fetch;
  now?: () => Date;
}): Promise<SlackInterruptDeliveryResult> {
  const payload = buildSlackInterruptPayload(investigation, appOrigin);
  if (!payload) return { status: "not_actionable" };
  if (!webhookUrl) return { status: "unconfigured" };
  if (!isSlackWebhookUrl(webhookUrl)) {
    return {
      status: "invalid_configuration",
      error: "Slack webhook URL is not an allowed Slack endpoint"
    };
  }

  const attemptedAt = now().toISOString();
  let claimed: boolean;
  try {
    claimed = await store.claim(investigation.id, attemptedAt);
  } catch (error) {
    return {
      status: "failed",
      error: deliveryStoreError("claim", error)
    };
  }
  if (!claimed) return { status: "already_attempted" };

  try {
    const response = await fetcher(webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const error = `Slack webhook returned HTTP ${response.status}`;
      await safelyMarkFailed(store, investigation.id, now, error);
      return { status: "failed", error };
    }

    try {
      await store.markSent(investigation.id, now().toISOString());
    } catch (error) {
      return {
        status: "failed",
        error: deliveryStoreError("record successful delivery", error)
      };
    }
    return { status: "sent" };
  } catch (error) {
    const message =
      error instanceof Error
        ? `Slack webhook request failed: ${error.message}`
        : "Slack webhook request failed";
    await safelyMarkFailed(store, investigation.id, now, message);
    return { status: "failed", error: message };
  }
}

async function safelyMarkFailed(
  store: SlackInterruptDeliveryStore,
  investigationId: string,
  now: () => Date,
  error: string
) {
  try {
    await store.markFailed(investigationId, now().toISOString(), error);
  } catch {
    // Slack delivery is best-effort and must not disturb the investigation.
  }
}

function deliveryStoreError(action: string, error: unknown) {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return `Slack delivery could not ${action}${detail}`;
}

function isSlackWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SLACK_WEBHOOK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function escapeSlackText(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
