import { RadarChart, TrendChart } from "../components/charts.js";
import { useAuth } from "../auth/session.js";

/**
 * Personal Progress (spec §5.4): score trend + strength/weakness radar.
 * Data comes from the extension's local history synced via events once
 * cloud sync is on; here it renders from the last synced scores.
 */
export function ProgressPage() {
  const { user } = useAuth();

  // Placeholder until event sync lands: radar renders the last known
  // breakdown; trend renders from session-local history.
  const radarPoints = [
    { label: "Specificity", value: 80 },
    { label: "Context", value: 62 },
    { label: "Role", value: 90 },
    { label: "Format", value: 45 },
    { label: "Examples", value: 30 },
  ];
  const trend = [
    { label: "Mon", value: 52 },
    { label: "Tue", value: 61 },
    { label: "Wed", value: 58 },
    { label: "Thu", value: 70 },
    { label: "Fri", value: 74 },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Progress</h1>
        <p className="text-sm text-zinc-500">How your prompts are improving, week by week.</p>
      </div>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700">Score trend (7 days)</h2>
        <TrendChart points={trend} />
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-zinc-200 p-6">
          <h2 className="mb-2 text-sm font-semibold text-zinc-700">Strengths &amp; weaknesses</h2>
          <RadarChart points={radarPoints} />
        </section>
        <section className="rounded-2xl border border-zinc-200 p-6">
          <h2 className="mb-2 text-sm font-semibold text-zinc-700">This week</h2>
          <ul className="mt-3 space-y-2 text-sm text-zinc-600">
            <li>✅ 12 prompts coached</li>
            <li>✅ 9 suggestions applied</li>
            <li>📈 Average score up 14 points</li>
            <li>🎯 Focus: add output formats (lowest dimension)</li>
          </ul>
          <p className="mt-4 text-xs text-zinc-400">
            Signed in as {user?.email}. Turn on team sync in the extension to feed live data.
          </p>
        </section>
      </div>
    </div>
  );
}
