import { useEffect, useState } from "react";
import { BarList, TrendChart } from "../components/charts.js";
import { TeamInvites } from "../components/TeamInvites.js";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import { useTeams } from "../teams.js";
import type { DashboardResponse } from "../api/types.js";

/**
 * Team Manager dashboard (spec §5.5): aggregated, anonymised team analytics.
 * Only managers can load it (server 403 is the hard gate); members are shown
 * as pseudonyms unless every member opts in to identifiable mode.
 */
export function TeamDashboardPage() {
  const { session } = useAuth();
  const { teams } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [period, setPeriod] = useState<"7d" | "30d">("7d");
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [reminderCopied, setReminderCopied] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;
  const isManager = selectedTeam?.role === "manager";

  // Default to the first team once teams load.
  useEffect(() => {
    if (teams.length > 0 && !teams.some((t) => t.id === selectedTeamId)) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  // Auto-load the dashboard whenever team/period changes.
  useEffect(() => {
    if (!session || !selectedTeamId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .teamDashboard(session.token, selectedTeamId, period)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load dashboard");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, selectedTeamId, period, reloadKey]);

  const weaknessRows = (data?.common_weaknesses ?? []).map((w) => ({
    label: w.flag.replace(/_/g, " "),
    count: w.count,
  }));
  const scoreTrend = (data?.score_by_day ?? []).map((d) => ({ label: d.day, value: d.avg_score }));
  const promptCount = (data?.volume_by_day ?? []).reduce((n, d) => n + d.count, 0);

  /** Group the flat (user, day, score) rows into per-member progressions. */
  function groupTrendsByUser(rows: DashboardResponse["trends_by_user"]) {
    const byUser = new Map<string, DashboardResponse["trends_by_user"]>();
    for (const row of rows) {
      const list = byUser.get(row.user) ?? [];
      list.push(row);
      byUser.set(row.user, list);
    }
    return [...byUser.entries()].map(([user, points]) => ({ user, points }));
  }

  async function copyPrompt(id: string) {
    if (!session) return;
    try {
      const res = await api.libraryGet(session.token, id);
      await navigator.clipboard.writeText(res.prompt_text);
      setCopiedId(id);
    } catch {
      // Clipboard unavailable — ignore.
    }
  }

  async function markStandard(id: string) {
    if (!session || !isManager) return;
    try {
      await api.libraryPatch(session.token, id, { is_standard: true });
      setReloadKey((k) => k + 1);
    } catch {
      // Manager-only endpoint; ignore.
    }
  }

  async function coachingReminder() {
    if (!session || !data) return;
    const top = data.common_weaknesses[0];
    const text = [
      `Coaching reminder — ${selectedTeam?.name ?? "team"} (${data.period})`,
      `Team average PQS: ${data.avg_score ?? "—"}`,
      top
        ? `Top weakness: ${top.flag.replace(/_/g, " ")} (${top.count} prompts)`
        : "Top weakness: none yet",
      `Prompts this period: ${promptCount}`,
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setReminderCopied(true);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Team dashboard</h1>
        <p className="text-sm text-zinc-500">
          Anonymised team analytics — only managers can view this. Members are shown as pseudonyms.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Team
          <select
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.role})
              </option>
            ))}
          </select>
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
      </div>

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
              <p className="font-mono text-3xl font-bold">{promptCount}</p>
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
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">Team score trend</h2>
            <TrendChart points={scoreTrend} />
          </section>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">Common weaknesses</h2>
            <BarList rows={weaknessRows} />
          </section>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-700">Top prompts (library)</h2>
              <button
                onClick={() => void coachingReminder()}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
              >
                {reminderCopied ? "Reminder copied ✓" : "Coaching reminder"}
              </button>
            </div>
            <ul className="space-y-3">
              {data.top_prompts.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-zinc-800">
                        {p.title ?? "Untitled prompt"}
                      </span>
                      {p.is_standard && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                          Team Standard
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-400">
                      score {p.score ?? "—"} · used {p.usage_count}× · v{p.version} · by{" "}
                      {p.contributor} · {new Date(p.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => void copyPrompt(p.id)}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      {copiedId === p.id ? "Copied ✓" : "Copy"}
                    </button>
                    {isManager && (
                      <button
                        onClick={() => void markStandard(p.id)}
                        className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        Mark Team Standard
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {data.top_prompts.length === 0 && (
              <p className="text-sm text-zinc-400">No prompts shared to the library yet.</p>
            )}
            {!isManager && (
              <p className="mt-2 text-xs text-zinc-400">
                Read-only view — only managers can mark prompts as Team Standard.
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-zinc-200 p-6">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700">
              Individual trends (pseudonymised)
            </h2>
            {data.trends_by_user.length === 0 ? (
              <p className="text-sm text-zinc-400">No member trends in this period.</p>
            ) : (
              <div className="space-y-4">
                {groupTrendsByUser(data.trends_by_user).map((member) => (
                  <div key={member.user}>
                    <div className="flex items-baseline justify-between">
                      <p className="text-sm font-medium text-zinc-700">{member.user}</p>
                      <p className="text-xs text-zinc-400">
                        {member.points[0]?.avg_score} →{" "}
                        {member.points[member.points.length - 1]?.avg_score} pts ·{" "}
                        {member.points.length} day(s)
                      </p>
                    </div>
                    <TrendChart
                      points={member.points.map((p) => ({ label: p.day, value: p.avg_score }))}
                      width={520}
                      height={80}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="rounded-2xl border border-zinc-200 p-5">
            <p className="text-xs text-zinc-500">Identifiable mode</p>
            <p className="text-sm font-semibold text-zinc-700">
              {data.identifiable ? "On — first name + last initial" : "Off — pseudonyms only"}
            </p>
            <p className="mt-1 text-xs text-zinc-400">
              Identifiable mode requires every member to opt in before individual names appear.
            </p>
          </div>

          {isManager && (
            <section className="rounded-2xl border border-zinc-200 p-6">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700">Members &amp; invites</h2>
              <TeamInvites teamId={selectedTeamId} />
            </section>
          )}
        </>
      )}

      {!data && !loading && !error && (
        <p className="text-sm text-zinc-400">
          Select a team above to load analytics. Signed in as {session?.user.email}.
        </p>
      )}
    </div>
  );
}
