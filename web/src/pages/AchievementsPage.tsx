import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { StatsResponse } from "../api/types.js";

/** Badges earned from the cloud stats (spec §5.4 / §5.8). */
const BADGES: Array<{
  id: string;
  name: string;
  desc: string;
  check: (s: StatsResponse) => boolean;
}> = [
  {
    id: "first-green",
    name: "First Green",
    desc: "Score ≥70 on your first prompt",
    check: (s) => s.green_count > 0,
  },
  {
    id: "clarity-pro",
    name: "Clarity Pro",
    desc: "10 prompts with role clarity >80",
    check: (s) => s.clarity_count >= 10,
  },
  {
    id: "format-master",
    name: "Format Master",
    desc: "Use an output format in 25 prompts",
    check: (s) => s.format_count >= 25,
  },
  {
    id: "streak-5",
    name: "Week Streak",
    desc: "Score prompts 5 days in a row",
    check: (s) => s.streak_days >= 5,
  },
  {
    id: "first-week",
    name: "First Week Challenge",
    desc: "Score 5 green prompts (≥70) in your first week",
    check: (s: StatsResponse) => s.green_count >= 5,
  },
  {
    id: "team-player",
    name: "Team Player",
    desc: "Share 5 prompts to the team library",
    check: (s) => s.shared_count >= 5,
  },
];

export function AchievementsPage() {
  const { session } = useAuth();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [weekStats, setWeekStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    // 30d drives the long-term badges; 7d powers the spec §5.8 "first week"
    // mini-challenge (5 green prompts).
    Promise.all([api.stats(session.token, "30d"), api.stats(session.token, "7d")])
      .then(([month, week]) => {
        if (!cancelled) {
          setStats(month);
          setWeekStats(week);
        }
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  // The first-week badge is judged on the 7-day green count (spec §5.8).
  const statsFor = (b: (typeof BADGES)[number]): StatsResponse | null =>
    b.id === "first-week" ? weekStats : stats;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Achievements</h1>
        <p className="text-sm text-zinc-500">Milestones that make your AI skill visible.</p>
      </div>

      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {!loading && (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {BADGES.map((b) => {
            const source = statsFor(b);
            const earned = source ? b.check(source) : false;
            return (
              <div
                key={b.id}
                className={`rounded-2xl border p-5 ${earned ? "border-emerald-200 bg-emerald-50/50" : "border-zinc-200"}`}
              >
                <div className={`text-3xl ${earned ? "" : "opacity-30 grayscale"}`}>
                  {earned ? "🏅" : "🔒"}
                </div>
                <h3 className="mt-2 font-semibold text-zinc-800">{b.name}</h3>
                <p className="mt-1 text-xs text-zinc-500">{b.desc}</p>
                {earned && <p className="mt-2 text-xs font-semibold text-emerald-600">Earned ✓</p>}
              </div>
            );
          })}
        </div>
      )}

      {!loading && !stats && (
        <p className="text-sm text-zinc-500">
          Score prompts with the extension to start unlocking achievements.
        </p>
      )}
    </div>
  );
}
