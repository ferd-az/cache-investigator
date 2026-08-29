import { Agent, getAgentByName, routeAgentRequest } from "agents";
import type { FiberContext, FiberRecoveryContext } from "agents";
import type {
  Investigation,
  InvestigationAgentState
} from "./investigation/contracts";
import { D1InvestigationRepository } from "./investigation/repository.ts";
import {
  InvestigationModelError,
  InvestigationChaosDisabledError,
  InvestigationStartConflictError,
  prepareInvestigation,
  reconcileStalledInvestigation,
  resolveInvestigationStart,
  runInvestigation
} from "./investigation/runtime.ts";
import { AnthropicInvestigationModel } from "./investigation/anthropic-model.ts";
import {
  executeInvestigationTool,
  InvestigationToolInputError
} from "./telemetry/tools.ts";
import {
  deliverSlackInterrupt,
  D1SlackInterruptDeliveryStore
} from "./investigation/slack-interrupt.ts";

export type InvestigationState = InvestigationAgentState;

export class InvestigationAgent extends Agent<Env, InvestigationState> {
  initialState: InvestigationState = {
    investigation: null
  };

  async startInvestigation(value: unknown, appOrigin: string) {
    const repository = new D1InvestigationRepository(this.env.TELEMETRY_DB);
    const prepared = await prepareInvestigation(repository, value, new Date(), {
      allowChaos: chaosAllowed(this.env)
    });
    if (this.name !== prepared.investigation.id) {
      throw new InvestigationStartConflictError(
        "Investigation was routed to the wrong Agent instance"
      );
    }
    this.setState({ investigation: prepared.investigation });

    if (
      prepared.investigation.status === "completed" ||
      prepared.investigation.status === "no_findings" ||
      prepared.investigation.status === "failed"
    ) {
      await this.deliverSlackInterrupt(prepared.investigation, appOrigin);
      return {
        investigation: prepared.investigation,
        accepted: false,
        fiberStatus: "completed" as const
      };
    }

    const investigationId = prepared.investigation.id;
    const receipt = await this.startFiber(
      "cache-investigation",
      async (context) => {
        context.stash({ investigationId, appOrigin });
        await this.runDurableInvestigation(investigationId, appOrigin, context);
      },
      {
        idempotencyKey: `investigation:${investigationId}`,
        metadata: { investigationId, appOrigin }
      }
    );

    return {
      investigation:
        (await repository.get(investigationId)) ?? prepared.investigation,
      accepted: receipt.accepted,
      fiberId: receipt.fiberId,
      fiberStatus: receipt.status
    };
  }

  async getInvestigation(
    id: string,
    appOrigin?: string
  ): Promise<Investigation | null> {
    const repository = new D1InvestigationRepository(this.env.TELEMETRY_DB);
    const reconciled = await reconcileStalledInvestigation(repository, id, {
      resume: async () => {
        if (this.resumingStalledInvestigation) return;
        this.resumingStalledInvestigation = true;
        this.ctx.waitUntil(
          this.runDurableInvestigation(id, appOrigin)
            .catch((error) => {
              console.error("Stalled investigation resume failed", {
                investigationId: id,
                error
              });
            })
            .finally(() => {
              this.resumingStalledInvestigation = false;
            })
        );
      }
    });
    return reconciled?.investigation ?? null;
  }

  private resumingStalledInvestigation = false;

  async onFiberRecovered(context: FiberRecoveryContext) {
    if (context.name !== "cache-investigation") return;
    const { investigationId, appOrigin } =
      recoveryInvestigationContext(context);
    if (!investigationId) {
      return {
        status: "error" as const,
        error: "Missing investigation ID in durable fiber checkpoint"
      };
    }

    const investigation = await this.runDurableInvestigation(
      investigationId,
      appOrigin
    );
    return {
      status: "completed" as const,
      snapshot: { investigationId, status: investigation.status }
    };
  }

