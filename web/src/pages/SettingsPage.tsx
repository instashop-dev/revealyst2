import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import { useTeams } from "../teams.js";
import { TeamInvites } from "../components/TeamInvites.js";
import type { TeamMember } from "../api/types.js";

/**
 * Settings (spec §5.4): account, cloud sync (controlled in the extension),
 * team membership + manager controls, and data export/delete.
 */
export function SettingsPage() {
  const { user, session, logout } = useAuth();
  const { teams, refresh } = useTeams();
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [newTeamName, setNewTeamName] = useState("");
  const [createStatus, setCreateStatus] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [membersLoading, setMembersLoading] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState<string | null>(null);

  const selectedTeam = teams.find((t) => t.id === selectedTeamId) ?? null;
  const isManager = selectedTeam?.role === "manager";

  // Default the team selector to the first team once teams load.
  useEffect(() => {
    if (selectedTeamId === "" && teams.length > 0) {
      setSelectedTeamId(teams[0]!.id);
    }
  }, [teams, selectedTeamId]);

  // Load the members table for the selected team.
  useEffect(() => {
    if (!session || !selectedTeamId) {
      setMembers(null);
      return;
    }
    let cancelled = false;
    setMembersLoading(true);
    api
      .teamMembers(session.token, selectedTeamId)
      .then((res) => {
        if (!cancelled) setMembers(res.members);
      })
      .catch(() => {
        if (!cancelled) setMembers(null);
      })
      .finally(() => {
        if (!cancelled) setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, selectedTeamId]);

  async function createTeam(e: FormEvent) {
    e.preventDefault();
    if (!session || !newTeamName.trim()) return;
    setCreateStatus(null);
    try {
      const team = await api.createTeam(session.token, newTeamName.trim());
      setNewTeamName("");
      refresh();
      setSelectedTeamId(team.id);
    } catch (err) {
      setCreateStatus(err instanceof Error ? err.message : "Failed to create team");
    }
  }

  async function toggleOptIn(member: TeamMember) {
    if (!session || !selectedTeamId) return;
    try {
      const res = await api.teamOptIn(session.token, selectedTeamId, !member.opt_in_identifiable);
      setMembers(
        (ms) =>
          ms?.map((m) =>
            m.user_id === member.user_id
              ? { ...m, opt_in_identifiable: res.opt_in_identifiable }
              : m,
          ) ?? null,
      );
    } catch {
      // Keep current state; the server rejected the opt-in change.
    }
  }

  async function toggleAnonymize() {
    if (!session || !selectedTeamId || !isManager) return;
    try {
      await api.teamSettings(session.token, selectedTeamId, !selectedTeam?.anonymize_identities);
      refresh();
    } catch {
      // Manager-only endpoint; ignore.
    }
  }

  async function exportData() {
    if (!session) return;
    setExportStatus("Exporting…");
    try {
      const [history, stats] = await Promise.all([
        api.history(session.token, "all"),
        api.stats(session.token, "30d"),
      ]);
      const payload = { exported_at: new Date().toISOString(), history, stats };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "revealyst-export.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportStatus("Exported ✓");
    } catch {
      setExportStatus("Export failed.");
    }
  }

  async function deleteData() {
    if (!session) return;
    if (!window.confirm("Delete all synced data? This cannot be undone.")) return;
    setDeleteStatus("Deleting…");
    try {
      await api.deleteAccount(session.token);
      // The account is gone server-side; clear the local session and land on
      // the login page.
      logout();
      window.alert(
        "Your account and all synced data were deleted. Extension-local history is cleared in the extension Settings.",
      );
    } catch (err) {
      setDeleteStatus(err instanceof Error ? err.message : "Delete failed. Please try again.");
    }
  }

  function copyToken() {
    if (!session) return;
    void navigator.clipboard.writeText(session.token);
    setTokenCopied(true);
    setTimeout(() => setTokenCopied(false), 1500);
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-zinc-500">Account, privacy and team preferences.</p>
      </div>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Account</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Signed in as <b>{user?.email}</b> · plan: <b>{user?.plan}</b>
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Connect the extension</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Click the Revealyst toolbar icon and either sign in with your email (magic link) or paste
          this API token under <b>Connect with token</b>. Then open the sidebar Settings (⚙️), pick
          your team, and turn on <b>Cloud sync</b> — that&apos;s what sends scores to this dashboard
          and the team analytics. Only scores, flags and prompt hashes sync; the token only
          authorises signed requests — no prompt text is transmitted by entering it.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            readOnly
            value={session?.token ?? ""}
            type={showToken ? "text" : "password"}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 px-3 py-2 font-mono text-xs text-zinc-600"
          />
          <button
            onClick={() => setShowToken((s) => !s)}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100"
          >
            {showToken ? "Hide" : "Show"}
          </button>
          <button
            onClick={copyToken}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            {tokenCopied ? "Copied ✓" : "Copy token"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Privacy &amp; cloud sync</h2>
        <p className="mt-3 text-sm text-zinc-600">
          Cloud sync is controlled in the <b>extension&apos;s Settings panel</b> — the web dashboard
          cannot reach chrome.storage. Only scores and prompt hashes leave your device when sync is
          on (privacy-first).
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Teams</h2>

        <form onSubmit={(e) => void createTeam(e)} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Create a team
            <input
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="Company name"
              className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
            />
          </label>
          <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
            Create
          </button>
        </form>
        {createStatus && <p className="mt-2 text-sm text-red-600">{createStatus}</p>}

        <label className="mt-4 flex flex-col gap-1 text-sm">
          <span className="text-zinc-600">My teams</span>
          {teams.length === 0 ? (
            <p className="text-sm text-zinc-400">You are not in any team yet.</p>
          ) : (
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
          )}
        </label>

        {selectedTeam && isManager && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-zinc-700">Invite members</h3>
            <TeamInvites teamId={selectedTeam.id} />
          </div>
        )}

        {selectedTeam && (
          <div className="mt-5">
            <h3 className="text-sm font-semibold text-zinc-700">Members</h3>
            {membersLoading && <p className="mt-2 text-sm text-zinc-400">Loading…</p>}
            {!membersLoading && members && members.length > 0 && (
              <table className="mt-2 w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Member</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="px-3 py-2">Opt-in to identifiable</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => {
                    const isSelf = m.user_id === session?.user.id;
                    return (
                      <tr key={m.user_id} className="border-t border-zinc-100">
                        <td className="px-3 py-2 text-zinc-700">
                          {m.display_name}
                          {isSelf && <span className="text-zinc-400"> (you)</span>}
                        </td>
                        <td className="px-3 py-2">{m.role}</td>
                        <td className="px-3 py-2">
                          {isSelf ? (
                            <input
                              type="checkbox"
                              checked={m.opt_in_identifiable}
                              onChange={() => void toggleOptIn(m)}
                              className="h-4 w-4"
                            />
                          ) : (
                            <span className="text-zinc-500">
                              {m.opt_in_identifiable ? "opted in" : "not opted in"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-xs text-zinc-400">
              Identifiable mode requires every member to opt in — until then the dashboard shows
              pseudonyms.
            </p>
          </div>
        )}

        {selectedTeam && isManager && (
          <label className="mt-4 flex items-center justify-between gap-4">
            <span className="text-sm text-zinc-600">
              Anonymize identities
              <span className="block text-xs text-zinc-400">
                Manager only — when off and all members opt in, first name + last initial are shown.
              </span>
            </span>
            <input
              type="checkbox"
              checked={selectedTeam.anonymize_identities}
              onChange={() => void toggleAnonymize()}
              className="h-5 w-5"
            />
          </label>
        )}
      </section>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Data</h2>
        <button
          onClick={() => void exportData()}
          className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
        >
          Export my data (JSON)
        </button>
        {exportStatus && <span className="ml-2 text-sm text-zinc-500">{exportStatus}</span>}
        <button
          onClick={deleteData}
          className="mt-3 ml-2 rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50"
        >
          Delete my data
        </button>
        {deleteStatus && <span className="ml-2 text-sm text-red-600">{deleteStatus}</span>}
        <p className="mt-3 text-xs text-zinc-400">
          Export combines your cloud history and stats. Deleting your data removes synced scores,
          events and library entries. Cloud sync state and extension-local history are controlled in
          the extension&apos;s Settings.
        </p>
      </section>
    </div>
  );
}
