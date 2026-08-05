import { useState } from "react";
import { useAuth } from "../auth/session.js";

/** Settings (spec §5.4): manage cloud sync, team membership, data export. */
export function SettingsPage() {
  const { user } = useAuth();
  const [sync, setSync] = useState(false);
  const [teamId, setTeamId] = useState("");

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
        <h2 className="text-sm font-semibold text-zinc-700">Privacy &amp; cloud sync</h2>
        <label className="mt-3 flex items-center justify-between gap-4">
          <span className="text-sm text-zinc-600">
            Cloud sync for team analytics{" "}
            <span className="block text-xs text-zinc-400">
              Off by default — only scores/hashes leave your device (privacy-first, spec §5.7).
            </span>
          </span>
          <input
            type="checkbox"
            checked={sync}
            onChange={(e) => setSync(e.target.checked)}
            className="h-5 w-5"
          />
        </label>
        <label className="mt-4 flex flex-col gap-1 text-sm">
          <span className="text-zinc-600">Team id (from your manager)</span>
          <input
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            placeholder="paste team UUID"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
      </section>

      <section className="rounded-2xl border border-zinc-200 p-6">
        <h2 className="text-sm font-semibold text-zinc-700">Data</h2>
        <button className="mt-3 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">
          Export my data (JSON)
        </button>
        <button className="mt-3 ml-2 rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50">
          Delete my data
        </button>
        <p className="mt-3 text-xs text-zinc-400">
          Deleting your account removes synced scores, events and library entries.
        </p>
      </section>
    </div>
  );
}