  private async runDurableInvestigation(
    investigationId: string,
    appOrigin?: string,
    fiber?: FiberContext
  ) {
    const repository = new D1InvestigationRepository(this.env.TELEMETRY_DB);
    const investigation = await runInvestigation(investigationId, {
      repository,
      model: new AnthropicInvestigationModel(this.env.ANTHROPIC_API_KEY),
      executeTool: (call) =>
        executeInvestigationTool(this.env.TELEMETRY_DB, call),
      onPersist: (investigation) => {
        this.setState({ investigation });
      },
      onCheckpoint: (checkpoint) => {
        fiber?.stash({ investigationId, appOrigin, checkpoint });
      }
    });
    await this.deliverSlackInterrupt(investigation, appOrigin);
    return investigation;
  }

  private async deliverSlackInterrupt(
    investigation: Investigation,
    appOrigin?: string
  ) {
    if (!appOrigin) return;
    const result = await deliverSlackInterrupt({
      investigation,
      appOrigin,
      webhookUrl: this.env.SLACK_WEBHOOK_URL,
      store: new D1SlackInterruptDeliveryStore(this.env.TELEMETRY_DB)
    });
    if (
      result.status === "failed" ||
      result.status === "invalid_configuration"
    ) {
      console.error("Slack interrupt delivery failed", {
        investigationId: investigation.id,
        reason: result.error
      });
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/investigations") {
        const investigations = await new D1InvestigationRepository(
          env.TELEMETRY_DB
        ).list();
        return Response.json({ investigations });
      }

      if (request.method === "POST" && url.pathname === "/api/investigations") {
        const requestedChaos = url.searchParams.get("chaos");
        const body = await request.json();
        const startValue = withChaos(body, requestedChaos);
        const resolved = await resolveInvestigationStart(startValue, {
          allowChaos: chaosAllowed(env)
        });
        const agent = await getAgentByName(env.InvestigationAgent, resolved.id);
        return Response.json(
          await agent.startInvestigation(resolved.input, url.origin),
          {
            status: 202
          }
        );
      }

      const match = /^\/api\/investigations\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && match) {
        const agent = await getAgentByName(
          env.InvestigationAgent,
          decodeURIComponent(match[1])
        );
        const investigation = await agent.getInvestigation(
          decodeURIComponent(match[1]),
          url.origin
        );
        return investigation
          ? Response.json(investigation)
          : Response.json(
              { error: "Investigation not found" },
              { status: 404 }
            );
      }

      return (
        (await routeAgentRequest(request, env)) ||
        new Response("Not found", { status: 404 })
      );
    } catch (error) {
      if (error instanceof InvestigationStartConflictError) {
        return Response.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof InvestigationChaosDisabledError) {
        return Response.json({ error: error.message }, { status: 403 });
      }
      if (
        error instanceof InvestigationToolInputError ||
        error instanceof InvestigationModelError ||
        error instanceof SyntaxError
      ) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      console.error("Investigation API failed", error);
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

function recoveryInvestigationContext(context: FiberRecoveryContext) {
  const snapshot = context.snapshot;
  const metadata = context.metadata;
  let investigationId: string | null = null;
  let appOrigin: string | undefined;
  if (
    typeof snapshot === "object" &&
    snapshot !== null &&
    "investigationId" in snapshot &&
    typeof snapshot.investigationId === "string"
  ) {
    investigationId = snapshot.investigationId;
  } else if (metadata && typeof metadata.investigationId === "string") {
    investigationId = metadata.investigationId;
  }
  if (
    typeof snapshot === "object" &&
    snapshot !== null &&
    "appOrigin" in snapshot &&
    typeof snapshot.appOrigin === "string"
  ) {
    appOrigin = snapshot.appOrigin;
  } else if (metadata && typeof metadata.appOrigin === "string") {
    appOrigin = metadata.appOrigin;
  }
  return { investigationId, appOrigin };
}

function withChaos(value: unknown, requestedChaos: string | null) {
  if (requestedChaos === null) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return { ...value, chaos: requestedChaos };
}

function chaosAllowed(env: Env) {
  return String(env.INVESTIGATION_CHAOS) === "enabled";
}
