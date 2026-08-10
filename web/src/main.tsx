import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./auth/session.js";
import { TeamsProvider, useTeams } from "./teams.js";
import { AppShell } from "./components/AppShell.js";
import { LoginPage } from "./pages/LoginPage.js";
import { VerifyPage } from "./pages/VerifyPage.js";
import { ProgressPage } from "./pages/ProgressPage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { AchievementsPage } from "./pages/AchievementsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { TeamDashboardPage } from "./pages/TeamDashboardPage.js";
import { LibraryPage } from "./pages/LibraryPage.js";
import { AdminPage } from "./pages/AdminPage.js";

/**
 * /team requires a manager role in at least one team. The server 403 is the
 * hard gate; this redirect is just the UX layer for non-managers.
 */
function TeamRoute() {
  const { teams, loading } = useTeams();
  if (loading) return <p className="text-sm text-zinc-400">Checking team role…</p>;
  if (!teams.some((t) => t.role === "manager")) return <Navigate to="/progress" replace />;
  return <TeamDashboardPage />;
}

/**
 * /admin is for the app creator only. The server 403 is the hard gate; this
 * redirect is just the UX layer for everyone else.
 */
function AdminRoute() {
  const { user, loading } = useAuth();
  if (loading) return <p className="text-sm text-zinc-400">Checking admin access…</p>;
  if (user?.is_admin !== true) return <Navigate to="/progress" replace />;
  return <AdminPage />;
}

function GuardedApp() {
  const { session, loading } = useAuth();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-400">
        Loading…
      </div>
    );
  return (
    <TeamsProvider>
      <Routes>
        <Route path="/auth/verify" element={<VerifyPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={session ? <AppShell /> : <Navigate to="/login" replace />}>
          <Route index element={<Navigate to="/progress" replace />} />
          <Route path="progress" element={<ProgressPage />} />
          <Route path="history" element={<HistoryPage />} />
          <Route path="achievements" element={<AchievementsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="team" element={<TeamRoute />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="admin" element={<AdminRoute />} />
        </Route>
      </Routes>
    </TeamsProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <GuardedApp />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
