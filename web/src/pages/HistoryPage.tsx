/** Prompt History (spec §5.4): searchable list with date, platform, snippet, score, rating. */
export function HistoryPage() {
  const rows: Array<{
    date: string;
    platform: string;
    snippet: string;
    score: number;
    rating: "up" | "down" | null;
  }> = [
    // Session-local history — replaced by synced events once cloud sync lands.
    {
      date: "2026-08-05 09:12",
      platform: "ChatGPT",
      snippet: "Help me write something good…",
      score: 25,
      rating: null,
    },
    {
      date: "2026-08-05 09:15",
      platform: "ChatGPT",
      snippet: "Act as a senior copywriter. Help me write…",
      score: 74,
      rating: "up",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Prompt history</h1>
        <p className="text-sm text-zinc-500">Your recent prompts, scores and ratings.</p>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Platform</th>
              <th className="px-4 py-3">Prompt</th>
              <th className="px-4 py-3">Score</th>
              <th className="px-4 py-3">Rating</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-zinc-100">
                <td className="px-4 py-3 text-zinc-500">{r.date}</td>
                <td className="px-4 py-3">{r.platform}</td>
                <td className="max-w-md truncate px-4 py-3 text-zinc-700">{r.snippet}</td>
                <td className="px-4 py-3">
                  <span className="rounded bg-emerald-100 px-2 py-0.5 font-mono text-emerald-700">
                    {r.score}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {r.rating === "up" ? "👍" : r.rating === "down" ? "👎" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-400">
        Synced history appears here when the extension&apos;s team/cloud sync is enabled.
      </p>
    </div>
  );
}
