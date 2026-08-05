/** Achievements (spec §5.4): badges for milestones. */
const BADGES = [
  { id: "first-green", name: "First Green", desc: "Score ≥70 on your first prompt", earned: true },
  {
    id: "clarity-pro",
    name: "Clarity Pro",
    desc: "10 prompts with role clarity >80",
    earned: false,
  },
  {
    id: "format-master",
    name: "Format Master",
    desc: "Use an output format in 25 prompts",
    earned: false,
  },
  { id: "streak-5", name: "Week Streak", desc: "Score prompts 5 days in a row", earned: false },
  {
    id: "team-player",
    name: "Team Player",
    desc: "Share 5 prompts to the team library",
    earned: false,
  },
];

export function AchievementsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Achievements</h1>
        <p className="text-sm text-zinc-500">Milestones that make your AI skill visible.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
        {BADGES.map((b) => (
          <div
            key={b.id}
            className={`rounded-2xl border p-5 ${b.earned ? "border-emerald-200 bg-emerald-50/50" : "border-zinc-200"}`}
          >
            <div className={`text-3xl ${b.earned ? "" : "opacity-30 grayscale"}`}>
              {b.earned ? "🏅" : "🔒"}
            </div>
            <h3 className="mt-2 font-semibold text-zinc-800">{b.name}</h3>
            <p className="mt-1 text-xs text-zinc-500">{b.desc}</p>
            {b.earned && <p className="mt-2 text-xs font-semibold text-emerald-600">Earned ✓</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
