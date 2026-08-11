import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { StatsResponse } from "../api/types.js";

/** Badge progress: how far the user is toward earning it (0..target). */
export interface BadgeProgress {
  current: number;
  target: number;
}

export interface Badge {
  id: string;
  name: string;
  desc: string;
  check: (s: StatsResponse) => boolean;
  progress: (s: StatsResponse) => BadgeProgress;
}

/** Badges earned from the cloud stats (spec §5.4 / §5.8). Every badge also
 *  exposes `progress` so a locked badge shows how close the user is —
 *  opaque "locked" tiles motivated nobody (PMF review). */
const BADGES: Badge[] = [
  {
    id: "first-green",
    name: "First Green",
    desc: "Score your first green prompt (≥70)",
    check: (s) => s.green_count > 0,
    progress: (s) => ({ current: Math.min(s.green_count, 1), target: 1 }),
  },
  {
    id: "clarity-pro",
    name: "Clarity Pro",
    desc: "10 prompts with role clarity >80",
    check: (s) => s.clarity_count >= 10,
    progress: (s) => ({ current: Math.min(s.clarity_count, 10), target: 10 }),
  },
  {
    id: "format-master",
    name: "Format Master",
    desc: "Use an output format in 25 prompts",
    check: (s) => s.format_count >= 25,
    progress: (s) => ({ current: Math.min(s.format_count, 25), target: 25 }),
  },
  {
    id: "streak-5",
    name: "Week Streak",
    desc: "Score prompts 5 days in a row",
    check: (s) => s.streak_days >= 5,
    progress: (s) => ({ current: Math.min(s.streak_days, 5), target: 5 }),
  },
  {
    id: "first-week",
    name: "First Week Challenge",
    desc: "Score 5 green prompts (≥70) in any 7 days",
    check: (s: StatsResponse) => s.green_count >= 5,
    progress: (s) => ({ current: Math.min(s.green_count, 5), target: 5 }),
  },
  {
    id: "team-player",
    name: "Team Player",
    desc: "Share 5 prompts to the team library",
    check: (s) => s.shared_count >= 5,
    progress: (s) => ({ current: Math.min(s.shared_count, 5), target: 5 }),
  },
];

/** The 30d stats drive the long-term badges; 7d powers the "first week"
 *  mini-challenge (spec §5.8). */
export function statsForBadge(
  b: Badge,
  month: StatsResponse | null,
  week: StatsResponse | null,
): StatsResponse | null {
  return b.id === "first-week" ? week : month;
}

export function AchievementsPage() {
  const { session } = useAuth();
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [weekStats, setWeekStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoadError(null);
    Promise.all([api.stats(session.token, "30d"), api.stats(session.token, "7d")])
      .then(([month, week]) => {
        if (!cancelled) {
          setStats(month);
          setWeekStats(week);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStats(null);
          setLoadError(err instanceof Error ? err.message : "Could not load achievements.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token]);

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
            const source = statsForBadge(b, stats, weekStats);
            const earned = source ? b.check(source) : false;
            const progress = source ? b.progress(source) : { current: 0, target: 1 };
            const pct = Math.round((progress.current / progress.target) * 100);
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
                {earned ? (
                  <p className="mt-2 text-xs font-semibold text-emerald-600">Earned ✓</p>
                ) : (
                  <div className="mt-2">
                    <div className="h-1.5 rounded bg-zinc-100">
                      <div
                        className="h-1.5 rounded bg-emerald-500"
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-[11px] text-zinc-400">
                      {progress.current} / {progress.target}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!loading && loadError && (
        <p className="text-sm text-red-600">Could not load achievements: {loadError}</p>
      )}

      {!loading && !loadError && !stats && (
        <p className="text-sm text-zinc-500">
          Score prompts with the extension to start unlocking achievements.
        </p>
      )}
    </div>
  );
}
