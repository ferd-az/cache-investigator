import { useAgent } from "agents/react";
import type { InvestigationAgent, InvestigationState } from "./server";

export default function App() {
  const agent = useAgent<InvestigationAgent, InvestigationState>({
    agent: "InvestigationAgent",
    name: "demo"
  });

  return (
    <main>
      <h1>Cache Investigator</h1>
      <p>Agent status: {agent.state?.activeInvestigation?.status ?? "idle"}</p>
    </main>
  );
}
