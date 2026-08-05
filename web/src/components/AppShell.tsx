import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/session.js";

const NAV = [
  { to: "/progress", label: "Progress" },
  { to: "/history", label: "History" },
  { to: "/achievements", label: "Achievements" },
  { to: "/library", label: "Library" },
  { to: "/team", label: "Team" },
  { to: "/settings", label: "Settings" },
];

export function AppShell() {
  const { user, logout } = useAuth();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <span className="text-lg font-bold text-emerald-700">Revealyst</span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
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
