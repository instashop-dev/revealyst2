import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client.js";
import { useAuth } from "../auth/session.js";
import type { TeamInvite } from "../api/types.js";

/**
 * Team invite management (spec §5.8): send an invite by email (with a role),
 * see pending/revoked/accepted invites, re-send a fresh link, or revoke one.
 * Manager-only — the server 403 is the hard gate; pages guard with isManager.
 */
export function TeamInvites({ teamId }: { teamId: string }) {
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "manager">("member");
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!session || !teamId) return;
    let cancelled = false;
    setLoading(true);
    api
      .teamInvites(session.token, teamId)
      .then((res) => {
        if (!cancelled) setInvites(res.invites);
      })
      .catch(() => {
        if (!cancelled) setStatus({ ok: false, text: "Failed to load invites." });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.token, teamId]);

  useEffect(() => load(), [load]);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!session || !email.trim()) return;
    setStatus(null);
    try {
      await api.inviteMember(session.token, teamId, email.trim(), role);
      setStatus({
        ok: true,
        text: `Invite sent to ${email.trim()} — they will receive an email with a sign-in link.`,
      });
      setEmail("");
      load();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Invite failed." });
    }
  }

  async function revoke(invite: TeamInvite) {
    if (!session) return;
    setBusyId(invite.id);
    setStatus(null);
    try {
      await api.revokeInvite(session.token, invite.id);
      setStatus({
        ok: true,
        text: `Invite to ${invite.email} revoked — its link no longer works.`,
      });
      load();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Revoke failed." });
    } finally {
      setBusyId(null);
    }
  }

  async function resend(invite: TeamInvite) {
    if (!session) return;
    setBusyId(invite.id);
    setStatus(null);
    try {
      await api.resendInvite(session.token, invite.id);
      setStatus({ ok: true, text: `A fresh invite was sent to ${invite.email}.` });
      load();
    } catch (err) {
      setStatus({ ok: false, text: err instanceof Error ? err.message : "Re-send failed." });
    } finally {
      setBusyId(null);
    }
  }

  const pending = invites.filter((i) => i.status === "pending");

  return (
    <div>
      <form onSubmit={(e) => void send(e)} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Invite by email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "member" | "manager")}
            className="rounded-lg border border-zinc-300 px-3 py-2 text-sm"
          >
            <option value="member">Member</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <button className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">
          Send invite
        </button>
      </form>

      {status && (
        <p className={`mt-2 text-sm ${status.ok ? "text-emerald-700" : "text-red-600"}`}>
          {status.text}
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-semibold text-zinc-700">
          Invites
          {pending.length > 0 && (
            <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700">
              {pending.length} pending
            </span>
          )}
        </h3>
        {loading && <p className="mt-2 text-sm text-zinc-400">Loading invites…</p>}
        {!loading && invites.length === 0 && (
          <p className="mt-2 text-sm text-zinc-400">No invites sent yet.</p>
        )}
        {!loading && invites.length > 0 && (
          <ul className="mt-2 space-y-2">
            {invites.map((invite) => (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-100 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <span className="font-medium text-zinc-700">{invite.email}</span>
                  <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600">
                    {invite.role}
                  </span>
                  <span
                    className={`ml-2 text-xs ${
                      invite.status === "pending"
                        ? "text-amber-600"
                        : invite.status === "accepted"
                          ? "text-emerald-600"
                          : "text-zinc-400"
                    }`}
                  >
                    {invite.status === "pending"
                      ? `pending · sent ${new Date(invite.created_at).toLocaleDateString()}`
                      : invite.status === "accepted"
                        ? "accepted"
                        : "revoked"}
                  </span>
                </div>
                {invite.status === "pending" && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void resend(invite)}
                      disabled={busyId === invite.id}
                      className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
                    >
                      {busyId === invite.id ? "Sending…" : "Re-send"}
                    </button>
                    <button
                      onClick={() => void revoke(invite)}
                      disabled={busyId === invite.id}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
