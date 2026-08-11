import { useEffect, useState } from "react";
import { RadarChart, TrendChart } from "../components/charts.js";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { StatsResponse } from "../api/types.js";

/** Canonical radar dimension order (spec §5.2). */
const DIMENSIONS = [
  { key: "specificity", label: "Specificity" },
  { key: "context", label: "Context" },
  { key: "role_clarity", label: "Role" },
  { key: "output_format", label: "Format" },
  { key: "examples_included", label: "Examples" },
];

/**
 * Personal Progress (spec §5.4): score trend + strength/weakness radar from
 * the cloud `/api/stats` endpoint (fed by synced, hashed events).
 */
export function ProgressPage() {
  const { session, user } = useAuth();
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .stats(session.token, period)
      .then((res) => {
        if (!cancelled) setStats(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load stats");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, period]);

  const radarPoints = DIMENSIONS.map((d) => ({
    label: d.label,
    value: stats?.radar[d.key] ?? 0,
  })).filter((p) => p.value > 0);
  const trend = (stats?.trend ?? []).map((t) => ({ label: t.day, value: t.avg_score }));
  const hasData = (stats?.prompts_count ?? 0) > 0 && radarPoints.length > 0;
  const focus = radarPoints.length
    ? radarPoints.reduce((min, p) => (p.value < min.value ? p : min), radarPoints[0]!).label
    : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Progress</h1>
        <p className="text-sm text-zinc-500">How your prompts are improving, week by week.</p>
      </div>

      <div className="flex gap-2">
        {(["7d", "30d"] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              period === p
                ? "bg-emerald-600 text-white"
                : "border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            {p === "7d" ? "Last 7 days" : "Last 30 days"}
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {!loading && !error && !hasData && (
        <p className="rounded-2xl border border-zinc-200 p-6 text-sm text-zinc-500">
          No data yet — install the extension and score a prompt.
        </p>
      )}

      {!loading && !error && hasData && stats && (
        <>
          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-2 text-sm font-semibold text-zinc-700">
              Score trend ({period === "7d" ? "7 days" : "30 days"})
            </h2>
            <TrendChart points={trend} />
          </section>

          <div className="grid gap-6 md:grid-cols-2">
            <section className="rounded-2xl border border-zinc-200 p-6">
              <h2 className="mb-2 text-sm font-semibold text-zinc-700">
                Strengths &amp; weaknesses
              </h2>
              <RadarChart points={radarPoints} />
            </section>
            <section className="rounded-2xl border border-zinc-200 p-6">
              <h2 className="mb-2 text-sm font-semibold text-zinc-700">This week</h2>
              <ul className="mt-3 space-y-2 text-sm text-zinc-600">
                <li>✅ {stats.prompts_count} prompts coached</li>
                <li>✅ {stats.green_count} green prompts (≥70)</li>
                <li>✅ {stats.accepted_count} suggestions applied</li>
                <li>📈 Average score: {stats.avg_score ?? "—"}</li>
                <li>🎯 Focus: {focus ?? "keep scoring"}</li>
              </ul>
              <p className="mt-4 text-xs text-zinc-400">
                Signed in as {user?.email}. Turn on team sync in the extension to feed live data.
              </p>
            </section>
          </div>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="text-sm font-semibold text-zinc-700">North-star (spec §4)</h2>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl bg-emerald-50/50 p-4">
                <p className="text-xs text-zinc-500">4-week PQS lift</p>
                {stats.improvement?.pqs_delta_4w == null ? (
                  <p className="mt-1 text-sm text-zinc-500">Score for 4 weeks to see your trend.</p>
                ) : (
                  <p
                    className={`mt-1 text-2xl font-bold ${
                      stats.improvement?.pqs_delta_4w >= 10
                        ? "text-emerald-600"
                        : stats.improvement?.pqs_delta_4w > 0
                          ? "text-emerald-500"
                          : "text-red-500"
                    }`}
                  >
                    {stats.improvement?.pqs_delta_4w > 0 ? "+" : ""}
                    {stats.improvement?.pqs_delta_4w} pts
                  </p>
                )}
                <p className="mt-1 text-[10px] text-zinc-400">
                  {stats.improvement?.current_avg == null
                    ? "current week: no data"
                    : `current 7d avg ${stats.improvement?.current_avg}`}
                  {stats.improvement?.baseline_avg == null
                    ? ""
                    : ` · baseline ${stats.improvement?.baseline_avg}`}
                </p>
              </div>

              <div className="rounded-xl bg-zinc-50 p-4">
                <p className="text-xs text-zinc-500">Re-prompt rate (30d)</p>
                {stats.improvement?.reprompt_rate == null ? (
                  <p className="mt-1 text-sm text-zinc-500">No data yet.</p>
                ) : (
                  <p className="mt-1 text-2xl font-bold text-zinc-800">
                    {Math.round(stats.improvement?.reprompt_rate * 100)}%
                  </p>
                )}
                {stats.improvement?.reprompt_rate != null &&
                  stats.improvement?.reprompt_rate_prev != null && (
                    <p className="mt-1 text-[10px] text-zinc-400">
                      was {Math.round(stats.improvement?.reprompt_rate_prev * 100)}% the month
                      before
                    </p>
                  )}
              </div>

              <div className="rounded-xl bg-zinc-50 p-4">
                <p className="text-xs text-zinc-500">Active weeks (of 4)</p>
                <p className="mt-1 text-2xl font-bold text-zinc-800">
                  {stats.improvement?.active_weeks ?? "—"}
                  <span className="text-sm font-normal text-zinc-400"> / 4</span>
                </p>
                <p className="mt-1 text-[10px] text-zinc-400">weekly retention signal</p>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
