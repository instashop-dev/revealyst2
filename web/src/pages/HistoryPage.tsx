import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { HistoryEvent } from "../api/types.js";

function scoreClass(score: number) {
  if (score >= 70) return "bg-emerald-100 text-emerald-700";
  if (score >= 50) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
}

/**
 * Prompt History (spec §5.4): synced events from `/api/history` — scores and
 * flags only, no prompt text (snippets stay in the extension's local history).
 */
export function HistoryPage() {
  const { session } = useAuth();
  const [period, setPeriod] = useState<"7d" | "30d" | "all">("all");
  const [minScore, setMinScore] = useState(0);
  const [platformFilter, setPlatformFilter] = useState("");
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .history(session.token, period, undefined, minScore || undefined)
      .then((res) => {
        if (!cancelled) {
          setEvents(res.events);
          setNote(res.note);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load history");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, period, minScore]);

  // Client-side platform filter — re-filters the fetched rows as you type.
  const rows = useMemo(() => {
    const q = platformFilter.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => (e.llm_platform ?? "").toLowerCase().includes(q));
  }, [events, platformFilter]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Prompt history</h1>
        <p className="text-sm text-zinc-500">Your recent prompts, scores and flags.</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Period
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value as "7d" | "30d" | "all")}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Min score
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value={0}>Any score</option>
            <option value={50}>50+</option>
            <option value={70}>70+</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Filter by platform
          <input
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value)}
            placeholder="e.g. chatgpt"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {!loading && !error && rows.length === 0 && (
        <p className="rounded-2xl border border-zinc-200 p-6 text-sm text-zinc-500">
          No prompts scored in this period — install the extension and score a prompt.
        </p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-zinc-200">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Platform</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.prompt_hash + e.created_at} className="border-t border-zinc-100">
                  <td className="px-4 py-3 text-zinc-500">
                    {new Date(e.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">{e.llm_platform ?? "unknown"}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded px-2 py-0.5 font-mono ${scoreClass(e.score)}`}>
                      {e.score}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {e.flags.length === 0 ? (
                      <span className="text-zinc-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {e.flags.map((f) => (
                          <span
                            key={f}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500"
                          >
                            {f.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-zinc-400">
        {note ||
          "Prompt snippets are stored locally in the extension's history — only scores and flags sync to the cloud."}
      </p>
    </div>
  );
}
