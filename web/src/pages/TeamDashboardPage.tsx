import { useState } from "react";
import { BarList } from "../components/charts.js";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { DashboardResponse } from "../api/types.js";

/**
 * Team Manager dashboard (spec §5.5): fully anonymised aggregates — no
 * individual prompts are ever shown; members appear as User A/B pseudonyms.
 */
export function TeamDashboardPage() {
  const { user, session } = useAuth();
  const [teamId, setTeamId] = useState("");
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!session || !teamId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.teamDashboard(session.token, teamId.trim(), period));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  const weaknessRows = (data?.common_weaknesses ?? []).map((w) => ({
    label: w.flag.replace(/_/g, " "),
    count: w.count,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Team dashboard</h1>
        <p className="text-sm text-zinc-500">
          Anonymised team analytics — only managers can view this. Members are shown as pseudonyms.
        </p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Team id
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            placeholder="team UUID from Settings"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Period
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as "7d" | "30d")}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
          </select>
        </label>
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          Load
        </button>
      </form>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-zinc-200 p-5">
              <p className="text-xs text-zinc-500">Team average PQS</p>
              <p className="font-mono text-3xl font-bold text-emerald-600">
                {data.avg_score ?? "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-5">
              <p className="text-xs text-zinc-500">Prompts this period</p>
              <p className="font-mono text-3xl font-bold">
                {data.volume_by_day.reduce((n, d) => n + d.count, 0)}
              </p>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-5">
              <p className="text-xs text-zinc-500">Platforms</p>
              <ul className="mt-2 space-y-1 text-sm">
                {data.volume_by_platform.map((p) => (
                  <li key={p.llm_platform ?? "other"}>
                    {p.llm_platform ?? "unknown"}: <b>{p.count}</b>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">Common weaknesses</h2>
            <BarList rows={weaknessRows} />
          </section>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">
              Individual trends (pseudonymised)
            </h2>
            <ul className="space-y-2 text-sm">
              {data.trends_by_user.map((t, i) => (
                <li key={i} className="text-zinc-600">
                  <b>{t.user}</b> — {t.day}: <b className="text-emerald-600">{t.avg_score}</b>
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">
              Top prompts (hashes only — privacy)
            </h2>
            <ul className="space-y-1 text-sm text-zinc-600">
              {data.top_prompts.map((p) => (
                <li key={p.prompt_hash} className="flex justify-between">
                  <code className="truncate">{p.prompt_hash.slice(0, 20)}…</code>
                  <span>
                    <b>{p.best_score}</b> · used {p.occurrences}×
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {!data && !loading && (
        <p className="text-sm text-zinc-400">
          Enter your team id above (see Settings) to load analytics. Signed in as {user?.email}.
        </p>
      )}
    </div>
  );
}
