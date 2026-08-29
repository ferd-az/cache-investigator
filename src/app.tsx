import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/app-shell";
import { InvestigationDetailPage } from "./pages/investigation-detail-page";
import { InvestigationsPage } from "./pages/investigations-page";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<InvestigationsPage />} />
          <Route path="i/:id" element={<InvestigationDetailPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
