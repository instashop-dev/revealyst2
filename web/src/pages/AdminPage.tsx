import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { AdminUser } from "../api/types.js";

/**
 * App-creator admin (MVP): every signed-up user with signup date, activity,
 * plan, team memberships, and one-click impersonation login.
 */
export function AdminPage() {
  const { session, user, impersonate } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setError(null);
    api
      .adminUsers(session.token)
      .then((res) => {
        if (!cancelled) setUsers(res.users);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setUsers(null);
          setError(err instanceof Error ? err.message : "Failed to load users");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  async function logInAs(target: AdminUser) {
    if (!session) return;
    const ok = window.confirm(
      `Log in as ${target.email}? You can return to your own account afterwards.`,
    );
    if (!ok) return;
    setImpersonatingId(target.id);
    try {
      const next = await api.adminImpersonate(session.token, target.id);
      impersonate(next);
      navigate("/progress", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impersonation failed");
    } finally {
      setImpersonatingId(null);
    }
  }

  function formatDate(value: string | null): string {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Admin</h1>
        <p className="text-sm text-zinc-500">
          All signed-up users. Use “Log in as” to open their account exactly as they see it — the
          banner lets you return at any time.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
          {error}
        </p>
      )}

      {!error && !users && <p className="text-sm text-zinc-400">Loading users…</p>}

      {users && users.length === 0 && (
        <p className="text-sm text-zinc-400">No signed-up users yet.</p>
      )}

      {users && users.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">User</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Signed up</th>
                <th className="px-3 py-2">Last active</th>
                <th className="px-3 py-2">Events</th>
                <th className="px-3 py-2">Teams</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isSelf = u.id === user?.id;
                return (
                  <tr key={u.id} className="border-t border-zinc-100 align-top">
                    <td className="px-3 py-2 text-zinc-700">
                      {u.email}
                      {isSelf && <span className="text-zinc-400"> (you)</span>}
                    </td>
                    <td className="px-3 py-2">{u.plan}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-600">
                      {formatDate(u.created_at)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-zinc-600">
                      {formatDate(u.last_active_at)}
                    </td>
                    <td className="px-3 py-2 text-zinc-600">{u.events_count}</td>
                    <td className="px-3 py-2 text-zinc-600">
                      {u.teams.length === 0 ? (
                        <span className="text-zinc-400">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {u.teams.map((t) => (
                            <li key={t.id}>
                              {t.name} <span className="text-zinc-400">({t.role})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {!isSelf && (
                        <button
                          onClick={() => void logInAs(u)}
                          disabled={impersonatingId !== null}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {impersonatingId === u.id ? "Logging in…" : "Log in as"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-zinc-400">
        Admin access is limited to the app creator (ADMIN_EMAILS). Impersonation signs you in with
        the user’s own session — their data is never modified.
      </p>
    </div>
  );
}
