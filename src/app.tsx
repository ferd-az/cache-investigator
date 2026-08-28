import { useAgent } from "agents/react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { InvestigationsPage } from "./pages/investigations-page";
import type { InvestigationAgent, InvestigationState } from "./server";

export default function App() {
  useAgent<InvestigationAgent, InvestigationState>({
    agent: "InvestigationAgent",
    name: "demo"
  });

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<InvestigationsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
