import { Agent, routeAgentRequest } from "agents";
import type { InvestigationAgentState } from "./investigation/contracts";

export type InvestigationState = InvestigationAgentState;

export class InvestigationAgent extends Agent<Env, InvestigationState> {
  initialState: InvestigationState = {
    activeInvestigation: null
  };
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
