import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/session.js";
import { useTeams } from "../teams.js";

const NAV = [
  { to: "/progress", label: "Progress" },
  { to: "/history", label: "History" },
  { to: "/achievements", label: "Achievements" },
  { to: "/library", label: "Library" },
  { to: "/team", label: "Team", managerOnly: true },
  { to: "/admin", label: "Admin", adminOnly: true },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  const { user, logout, impersonating, exitImpersonation } = useAuth();
  const { teams } = useTeams();
  const isManager = teams.some((t) => t.role === "manager");
  const isAdmin = user?.is_admin === true;
  const nav = NAV.filter(
    (item) => (!("managerOnly" in item) || isManager) && (!("adminOnly" in item) || isAdmin),
  );

  return (
    <div className="flex min-h-screen flex-col">
      {impersonating && (
        <div className="bg-amber-400 px-4 py-2 text-center text-sm font-medium text-amber-950">
          You are viewing the app as <b>{user?.email}</b> (admin impersonation).{" "}
          <button
            onClick={exitImpersonation}
            className="ml-1 rounded-md bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-100 hover:bg-amber-900"
          >
            Exit impersonation
          </button>
        </div>
      )}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-lg font-bold text-emerald-700">Revealyst</span>
          <nav className="flex gap-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 text-sm ${isActive ? "bg-emerald-600 text-white" : "text-zinc-600 hover:bg-zinc-100"}`
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-zinc-500">
            <span>{user?.email}</span>
            <button
              onClick={logout}
              className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
