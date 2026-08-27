import { Agent, routeAgentRequest } from "agents";

export type InvestigationState = {
  status: "idle";
};

export class InvestigationAgent extends Agent<Env, InvestigationState> {
  initialState: InvestigationState = {
    status: "idle"
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
