import { useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import { useTeams } from "../teams.js";
import type { LibraryCard, LibraryVersion } from "../api/types.js";

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Shared Prompt Library (spec §5.6): search, tags, copy/send, versions, edit. */
export function LibraryPage() {
  const { session } = useAuth();
  const { teams } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [sort, setSort] = useState<"most_used" | "highest_score" | "newest">("most_used");
  const [cards, setCards] = useState<LibraryCard[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openText, setOpenText] = useState<Record<string, string>>({});
  const [versionsById, setVersionsById] = useState<Record<string, LibraryVersion[]>>({});
  const [openVersions, setOpenVersions] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [sendOpenFor, setSendOpenFor] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStandard, setEditStandard] = useState(false);
  const [editPromptText, setEditPromptText] = useState("");
  const [originalPromptText, setOriginalPromptText] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [newPromptText, setNewPromptText] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newTags, setNewTags] = useState("");
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;
  const isManager = selectedTeam?.role === "manager";

  // Default to the first team once teams load.
  useEffect(() => {
    if (teams.length > 0 && !teams.some((t) => t.id === selectedTeamId)) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  // Reload whenever the team or any filter changes. Search is debounced so
  // typing does not fire a request per keystroke.
  useEffect(() => {
    if (!session || !selectedTeamId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      api
        .libraryList(session.token, selectedTeamId, {
          search: search || undefined,
          tag: tag || undefined,
          minScore: minScore || undefined,
          sort,
        })
        .then((res) => {
          if (!cancelled) {
            setCards(res.prompts);
            setTotal(res.total);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load library");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session?.token, selectedTeamId, search, tag, minScore, sort, refreshKey]);

  async function copyPrompt(id: string) {
    if (!session) return;
    try {
      const res = await api.libraryGet(session.token, id);
      setOpenText((s) => ({ ...s, [id]: res.prompt_text }));
      await navigator.clipboard.writeText(res.prompt_text);
    } catch {
      // Clipboard unavailable — the preview still shows the text.
    }
  }

  async function sendToLlm(id: string, platform: "chatgpt" | "claude" | "gemini") {
    await copyPrompt(id);
    const urls = {
      chatgpt: "https://chatgpt.com/",
      claude: "https://claude.ai/",
      gemini: "https://gemini.google.com/",
    };
    window.open(urls[platform], "_blank", "noopener,noreferrer");
  }

  async function toggleVersions(id: string) {
    if (!session) return;
    if (openVersions[id]) {
      setOpenVersions((s) => ({ ...s, [id]: false }));
      return;
    }
    try {
      const res = await api.libraryVersions(session.token, id);
      setVersionsById((s) => ({ ...s, [id]: res.versions }));
      setOpenVersions((s) => ({ ...s, [id]: true }));
    } catch {
      // Version history unavailable.
    }
  }

  async function startEdit(card: LibraryCard) {
    setEditingId(card.id);
    setEditTitle(card.title ?? "");
    setEditTags(card.tags.join(", "));
    setEditNotes(card.notes ?? "");
    setEditStandard(card.is_standard);
    setEditError(null);
    try {
      const detail = await api.libraryGet(session!.token, card.id);
      setEditPromptText(detail.prompt_text);
      setOriginalPromptText(detail.prompt_text);
    } catch {
      setEditPromptText("");
      setOriginalPromptText("");
    }
  }

  async function saveEdit() {
    if (!session || !editingId) return;
    const patch: Parameters<typeof api.libraryPatch>[2] = isManager
      ? { notes: editNotes || null, is_standard: editStandard }
      : { title: editTitle || undefined, tags: parseTags(editTags) };
    // Editing the prompt body creates a new version (spec §5.6) — only send
    // the body when it actually changed, so metadata edits don't fork versions.
    if (editPromptText !== originalPromptText && editPromptText.trim()) {
      patch.prompt_text = editPromptText;
    }
    try {
      await api.libraryPatch(session.token, editingId, patch);
      setEditingId(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to save changes");
    }
  }

  async function saveNew(e: FormEvent) {
    e.preventDefault();
    if (!session || !selectedTeamId || !newPromptText.trim()) return;
    setSaveStatus(null);
    try {
      await api.librarySave(session.token, {
        team_id: selectedTeamId,
        prompt_text: newPromptText.trim(),
        title: newTitle.trim() || undefined,
        tags: parseTags(newTags),
      });
      setNewPromptText("");
      setNewTitle("");
      setNewTags("");
      setSaveStatus("Saved ✓");
      setRefreshKey((k) => k + 1);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSaveStatus("Already saved — this prompt is already in the library.");
      } else {
        setSaveStatus(err instanceof Error ? err.message : "Failed to save prompt");
      }
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Shared prompt library</h1>
        <p className="text-sm text-zinc-500">
          Your team&apos;s best prompts — save, share, standardise.
        </p>
      </div>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Save new prompt</h2>
        <form onSubmit={saveNew} className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Title (optional)
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Outreach email prompt"
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Prompt text
            <textarea
              required
              value={newPromptText}
              onChange={(e) => setNewPromptText(e.target.value)}
              rows={4}
              placeholder="Paste the prompt you want to share…"
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Tags (comma-separated, optional)
            <input
              value={newTags}
              onChange={(e) => setNewTags(e.target.value)}
              placeholder="email, sales"
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <button className="self-start rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            Save to library
          </button>
          {saveStatus && <p className="text-sm text-zinc-600">{saveStatus}</p>}
        </form>
      </section>

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
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Search
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="keyword"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Tag
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="tag"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Min score
          <select
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value={0}>Any</option>
            <option value={50}>50+</option>
            <option value={70}>70+</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as "most_used" | "highest_score" | "newest")}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="most_used">Most used</option>
            <option value="highest_score">Highest score</option>
            <option value="newest">Newest</option>
          </select>
        </label>
      </div>

      {error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      {loading && <p className="text-sm text-zinc-400">Loading…</p>}

      {!loading && !error && cards.length === 0 && (
        <p className="rounded-2xl border border-zinc-200 p-6 text-sm text-zinc-500">
          No prompts yet — save one with the extension or in the form above.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {cards.map((card) => {
          const preview = openText[card.id];
          const versions = versionsById[card.id];
          return (
            <article key={card.id} className="rounded-2xl border border-zinc-200 p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold text-zinc-800">{card.title ?? "Untitled prompt"}</h3>
                  {card.is_standard && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-700">
                      Team Standard
                    </span>
                  )}
                </div>
                {card.score !== null && (
                  <span className="rounded-md bg-emerald-100 px-2 py-0.5 font-mono text-sm text-emerald-700">
                    {card.score}
                  </span>
                )}
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {card.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-500"
                  >
                    #{t}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs text-zinc-400">
                by {card.contributor} · used {card.usage_count}× · v{card.version} · created{" "}
                {new Date(card.created_at).toLocaleDateString()}
                {card.last_used_at
                  ? ` · last used ${new Date(card.last_used_at).toLocaleDateString()}`
                  : ""}
              </p>
              {card.notes && (
                <p className="mt-2 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600">{card.notes}</p>
              )}
              {preview && (
                <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-2 text-xs text-zinc-700">
                  {preview}
                </pre>
              )}

              {editingId === card.id && (
                <div className="mt-3 flex flex-col gap-2 rounded-lg bg-zinc-50 p-3 text-sm">
                  <label className="flex flex-col gap-1">
                    Prompt text (edits create a new version, preserving this one)
                    <textarea
                      value={editPromptText}
                      onChange={(e) => setEditPromptText(e.target.value)}
                      rows={4}
                      className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                    />
                  </label>
                  {isManager ? (
                    <>
                      <label className="flex flex-col gap-1">
                        Notes
                        <textarea
                          value={editNotes}
                          onChange={(e) => setEditNotes(e.target.value)}
                          rows={3}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={editStandard}
                          onChange={(e) => setEditStandard(e.target.checked)}
                          className="h-4 w-4"
                        />
                        Team Standard
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="flex flex-col gap-1">
                        Title
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        Tags (comma-separated)
                        <input
                          value={editTags}
                          onChange={(e) => setEditTags(e.target.value)}
                          className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
                        />
                      </label>
                    </>
                  )}
                  {editError && <p className="text-sm text-red-600">{editError}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => void saveEdit()}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => void copyPrompt(card.id)}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
                >
                  Copy to clipboard
                </button>
                <button
                  onClick={() => setSendOpenFor(sendOpenFor === card.id ? null : card.id)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                  title="Copies the prompt and opens your chosen LLM"
                >
                  Send to LLM {sendOpenFor === card.id ? "▲" : "▼"}
                </button>
                {sendOpenFor === card.id && (
                  <div className="flex gap-1.5">
                    {(["chatgpt", "claude", "gemini"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => void sendToLlm(card.id, p)}
                        className="rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200"
                      >
                        {p === "chatgpt" ? "ChatGPT" : p === "claude" ? "Claude" : "Gemini"}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => void toggleVersions(card.id)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  {openVersions[card.id] ? "Hide versions" : "Versions"}
                </button>
                <button
                  onClick={() => startEdit(card)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
                >
                  {isManager ? "Edit (notes)" : "Edit"}
                </button>
              </div>

              {versions && openVersions[card.id] && (
                <ul className="mt-3 space-y-1 rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600">
                  {versions.map((v) => (
                    <li key={v.id}>
                      v{v.version} — {v.title ?? "Untitled"}
                      {v.is_standard ? " · Team Standard" : ""} —{" "}
                      {new Date(v.created_at).toLocaleDateString()}
                    </li>
                  ))}
                  {versions.length === 0 && <li>No earlier versions.</li>}
                </ul>
              )}
            </article>
          );
        })}
      </div>

      {total > cards.length && (
        <p className="text-sm text-zinc-400">
          {cards.length} of {total} shown — refine the search to narrow results.
        </p>
      )}
    </div>
  );
}
