import { useEffect, useState } from "react";
import type { LocalHistoryEntry, Settings } from "../shared/types.js";

export interface TeamOption {
  id: string;
  name: string;
  role: string;
}

export interface SettingsPanelProps {
  settings: Settings;
  localHistory: LocalHistoryEntry[];
  onSave: (patch: Partial<Settings>) => void;
  onClearHistory: () => void;
  loadTeams: (token: string) => Promise<TeamOption[]>;
}

/**
 * Extension settings (spec §5.1): API base + token (copied from the web
 * dashboard Settings), team selection for save-to-library, cloud sync toggle,
 * and the personal local prompt history (snippets never leave the device).
 */
export function SettingsPanel({
  settings,
  localHistory,
  onSave,
  onClearHistory,
  loadTeams,
}: SettingsPanelProps) {
  const [apiBase, setApiBase] = useState(settings.apiBase);
  const [apiToken, setApiToken] = useState(settings.apiToken);
  const [teamId, setTeamId] = useState(settings.teamId);
  const [cloudSync, setCloudSync] = useState(settings.cloudSync);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [teamsStatus, setTeamsStatus] = useState<string | null>(null);

  useEffect(() => {
    if (settings.apiToken) {
      loadTeams(settings.apiToken)
        .then((ts) => {
          setTeams(ts);
          if (ts.length > 0 && !ts.some((t) => t.id === settings.teamId)) {
            setTeamId(ts[0]!.id);
          }
        })
        .catch(() => setTeamsStatus("Could not load teams — check your token."));
    }
  }, [settings.apiToken]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshTeams() {
    if (!apiToken.trim()) {
      setTeamsStatus("Paste your API token first.");
      return;
    }
    setTeamsStatus("Loading…");
    try {
      const ts = await loadTeams(apiToken.trim());
      setTeams(ts);
      setTeamsStatus(
        ts.length > 0
          ? `${ts.length} team(s) found`
          : "No teams yet — create one in the dashboard.",
      );
    } catch {
      setTeamsStatus("Could not load teams — check your token.");
    }
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <p className="text-base font-bold text-emerald-700">Settings</p>
        <button
          className="rounded px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100"
          onClick={() => onSave({})}
        >
          Close ✕
        </button>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">API base URL</span>
        <input
          value={apiBase}
          onChange={(e) => setApiBase(e.target.value)}
          className="rounded-lg border border-zinc-300 px-3 py-2 text-xs"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">
          API token{" "}
          <span className="text-zinc-400">(from dashboard Settings → Connect the extension)</span>
        </span>
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder="Paste your session token"
          className="rounded-lg border border-zinc-300 px-3 py-2 text-xs"
        />
      </label>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-zinc-500">Team (save-to-library)</span>
        <div className="flex items-center gap-2">
          <select
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2 text-xs"
            disabled={teams.length === 0}
          >
            {teams.length === 0 && <option value="">No teams loaded</option>}
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.role})
              </option>
            ))}
          </select>
          <button
            onClick={() => void refreshTeams()}
            className="rounded-md border border-zinc-300 px-2 py-1.5 text-[11px] text-zinc-600 hover:bg-zinc-100"
          >
            Load
          </button>
        </div>
        {teamsStatus && <p className="text-[11px] text-zinc-400">{teamsStatus}</p>}
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={cloudSync}
          onChange={(e) => setCloudSync(e.target.checked)}
          className="h-4 w-4"
        />
        <span className="text-xs text-zinc-600">
          Team sync (scores + hashes only — privacy-first)
        </span>
      </label>

      <button
        className="mt-auto rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700"
        onClick={() =>
          onSave({
            apiBase: apiBase.trim(),
            apiToken: apiToken.trim(),
            teamId,
            cloudSync,
          })
        }
      >
        Save settings
      </button>

      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">
          Personal prompt history ({localHistory.length})
        </summary>
        {localHistory.length === 0 ? (
          <p className="mt-1 text-zinc-400">Nothing scored yet on this device.</p>
        ) : (
          <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
            {localHistory.map((h, i) => (
              <div key={i} className="rounded border border-zinc-100 p-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-[11px] ${h.score >= 70 ? "text-emerald-600" : h.score >= 50 ? "text-amber-600" : "text-red-600"}`}
                  >
                    {h.score}
                  </span>
                  <span className="text-[10px] text-zinc-400">
                    {h.platform} · {new Date(h.createdAt).toLocaleDateString()}
                  </span>
                  <span className="text-[11px]">
                    {h.rating === 1 ? "👍" : h.rating === -1 ? "👎" : ""}
                  </span>
                </div>
                <p className="truncate text-[11px] text-zinc-600">{h.prompt}</p>
              </div>
            ))}
          </div>
        )}
        {localHistory.length > 0 && (
          <button
            className="mt-1 text-[11px] text-red-500 hover:underline"
            onClick={onClearHistory}
          >
            Clear local history
          </button>
        )}
        <p className="mt-1 text-[10px] text-zinc-400">
          Stored only on this device — prompt snippets never sync (spec §5.7).
        </p>
      </details>
    </div>
  );
}
