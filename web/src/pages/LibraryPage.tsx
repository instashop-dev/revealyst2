import { useState } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { LibraryCard } from "../api/types.js";

/** Shared Prompt Library (spec §5.6): search, tags, copy/send, versions. */
export function LibraryPage() {
  const { session } = useAuth();
  const [teamId, setTeamId] = useState("");
  const [search, setSearch] = useState("");
  const [cards, setCards] = useState<LibraryCard[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openText, setOpenText] = useState<Record<string, string>>({});

  async function load(page = 1) {
    if (!session || !teamId.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.libraryList(session.token, teamId.trim(), { search, page });
      setCards(res.prompts);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load library");
    } finally {
      setLoading(false);
    }
  }

  async function copyPrompt(id: string) {
    if (!session) return;
    const res = await api.libraryGet(session.token, id);
    setOpenText((s) => ({ ...s, [id]: res.prompt_text }));
    await navigator.clipboard.writeText(res.prompt_text);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Shared prompt library</h1>
        <p className="text-sm text-zinc-500">
          Your team&apos;s best prompts — save, share, standardise.
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
            placeholder="team UUID"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="keyword or tag"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          Search
        </button>
      </form>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {cards.length === 0 && !loading && !error && (
        <p className="text-sm text-zinc-400">
          {total === 0 ? "No prompts yet — save one from the extension with team sync on." : ""}
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => (
          <article key={card.id} className="rounded-2xl border border-zinc-200 p-5">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-semibold text-zinc-800">{card.title ?? "Untitled prompt"}</h3>
              {card.score !== null && (
                <span className="rounded-md bg-emerald-100 px-2 py-0.5 font-mono text-sm text-emerald-700">
                  {card.score}
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {card.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500"
                >
                  #{tag}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-zinc-400">
              by {card.contributor} · used {card.usage_count}× · v{card.version} ·{" "}
              {new Date(card.created_at).toLocaleDateString()}
            </p>
            {openText[card.id] && (
              <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-2 text-xs text-zinc-700">
                {openText[card.id]}
              </pre>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void copyPrompt(card.id)}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                Copy to clipboard
              </button>
              <button
                onClick={() => void copyPrompt(card.id)}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                title="Copies the prompt — paste it into any LLM"
              >
                Send to LLM
              </button>
            </div>
          </article>
        ))}
      </div>

      {total > cards.length && (
        <p className="text-sm text-zinc-400">
          {cards.length} of {total} shown — refine the search to narrow results.
        </p>
      )}
    </div>
  );
}
